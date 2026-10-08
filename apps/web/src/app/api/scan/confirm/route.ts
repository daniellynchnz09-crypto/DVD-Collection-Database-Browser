import { randomUUID } from "node:crypto";
import { after, NextResponse } from "next/server";
import { refreshWebsiteCaches } from "@/lib/catalog/cacheRefresh";
import { requireScanSecret } from "@/lib/scanAuth";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { logScanEvent } from "@/lib/scanLog";
import {
  appendRowToSheet,
  deleteSheetRowsByUniqueIds,
  getSheetHeaderAndColumns,
  getSheetRowByUniqueId,
  restoreSheetRowByUniqueId,
  updateSheetFieldsByUniqueId,
} from "@/lib/googleSheets";
import { canonicalizeValue } from "@/lib/canonicalizeValue";
import {
  buildColumnIndexes,
  buildSheetRowFromTitle,
  cleanFreeText,
  deriveDocumentaryValue,
  extractImdbIdFromPage,
  inferDepictedEraStart,
  normalizeAnimationOrLiveAction,
  normalizeDocumentary,
  normalizeDiscCondition,
  normalizeFormat,
  isValidNzRating,
  normalizeFranchiseList,
  normalizeRating,
  normalizeStudio,
  removeNonGenreTags,
  omdbGetById,
  parseOmdbReleaseDate,
  parseOmdbRuntimeMins,
} from "@danflix/shared";
import {
  CLASSIC_WHO_SERIES_IMDB_ID,
  deleteStagedCoverPhotos,
  fetchTmdbFieldsById,
  lookupClassicWhoSerialByImdbId,
  lookupRottenTomatoesPage,
  lookupTmdbFields,
  pickFrontCoverPath,
  promoteStagedCoverToCaseImage,
  refreshTitlesMetadata,
  uploadCaseImage,
  uploadPosterImage,
  type StagedCoverAnalysis,
  type TmdbFields,
  type TmdbMediaType,
  tagWeirdMovieMatches,
} from "@danflix/backend";
import type { SupabaseClient } from "@supabase/supabase-js";

/** A confirm write that failed and must roll the whole confirm back (see rollBackConfirmWrites). */
class ConfirmWriteError extends Error {}

/** What a confirm has written so far, so a failure can undo it (2026-10-07). */
type WriteJournalEntry =
  | { kind: "insert"; uniqueId: string; caseImagePath: string | null }
  | { kind: "overwrite"; uniqueId: string; previousRow: Record<string, unknown>; previousSheetValues: string[] };

/**
 * Undoes a failed confirm's writes, newest first: inserted rows are deleted from the database and
 * the Sheet (with the case image stored under their own new id), overwritten rows get their
 * previous database values and Sheet cells back. Best effort - returns a description of anything
 * that couldn't be undone, so the error the app shows says exactly what to check.
 * (An Overwrite's replaced case image can't be restored - it's written to the same path.)
 */
async function rollBackConfirmWrites(
  supabase: SupabaseClient,
  journal: WriteJournalEntry[],
  header: string[],
  columnIndexes: Record<string, number>
): Promise<string[]> {
  const problems: string[] = [];
  const inserted = journal.filter((j): j is Extract<WriteJournalEntry, { kind: "insert" }> => j.kind === "insert");
  for (const j of [...journal].reverse()) {
    if (j.kind !== "overwrite") continue;
    const { error } = await supabase.from("titles").update(j.previousRow).eq("unique_id", j.uniqueId);
    if (error) problems.push(`database row ${j.uniqueId} (restore: ${error.message})`);
    try {
      if (!(await restoreSheetRowByUniqueId(j.uniqueId, j.previousSheetValues, header, columnIndexes))) {
        problems.push(`Sheet row ${j.uniqueId} (not found to restore)`);
      }
    } catch (err) {
      problems.push(`Sheet row ${j.uniqueId} (restore: ${err instanceof Error ? err.message : err})`);
    }
  }
  if (inserted.length) {
    const ids = inserted.map((j) => j.uniqueId);
    try {
      // Every inserted id is tried, even ones whose append threw - a timed-out append may still have landed.
      await deleteSheetRowsByUniqueIds(ids, columnIndexes);
    } catch (err) {
      problems.push(`Sheet rows for ${ids.join(", ")} (delete: ${err instanceof Error ? err.message : err})`);
    }
    const { error } = await supabase.from("titles").delete().in("unique_id", ids);
    if (error) problems.push(`database rows ${ids.join(", ")} (delete: ${error.message})`);
    // Only images stored under one of these brand-new ids - never an existing title's image.
    const images = [...new Set(inserted.map((j) => j.caseImagePath).filter((p): p is string => !!p && ids.some((id) => p.includes(id))))];
    if (images.length) await supabase.storage.from("case-images").remove(images);
  }
  return problems;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Accepts either a bare TMDb numeric id or a pasted themoviedb.org movie/tv URL, for the
 * manual-override field ConfirmScreen shows when the automatic /find lookup comes up
 * empty (see the hard-requirement check below). A bare id (no URL) is assumed to be a movie
 * id, same as before TV scanning support existed - there's no way to tell otherwise. */
function parseTmdbIdOverride(value: string | undefined): { id: number; mediaType: TmdbMediaType } | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/(\d+)/);
  if (!match) return null;
  const id = parseInt(match[1], 10);
  if (Number.isNaN(id)) return null;
  const mediaType: TmdbMediaType = /\/tv\//.test(trimmed) ? "tv" : "movie";
  return { id, mediaType };
}

interface ConfirmEntry {
  imdbId?: string;
  barcodeId?: string;
  manualFields?: Record<string, unknown>;
  /** Per-entry (added 2026-09-20, for the Collection scanning flow) - see this route's own
   * doc comment on `overwriteUniqueId` below for the full reasoning on why this moved from a
   * single request-level field to a per-entry one. */
  overwriteUniqueId?: string;
}

/** `seriesID` is only ever present on an "episode"-Type OMDB detail (the parent show's own
 * imdbID) - checked ahead of the generic Type mapping below so a classic (1963-1989) Doctor
 * Who serial guesses "TV Series" ("a selection of TV episodes", per the user's own words)
 * rather than "TV Episode", the correct guess for an ordinary modern show's single-episode
 * disc. Deliberately scoped to just this one show's classic-era id, not a general rule for
 * every OMDB episode-Type match - see classicWhoSerials.ts's own header comment. */
function omdbTypeToMovieOrTv(type: string | undefined, seriesID: string | undefined): string {
  if (seriesID === CLASSIC_WHO_SERIES_IMDB_ID) return "TV Series";
  if (type === "series") return "TV Series";
  if (type === "episode") return "TV Episode";
  return "Movie";
}

/** Flattens and dedupes while preserving first-occurrence order - used by the collection-
 * header aggregation below for Genre/Franchise (a union of every member's own values, not an
 * intersection - a collection is worth finding under any genre/franchise any of its titles
 * belong to). */
function dedupePreserveOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const v of values) {
    if (!seen.has(v)) {
      seen.add(v);
      result.push(v);
    }
  }
  return result;
}

/** The single most frequent value in the list, or null when there's no clear single winner
 * (an empty list, or a tie for first place) - used by the collection-header aggregation below
 * for Director/Studio. A tie deliberately doesn't guess which of the tied values to prefer. */
function mostCommonValue(values: string[]): string | null {
  if (values.length === 0) return null;
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: string | null = null;
  let bestCount = 0;
  let tied = false;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
      tied = false;
    } else if (count === bestCount) {
      tied = true;
    }
  }
  return tied ? null : best;
}

