import type { SupabaseClient } from "@supabase/supabase-js";
import { isoCodeToLanguageName } from "./iso639";

/**
 * TMDb (themoviedb.org) integration - a real free public API (unlike IMDb, whose own
 * robots.txt prohibits any automated scraping outright), used for exactly the two fields
 * an IMDb parental-guide/company-credits page would have given if that were allowed: a
 * per-country (NZ/Oceania) certification and the primary production company. Both are
 * genuinely per-film data, so unlike the manual Rating/Studio fields in
 * apps/web/src/app/api/scan/confirm/route.ts (deliberately never shared across a
 * collection scan), TMDb lookups apply to every member of a collection scan individually -
 * solving the original "the box only has one rating, not each film's own" problem.
 *
 * TMDb's own API Terms of Use (fetched directly and quoted verbatim, not assumed - see
 * Claude/TECH STACK AND ARCHITECTURE.md) explicitly forbid caching any TMDb-sourced data
 * for longer than 6 months. Since this project stores fields permanently, tmdb_synced_at
 * tracks when each row was last refreshed so refreshTmdbFields can re-fetch and renew
 * anything approaching that limit - decided deliberately rather than just for compliance,
 * since ratings/studio names can genuinely change over time anyway (re-classifications,
 * studio mergers/renames).
 */

const TMDB_API_BASE = "https://api.themoviedb.org/3";
// ~5 months - a safety buffer comfortably under TMDb's 6-month cache limit.
const REFRESH_INTERVAL_MS = 150 * 24 * 60 * 60 * 1000;

function getAuthHeader(): string {
  const token = process.env.TMDB_READ_ACCESS_TOKEN;
  if (!token) throw new Error("TMDB_READ_ACCESS_TOKEN not configured.");
  return `Bearer ${token}`;
}

async function tmdbFetch<T>(path: string): Promise<T | null> {
  const res = await fetch(`${TMDB_API_BASE}${path}`, {
    headers: { Authorization: getAuthHeader(), accept: "application/json" },
  });
  if (!res.ok) return null;
  return (await res.json()) as T;
}

interface TmdbFindResponse {
  movie_results?: { id: number }[];
  // A TV show's episode/season can also be looked up by imdb id (tv_episode_results/
  // tv_season_results), but this project always confirms against the show's own overall
  // imdb id (see Claude/TECH STACK AND ARCHITECTURE/barcode-review-screen-fields.md's TV
  // Scanning section - "IMDb page for TV" - an episode-Type OMDb match is resolved back to
  // its parent series' imdbID before it ever reaches here), so only tv_results is relevant.
  tv_results?: { id: number }[];
}

interface TmdbMovieDetail {
  production_companies?: { name: string }[];
  genres?: { name: string }[];
  original_language?: string;
}

interface TmdbReleaseDatesResponse {
  results?: {
    iso_3166_1: string;
    release_dates?: { certification: string }[];
  }[];
}

// TV's certification endpoint is shaped differently from a movie's (a flat rating per
// country, not a history of release-date-tagged certifications) - TMDb's own API, two
// genuinely different endpoints, not a movie-only oversight.
interface TmdbContentRatingsResponse {
  results?: { iso_3166_1: string; rating?: string }[];
}

export type TmdbMediaType = "movie" | "tv";

// This collection's own real NZ classification scheme (Claude/RESOURCES.md, packages/shared/
// src/titleParsing.ts's RATING_ALIASES) - checked against below because TMDb's "NZ" release-
// certification entry is itself crowdsourced and can carry a mistagged non-NZ code (found live
// 2026-09-20: real Psycho/The Birds rows had "R"/"PG-13" - neither a real NZ rating - silently
// written from TMDb's own NZ slot). An invalid code is treated the same as "TMDb has no NZ
// certification at all" (returns null) rather than trusted at face value, so it falls through
// to ConfirmScreen's manual Rating field instead of silently writing a wrong classification.
const VALID_NZ_RATINGS = new Set(["G", "PG", "M", "R12", "R13", "R15", "R16", "R18"]);

