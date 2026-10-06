import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchOmdbScores, type OmdbScoresResult } from "./omdbScores";
import { saveOmdbScores, savePersonDetails, saveTmdbMetadata } from "./storage";
import { fetchTmdbMetadata, fetchTmdbPerson } from "./tmdbMetadata";

export { fetchTmdbMetadata, fetchTmdbPerson, findTmdbByImdbId, type TmdbMetadataResult } from "./tmdbMetadata";
export { fetchOmdbScores, parseOmdbDecimal, parseOmdbInteger, type OmdbScoresResult } from "./omdbScores";
export { saveTmdbMetadata, saveOmdbScores, savePersonDetails } from "./storage";
export type { CreditRow, PersonRow, TitleMetadataOmdbFields, TitleMetadataTmdbFields } from "./types";

export interface RefreshTitleMetadataResult {
  imdbId: string;
  /** "saved" | "no_match" (TMDb has no entry) | "error". */
  tmdb: "saved" | "no_match" | "error";
  omdb: OmdbScoresResult["status"] | "saved_error";
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
 */
export async function refreshTitleMetadata(supabase: SupabaseClient, imdbId: string): Promise<RefreshTitleMetadataResult> {
  const tmdb = await refreshTmdbMetadata(supabase, imdbId);
  const omdb = await refreshOmdbScores(supabase, imdbId);
  return { imdbId, tmdb: tmdb.status, omdb, castCount: tmdb.castCount, crewCount: tmdb.crewCount };
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
