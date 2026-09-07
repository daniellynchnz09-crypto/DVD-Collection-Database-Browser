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
 * single-film shell entity). */
export async function fetchTmdbFieldsById(
  tmdbId: number
): Promise<{ rating: string | null; studio: string | null }> {
  const [details, releaseDates] = await Promise.all([
    tmdbFetch<TmdbMovieDetail>(`/movie/${tmdbId}`),
    tmdbFetch<TmdbReleaseDatesResponse>(`/movie/${tmdbId}/release_dates`),
  ]);

  const studio = details?.production_companies?.[0]?.name ?? null;

  const nzEntry = releaseDates?.results?.find((r) => r.iso_3166_1 === "NZ");
  const certification = nzEntry?.release_dates?.find((rd) => rd.certification)?.certification;
  const rating = certification && certification.trim() ? certification : null;

  return { rating, studio };
}

export interface TmdbFields {
  tmdbId: number | null;
  rating: string | null;
  studio: string | null;
}

/** Looks a title up on TMDb for the first time, via its IMDb id - returns everything
 * needed to populate tmdb_id/rating/studio on a freshly confirmed title. Returns nulls
 * throughout (never throws) when TMDb has no matching movie, so a lookup miss never
 * blocks the rest of the confirm flow. */
export async function lookupTmdbFields(imdbId: string): Promise<TmdbFields> {
  const tmdbId = await findTmdbIdByImdbId(imdbId);
  if (tmdbId == null) return { tmdbId: null, rating: null, studio: null };
  const { rating, studio } = await fetchTmdbFieldsById(tmdbId);
  return { tmdbId, rating, studio };
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
