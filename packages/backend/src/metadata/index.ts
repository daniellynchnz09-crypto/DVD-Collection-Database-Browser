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
  type MdblistScores,
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
  const omdbDetailById = options.omdbDetail ? new Map([[imdbId, options.omdbDetail]]) : undefined;
  const [result] = await refreshTitlesMetadata(supabase, [imdbId], { omdbDetailById });
  return result;
}

/**
 * refreshTitleMetadata for several films at once - a collection confirm (2026-10-07,
 * efficiency pass). TMDb and OMDb still go film by film, exactly as before, but the RT audience
 * scores are fetched in one MDBList batch request per media type instead of one request per
 * film: MDBList's batch endpoint takes up to 100 ids for the same single request from the
 * 1,000/day allowance, so a 9-title box set now spends 1 request instead of 9 (and one
 * freshness query instead of 9). Never throws.
 */
export async function refreshTitlesMetadata(
  supabase: SupabaseClient,
  imdbIds: string[],
  options: { omdbDetailById?: Map<string, OmdbScoreResponse> } = {}
): Promise<RefreshTitleMetadataResult[]> {
  const partial: Omit<RefreshTitleMetadataResult, "audience">[] = [];
  for (const imdbId of imdbIds) {
    const tmdb = await refreshTmdbMetadata(supabase, imdbId);
    const omdbDetail = options.omdbDetailById?.get(imdbId);
    let omdb: RefreshTitleMetadataResult["omdb"];
    if (omdbDetail) {
      try {
        await saveOmdbScores(supabase, omdbScoresFromResponse(imdbId, omdbDetail));
        omdb = "from_scan";
      } catch (err) {
        console.error(`[metadata] OMDb save failed for ${imdbId}:`, err);
        omdb = "saved_error";
      }
    } else {
      const { data: existing } = await supabase.from("title_metadata").select("omdb_fetched_at, release_date").eq("imdb_id", imdbId).maybeSingle();
      omdb = isWithin(existing?.omdb_fetched_at, omdbRefreshAgeMs(existing?.release_date)) ? "fresh" : await refreshOmdbScores(supabase, imdbId);
    }
    partial.push({ imdbId, tmdb: tmdb.status, omdb, castCount: tmdb.castCount, crewCount: tmdb.crewCount });
  }
  const audience = await refreshAudienceScores(supabase, imdbIds);
  return partial.map((p) => ({ ...p, audience: audience.get(p.imdbId) ?? "error" }));
}

function isWithin(iso: string | null | undefined, maxAgeMs: number): boolean {
  const at = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(at) && Date.now() - at < maxAgeMs;
}

/** RT audience scores for films after a scan - movie or show going by TMDb's media type, one
 * MDBList batch per media type for whichever of them are due. */
async function refreshAudienceScores(
  supabase: SupabaseClient,
  imdbIds: string[]
): Promise<Map<string, RefreshTitleMetadataResult["audience"]>> {
  const statuses = new Map<string, RefreshTitleMetadataResult["audience"]>();
  if (imdbIds.length === 0) return statuses;
  if (!process.env.MDBLIST_API_KEY) {
    for (const id of imdbIds) statuses.set(id, "skipped");
    return statuses;
  }
  const { data: rows } = await supabase
    .from("title_metadata")
    .select("imdb_id, mdblist_fetched_at, release_date, tmdb_media_type")
    .in("imdb_id", imdbIds);
  const rowById = new Map((rows ?? []).map((r) => [r.imdb_id as string, r]));
  const due: Record<"movie" | "show", string[]> = { movie: [], show: [] };
  for (const id of new Set(imdbIds)) {
    const row = rowById.get(id);
    if (isWithin(row?.mdblist_fetched_at, omdbRefreshAgeMs(row?.release_date))) statuses.set(id, "fresh");
    else due[row?.tmdb_media_type === "tv" ? "show" : "movie"].push(id);
  }
  for (const mediaType of ["movie", "show"] as const) {
    const ids = due[mediaType];
    if (ids.length === 0) continue;
    const result = await refreshMdblistAudienceScores(supabase, ids, mediaType);
    if (result.status === "error") console.error(`[metadata] MDBList refresh failed for ${ids.join(", ")}: ${result.message}`);
    for (const id of ids) statuses.set(id, result.status === "ok" ? "saved" : result.status);
  }
  return statuses;
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
