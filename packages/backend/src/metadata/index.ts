import type { SupabaseClient } from "@supabase/supabase-js";
import { refreshMdblistAudienceScores } from "./mdblistScores";
import { fetchOmdbScores, omdbRefreshAgeMs, omdbScoresFromResponse, type OmdbScoreResponse, type OmdbScoresResult } from "./omdbScores";
import { saveOmdbScores, savePersonDetails, saveTmdbMetadata } from "./storage";
import { fetchTmdbMetadata, fetchTmdbPerson } from "./tmdbMetadata";

export { fetchTmdbMetadata, fetchTmdbPerson, findTmdbByImdbId, type TmdbMetadataResult } from "./tmdbMetadata";
export {
  fetchOmdbScores,
  omdbRefreshAgeMs,
  omdbScoresFromResponse,
  parseOmdbDecimal,
  parseOmdbInteger,
  type OmdbScoreResponse,
  type OmdbScoresResult,
} from "./omdbScores";
export {
  fetchMdblistAudienceScores,
  refreshMdblistAudienceScores,
  MDBLIST_BATCH_SIZE,
  type MdblistBatchResult,
  type MdblistMediaType,
} from "./mdblistScores";
export { saveTmdbMetadata, saveOmdbScores, savePersonDetails } from "./storage";
export type { CreditRow, PersonRow, TitleMetadataOmdbFields, TitleMetadataTmdbFields } from "./types";

export interface RefreshTitleMetadataResult {
  imdbId: string;
  /** "saved" | "no_match" (TMDb has no entry) | "error". */
  tmdb: "saved" | "no_match" | "error";
  /** "from_scan": saved from the OMDb record the confirm already had; "fresh": skipped, the
   * stored scores are within omdbRefreshAgeMs. Neither spends an OMDb request. */
  omdb: OmdbScoresResult["status"] | "saved_error" | "from_scan" | "fresh";
  /** RT audience score from MDBList: "fresh" skips (same windows as OMDb), "skipped" when no
   * MDBLIST_API_KEY is configured. One MDBList request otherwise. */
  audience: "saved" | "fresh" | "skipped" | "limit_reached" | "error";
  castCount: number;
  crewCount: number;
}

/** TMDb half of a refresh: fetch + save. Never throws. */
export async function refreshTmdbMetadata(
  supabase: SupabaseClient,
  imdbId: string
): Promise<{ status: "saved" | "no_match" | "error"; castCount: number; crewCount: number }> {
  try {
    const result = await fetchTmdbMetadata(imdbId);
    if (!result) return { status: "no_match", castCount: 0, crewCount: 0 };
    await saveTmdbMetadata(supabase, result);
    const castCount = result.credits.filter((c) => c.credit_type === "cast").length;
    return { status: "saved", castCount, crewCount: result.credits.length - castCount };
  } catch (err) {
    console.error(`[metadata] TMDb refresh failed for ${imdbId}:`, err);
    return { status: "error", castCount: 0, crewCount: 0 };
  }
}

/** OMDb half of a refresh: fetch + save. Never throws. Spends one OMDb request. */
export async function refreshOmdbScores(
  supabase: SupabaseClient,
  imdbId: string
): Promise<OmdbScoresResult["status"] | "saved_error"> {
  const result = await fetchOmdbScores(imdbId);
  if (result.status === "ok" || result.status === "not_found") {
    try {
      await saveOmdbScores(supabase, result.scores);
    } catch (err) {
      console.error(`[metadata] OMDb save failed for ${imdbId}:`, err);
      return "saved_error";
    }
  } else if (result.status === "error") {
    console.error(`[metadata] OMDb lookup failed for ${imdbId}: ${result.message}`);
  }
  return result.status;
}

/**
 * Single entry point used after a scan confirm: refreshes one film's TMDb details/credits and
 * OMDb scores. TMDb runs first so the OMDb upsert lands on a populated row. Never throws.
 *
 * OMDb is only asked when it has to be: `omdbDetail` (the record the confirm already fetched)
 * is saved directly, and scores still within omdbRefreshAgeMs - e.g. a second copy of a film -
 * are left alone.
 */
export async function refreshTitleMetadata(
  supabase: SupabaseClient,
  imdbId: string,
  options: { omdbDetail?: OmdbScoreResponse | null } = {}
): Promise<RefreshTitleMetadataResult> {
  const tmdb = await refreshTmdbMetadata(supabase, imdbId);
  let omdb: RefreshTitleMetadataResult["omdb"];
  if (options.omdbDetail) {
    try {
      await saveOmdbScores(supabase, omdbScoresFromResponse(imdbId, options.omdbDetail));
      omdb = "from_scan";
    } catch (err) {
      console.error(`[metadata] OMDb save failed for ${imdbId}:`, err);
      omdb = "saved_error";
    }
  } else {
    const { data: existing } = await supabase.from("title_metadata").select("omdb_fetched_at, release_date").eq("imdb_id", imdbId).maybeSingle();
    omdb = isWithin(existing?.omdb_fetched_at, omdbRefreshAgeMs(existing?.release_date)) ? "fresh" : await refreshOmdbScores(supabase, imdbId);
  }
  const audience = await refreshAudienceScore(supabase, imdbId);
  return { imdbId, tmdb: tmdb.status, omdb, audience, castCount: tmdb.castCount, crewCount: tmdb.crewCount };
}

function isWithin(iso: string | null | undefined, maxAgeMs: number): boolean {
  const at = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(at) && Date.now() - at < maxAgeMs;
}

/** RT audience score for one film after a scan - movie or show going by TMDb's media type. */
async function refreshAudienceScore(supabase: SupabaseClient, imdbId: string): Promise<RefreshTitleMetadataResult["audience"]> {
  if (!process.env.MDBLIST_API_KEY) return "skipped";
  const { data: row } = await supabase.from("title_metadata").select("mdblist_fetched_at, release_date, tmdb_media_type").eq("imdb_id", imdbId).maybeSingle();
  if (isWithin(row?.mdblist_fetched_at, omdbRefreshAgeMs(row?.release_date))) return "fresh";
  const result = await refreshMdblistAudienceScores(supabase, [imdbId], row?.tmdb_media_type === "tv" ? "show" : "movie");
  if (result.status === "error") console.error(`[metadata] MDBList refresh failed for ${imdbId}: ${result.message}`);
  return result.status === "ok" ? "saved" : result.status;
}

/**
 * Fills a person's lazy columns (biography, birthday, ...) - for the Person page's first build
 * or the backfill's optional bios pass. Returns false on a miss/failure; never throws.
 */
export async function refreshPersonDetails(supabase: SupabaseClient, tmdbPersonId: number): Promise<boolean> {
  try {
    const person = await fetchTmdbPerson(tmdbPersonId);
    if (!person) return false;
    await savePersonDetails(supabase, person);
    return true;
  } catch (err) {
    console.error(`[metadata] person refresh failed for ${tmdbPersonId}:`, err);
    return false;
  }
}
