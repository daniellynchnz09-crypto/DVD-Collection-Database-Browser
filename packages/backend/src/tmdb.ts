import type { SupabaseClient } from "@supabase/supabase-js";

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
}

interface TmdbMovieDetail {
  production_companies?: { name: string }[];
  genres?: { name: string }[];
}

interface TmdbReleaseDatesResponse {
  results?: {
    iso_3166_1: string;
    release_dates?: { certification: string }[];
  }[];
}

/** Finds the TMDb movie id for a given IMDb id, via TMDb's "find by external id" endpoint. */
async function findTmdbIdByImdbId(imdbId: string): Promise<number | null> {
  const data = await tmdbFetch<TmdbFindResponse>(`/find/${imdbId}?external_source=imdb_id`);
  const match = data?.movie_results?.[0];
  return typeof match?.id === "number" ? match.id : null;
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
 * asked about. */
export async function fetchTmdbFieldsById(
  tmdbId: number
): Promise<{ rating: string | null; studio: string | null; isAnimated: boolean | null }> {
  const [details, releaseDates] = await Promise.all([
    tmdbFetch<TmdbMovieDetail>(`/movie/${tmdbId}`),
    tmdbFetch<TmdbReleaseDatesResponse>(`/movie/${tmdbId}/release_dates`),
  ]);

  const studio = details?.production_companies?.[0]?.name ?? null;
  const isAnimated = details ? (details.genres?.some((g) => g.name === "Animation") ?? false) : null;

  const nzEntry = releaseDates?.results?.find((r) => r.iso_3166_1 === "NZ");
  const certification = nzEntry?.release_dates?.find((rd) => rd.certification)?.certification;
  const rating = certification && certification.trim() ? certification : null;

  return { rating, studio, isAnimated };
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

export interface TmdbSearchCandidate {
  Title: string;
  Year: string;
  imdbID: string;
  Type: "movie";
  Poster: string;
}

/** Fetches full `/movie/{id}` details and shapes them into the same candidate form OMDB
 * search results already come in (Title/Year/imdbID/Type/Poster) - shared by
 * searchTmdbMovies below and by resolveTmdbCandidatesByIds (the fuzzy title-index fallback,
 * which only has a bare tmdb_id + title to start from and needs this same detail fetch to
 * get a poster/year/imdb_id out of it). */
async function resolveTmdbCandidateById(tmdbId: number): Promise<TmdbSearchCandidate | null> {
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

/** Resolves a batch of bare TMDb ids (e.g. from the fuzzy title-index fallback below,
 * which only has an id + title to start from) into full candidates. */
export async function resolveTmdbCandidatesByIds(tmdbIds: number[]): Promise<TmdbSearchCandidate[]> {
  const candidates = await Promise.all(tmdbIds.map((id) => resolveTmdbCandidateById(id)));
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
  rating: string | null;
  studio: string | null;
  isAnimated: boolean | null;
}

/** Looks a title up on TMDb for the first time, via its IMDb id - returns everything
 * needed to populate tmdb_id/rating/studio on a freshly confirmed title. Returns nulls
 * throughout (never throws) when TMDb has no matching movie, so a lookup miss never
 * blocks the rest of the confirm flow. `isAnimated: null` here means "no TMDb match at
 * all", same "unknown, not a confirmed answer" reasoning as fetchTmdbFieldsById above. */
export async function lookupTmdbFields(imdbId: string): Promise<TmdbFields> {
  const tmdbId = await findTmdbIdByImdbId(imdbId);
  if (tmdbId == null) return { tmdbId: null, rating: null, studio: null, isAnimated: null };
  const { rating, studio, isAnimated } = await fetchTmdbFieldsById(tmdbId);
  return { tmdbId, rating, studio, isAnimated };
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
 * touches rating/studio on a row where the corresponding *_is_manual flag is false - a
 * value the user actually typed in (from the case, or the original Sheet) is never
 * overwritten by this job.
 */
export async function refreshTmdbFields(
  supabase: SupabaseClient,
  limit: number
): Promise<TmdbRefreshResult> {
  const cutoffIso = new Date(Date.now() - REFRESH_INTERVAL_MS).toISOString();

  // Postgrest's `.or()` doesn't cleanly combine with a second independent OR-condition, so
  // the rating_is_manual/studio_is_manual check happens in JS after a broader fetch rather
  // than in the query itself.
  const { data: candidates } = await supabase
    .from("titles")
    .select("unique_id, tmdb_id, rating_is_manual, studio_is_manual")
    .not("tmdb_id", "is", null)
    .or(`tmdb_synced_at.is.null,tmdb_synced_at.lt.${cutoffIso}`)
    .limit(limit * 2);

  const due = (candidates ?? [])
    .filter((row) => !row.rating_is_manual || !row.studio_is_manual)
    .slice(0, limit);

  let updated = 0;
  for (const row of due) {
    const { rating, studio } = await fetchTmdbFieldsById(row.tmdb_id as number);
    const patch: Record<string, unknown> = { tmdb_synced_at: new Date().toISOString() };
    if (!row.rating_is_manual) patch.rating = rating;
    if (!row.studio_is_manual) patch.studio = studio;

    const { error } = await supabase.from("titles").update(patch).eq("unique_id", row.unique_id);
    if (!error) updated++;
  }

  return { processed: due.length, updated };
}