function validNzRatingOrNull(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && VALID_NZ_RATINGS.has(trimmed) ? trimmed : null;
}

/** Finds the TMDb id for a given IMDb id, via TMDb's "find by external id" endpoint - checks
 * movie_results first (this collection is overwhelmingly films), then tv_results, since the
 * same endpoint returns both in one call regardless of which the id actually is. */
async function findTmdbIdByImdbId(imdbId: string): Promise<{ tmdbId: number; mediaType: TmdbMediaType } | null> {
  const data = await tmdbFetch<TmdbFindResponse>(`/find/${imdbId}?external_source=imdb_id`);
  const movieMatch = data?.movie_results?.[0];
  if (typeof movieMatch?.id === "number") return { tmdbId: movieMatch.id, mediaType: "movie" };
  const tvMatch = data?.tv_results?.[0];
  if (typeof tvMatch?.id === "number") return { tmdbId: tvMatch.id, mediaType: "tv" };
  return null;
}

/** Fetches the NZ/Oceania certification + primary production company for a TMDb movie id.
 * Picks the first company in TMDb's own list as "the" studio - TMDb doesn't expose a
 * "size" metric, but the first-listed company is empirically the lead/primary one for
 * most titles (matches the same judgment call made manually for Paper Planes, where the
 * first-listed of two credited companies was the real studio and the second was a
 * single-film shell entity).
 *
 * Also returns `isAnimated` (TMDb's own genre list includes "Animation") - verified live
 * against Casper's Haunted Christmas after the user found it had been wrongly logged as
 * Live Action, since the mobile scan form never actually asked for this field at all (see
 * Claude/TECH STACK AND ARCHITECTURE.md). Only distinguishes animated-vs-not; TMDb has no
 * field for the *specific* animation style (2D/3D/stop-motion/...), which this collection's
 * own data already tracks - that part stays a manual choice, this is just the prefill.
 * Three-valued (`true`/`false`/`null`) rather than a plain boolean: `null` means "the detail
 * fetch itself failed", which is a genuinely different situation from TMDb successfully
 * answering "no Animation genre tagged" - conflating the two would make the mobile form
 * hide the manual field and silently force "Live Action" on a title TMDb was never actually
 * asked about.
 *
 * Also returns `originalLanguage` - TMDb's own `original_language` field on this same
 * `/movie/{id}` detail response (genuinely free, no extra API call), mapped from its bare
 * ISO 639-1 code (e.g. "en") to a human-readable name (e.g. "English") via iso639.ts, since
 * that's this collection's own convention for the field (see
 * Claude/TECH STACK AND ARCHITECTURE/barcode-review-screen-fields.md's Original Language
 * note for the full history of why a bare code was rejected as an auto-fill value on its
 * own). `null` covers both "no TMDb match at all" and "TMDb returned a code this table
 * doesn't recognize" - either way, the confirm form falls back to the manual field rather
 * than writing something wrong. */
