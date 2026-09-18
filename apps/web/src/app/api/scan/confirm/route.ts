import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { requireScanSecret } from "@/lib/scanAuth";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { appendRowToSheet, getSheetHeaderAndColumns, updateSheetFieldsByUniqueId } from "@/lib/googleSheets";
import { canonicalizeValue } from "@/lib/canonicalizeValue";
import {
  buildColumnIndexes,
  buildSheetRowFromTitle,
  cleanFreeText,
  inferDepictedEraStart,
  normalizeAnimationOrLiveAction,
  normalizeDiscCondition,
  normalizeFormat,
  normalizeRating,
  omdbGetById,
  parseOmdbReleaseDate,
  parseOmdbRuntimeMins,
} from "@danflix/shared";
import { fetchTmdbFieldsById, lookupRottenTomatoesPage, lookupTmdbFields, uploadCaseImage, type TmdbFields, type TmdbMediaType } from "@danflix/backend";
import type { SupabaseClient } from "@supabase/supabase-js";

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

function omdbTypeToMovieOrTv(type: string | undefined): string {
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

async function computeShelfLocation(
  supabase: SupabaseClient,
  genreLocation: string | null | undefined,
  newTitleName: string,
  newEraStart: number | null,
  excludeUniqueId: string
): Promise<{ before: string | null; after: string | null }> {
  if (!genreLocation) return { before: null, after: null };

  const { data: siblings } = await supabase
    .from("titles")
    .select("title, depicted_era_start")
    .eq("genre_location", genreLocation)
    .neq("unique_id", excludeUniqueId);
  if (!siblings || siblings.length === 0) return { before: null, after: null };

  const isHistoryDoc = /history document/i.test(genreLocation);
  const sorted = [...siblings].sort((a, b) =>
    isHistoryDoc
      ? (a.depicted_era_start ?? Infinity) - (b.depicted_era_start ?? Infinity)
      : a.title.localeCompare(b.title)
  );

  let before: string | null = null;
  let after: string | null = null;
  for (const sibling of sorted) {
    const isBeforeNew = isHistoryDoc
      ? (sibling.depicted_era_start ?? Infinity) <= (newEraStart ?? Infinity)
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

  if (body?.discard === true) {
    await supabase.from("pending_scans").delete().eq("id", pendingScanId);
    return NextResponse.json({ success: true, createdTitleIds: [], shelfLocation: null });
  }

  if (body?.dismiss === true) {
    await supabase.from("pending_scans").update({ status: "confirmed" }).eq("id", pendingScanId);
    return NextResponse.json({ success: true, createdTitleIds: [], shelfLocation: null });
  }

  const entries: ConfirmEntry[] = Array.isArray(body?.entries) ? body.entries : [];
  if (entries.length === 0) {
    return NextResponse.json({ error: "entries is required unless dismiss is true" }, { status: 400 });
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
  const resolvedTmdb: TmdbFields[] = [];
  for (const entry of entries) {
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

    // Hard requirement (Claude/TECH STACK AND ARCHITECTURE.md's "Backfill Rescan" section):
    // any entry backed by a real OMDB/TMDb candidate (entry.imdbId set) must end up with a
    // real TMDb id, so every other metadata-driven feature (scores, cast/crew, synopsis,
    // third-party review-tracking integrations, ...) can be backfilled later for the whole
    // collection at once, without ever re-touching the physical disc. A fully manual entry
    // (no candidate at all - the user's own custom-burned discs) has nothing to look up and
    // is exempt.
    if (entry.imdbId && fields.tmdbId == null) {
      return NextResponse.json(
        {
          error:
            "TMDb has no match for this title, and no manual TMDb link/id was given - " +
            "enter one in the TMDb field on the confirm screen to continue.",
        },
        { status: 400 }
      );
    }
    resolvedTmdb.push(fields);
  }

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

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const manual = entry.manualFields ?? {};
    const tmdbFields = resolvedTmdb[i];

    let omdbFields: Record<string, unknown> = {};
    let synopsis: string | null = null;
    if (entry.imdbId) {
      const detail = await omdbGetById(entry.imdbId);
      if (detail) {
        synopsis = detail.Plot;

        // An "episode"-Type OMDb match is this project's classic-serial convention (one row
        // per serial, e.g. a Doctor Who story) - but release_date/imdb_page must always
        // reflect the *show* itself, never one specific serial (see barcode-review-screen-
        // fields.md's TV Scanning section, "Release date for TV"/"IMDb page for TV").
        // Resolved via OMDb's own seriesID field on the episode detail response.
        let showLevelDetail = detail;
        if (detail.Type === "episode" && detail.seriesID) {
          const seriesDetail = await omdbGetById(detail.seriesID);
          if (seriesDetail) showLevelDetail = seriesDetail;
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
        const resolvedMovieOrTv = asString(manual.movie_or_tv) || omdbTypeToMovieOrTv(detail.Type);

        omdbFields = {
          title: detail.Title,
          movie_or_tv: omdbTypeToMovieOrTv(detail.Type),
          release_date: parseOmdbReleaseDate(showLevelDetail.Released),
          running_time_mins: resolvedMovieOrTv === "TV Series" ? null : parseOmdbRuntimeMins(detail.Runtime),
          genre: mergeOmdbAndTmdbGenres(
            detail.Genre?.split(",").map((g) => g.trim()).filter(Boolean) ?? [],
            tmdbFields.genres
          ),
          director: creatorOrDirectorText?.split(",").map((d) => d.trim()).filter(Boolean) ?? [],
          rating: detail.Rated !== "N/A" ? detail.Rated : null,
          imdb_page: `https://www.imdb.com/title/${showLevelDetail.imdbID}/`,
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
    const cleanFranchise: string[] = Array.isArray(manual.franchise) ? manual.franchise : [];

    // Priority: a manual entry (the physical case, or a single-title scan) always wins
    // when given; otherwise TMDb's per-title lookup above; otherwise whatever OMDB itself
    // had (rating only - OMDB's own Production field proved unreliable, confirmed live
    // against a real title, so it's not chained in for studio at all). *_is_manual records
    // which branch actually won, so refreshTmdbFields (packages/backend/src/tmdb.ts) knows
    // never to touch a value that came from a human rather than TMDb.
    const manualRating = normalizeRating(asString(manual.rating));
    const manualStudio = cleanFreeText(asString(manual.studio));
    const manualOriginalLanguage = cleanFreeText(asString(manual.original_language));
    const finalRating = manualRating ?? tmdbFields.rating ?? (omdbFields.rating as string | null) ?? null;
    const finalStudio = manualStudio ?? tmdbFields.studio ?? null;
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
    if (entry.overwriteUniqueId) {
      const { data: existingWatchedRow } = await supabase
        .from("titles")
        .select("watched, watched_disc, personal_rating, last_watched_date")
        .eq("unique_id", entry.overwriteUniqueId)
        .maybeSingle();
      existingWatched = existingWatchedRow?.watched === true;
      existingWatchedDisc = existingWatchedRow?.watched_disc === true;
      existingPersonalRating = existingWatchedRow?.personal_rating ?? null;
      existingLastWatchedDate = existingWatchedRow?.last_watched_date ?? null;
    }
    // Caches the barcode listing's own product photo into Storage for the future web app's
    // DVD Pages (0026_add_case_image_path.sql) - unconditional on every confirm (including an
    // Overwrite), since a fresh photo of the user's actual physical copy is always
    // authoritative over whatever was there before. Deliberately NOT included in `title` below
    // when the upload fails (transient fetch/network error) rather than writing `null` - an
    // Overwrite must never silently erase a previously-good case image just because this one
    // re-fetch attempt didn't work.
    const caseImageUrl = asString(manual.case_image_url);
    const caseImagePath = caseImageUrl ? await uploadCaseImage(supabase, `titles/${uniqueId}/case.jpg`, caseImageUrl) : null;
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
      genre: manual.genre ?? omdbFields.genre ?? [],
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
      animation_or_live_action:
        normalizeAnimationOrLiveAction(asString(manual.animation_or_live_action)) ?? "Live Action",
      documentary: manual.documentary ?? "n",
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
      genre_location: cleanGenreLocation,
      release_name: cleanFreeText(asString(manual.release_name)),
      depicted_era_start:
        manual.depicted_era_start ??
        inferDepictedEraStart(String(manual.title ?? omdbFields.title ?? ""), synopsis),
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

      // Special Features (#8): true the moment ANY member has its own special features disc
      // - the collection's own toggle (already resolved above, describing a bonus disc
      // belonging to the set as a whole) only ever adds to this, never overrides it back to
      // false. Its own disc count/format are left exactly as the header form set them - a
      // per-title bonus disc is NOT the collection's own, per the user's explicit distinction.
      const anyMemberSpecialFeatures = memberBuilts.some((b) => b.title.special_features === true);
      headerBuilt.title.special_features = headerBuilt.title.special_features === true || anyMemberSpecialFeatures;

      // Disc Count: the real total across every physical disc in the box - every member's
      // own disc_count, summed, plus the collection's own bonus disc(s) if it has one
      // (already resolved into special_features_disc_count above, before this aggregation
      // pass touches special_features itself).
      const memberDiscTotal = memberBuilts.reduce((sum, b) => sum + ((b.title.disc_count as number) || 0), 0);
      const headerOwnBonusDiscCount =
        headerBuilt.title.special_features === true ? (headerBuilt.title.special_features_disc_count as number | null) ?? 0 : 0;
      headerBuilt.title.disc_count = memberDiscTotal + headerOwnBonusDiscCount || 1;

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

  for (let i = 0; i < built.length; i++) {
    const { entry, title } = built[i];
    const uniqueId = title.unique_id as string;

    if (entry.overwriteUniqueId) {
      const { error: updateError } = await supabase.from("titles").update(title).eq("unique_id", entry.overwriteUniqueId);
      if (updateError) {
        return NextResponse.json({ error: updateError.message }, { status: 500 });
      }
      await updateSheetFieldsByUniqueId(entry.overwriteUniqueId, title, header, columnIndexes);
    } else {
      const { error: insertError } = await supabase.from("titles").insert(title);
      if (insertError) {
        return NextResponse.json({ error: insertError.message }, { status: 500 });
      }
      const row = buildSheetRowFromTitle(title, columnIndexes, header.length);
      await appendRowToSheet(row);
    }
    createdIds.push(uniqueId);

    if (i === 0) {
      primaryShelfLocation = await computeShelfLocation(
        supabase,
        title.genre_location as string | null,
        title.title as string,
        title.depicted_era_start as number | null,
        uniqueId
      );
    }
  }

  await supabase
    .from("pending_scans")
    .update({ status: "confirmed", resolved_title_id: createdIds[0] })
    .eq("id", pendingScanId);


  return NextResponse.json({
    success: true,
    createdTitleIds: createdIds,
    shelfLocation: primaryShelfLocation,
  });
}
