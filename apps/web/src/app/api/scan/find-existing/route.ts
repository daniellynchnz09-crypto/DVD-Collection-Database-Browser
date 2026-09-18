import { NextResponse } from "next/server";
import { requireScanSecret } from "@/lib/scanAuth";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import {
  extractDiscCountHint,
  extractFormatHint,
  extractImdbIdFromPage,
  normalizeTitleForMatch,
  omdbGetById,
} from "@danflix/shared";

// Format/packaging words that can appear on both sides of a collection-name comparison
// independent of which physical box it actually is (e.g. "4K", "Boxset") - stripped before
// tokenizing so two genuinely different collections in the same format never score similar
// purely from that overlap. Same convention the private-only pricing-confidence module
// already uses for retail-listing text; duplicated here rather than shared across the
// public/private build boundary (see textSimilarity's own comment below).
const FORMAT_NOISE_WORDS = /\b(4k|uhd|ultra ?hd|blu-?ray|dvd|vhs|cd|steelbook|disc|disk|boxset|box ?set|collection|edition)\b/gi;

function tokenize(text: string): Set<string> {
  const stripped = text.replace(FORMAT_NOISE_WORDS, " ");
  return new Set(normalizeTitleForMatch(stripped).split(/\s+/).filter(Boolean));
}

/** Dice coefficient over normalized word tokens - a small local duplicate of the private-only
 * pricing-confidence module's own `textSimilarity` (not imported from there: that whole
 * module lives inside the private-collection-only directory excluded from the public
 * build, but collection matching is a core, always-public feature). Used by the collection-
 * header fuzzy match below to score how similar two box-set names are. */
function textSimilarity(a: string, b: string): number {
  const tokensA = tokenize(a);
  const tokensB = tokenize(b);
  if (tokensA.size === 0 || tokensB.size === 0) return 0;
  let common = 0;
  for (const token of tokensA) if (tokensB.has(token)) common++;
  return (2 * common) / (tokensA.size + tokensB.size);
}

interface ExistingTitleRow {
  unique_id: string;
  title: string;
  release_name: string | null;
  format: string;
  disc_count: number;
  disk_region: string | null;
  genre_location: string | null;
  franchise: string[];
  rating: string | null;
  studio: string | null;
  animation_or_live_action: string;
  special_features: boolean;
  steelbook: boolean;
  barcode_id: string | null;
  case_image_url: string | null;
  imdb_page: string | null;
  release_date: string | null;
  movie_or_tv: string;
  season_no: string | null;
  part_of_season_no: string | null;
  episode_count: number | null;
  is_collection: boolean;
  title_in_a_collection: boolean;
  name_of_collection: string | null;
}

export interface ExistingTitleCandidate extends ExistingTitleRow {
  posterUrl: string | null;
  /** Only populated for an `is_collection` candidate returned from the collection-header
   * fuzzy match above (added 2026-09-20) - the titles/ids of that candidate's own already-
   * catalogued members, so the client can resolve a single "overwrite the whole collection"
   * decision into a per-title match (an exact normalized-title equal to one of these becomes
   * that new member's own `overwriteUniqueId`; anything else is a genuinely new addition to
   * the collection) without a second round-trip. */
  existingMemberTitles?: { title: string; unique_id: string }[];
}