export async function fetchTmdbFieldsById(
  tmdbId: number,
  mediaType: TmdbMediaType = "movie"
): Promise<{
  rating: string | null;
  studio: string | null;
  isAnimated: boolean | null;
  originalLanguage: string | null;
  // TMDb's own genre names, verbatim (e.g. "Science Fiction", "Sci-Fi & Fantasy" for a TV
  // entry, "TV Movie" for a movie entry actually tagged that way) - added 2026-09-19 so the
  // confirm route can merge these into the Genre column alongside OMDb's own (narrower)
  // Genre field, per the user's own request after noticing OMDb's classic Doctor Who entry
  // was missing "Sci-Fi" entirely. Same `/movie or /tv {id}` response `isAnimated` already
  // reads - genuinely free, no extra call. Empty array (not null) when the detail fetch
  // itself failed, same "absence of a signal" convention as isAnimated defaulting to false.
  genres: string[];
}> {
  if (mediaType === "tv") {
    const [details, contentRatings] = await Promise.all([
      tmdbFetch<TmdbMovieDetail>(`/tv/${tmdbId}`),
      tmdbFetch<TmdbContentRatingsResponse>(`/tv/${tmdbId}/content_ratings`),
    ]);

    const studio = details?.production_companies?.[0]?.name ?? null;
    const isAnimated = details ? (details.genres?.some((g) => g.name === "Animation") ?? false) : null;
    const originalLanguage = isoCodeToLanguageName(details?.original_language);
    const genres = details?.genres?.map((g) => g.name) ?? [];

    const nzEntry = contentRatings?.results?.find((r) => r.iso_3166_1 === "NZ");
    const rating = validNzRatingOrNull(nzEntry?.rating);

    return { rating, studio, isAnimated, originalLanguage, genres };
  }

  const [details, releaseDates] = await Promise.all([
    tmdbFetch<TmdbMovieDetail>(`/movie/${tmdbId}`),
    tmdbFetch<TmdbReleaseDatesResponse>(`/movie/${tmdbId}/release_dates`),
  ]);

  const studio = details?.production_companies?.[0]?.name ?? null;
  const isAnimated = details ? (details.genres?.some((g) => g.name === "Animation") ?? false) : null;
  const originalLanguage = isoCodeToLanguageName(details?.original_language);
  const genres = details?.genres?.map((g) => g.name) ?? [];

  const nzEntry = releaseDates?.results?.find((r) => r.iso_3166_1 === "NZ");
  const certification = nzEntry?.release_dates?.find((rd) => rd.certification)?.certification;
  const rating = validNzRatingOrNull(certification);

  return { rating, studio, isAnimated, originalLanguage, genres };
}

const TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p/w342";

interface TmdbSearchResponse {
  results?: {
    id: number;
    title?: string;
    release_date?: string;
    poster_path?: string | null;
  }[];
}

interface TmdbMovieDetailFull {
  imdb_id?: string | null;
  title?: string;
  release_date?: string;
  poster_path?: string | null;
}

// TV has no top-level imdb_id on `/tv/{id}` the way a movie does - append_to_response pulls
// it in via the same call rather than a second round-trip to /tv/{id}/external_ids.
interface TmdbTvDetailFull {
  external_ids?: { imdb_id?: string | null };
  name?: string;
  first_air_date?: string;
  poster_path?: string | null;
}

export interface TmdbSearchCandidate {
  Title: string;
  Year: string;
  imdbID: string;
  Type: "movie" | "series";
  Poster: string;
}

/** Fetches full `/movie/{id}` or `/tv/{id}` details and shapes them into the same candidate
 * form OMDB search results already come in (Title/Year/imdbID/Type/Poster) - shared by
 * searchTmdbMovies below and by resolveTmdbCandidatesByIds (the fuzzy title-index fallback
 * and resolvePosterUrl, which only have a bare tmdb_id + media type to start from and need
 * this same detail fetch to get a poster/year/imdb_id out of it). Defaults to "movie" since
 * most callers (searchTmdbMovies, the fuzzy title-index, which is movie-only by construction)
 * only ever deal in movie ids - resolvePosterUrl is the one caller that passes a title's own
 * real tmdb_media_type, since calling `/movie/{id}` on what's actually a TV show's id can
 * coincidentally resolve to a wholly unrelated movie that happens to share that number in
 * the separate movie id space (found live: a TV title's poster resolved to a random
 * unrelated film's poster this way). */