// TMDb's own genre wording that needs mapping onto this collection's established vocabulary
// before merging - confirmed live (2026-09-19) this collection's existing Genre data never
// once uses "Science Fiction" (only "Sci-Fi", in various spellings), so TMDb's own label would
// otherwise sit alongside it as a second, inconsistent spelling of the same thing.
const TMDB_GENRE_ALIASES: Record<string, string> = { "Science Fiction": "Sci-Fi" };

// Not a real content genre - a leftover of TMDb's own movie-genre taxonomy (id 10770) used to
// flag a film that premiered on television rather than in theatres. This collection already
// has a dedicated movie_or_tv field for exactly that distinction, so folding it into Genre
// too would just duplicate information in the wrong column. Per the user's own idea, this
// signal is used client-side instead, to sharpen the movie_or_tv *guess* itself (still just a
// prefill, never a forced value) - see guessMovieOrTvFromType in ConfirmScreen.tsx.
const TMDB_NON_GENRE_TAGS = new Set(["TV Movie"]);

/** Merges OMDb's own (often narrower) Genre field with TMDb's genre list, added 2026-09-19
 * after the user noticed OMDb's classic Doctor Who entry was missing "Sci-Fi" entirely while
 * TMDb's own genre list for the same title has it. TMDb's compound TV tags ("Sci-Fi & Fantasy",
 * "Action & Adventure") are split on " & " - both halves already exist as plain standalone
 * genre values throughout this collection's real data, so splitting keeps the merge consistent
 * with the vocabulary already in use rather than introducing a third, combined phrasing.
 * OMDb's own genres always come first and are never altered - TMDb only ever adds whatever
 * OMDb didn't already have (case-insensitive dedup), never replaces or reorders anything. */
function mergeOmdbAndTmdbGenres(omdbGenres: string[], tmdbGenres: string[]): string[] {
  const merged = [...omdbGenres];
  const seenLower = new Set(omdbGenres.map((g) => g.toLowerCase()));
  for (const raw of tmdbGenres) {
    if (TMDB_NON_GENRE_TAGS.has(raw)) continue;
    for (const part of raw.split(" & ")) {
      const g = TMDB_GENRE_ALIASES[part] ?? part;
      const lower = g.toLowerCase();
      if (seenLower.has(lower)) continue;
      seenLower.add(lower);
      merged.push(g);
    }
  }
  return merged;
}

// The user's own dedicated Doctor Who shelf (currently Doctor Who only, nothing else) -
// ordered by real release order rather than alphabetically, same idea as the "history
// document" branch below being ordered by depicted_era_start. A single exact-match genre_
// location check, not a general franchise-detection rule, since this shelf doesn't hold
// anything else right now - if the user ever puts another TV sci-fi franchise on it too,
// this will need generalizing past a plain title-text sort for whatever isn't Doctor Who.
const WHO_SHELF_GENRE_LOCATION = "BOX TV Sci-Fi";

const TMDB_LOOKUP_CONCURRENCY = 4;

/** Promise.all over `items` with at most `limit` running at once; results keep input order. */
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

async function computeShelfLocation(
  supabase: SupabaseClient,
  genreLocation: string | null | undefined,
  newTitleName: string,
  newEraStart: number | null,
  newWhoShelfOrder: number | null,
  excludeUniqueId: string
): Promise<{ before: string | null; after: string | null }> {
  if (!genreLocation) return { before: null, after: null };

  // Excludes collection members (found live 2026-09-20, a real box set) - a member disc lives
  // inside its own box, not as an independent object on the open shelf, so it must never be
  // offered as a shelf-neighbor to anything (a standalone title, or a collection header, which
  // shares its own genre_location with every one of its own members). Without this, a new
  // collection header's own "neighbor" query could land on one of its own just-inserted
  // members, or another set's member elsewhere in the same genre_location bucket - "you can't
  // put a box set inside another box set."
  const { data: siblings } = await supabase
    .from("titles")
    .select("title, depicted_era_start, who_shelf_order")
    .eq("genre_location", genreLocation)
    .eq("title_in_a_collection", false)
    .neq("unique_id", excludeUniqueId);
  if (!siblings || siblings.length === 0) return { before: null, after: null };

  const isHistoryDoc = /history document/i.test(genreLocation);
  const isWhoShelf = genreLocation === WHO_SHELF_GENRE_LOCATION;
  const sorted = [...siblings].sort((a, b) =>
    isHistoryDoc
      ? (a.depicted_era_start ?? Infinity) - (b.depicted_era_start ?? Infinity)
      : isWhoShelf
        ? (a.who_shelf_order ?? Infinity) - (b.who_shelf_order ?? Infinity)
        : a.title.localeCompare(b.title)
  );

  let before: string | null = null;
  let after: string | null = null;
  for (const sibling of sorted) {
    const isBeforeNew = isHistoryDoc
      ? (sibling.depicted_era_start ?? Infinity) <= (newEraStart ?? Infinity)
      : isWhoShelf
        ? (sibling.who_shelf_order ?? Infinity) <= (newWhoShelfOrder ?? Infinity)
        : sibling.title.localeCompare(newTitleName) <= 0;
    if (isBeforeNew) {
      before = sibling.title;
    } else {
      after = sibling.title;
      break;
    }
  }
  return { before, after };
}

/**
 * Writes a reviewed/confirmed pending scan to Supabase + the Sheet. `entries` is usually
 * one item, but is an array to support a collection scan producing the collection entry
 * plus every checked sub-title in one request (Claude/TECH STACK AND ARCHITECTURE.md's
 * collections mechanism). The first entry's shelf-location is what's returned.
 *
 * `{ pendingScanId, dismiss: true }` (no entries) instead marks the pending scan
 * confirmed without creating anything - for the re-scan case, where the resolver already
 * found an existingMatch and there's nothing new to write.
 *
 * `{ pendingScanId, discard: true }` deletes the pending scan outright - for a stray/junk
 * read (e.g. a barcode briefly glimpsed on a neighbouring disc while lining up a shot)
 * that was never meant to be catalogued at all.
 *
 * `entry.overwriteUniqueId` (per-entry, added 2026-09-20): instead of inserting a new row for
 * THAT entry, fully replaces every field of the already-catalogued title at that unique_id
 * with this entry's data (Supabase update + a full Sheet row rewrite via
 * updateSheetFieldsByUniqueId, not appendRowToSheet). This is the "Overwrite" option
 * ConfirmScreen's pre-submit similar-entry check offers (Claude/TECH STACK AND
 * ARCHITECTURE.md's "Backfill Rescan" section) - functionally equivalent to deleting the old
 * entry and re-adding it as described, but implemented as an update-in-place so the row's
 * unique_id (and anything that already references it, e.g. a confirmed pending_scans row)
 * never has to change. Originally a single request-level field restricted to a single-entry
 * submission; moved to be per-entry so a Collection scan (Claude/TECH STACK AND
 * ARCHITECTURE/barcode-scanning-pipeline.md) can submit a mix of fresh-insert entries (a
 * genuinely new member, or the collection header itself) and overwrite entries (a member
 * that matched an already-catalogued row via the collection-scoped similar-entry check) in
 * one request - the write loop below already processed this per-iteration even before this
 * change, so only the field's origin (per-entry vs. request-level) actually moved.
 */