/**
 * Similar/matching-entry check (Claude/TECH STACK AND ARCHITECTURE.md's "Backfill Rescan"
 * section) - runs right before /api/scan/confirm actually writes anything, so a rescan of
 * a title already in the collection (the whole point of the backfill pass) surfaces as a
 * choice (Overwrite / Is a new entry / Reject) instead of silently creating a duplicate
 * row. Broader than the original backfill-matching check it replaces: matches by base
 * title text (ignoring cut-suffix differences, see normalizeTitleForMatch) OR by a shared
 * imdb_id, and - unlike the original, which only ever looked at rows with no barcode yet -
 * checks EVERY row, since two real physical copies of the same film (a Blu-ray and a 4K
 * UHD) should also surface here so the user can deliberately choose "Is a new entry" for a
 * genuine second copy, not just for the legacy Sheet-only backfill case.
 *
 * Narrows using a format/disc-count hint, only when doing so actually narrows the set (an
 * unreliable hint should never zero out a real candidate). Prefers `formatOverride`/
 * `discCountOverride` - ConfirmScreen's own already-resolved state - over re-deriving a hint
 * from the raw UPC product text, added 2026-09-18 after a real "Blade Runner: The Final Cut"
 * listing's own text said "...Dvd" despite the actual disc being 4K UHD: re-deriving from
 * that same stale text here silently filtered the genuine 4K UHD duplicate out of the
 * results, even though it had already correctly matched by shared imdb_id above - see
 * scanApi.ts's `findExistingTitle` for the full story. Falls back to the raw-text-derived
 * hint only when the client didn't send an override at all (e.g. an older app build).
 *
 * Each candidate carries enough detail for a real side-by-side comparison (poster + key
 * fields, `release_name` included as of 2026-09-18 - the user pointed out that two
 * similarly-titled entries are often actually different releases, e.g. a plain DVD vs. a
 * "Special Edition," and the title text alone doesn't say which is which), not just a
 * title/format/disc-count summary - falls back to an OMDB poster fetch via imdb_id when a
 * legacy row has no case_image_url of its own (most of the collection, pre-dating the
 * barcode pipeline, has neither yet).
 *
 * **`scopeToCollections` (added 2026-09-20, for the Collection scanning flow)** - per the
 * user's own explicit rule, a collection scan (the header row) and a collection member scan
 * must only ever be compared against *other* collections/collection-members, never against a
 * standalone title - a film owned both as its own standalone disc and as a member of some box
 * set is a legitimate, real situation (two different physical objects), not a duplicate. When
 * this flag is true, `rows` is filtered to `is_collection || title_in_a_collection` rows
 * *before* the matching logic below runs, so a standalone row can never surface as a
 * "duplicate" of a collection scan and vice versa.
 *
 * **`collectionMemberTitles` (added 2026-09-20)** - when checking the collection HEADER
 * itself (not an individual member), the plain exact-title-match this route otherwise uses
 * is too strict: a real box set was found to fail this exactly once already (a legacy pre-
 * barcode row titled "The Alfred Hitchcock Classics Collection 4K" simply isn't the same text
 * as a freshly-typed "The Alfred Hitchcock Classics," even though they're the same physical
 * box, and there's no barcode on the legacy row to match by either - it predates barcode
 * scanning). Per the user's own explicit request, matching a collection header instead scores
 * every existing `is_collection` row by three signals: fuzzy name similarity (`textSimilarity`
 * below - a real word-overlap comparison, not exact equality), a format match bonus, and -
 * the strongest signal - how many of the NEW collection's own already-added member titles
 * (`collectionMemberTitles`) match an EXISTING member already catalogued under that candidate
 * collection's own `name_of_collection`. The best-scoring plausible candidates (capped at 3)
 * feed into the same format/disc-count narrowing and poster resolution below as an ordinary
 * match, so the existing auto/ambiguous response shape and Overwrite/New-Entry resolution UI
 * both work completely unchanged.
 */