async function resolveTmdbCandidateById(
  tmdbId: number,
  mediaType: TmdbMediaType = "movie"
): Promise<TmdbSearchCandidate | null> {
  if (mediaType === "tv") {
    const detail = await tmdbFetch<TmdbTvDetailFull>(`/tv/${tmdbId}?append_to_response=external_ids`);
    const imdbId = detail?.external_ids?.imdb_id;
    if (!imdbId || !detail?.name) return null;
    return {
      Title: detail.name,
      Year: detail.first_air_date ? detail.first_air_date.slice(0, 4) : "",
      imdbID: imdbId,
      Type: "series",
      Poster: detail.poster_path ? `${TMDB_IMAGE_BASE}${detail.poster_path}` : "N/A",
    };
  }

  const detail = await tmdbFetch<TmdbMovieDetailFull>(`/movie/${tmdbId}`);
  if (!detail?.imdb_id || !detail.title) return null;
  return {
    Title: detail.title,
    Year: detail.release_date ? detail.release_date.slice(0, 4) : "",
    imdbID: detail.imdb_id,
    Type: "movie",
    Poster: detail.poster_path ? `${TMDB_IMAGE_BASE}${detail.poster_path}` : "N/A",
  };
}

/**
 * A second, parallel pass alongside the manual title-search route's existing literal OMDB
 * search (apps/web/src/app/api/scan/title-search/route.ts). Verified live that TMDb's
 * search is NOT meaningfully more typo-tolerant than OMDB's for a realistic misspelling
 * (both returned zero results for "Jurrasic Park", "Lord of the Rngs") - this still runs
 * because it's a genuinely different index than OMDB's (catches titles/editions one
 * provider has that the other doesn't) and because it's re-run with the spellchecked query
 * too (see the title-search route), where TMDb sometimes has an entry OMDB lacks.
 *
 * Limited to the top 5 hits since each one needs a follow-up `/movie/{id}` call to resolve
 * its IMDb id (TMDb's own numeric id space is different from IMDb's, and this collection is
 * keyed on IMDb id everywhere else in the pipeline - posters, TMDb-preview, confirm).
 * Movies only (TMDb's `/search/movie`), matching the fact that this collection is
 * overwhelmingly films - series/episode candidates still come from the existing OMDB search.
 */
export async function searchTmdbMovies(query: string): Promise<TmdbSearchCandidate[]> {
  const data = await tmdbFetch<TmdbSearchResponse>(`/search/movie?query=${encodeURIComponent(query)}`);
  const hits = (data?.results ?? []).slice(0, 5);
  const candidates = await Promise.all(hits.map((hit) => resolveTmdbCandidateById(hit.id)));
  return candidates.filter((c): c is TmdbSearchCandidate => c !== null);
}

/** Resolves a batch of bare TMDb ids (e.g. from the fuzzy title-index fallback below, which
 * only has an id + title to start from - always movie ids, since that index is movie-only -
 * or from resolvePosterUrl, which passes a title's own real tmdb_media_type) into full
 * candidates. `mediaType` applies to every id in the batch, same as resolveTmdbCandidateById's
 * default. */
export async function resolveTmdbCandidatesByIds(
  tmdbIds: number[],
  mediaType: TmdbMediaType = "movie"
): Promise<TmdbSearchCandidate[]> {
  const candidates = await Promise.all(tmdbIds.map((id) => resolveTmdbCandidateById(id, mediaType)));
  return candidates.filter((c): c is TmdbSearchCandidate => c !== null);
}

export interface FuzzyTitleMatch {
  tmdbId: number;
  title: string;
  popularity: number;
  similarity: number;
}

/**
 * Fuzzy-matches `query` against every real TMDb movie title via the tmdb_title_index
 * table's trigram index (supabase/migrations/0006_tmdb_title_index.sql) - the fallback for
 * a typo neither OMDB's nor TMDb's own search catches, and that the generic English
 * spellchecker (spellcheck.ts) can't fix either because the misspelled word isn't an
 * ordinary English word at all (an invented/proper name like "Shawshank"). Matches against
 * actual title strings rather than dictionary words, so it catches exactly the cases the
 * other two passes miss. Returns an empty array (never throws) on any failure - e.g. the
 * table hasn't been populated yet via `npm run refresh:tmdb-title-index` - so a missing
 * local index never blocks the rest of the search.
 */