export async function POST(request: Request) {
  const authError = requireScanSecret(request);
  if (authError) return authError;

  const body = await request.json().catch(() => null);
  const pendingScanId = typeof body?.pendingScanId === "string" ? body.pendingScanId : null;
  if (!pendingScanId) {
    return NextResponse.json({ error: "pendingScanId is required" }, { status: 400 });
  }

  const supabase = getSupabaseServerClient();

  // Read once, up front, purely for the scan log below - every other branch already gets its
  // own data from `entries` (ConfirmScreen resolves everything client-side), so this row is
  // otherwise unused here. Read before discard/dismiss touch the row, since discard deletes it
  // outright. A read failure just means a null snapshot in the log, never blocks the real work.
  const { data: pendingScanRow } = await supabase
    .from("pending_scans")
    .select("barcode, status, resolved_candidates, staged_cover_photos")
    .eq("id", pendingScanId)
    .maybeSingle();
  const stagedCoverPaths: string[] = (pendingScanRow?.staged_cover_photos as string[] | null) ?? [];
  const coverAnalysis: StagedCoverAnalysis[] =
    (pendingScanRow?.resolved_candidates as { coverAnalysis?: StagedCoverAnalysis[] } | null)?.coverAnalysis ?? [];

  if (body?.discard === true) {
    await supabase.from("pending_scans").delete().eq("id", pendingScanId);
    // A stray/junk read was never meant to be catalogued - every staged cover photo captured
    // alongside it (front, back, or both) is cleaned up too, not just the barcode.
    await deleteStagedCoverPhotos(supabase, stagedCoverPaths);
    logScanEvent({
      outcome: "discarded",
      pendingScanId,
      barcode: pendingScanRow?.barcode ?? null,
      resolvedCandidates: pendingScanRow?.resolved_candidates ?? null,
    });
    return NextResponse.json({ success: true, createdTitleIds: [], shelfLocation: null });
  }

  if (body?.dismiss === true) {
    // Re-scan case: the resolver already found this exact disc already catalogued
    // (existingMatch) and there's nothing new to write - but a fresh cover photo may still
    // have been captured in the same session (any combination of barcode/front/back is valid).
    // Per decision 8 (Claude/TECH STACK AND ARCHITECTURE/barcode-scanning-pipeline.md), that
    // photo updates the already-catalogued title's stored product image rather than being
    // discarded outright - `existingMatchTitleId` is the client's own already-resolved
    // existingMatch.unique_id (ConfirmScreen holds it client-side already), since this route
    // has no barcode_id-based way to look the row back up here without it.
    const existingMatchTitleId = typeof body?.existingMatchTitleId === "string" ? body.existingMatchTitleId : null;
    const frontCoverPath = pickFrontCoverPath(coverAnalysis);
    if (existingMatchTitleId && frontCoverPath) {
      const promotedPath = await promoteStagedCoverToCaseImage(supabase, frontCoverPath, existingMatchTitleId);
      if (promotedPath) {
        await supabase.from("titles").update({ case_image_path: promotedPath }).eq("unique_id", existingMatchTitleId);
      }
    }
    // A re-scan still counts as scanned - the website only lists scanned rows (migration 0046).
    if (existingMatchTitleId) {
      await supabase.from("titles").update({ scanned: true }).eq("unique_id", existingMatchTitleId);
    }
    await deleteStagedCoverPhotos(supabase, stagedCoverPaths);
    // A fresh photo of an existing entry shows on its pages straight away.
    if (existingMatchTitleId) refreshWebsiteCaches();

    await supabase.from("pending_scans").update({ status: "confirmed" }).eq("id", pendingScanId);
    logScanEvent({
      outcome: "dismissed",
      pendingScanId,
      barcode: pendingScanRow?.barcode ?? null,
      resolvedCandidates: pendingScanRow?.resolved_candidates ?? null,
    });
    return NextResponse.json({ success: true, createdTitleIds: [], shelfLocation: null });
  }

  const entries: ConfirmEntry[] = Array.isArray(body?.entries) ? body.entries : [];
  if (entries.length === 0) {
    return NextResponse.json({ error: "entries is required unless dismiss is true" }, { status: 400 });
  }
  // A scan that's already been saved is never saved a second time (2026-10-07). Nothing used
  // to stop it - a retry after a dropped response the server had in fact finished, or the
  // app's offline queue resubmitting an item, inserted the title(s) all over again.
  if (pendingScanRow?.status === "confirmed") {
    return NextResponse.json({ error: "This scan has already been saved to your collection." }, { status: 409 });
  }
  const { header } = await getSheetHeaderAndColumns();
  const columnIndexes = buildColumnIndexes(header);

  // NOTE (revised 2026-09-20): this used to force manual Rating/Studio/Original Language to
  // undefined whenever `entries.length > 1`, back when a multi-title submission shared one
  // `manualFields` object verbatim across every entry - a real box-set cover only shows one
  // rating for the whole collection, not necessarily any single film's own, so a shared value
  // couldn't safely apply to every member. Now that the Collection flow builds distinct
  // `manualFields` per entry (ConfirmScreen.tsx's `performCreateCollection`), that blanket
  // guard would incorrectly suppress the collection HEADER's own genuine manual Rating/
  // Distributor fields too - removed; each entry's own manual value is honored exactly like
  // the single-title path always has. Members still never send one at all (TitleSearchPicker
  // has no such fields - each resolves its own from TMDb, unchanged).

  // Resolved fully before any writes happen, not inline in the write loop below - the
  // hard-requirement check right after this must never leave an earlier entry in a
  // multi-title collection already written to Supabase/the Sheet while a later one fails.
  // Genuinely per-film data (an NZ/Oceania certification, the primary production company,
  // now also the canonical TMDb id itself), so this runs for every entry unconditionally;
  // it's exactly what solves the collection-member case where there's no single physical
  // case to read a rating off. See packages/backend/src/tmdb.ts for why this needed TMDb
  // rather than IMDb.
  //
  // Looked up a few entries at a time rather than strictly one after another (2026-10-07,
  // efficiency pass): each entry is 2-3 sequential TMDb round-trips that don't depend on any
  // other entry, so a 9-title box set spent ~20 back-to-back requests here before anything was
  // written. Capped at TMDB_LOOKUP_CONCURRENCY so a big set can't burst into TMDb's own rate
  // limit - a 429 there reads as "no match" (tmdbFetch returns null) and would save the entry
  // without its TMDb id. Results keep entry order.
  const resolvedTmdb: TmdbFields[] = await mapWithConcurrency(entries, TMDB_LOOKUP_CONCURRENCY, async (entry) => {
    const manual = entry.manualFields ?? {};
    let fields: TmdbFields = entry.imdbId
      ? await lookupTmdbFields(entry.imdbId)
      : { tmdbId: null, tmdbMediaType: null, rating: null, studio: null, isAnimated: null, originalLanguage: null, genres: [] };

    // TMDb's own /find-by-imdb-id lookup sometimes has nothing (a genuinely obscure title,
    // or an IMDb id TMDb hasn't indexed yet) - the manual override field ConfirmScreen
    // shows in that case lets the user paste a TMDb link/id themselves rather than being
    // stuck. Still worth a real detail fetch so rating/studio/isAnimated get populated too,
    // not just the bare id.
    const override = parseTmdbIdOverride(asString(manual.tmdb_id_override));
    if (fields.tmdbId == null && override != null) {
      const overrideDetails = await fetchTmdbFieldsById(override.id, override.mediaType);
      fields = { tmdbId: override.id, tmdbMediaType: override.mediaType, ...overrideDetails };
    }

    // No longer a hard requirement (2026-10-03, per the user's own instruction): an entry
    // whose candidate TMDb has no match for is saved without a TMDb id rather than rejected -
    // that's almost always a thin, weak IMDb entry, effectively a manual entry, and the user
    // can't realistically find a TMDb page the lookup itself couldn't. Previously a 400 here
    // (the original "Backfill Rescan" rule that every candidate-backed entry needs a TMDb id).
    return fields;
  });

  const createdIds: string[] = [];
  let primaryShelfLocation: { before: string | null; after: string | null } | null = null;

  // Every entry's own row is fully built (but not yet written) before any collection-header
  // aggregation or actual writes happen - added 2026-09-20 so the header's own genre/
  // franchise/director/studio/special_features/disc_count/personal_rating/last_watched_date
  // can be computed from its own members' final resolved values (see the aggregation step
  // right after this loop). `existingPersonalRating`/`existingLastWatchedDate` are carried
  // alongside `title` rather than inside it, since those two columns are deliberately never
  // part of an ordinary entry's own write payload (see the watched/watched_disc Overwrite-
  // protection comment below) - they only ever matter for the header's own aggregation.
  interface BuiltEntry {
    entry: ConfirmEntry;
    title: Record<string, unknown>;
    existingPersonalRating: number | null;
    existingLastWatchedDate: string | null;
  }
  const built: BuiltEntry[] = [];
  // A Collection scan submits every member with the *same* case_image_url (the box's own
  // listing photo, inherited from the header - individual titles in a box set have no cover
  // photo of their own to scan). Without this cache, the loop below would independently
  // re-fetch and re-upload that identical external image once per member, leaving N
  // byte-for-byte duplicate files in Storage for one box set (confirmed live, 2026-09-29 -
  // Universal Classic Monsters' 9 members and header all shared one identical eTag). Keyed by
  // source URL, scoped to just this one confirm request/loop - reused across entries only
  // when they genuinely share the same source image, never across unrelated scans.
  const uploadedCaseImagePathByUrl = new Map<string, string | null>();
  // Front-cover promotion (decision 4) - see the case-image step in the loop below.
  const frontCoverPath = pickFrontCoverPath(coverAnalysis);
  // OMDb records fetched below, reused for title_metadata's scores so the metadata refresh at
  // the end doesn't spend a second OMDb request on the same film.
  const omdbDetailById = new Map<string, NonNullable<Awaited<ReturnType<typeof omdbGetById>>>>();

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const manual = entry.manualFields ?? {};
    const tmdbFields = resolvedTmdb[i];

    let omdbFields: Record<string, unknown> = {};
    let synopsis: string | null = null;
    // Only ever set for a classic (1963-1989) Doctor Who serial - see computeShelfLocation's
    // own "BOX TV Sci-Fi" branch below and 0041_add_who_shelf_order.sql.
    let whoShelfOrder: number | null = null;
    if (entry.imdbId) {
      const detail = await omdbGetById(entry.imdbId);
      if (detail) {
        omdbDetailById.set(entry.imdbId, detail);
        synopsis = detail.Plot;

        // Only set for a genuine classic-serial match (entry.imdbId is one of that serial's
        // own episode ids in classic_who_serial_index) - null for a whole-season box set,
        // which was never indexed by individual episode id at all, so this naturally never
        // fires for one. Reused below for the release_date carve-out.
        let classicWhoSerialMatch: Awaited<ReturnType<typeof lookupClassicWhoSerialByImdbId>> = null;
        if (detail.seriesID === CLASSIC_WHO_SERIES_IMDB_ID) {
          classicWhoSerialMatch = await lookupClassicWhoSerialByImdbId(supabase, entry.imdbId);
          if (classicWhoSerialMatch) {
            whoShelfOrder = classicWhoSerialMatch.season * 1000 + classicWhoSerialMatch.storyOrderInSeason;
          }
        }

        // An "episode"-Type OMDb match is this project's classic-serial convention (one row
        // per serial, e.g. a Doctor Who story) - but release_date/imdb_page must always
        // reflect the *show* itself, never one specific serial (see barcode-review-screen-
        // fields.md's TV Scanning section, "Release date for TV"/"IMDb page for TV").
        // Resolved via OMDb's own seriesID field on the episode detail response.
        let showLevelDetail = detail;
        if (detail.Type === "episode" && detail.seriesID) {
          const seriesDetail = await omdbGetById(detail.seriesID);
          if (seriesDetail) {
            showLevelDetail = seriesDetail;
            omdbDetailById.set(detail.seriesID, seriesDetail);
          }
        }

        // Director vs. Creator/Head-Writer (same section, "Director vs. Creator/Head-
        // Writer"): a "series"-Type match is a whole-season/show-level confirmation, where
        // OMDb's own Director field is usually blank or just names the pilot's director -
        // Writer is the closer real-world equivalent of the show's creator/head-writer. An
        // "episode"-Type match (a specific classic serial) keeps using Director exactly as
        // it always has, since that field is genuinely meaningful there.
        const creatorOrDirectorText = detail.Type === "series" ? detail.Writer : detail.Director;

        // Running Time for TV (RESOURCES.md, "Running Time for TV"): a TV Series is
        // off-by-default (case-by-case only, via a manual override the confirm form doesn't
        // yet expose for a matched candidate) - a whole ongoing show has no single runtime.
        // Every other category (TV Movie/TV Special/TV Episode/TV Mini-Series/Serial, and
        // plain Movie) always keeps OMDb's own Runtime. The user's own movie_or_tv choice on
        // the confirm screen wins when given (e.g. reclassifying an "episode"-Type OMDb match
        // to "Serial"), falling back to OMDb's Type-based guess otherwise - same precedence
        // the final `title.movie_or_tv` below resolves with.
        const resolvedMovieOrTv = asString(manual.movie_or_tv) || omdbTypeToMovieOrTv(detail.Type, detail.seriesID);

        omdbFields = {
          title: detail.Title,
          movie_or_tv: omdbTypeToMovieOrTv(detail.Type, detail.seriesID),
          // Deliberate carve-out from the "release_date reflects the show, not one specific
          // serial" rule above, per the user's own explicit instruction (2026-10-01) - scoped
          // to an individual classic serial ONLY, never a whole-season box set (which
          // `classicWhoSerialMatch` is always null for, so falls straight through to the
          // general showLevelDetail rule unchanged). `detail.Released` here is the confirmed
          // candidate's own OMDb detail (the serial's own first episode, e.g. "14 Jan 1967"
          // for The Underwater Menace), fetched moments ago - before `showLevelDetail` above
          // replaced it with the whole show's own 1963 series premiere date.
          release_date: parseOmdbReleaseDate(
            classicWhoSerialMatch ? detail.Released : showLevelDetail.Released
          ),
          running_time_mins: resolvedMovieOrTv === "TV Series" ? null : parseOmdbRuntimeMins(detail.Runtime),
          genre: mergeOmdbAndTmdbGenres(
            detail.Genre?.split(",").map((g) => g.trim()).filter(Boolean) ?? [],
            tmdbFields.genres
          ),
          director: creatorOrDirectorText?.split(",").map((d) => d.trim()).filter(Boolean) ?? [],
          rating: detail.Rated !== "N/A" ? detail.Rated : null,
          imdb_page: `https://www.imdb.com/title/${showLevelDetail.imdbID}/`,
          // Reuses this same OMDB detail response already fetched above - no extra API call.
          // Feeds movie_poster_path below (0036_add_movie_poster_path.sql).
          posterUrl: detail.Poster && detail.Poster !== "N/A" ? detail.Poster : null,
        };

        // Only bother looking Rotten Tomatoes up at all once OMDB's own Ratings array has
        // already confirmed a critics score exists - skips the fetch entirely for titles
        // with none, and never overrides a link the user already typed in themselves.
        if (!asString(manual.rotten_tomatoes_page)) {
          const rtRating = detail.Ratings?.find((r) => r.Source === "Rotten Tomatoes");
          const percent = rtRating ? parseInt(rtRating.Value, 10) : NaN;
          if (!Number.isNaN(percent)) {
            omdbFields.rotten_tomatoes_page = await lookupRottenTomatoesPage(detail.Title, percent);
          }
        }
      }
    }

    // Normalizes scanner-entered free text so random capitalization/spacing never creates
    // a near-duplicate of a category the collection already uses. `format` has a small
    // fixed set of legitimate spellings (normalizeFormat's FORMAT_ALIASES); Genre Location
    // is genuinely open-ended, so canonicalizeValue resolves against whatever's already in
    // `titles` instead. Title/Release Name only get whitespace tidied, never case-folded -
    // they're proper nouns/verbatim text where casing matters. Disk Region needs none of
    // this - ConfirmScreen's MultiSelectChips only ever sends a comma-joined string built
    // from a small fixed set of codes, never free-typed text.
    const cleanGenreLocation = await canonicalizeValue(
      supabase,
      "genre_location",
      cleanFreeText(asString(manual.genre_location))
    );
    // Franchise is now a multi-value list (0020_merge_franchise_columns.sql, merged with
    // the former sub_franchise column) - the client already sends it comma-split/trimmed,
    // same as genre/director, so it's trusted as-is here rather than run through
    // canonicalizeValue's single-value ilike dedup (which doesn't apply cleanly to an array
    // column). A near-duplicate casing across two individual franchise entries (e.g.
    // "casper" vs "Casper") is a cosmetic gap left for a future backfill pass, same as the
    // Format-casing drift found and fixed once already - not a correctness issue.
    const cleanFranchise: string[] = normalizeFranchiseList(Array.isArray(manual.franchise) ? manual.franchise : []);

    // Priority: a manual entry (the physical case, or a single-title scan) always wins
    // when given; otherwise TMDb's per-title lookup above; otherwise whatever OMDB itself
    // had (rating only - OMDB's own Production field proved unreliable, confirmed live
    // against a real title, so it's not chained in for studio at all). *_is_manual records
    // which branch actually won, so refreshTmdbFields (packages/backend/src/tmdb.ts) knows
    // never to touch a value that came from a human rather than TMDb.
    const manualRating = normalizeRating(asString(manual.rating));
    const manualStudio = cleanFreeText(asString(manual.studio));
    const manualOriginalLanguage = cleanFreeText(asString(manual.original_language));
    // omdbFields.rating (OMDB's own `Rated` field) was never passed through normalizeRating at
    // all until now (found live 2026-09-20 via 4 real rows stuck with the literal US
    // pre-1968-classification value "Approved") - RATING_ALIASES' NZ-scheme entries are a no-op
    // on an already-valid NZ code, so this is a strict fix, not a behavior change for the
    // common case.
    // Only a real NZ code is trusted from OMDB (same gate TMDb's NZ slot already has): "Not Rated",
    // "Passed", "Unrated", "TV-14", "PG-13", "R" ... are US classifications, not this collection's
    // scheme, so they're treated as "no answer" and reveal the manual Rating field instead.
    const omdbRating = normalizeRating(asString(omdbFields.rating));
    const finalRating = manualRating ?? tmdbFields.rating ?? (isValidNzRating(omdbRating) ? omdbRating : null);
    const finalStudio = normalizeStudio(manualStudio ?? tmdbFields.studio ?? undefined);
    const finalOriginalLanguage = manualOriginalLanguage ?? tmdbFields.originalLanguage ?? null;

    const uniqueId = entry.overwriteUniqueId ?? randomUUID();
    // Overwrite protection for watched/watched_disc (added 2026-09-20, per the user's own
    // explicit request, applied to every Overwrite - not just Collection scans): `watched`/
    // `watched_disc` are two columns that can already carry real, independently-recorded
    // viewing history and are ALSO explicitly sent on every ordinary scan submission (unlike
    // personal_rating/last_watched_date, which are never part of this route's own `title`
    // object at all, and so were never actually at risk here - Supabase's `.update()` only
    // touches keys present in the payload). Because watched/watched_disc genuinely are sent
    // every time, an Overwrite whose own manualFields don't happen to have them checked would
    // otherwise silently blank out real viewing history - confirmed as a real, currently-live
    // gap by reading this code directly, not just suspected. Fixed by ORing the incoming value
    // with whatever the existing row already has: an Overwrite can only ever ADD watched
    // status, never remove it - matching the user's own words, "that data takes priority."
    let existingWatched = false;
    let existingWatchedDisc = false;
    // personal_rating/last_watched_date are never part of any entry's own write payload
    // (confirmed below - Supabase's `.update()` only touches keys actually present, so these
    // two have always been implicitly safe from Overwrite) - fetched here anyway, alongside
    // watched/watched_disc, purely so the collection-header aggregation step after this loop
    // can read a fresh-Overwrite member's own already-recorded values (a plain new insert
    // has neither yet, which is exactly why they stay null below in that case).
    let existingPersonalRating: number | null = null;
    let existingLastWatchedDate: string | null = null;
    let existingMoviePosterPath: string | null = null;
    if (entry.overwriteUniqueId) {
      const { data: existingWatchedRow } = await supabase
        .from("titles")
        .select("watched, watched_disc, personal_rating, last_watched_date, movie_poster_path")
        .eq("unique_id", entry.overwriteUniqueId)
        .maybeSingle();
      existingWatched = existingWatchedRow?.watched === true;
      existingWatchedDisc = existingWatchedRow?.watched_disc === true;
      existingPersonalRating = existingWatchedRow?.personal_rating ?? null;
      existingLastWatchedDate = existingWatchedRow?.last_watched_date ?? null;
      existingMoviePosterPath = existingWatchedRow?.movie_poster_path ?? null;
    }
    // Caches this film's official OMDB poster into Storage (0036_add_movie_poster_path.sql) -
    // added 2026-09-25 per the user's own request for every confirmed title to end up with
    // both a case photo and a poster on file, so the app never has to re-fetch one from OMDB
    // later (e.g. the scan resolver's "best match" step on a rescan). Unlike case_image_path
    // just below, this is skipped once already cached rather than always refreshed - a film's
    // official poster doesn't change the way a user's own physical case photo can (a
    // different edition/printing). Same "a cache miss is fine, a bad write isn't" convention:
    // never included in `title` below when there's nothing to cache or the upload fails.
    const moviePosterPath =
      !existingMoviePosterPath && omdbFields.posterUrl
        ? await uploadPosterImage(supabase, `titles/${uniqueId}/poster.jpg`, omdbFields.posterUrl as string)
        : null;
    // Caches the barcode listing's own product photo into Storage for the future web app's
    // DVD Pages (0026_add_case_image_path.sql) - unconditional on every confirm (including an
    // Overwrite), since a fresh photo of the user's actual physical copy is always
    // authoritative over whatever was there before. Deliberately NOT included in `title` below
    // when the upload fails (transient fetch/network error) rather than writing `null` - an
    // Overwrite must never silently erase a previously-good case image just because this one
    // re-fetch attempt didn't work.
    //
    // Reuses an already-uploaded path for the same source URL (uploadedCaseImagePathByUrl,
    // declared above the loop) instead of re-uploading - every member of a Collection scan
    // submits the identical case_image_url (the box's own listing photo, since individual
    // titles in a box set have no cover photo of their own), so without this a 9-member box
    // set left 9 byte-for-byte duplicate files in Storage, one per member's own uuid folder.
    // The first entry to use a given URL still gets its own `titles/{uniqueId}/case.jpg`
    // upload as before; every later entry sharing that same URL points at that same stored
    // path instead - a deliberate, documented exception to the usual "own uuid, own folder"
    // convention, specifically for this shared-cover case.
    //
    // Front-cover promotion (decision 4) - once per session, not per entry, since a multi-title
    // collection submission still has just one set of staged photos for the one physical case
    // that was actually photographed. Targets the first entry (a collection scan's own header,
    // or the single title on an ordinary scan), the same row computeShelfLocation below treats
    // as this session's primary. A captured front cover always wins over the barcode listing's
    // own product photo; with no usable staged cover (no front-classified photo, and more than
    // one ambiguous "unclear" candidate - see pickFrontCoverPath's own comment for why that's
    // left alone rather than guessed), or if promoting it fails, the listing photo is used.
    //
    // Done here, BEFORE the listing photo's upload rather than after every row was written
    // (2026-10-07, efficiency pass): it used to upload the listing photo to this same
    // `titles/{id}/case.jpg` path first - an image download, two Jimp passes and a Gemini
    // bounding-box request (uploadCaseImage) - only for the cover photo to overwrite it moments
    // later, plus a separate `titles` update to point at it. Collection members sharing the
    // listing URL reuse the promoted path exactly as they reused the overwritten one before.
    const caseImageUrl = asString(manual.case_image_url);
    let caseImagePath: string | null = null;
    if (i === 0 && frontCoverPath) {
      caseImagePath = await promoteStagedCoverToCaseImage(supabase, frontCoverPath, uniqueId);
      if (caseImagePath && caseImageUrl) uploadedCaseImagePathByUrl.set(caseImageUrl, caseImagePath);
    }
    if (caseImageUrl && !caseImagePath) {
      if (uploadedCaseImagePathByUrl.has(caseImageUrl)) {
        caseImagePath = uploadedCaseImagePathByUrl.get(caseImageUrl)!;
      } else {
        caseImagePath = await uploadCaseImage(supabase, `titles/${uniqueId}/case.jpg`, caseImageUrl);
        uploadedCaseImagePathByUrl.set(caseImageUrl, caseImagePath);
      }
    }
    // A specific CUT of the film ("the Final Cut," "Director's Cut," ...), detected
    // client-side from the barcode's own listing text (packages/shared/src/titleParsing.ts's
    // splitCutVariantTitle) - added 2026-09-18 per the user's explicit instruction: a cut
    // belongs appended to the catalogued title itself, unlike a packaging/marketing special
    // edition (which stays in release_name only, never touches title). Applied regardless of
    // whether the base name came from a real OMDB/TMDb match or a fully-manual entry.
    const baseTitle = cleanFreeText(asString(manual.title)) ?? omdbFields.title ?? "Unknown Title";
    const cutSuffix = cleanFreeText(asString(manual.cut_suffix));
    const title: Record<string, unknown> = {
      unique_id: uniqueId,
      title: cutSuffix ? `${baseTitle}: ${cutSuffix}` : baseTitle,
      movie_or_tv: manual.movie_or_tv ?? omdbFields.movie_or_tv ?? "Movie",
      season_no: manual.season_no ?? null,
      part_of_season_no: manual.part_of_season_no ?? null,
      episode_count: manual.episode_count ?? null,
      release_date: manual.release_date ?? omdbFields.release_date ?? null,
      running_time_mins: manual.running_time_mins ?? omdbFields.running_time_mins ?? null,
      // "Animation" is a medium, not a genre - stripped here and captured in animation_or_live_action.
      genre: removeNonGenreTags((manual.genre ?? omdbFields.genre ?? []) as string[]),
      director: manual.director ?? omdbFields.director ?? [],
      franchise: cleanFranchise,
      rating: finalRating,
      rating_is_manual: manualRating != null,
      format: normalizeFormat(asString(manual.format)) ?? "DVD",
      disc_count: manual.disc_count ?? 1,
      steelbook: manual.steelbook ?? false,
      special_features: manual.special_features ?? false,
      special_features_disc_count: manual.special_features_disc_count ?? null,
      special_features_disc_format: normalizeFormat(asString(manual.special_features_disc_format)),
      // Which of the set's own numbered discs actually hold the special features (0031) -
      // added 2026-09-23, per the user's own correction that a title's bonus features don't
      // always live on a separate, uncounted disc: they can be on the title's own movie disc,
      // or a disc shared with other titles' bonus features. Free text/comma list, same shape
      // as disc_number_in_set below, for the same reason (can hold more than one disc number).
      special_features_disc_number_in_set: cleanFreeText(asString(manual.special_features_disc_number_in_set)),
      animation_or_live_action:
        normalizeAnimationOrLiveAction(asString(manual.animation_or_live_action)) ??
        // No style was given (a collection member, or a scan where it wasn't asked): trust TMDb's
        // own animated flag / the "Animation" genre tag rather than defaulting a cartoon to Live Action
        // (found live: both Spider-Verse films saved as Live Action).
        (tmdbFields.isAnimated === true ||
        ((manual.genre ?? omdbFields.genre ?? []) as string[]).some((g) => /^animation$/i.test(g.trim()))
          ? "Animation"
          : "Live Action"),
      documentary:
        normalizeDocumentary(asString(manual.documentary)) ??
        deriveDocumentaryValue(
          (manual.genre ?? omdbFields.genre ?? []) as string[],
          (manual.movie_or_tv ?? omdbFields.movie_or_tv ?? "Movie") as string
        ),
      is_collection: manual.is_collection ?? false,
      name_of_collection: manual.name_of_collection ?? null,
      title_in_a_collection: manual.title_in_a_collection ?? false,
      number_of_titles_in_collection: manual.number_of_titles_in_collection ?? null,
      rotten_tomatoes_page: manual.rotten_tomatoes_page ?? omdbFields.rotten_tomatoes_page ?? null,
      imdb_page: manual.imdb_page ?? omdbFields.imdb_page ?? null,
      studio: finalStudio,
      studio_is_manual: manualStudio != null,
      tmdb_id: tmdbFields.tmdbId,
      // 0028_add_tmdb_media_type.sql - which TMDb endpoint ("movie" vs "tv") this id lives
      // under, so refreshTmdbFields (packages/backend/src/tmdb.ts) knows how to re-fetch it
      // later without re-deriving it from movie_or_tv (which can drift after the fact).
      tmdb_media_type: tmdbFields.tmdbMediaType,
      tmdb_synced_at: tmdbFields.tmdbId != null ? new Date().toISOString() : null,
      // Clean lookup key, added ahead of the backfill rescan so every future metadata
      // feature can be keyed off it without re-touching the physical disc - see the
      // hard-requirement check above. No separate imdb_id column any more
      // (0019_drop_imdb_id.sql) - imdb_page above already carries entry.imdbId embedded in
      // it; extractImdbIdFromPage recovers it when needed.
      tmdb_page:
        tmdbFields.tmdbId != null
          ? `https://www.themoviedb.org/${tmdbFields.tmdbMediaType ?? "movie"}/${tmdbFields.tmdbId}`
          : null,
      disk_region: cleanFreeText(asString(manual.disk_region)),
      barcode_id: entry.barcodeId ?? null,
      case_image_url: manual.case_image_url ?? null,
      ...(caseImagePath ? { case_image_path: caseImagePath } : {}),
      ...(moviePosterPath ? { movie_poster_path: moviePosterPath } : {}),
      genre_location: cleanGenreLocation,
      release_name: cleanFreeText(asString(manual.release_name)),
      disc_number_in_set: cleanFreeText(asString(manual.disc_number_in_set)),
      depicted_era_start:
        manual.depicted_era_start ??
        inferDepictedEraStart(String(manual.title ?? omdbFields.title ?? ""), synopsis),
      who_shelf_order: whoShelfOrder,
      depicted_era_label: cleanFreeText(asString(manual.depicted_era_label)),
      disc_condition: normalizeDiscCondition(asString(manual.disc_condition)),
      case_notes: cleanFreeText(asString(manual.case_notes)),
      release_variant_note: cleanFreeText(asString(manual.release_variant_note)),
      // Seen this film at all, on any format/copy - distinct from `watched_disc` below (this
      // specific disc). Both default false and are otherwise only ever set by the one-time
      // watch-history import or manually here, for prior viewings the user remembers but
      // that import can't discover on its own (see 0013_add_watched_title.sql,
      // 0018_rename_watched_title_to_watched_disc.sql).
      watched: manual.watched === true || existingWatched,
      watched_disc: manual.watched_disc === true || existingWatchedDisc,
      // Auto-filled from TMDb, manual entry as a fallback when there's no TMDb match at all
      // (0023_add_original_language_is_manual.sql) - see manualOriginalLanguage/
      // finalOriginalLanguage above. Manual text is normalized the same way title/
      // release_name are (whitespace tidied, never case-folded - a language name is
      // effectively a proper noun).
      original_language: finalOriginalLanguage,
      original_language_is_manual: manualOriginalLanguage != null,
      // Rental tracking (0021_add_rental_and_language_fields.sql) - ConfirmScreen already
      // clears rented_by_who/date_rented client-side whenever is_currently_rented_out is
      // unticked, same precedent as the Special Features Disc Count/Format fields, so
      // there's no extra guard needed here. `personal_rating`/`last_watched_date` are
      // deliberately NOT handled here at all for an ordinary entry - `personal_rating` is
      // only ever populated by the one-time star-rating import script, never asked for on
      // this screen. Both are still genuinely safe from Overwrite: since neither key is ever
      // present in this payload, Supabase's `.update()` leaves whatever the existing row
      // already had untouched (an omitted key is not the same as writing null) - the
      // collection-header aggregation step below is the one place either ever gets set, and
      // only on the header's own row.
      is_currently_rented_out: manual.is_currently_rented_out === true,
      rented_by_who: cleanFreeText(asString(manual.rented_by_who)),
      date_rented: (manual.date_rented as string | null | undefined) ?? null,
    };

    built.push({ entry, title, existingPersonalRating, existingLastWatchedDate });
  }

  // Collection header aggregation (added 2026-09-20, per the user's own explicit spec) - runs
  // once every entry's own fields are fully resolved above, so it can read each member's real
  // final genre/franchise/director/studio/special_features/disc_count/watched status rather
  // than re-deriving any of it independently. Only touches the header's own `title` object,
  // and only when the submission actually contains member rows to aggregate from (a lone
  // header with zero members can't happen today - ConfirmScreen requires at least two titles
  // - but the check is here defensively rather than assumed).
  const headerBuilt = built.find((b) => b.title.is_collection === true);
  if (headerBuilt) {
    const memberBuilts = built.filter((b) => b !== headerBuilt && b.title.title_in_a_collection === true);
    if (memberBuilts.length > 0) {
      // Franchise (#4) and Genre (#5): every distinct value across every member, union not
      // intersection - a collection is worth finding under any genre/franchise any of its
      // titles belong to, not just ones common to all of them.
      headerBuilt.title.genre = dedupePreserveOrder(memberBuilts.flatMap((b) => (b.title.genre as string[]) ?? []));
      headerBuilt.title.franchise = dedupePreserveOrder(
        memberBuilts.flatMap((b) => (b.title.franchise as string[]) ?? [])
      );

      // Director (#6): the single most-common director across every member (ties or no
      // repeated value at all -> left empty, no confident single answer).
      const commonDirector = mostCommonValue(memberBuilts.flatMap((b) => (b.title.director as string[]) ?? []));
      headerBuilt.title.director = commonDirector ? [commonDirector] : [];

      // Studio (#9/#15): most common among members first, else the header's own manual
      // "distributor" field (the box's own publisher, e.g. Universal - a real, different
      // concept from any single film's own original production company, which is what
      // "most common among members" actually measures), else "n/a" - confirmed directly
      // with the user as this exact priority order.
      const commonStudio = mostCommonValue(
        memberBuilts.map((b) => b.title.studio as string | null).filter((s): s is string => Boolean(s))
      );
      const manualDistributor = cleanFreeText(asString((headerBuilt.entry.manualFields ?? {}).studio));
      headerBuilt.title.studio = commonStudio ?? manualDistributor ?? "n/a";
      headerBuilt.title.studio_is_manual = commonStudio == null && manualDistributor != null;

      // Original Language: unanimous, not "most common" - per the user's own exact framing, a
      // box set where every member is the same language (overwhelmingly the common case - most
      // real collections are all-English) should show that language on the header too; "n/a"
      // is reserved for the rare case where the set genuinely mixes languages, not used as a
      // tie-break the way Director's "most common" is.
      const memberLanguages = memberBuilts.map((b) => b.title.original_language as string | null);
      const firstLanguage = memberLanguages[0];
      const allSameLanguage = firstLanguage != null && memberLanguages.every((l) => l === firstLanguage);
      headerBuilt.title.original_language = allSameLanguage ? firstLanguage : "n/a";

      // Special Features (#8): true the moment ANY member has its own special features disc
      // - the collection's own toggle (already resolved above, describing a bonus disc
      // belonging to the set as a whole) only ever adds to this, never overrides it back to
      // false. Its own disc count/format are left exactly as the header form set them - a
      // per-title bonus disc is NOT the collection's own, per the user's explicit distinction.
      // Animation or Live Action: an explicit value typed on the collection form wins; otherwise the
      // members' own detected values - unanimous keeps that value, a mix of animated and live action
      // titles becomes the existing "Live Action/Animation Hybrid" value.
      if (normalizeAnimationOrLiveAction(asString((headerBuilt.entry.manualFields ?? {}).animation_or_live_action)) == null) {
        const memberStyles = memberBuilts.map((b) => b.title.animation_or_live_action as string);
        const allSame = memberStyles.length > 0 && memberStyles.every((v) => v === memberStyles[0]);
        headerBuilt.title.animation_or_live_action = allSame
          ? memberStyles[0]
          : memberStyles.length === 0
            // Last resort only (added 2026-09-30, per the user's explicit request) - every
            // real member always resolves to a concrete value (never null, see the per-title
            // default above), so this only fires if a collection were somehow submitted with
            // no members at all.
            ? "n/a"
            : memberStyles.some((v) => v !== "Live Action")
              ? "Live Action/Animation Hybrid"
              : "Live Action";
      }
      const anyMemberSpecialFeatures = memberBuilts.some((b) => b.title.special_features === true);
      headerBuilt.title.special_features = headerBuilt.title.special_features === true || anyMemberSpecialFeatures;

      // Disc Count is deliberately NOT aggregated here any more (removed 2026-09-20). It used to
      // be recomputed server-side as a naive sum of every member's own disc_count, which
      // silently overwrote whatever the app had correctly computed client-side and double-
      // counted a disc two titles share (found live: a real 2-disc box set, two titles per
      // disc, saved with disc_count 4). The header's disc_count is now a plain manual field the
      // user types once on the Collection header form (the true total of every physical disc in
      // the box, bonus disc included) - it flows through from manualFields untouched, exactly
      // like the header's own Rating already does.

      // Personal Rating (#11): the average of every member's own, but ONLY when every single
      // member is both watched and has a real personal_rating already - a partial set (some
      // members unwatched/unrated) doesn't produce a meaningful average, so the header's own
      // personal_rating is simply left unset in that case rather than averaging a subset.
      const memberRatingsIfAllWatchedAndRated = memberBuilts.map((b) =>
        b.title.watched === true ? b.existingPersonalRating : null
      );
      if (memberRatingsIfAllWatchedAndRated.every((r): r is number => r != null)) {
        const ratings = memberRatingsIfAllWatchedAndRated as number[];
        headerBuilt.title.personal_rating = Math.round(ratings.reduce((sum, r) => sum + r, 0) / ratings.length);
      }

      // Last Watched Date (#10): the latest among every member's own real last_watched_date
      // (sourced from the one-time watch-history import, per the user's own instruction) - a
      // plain string max works correctly here since every real value is a "YYYY-MM-DD" ISO date.
      const memberLastWatchedDates = memberBuilts
        .map((b) => b.existingLastWatchedDate)
        .filter((d): d is string => Boolean(d))
        .sort();
      if (memberLastWatchedDates.length > 0) {
        headerBuilt.title.last_watched_date = memberLastWatchedDates[memberLastWatchedDates.length - 1];
      }
    }
  }

  // All-or-nothing writes (the user, 2026-10-07: "a sheet failure should stop the save so that
  // once fixed the import can happen again and there will be no duplicates"). Every database
  // and Sheet write below is journalled; if any of them fails - the Sheet most often (quota,
  // auth, network) - everything already written by this confirm is undone and the scan stays
  // pending, so retrying later starts clean instead of adding a box set's first titles twice.
  const journal: WriteJournalEntry[] = [];
  try {
    for (let i = 0; i < built.length; i++) {
      const { entry, title } = built[i];
      const uniqueId = title.unique_id as string;
      // Sheet-only cells already known at write time (the never-priced "n/a" below), written in
      // the same Sheet call as the rest of the row.
      const sheetOnlyFields: Record<string, unknown> = {};
      const sheetFields = { ...title, ...sheetOnlyFields };

      if (entry.overwriteUniqueId) {
        // Snapshot both copies first, so a later failure can put this row back exactly.
        const overwriteId = entry.overwriteUniqueId;
        const { data: previousRow, error: snapshotError } = await supabase
          .from("titles")
          .select(Object.keys(title).join(","))
          .eq("unique_id", overwriteId)
          .maybeSingle();
        if (snapshotError || !previousRow) throw new ConfirmWriteError(`Couldn't read the entry being overwritten: ${snapshotError?.message ?? "not found"}`);
        const previousSheetRow = await getSheetRowByUniqueId(overwriteId, columnIndexes);
        if (!previousSheetRow) throw new ConfirmWriteError("The entry being overwritten isn't in the Google Sheet (no row with its Unique Identifier).");
        journal.push({ kind: "overwrite", uniqueId: overwriteId, previousRow: previousRow as unknown as Record<string, unknown>, previousSheetValues: previousSheetRow.values });

        const { error: updateError } = await supabase.from("titles").update(title).eq("unique_id", overwriteId);
        if (updateError) throw new ConfirmWriteError(`Database update failed: ${updateError.message}`);
        if (!(await updateSheetFieldsByUniqueId(overwriteId, sheetFields, header, columnIndexes))) {
          throw new ConfirmWriteError("The entry being overwritten disappeared from the Google Sheet mid-save.");
        }
      } else {
        const { error: insertError } = await supabase.from("titles").insert(title);
        if (insertError) throw new ConfirmWriteError(`Database insert failed: ${insertError.message}`);
        journal.push({ kind: "insert", uniqueId, caseImagePath: (title.case_image_path as string | null) ?? null });
        const row = buildSheetRowFromTitle(sheetFields, columnIndexes, header.length);
        await appendRowToSheet(row);
      }
      createdIds.push(uniqueId);

      if (i === 0) {
        primaryShelfLocation = await computeShelfLocation(
          supabase,
          title.genre_location as string | null,
          title.title as string,
          title.depicted_era_start as number | null,
          title.who_shelf_order as number | null,
          uniqueId
        );
      }
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error("[confirm] write failed, rolling back:", reason);
    const rollbackProblems = await rollBackConfirmWrites(supabase, journal, header, columnIndexes);
    if (rollbackProblems.length) console.error("[confirm] rollback incomplete:", rollbackProblems);
    return NextResponse.json(
      {
        error: rollbackProblems.length
          ? `Saving failed (${reason}) and some of it couldn't be undone - check these entries before retrying: ${rollbackProblems.join("; ")}`
          : `Saving failed, so nothing was saved - the scan is still pending and can be retried. (${reason})`,
      },
      { status: 502 }
    );
  }

  // Every row this confirm wrote now shows on the website, which lists scanned rows only
  // (migration 0046). Kept out of `title` itself so the Sheet writes above never see it.
  if (createdIds.length > 0) {
    await supabase.from("titles").update({ scanned: true }).in("unique_id", createdIds);
  }
  // "Weird and Wonderful" (migration 0049): tag anything on the 366 Weird Movies lists. Best
  // effort - a failure here never fails the confirm.
  if (createdIds.length > 0) {
    void tagWeirdMovieMatches(supabase, createdIds).catch((err) => console.error("[confirm] weird list tagging failed:", err));
  }
  // New and overwritten entries show on the website straight away, not after the 5-minute
  // page/search caches expire. An Overwrite updates the same row (same unique_id), so its
  // pages update in place - never a second entry.
  if (createdIds.length > 0) refreshWebsiteCaches();
  // Back cover photos are never a stored product image (decision 5) - whether or not a front
  // cover was found/promoted above, every staged photo for this session is cleaned up now that
  // the pending scan has reached its terminal "confirmed" state.
  await deleteStagedCoverPhotos(supabase, stagedCoverPaths);

  await supabase
    .from("pending_scans")
    .update({ status: "confirmed", resolved_title_id: createdIds[0] })
    .eq("id", pendingScanId);

  logScanEvent({
    outcome: "confirmed",
    pendingScanId,
    barcode: pendingScanRow?.barcode ?? null,
    resolvedCandidates: pendingScanRow?.resolved_candidates ?? null,
    submittedEntries: entries.map((e) => ({ manualFields: e.manualFields, overwriteUniqueId: e.overwriteUniqueId })),
    createdTitleIds: createdIds,
  });



  // Fire-and-forget film metadata (TMDb details/cast/crew + OMDb scores into title_metadata/
  // people/title_credits - see web-app-build-plan.md) so a newly confirmed film gets its web
  // app page data immediately instead of waiting for the backfill. Uses each saved row's
  // imdb_page rather than entry.imdbId, since the confirm may have rewritten it (e.g. an
  // episode match resolved to its series) - taken from the rows this request just wrote
  // (`built`) rather than read back from the database (2026-10-07: the extra query fetched
  // exactly the values already in hand). Same long-running-process caveat as the hooks
  // above; refreshTitlesMetadata never throws. One call for every film, so a collection's
  // RT audience scores go to MDBList as one batch request instead of one per member.
  // Runs in after() so it outlives the response, then refreshes the caches again so the new
  // poster/cast/scores appear too.
  after(async () => {
    try {
      const imdbIds = [
        ...new Set(built.map((b) => extractImdbIdFromPage(b.title.imdb_page as string | null)).filter((id): id is string => !!id)),
      ];
      if (imdbIds.length > 0) await refreshTitlesMetadata(supabase, imdbIds, { omdbDetailById });
      if (imdbIds.length > 0) refreshWebsiteCaches();
    } catch (err) {
      console.error("[metadata] Failed to refresh metadata for newly confirmed title(s):", err);
    }
  });

  return NextResponse.json({
    success: true,
    createdTitleIds: createdIds,
    shelfLocation: primaryShelfLocation,
  });
}