export async function POST(request: Request) {
  const authError = requireScanSecret(request);
  if (authError) return authError;

  const body = await request.json().catch(() => null);
  const title = typeof body?.title === "string" ? body.title : null;
  const upcText = typeof body?.upcText === "string" ? body.upcText : "";
  const imdbId = typeof body?.imdbId === "string" ? body.imdbId : null;
  const formatOverride = typeof body?.formatOverride === "string" ? body.formatOverride : null;
  const discCountOverride = typeof body?.discCountOverride === "number" ? body.discCountOverride : null;
  const scopeToCollections = body?.scopeToCollections === true;
  const collectionMemberTitles: string[] = Array.isArray(body?.collectionMemberTitles)
    ? body.collectionMemberTitles.filter((t: unknown): t is string => typeof t === "string")
    : [];
  if (!title) {
    return NextResponse.json({ error: "title is required" }, { status: 400 });
  }

  const supabase = getSupabaseServerClient();
  const SELECT_COLUMNS =
    "unique_id, title, release_name, format, disc_count, disk_region, genre_location, franchise, rating, studio, " +
    "animation_or_live_action, special_features, steelbook, barcode_id, case_image_url, imdb_page, release_date, " +
    "movie_or_tv, season_no, part_of_season_no, episode_count, is_collection, title_in_a_collection, name_of_collection";
  const PAGE_SIZE = 1000;
  // PostgREST caps a single response at 1000 rows by default, and the collection has
  // 3000+ - an unpaginated select here silently missed any row past the first 1000 (found
  // live: a genuine duplicate, the pre-barcode-pipeline "Thor Ragnarok" row, has a random
  // UUID unique_id that happened to sort outside that window, so this check reported "no
  // match" for a rescanned "Thor: Ragnarok" that shares its exact IMDb id). Same fix already
  // applied to lib/fieldOptions.ts's own distinct-values query for the same reason.
  const rows: ExistingTitleRow[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from("titles")
      .select(SELECT_COLUMNS)
      .range(from, from + PAGE_SIZE - 1);
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    const page = (data ?? []) as unknown as ExistingTitleRow[];
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }

  const scopedRows = scopeToCollections
    ? rows.filter((r) => r.is_collection || r.title_in_a_collection)
    : rows;

  let candidates: ExistingTitleRow[];
  // Populated only by the collection-header fuzzy-match branch below, keyed by unique_id -
  // attached to the final response candidates further down so the client can resolve a
  // single "overwrite the whole collection" decision into a per-title match.
  const existingMembersByHeaderId = new Map<string, { title: string; unique_id: string }[]>();
  if (scopeToCollections && collectionMemberTitles.length > 0) {
    const headerCandidates = scopedRows.filter((r) => r.is_collection);
    const normalizedNewMemberTitles = collectionMemberTitles.map((t) => normalizeTitleForMatch(t));
    const scored = headerCandidates.map((r) => {
      const nameScore = textSimilarity(title, r.title);
      const formatBonus = formatOverride && r.format?.toLowerCase() === formatOverride.toLowerCase() ? 0.15 : 0;
      const existingMembers = scopedRows.filter(
        (m) => m.title_in_a_collection && m.name_of_collection === r.name_of_collection
      );
      existingMembersByHeaderId.set(
        r.unique_id,
        existingMembers.map((m) => ({ title: m.title, unique_id: m.unique_id }))
      );
      const memberTitleOverlap = normalizedNewMemberTitles.filter((t) =>
        existingMembers.some((m) => normalizeTitleForMatch(m.title) === t)
      ).length;
      // Weighted well above name/format similarity alone - two different collections
      // sharing even one exact member title (by title-text equality, the same check a
      // single-title scan already uses) is a far stronger signal than approximate name
      // similarity could ever be on its own.
      return { row: r, score: nameScore + formatBonus + memberTitleOverlap * 0.5, memberTitleOverlap };
    });
    const plausible = scored
      .filter((s) => s.score > 0.3 || s.memberTitleOverlap > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);
    candidates = plausible.map((s) => s.row);
  } else {
    const target = normalizeTitleForMatch(title);
    candidates = scopedRows.filter(
      (r) =>
        normalizeTitleForMatch(r.title) === target ||
        (imdbId != null && extractImdbIdFromPage(r.imdb_page) === imdbId)
    );
  }
  if (candidates.length === 0) {
    return NextResponse.json({ status: "none" });
  }

  const formatHint = formatOverride ?? extractFormatHint(upcText);
  const discCountHint = discCountOverride ?? extractDiscCountHint(upcText);

  let narrowed = candidates;
  if (formatHint) {
    const byFormat = narrowed.filter((r) => r.format?.toLowerCase() === formatHint.toLowerCase());
    if (byFormat.length > 0) narrowed = byFormat;
  }
  if (discCountHint != null) {
    const byDiscCount = narrowed.filter((r) => r.disc_count === discCountHint);
    if (byDiscCount.length > 0) narrowed = byDiscCount;
  }

  const withPosters: ExistingTitleCandidate[] = await Promise.all(
    narrowed.map(async (r) => {
      const existingMemberTitles = existingMembersByHeaderId.get(r.unique_id);
      if (r.case_image_url) return { ...r, posterUrl: r.case_image_url, existingMemberTitles };
      const imdbIdForRow = extractImdbIdFromPage(r.imdb_page);
      if (imdbIdForRow) {
        const detail = await omdbGetById(imdbIdForRow);
        if (detail?.Poster && detail.Poster !== "N/A") {
          return { ...r, posterUrl: detail.Poster, existingMemberTitles };
        }
      }
      return { ...r, posterUrl: null, existingMemberTitles };
    })
  );

  if (withPosters.length === 1) {
    return NextResponse.json({ status: "auto", match: withPosters[0] });
  }
  return NextResponse.json({ status: "ambiguous", candidates: withPosters });
}