export async function fuzzySearchTitleIndex(
  supabase: SupabaseClient,
  query: string,
  limit = 5
): Promise<FuzzyTitleMatch[]> {
  const { data, error } = await supabase.rpc("fuzzy_search_tmdb_titles", {
    search_query: query,
    match_limit: limit,
  });
  if (error || !data) return [];
  return (data as { tmdb_id: number; title: string; popularity: number; sim: number }[]).map((row) => ({
    tmdbId: row.tmdb_id,
    title: row.title,
    popularity: row.popularity,
    similarity: row.sim,
  }));
}

export interface TmdbFields {
  tmdbId: number | null;
  tmdbMediaType: TmdbMediaType | null;
  rating: string | null;
  studio: string | null;
  isAnimated: boolean | null;
  originalLanguage: string | null;
  genres: string[];
}

/** Looks a title up on TMDb for the first time, via its IMDb id - returns everything
 * needed to populate tmdb_id/tmdb_media_type/rating/studio/original_language on a freshly
 * confirmed title. Checks movie_results first, then tv_results (see findTmdbIdByImdbId) -
 * added for TV scanning support (2026-09-18): before this, a TV confirmation could never
 * satisfy the confirm route's hard "must resolve to a real TMDb id" requirement at all,
 * since this only ever checked movie_results. Returns nulls throughout (never throws) when
 * TMDb has no matching title of either kind, so a lookup miss never blocks the rest of the
 * confirm flow. `isAnimated: null` here means "no TMDb match at all", same "unknown, not a
 * confirmed answer" reasoning as fetchTmdbFieldsById above. */
export async function lookupTmdbFields(imdbId: string): Promise<TmdbFields> {
  const found = await findTmdbIdByImdbId(imdbId);
  if (found == null) {
    return { tmdbId: null, tmdbMediaType: null, rating: null, studio: null, isAnimated: null, originalLanguage: null, genres: [] };
  }
  const { rating, studio, isAnimated, originalLanguage, genres } = await fetchTmdbFieldsById(found.tmdbId, found.mediaType);
  return { tmdbId: found.tmdbId, tmdbMediaType: found.mediaType, rating, studio, isAnimated, originalLanguage, genres };
}

interface TmdbTvSearchResponse {
  results?: { id: number; name?: string; first_air_date?: string }[];
}

/**
 * Finds a TMDb TV show id by name, for the one-time watch-history import's TV
 * season-completeness check (Claude/TECH STACK AND ARCHITECTURE.md's "Backfill Rescan"
 * section) - e.g. resolving "Doctor Who" (stripped of a season-box-set suffix like "the
 * Collection Season 7") to the classic 1963 series specifically, not one of its many
 * spin-offs/behind-the-scenes shows that also happen to be named "Doctor Who". Prefers an
 * exact (case-insensitive) name match with the earliest `first_air_date` - verified live
 * that this correctly picks the long-running original series over same-named specials and
 * spin-offs, which either have a different exact name or a much later air date. Falls back
 * to TMDb's own top search result if nothing matches exactly.
 */
export async function findTmdbTvIdByName(name: string): Promise<number | null> {
  const data = await tmdbFetch<TmdbTvSearchResponse>(`/search/tv?query=${encodeURIComponent(name)}`);
  const results = data?.results ?? [];
  if (results.length === 0) return null;

  const exact = results.filter((r) => r.name?.toLowerCase() === name.toLowerCase() && r.first_air_date);
  if (exact.length > 0) {
    exact.sort((a, b) => (a.first_air_date! < b.first_air_date! ? -1 : 1));
    return exact[0].id;
  }
  return results[0].id;
}

interface TmdbSeasonResponse {
  episodes?: { name?: string }[];
}

// Classic-era episode names on TMDb are per-25-minute-segment, suffixed with their segment
// number within the serial - e.g. "Spearhead from Space (1)".."Spearhead from Space (4)".
// Stripping that suffix and deduping recovers the real serial list (verified live against
// Doctor Who Season 7: 25 episodes -> exactly the 4 real serials - Spearhead from Space,
// Doctor Who and the Silurians, The Ambassadors of Death, Inferno).
const EPISODE_SEGMENT_SUFFIX = /\s*\(\d+\)\s*$/;

/**
 * Fetches the distinct serial/story names for one season of a TV show, for checking
 * whether every serial in a Blu-ray "whole season" box set has been logged in the source
 * watch-history export (which catalogues each classic serial as its own "film", not as
 * individual episodes).
 * Returns null (never throws) when TMDb has no data for this season, so a missing/incomplete
 * TMDb entry falls through to manual review rather than a false "not watched".
 */
export async function fetchTmdbSeasonSerials(tvId: number, seasonNumber: number): Promise<string[] | null> {
  const data = await tmdbFetch<TmdbSeasonResponse>(`/tv/${tvId}/season/${seasonNumber}`);
  const episodes = data?.episodes;
  if (!episodes || episodes.length === 0) return null;

  const serials: string[] = [];
  for (const ep of episodes) {
    if (!ep.name) continue;
    const serial = ep.name.replace(EPISODE_SEGMENT_SUFFIX, "").trim();
    if (serial && !serials.includes(serial)) serials.push(serial);
  }
  return serials.length > 0 ? serials : null;
}

export interface TmdbRefreshResult {
  processed: number;
  updated: number;
}

/**
 * Re-fetches and renews TMDb-sourced fields for whatever's overdue (never synced, or
 * synced more than ~5 months ago) - required to stay within TMDb's 6-month cache limit,
 * and useful in its own right since ratings/studio names genuinely can change. Only ever
 * touches rating/studio/original_language on a row where the corresponding *_is_manual flag
 * is false - a value the user actually typed in (from the case, or the original Sheet) is
 * never overwritten by this job.
 */
export async function refreshTmdbFields(
  supabase: SupabaseClient,
  limit: number
): Promise<TmdbRefreshResult> {
  const cutoffIso = new Date(Date.now() - REFRESH_INTERVAL_MS).toISOString();

  // Postgrest's `.or()` doesn't cleanly combine with a second independent OR-condition, so
  // the rating_is_manual/studio_is_manual/original_language_is_manual check happens in JS
  // after a broader fetch rather than in the query itself.
  const { data: candidates } = await supabase
    .from("titles")
    .select("unique_id, tmdb_id, tmdb_media_type, rating_is_manual, studio_is_manual, original_language_is_manual")
    .not("tmdb_id", "is", null)
    .or(`tmdb_synced_at.is.null,tmdb_synced_at.lt.${cutoffIso}`)
    .limit(limit * 2);

  const due = (candidates ?? [])
    .filter((row) => !row.rating_is_manual || !row.studio_is_manual || !row.original_language_is_manual)
    .slice(0, limit);

  let updated = 0;
  for (const row of due) {
    // 0028_add_tmdb_media_type.sql backfilled every pre-existing row to "movie" (the only
    // kind this project could confirm before TV scanning support existed), so this only
    // ever falls back for a row that somehow predates that migration.
    const mediaType = ((row as { tmdb_media_type?: TmdbMediaType | null }).tmdb_media_type ?? "movie") as TmdbMediaType;
    const { rating, studio, originalLanguage } = await fetchTmdbFieldsById(row.tmdb_id as number, mediaType);
    const patch: Record<string, unknown> = { tmdb_synced_at: new Date().toISOString() };
    if (!row.rating_is_manual) patch.rating = rating;
    if (!row.studio_is_manual) patch.studio = studio;
    if (!row.original_language_is_manual) patch.original_language = originalLanguage;

    const { error } = await supabase.from("titles").update(patch).eq("unique_id", row.unique_id);
    if (!error) updated++;
  }

  return { processed: due.length, updated };
}
