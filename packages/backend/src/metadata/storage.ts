import type { SupabaseClient } from "@supabase/supabase-js";
import type { TmdbMetadataResult } from "./tmdbMetadata";
import type { PersonRow, TitleMetadataOmdbFields } from "./types";

/**
 * Writes for title_metadata/people/title_credits (0043_title_metadata.sql). Needs a
 * service-role client - those tables have no write policies. Order matters: credits reference
 * both title_metadata and people, so those are upserted first.
 */

/** Upserts a film's TMDb details, its people, and replaces its credits. */
export async function saveTmdbMetadata(supabase: SupabaseClient, result: TmdbMetadataResult): Promise<void> {
  const imdbId = result.metadata.imdb_id;
  // Upsert only sends TMDb columns, so existing OMDb score columns are left untouched.
  const { error: metaError } = await supabase.from("title_metadata").upsert(result.metadata, { onConflict: "imdb_id" });
  if (metaError) throw new Error(`title_metadata upsert failed for ${imdbId}: ${metaError.message}`);

  if (result.people.length > 0) {
    // Only the basic columns are sent, so a lazily-fetched biography is never wiped.
    const basic = result.people.map(({ tmdb_person_id, name, profile_path, known_for_department }) => ({
      tmdb_person_id,
      name,
      profile_path,
      known_for_department,
    }));
    const { error } = await supabase.from("people").upsert(basic, { onConflict: "tmdb_person_id" });
    if (error) throw new Error(`people upsert failed for ${imdbId}: ${error.message}`);
  }

  // Credits are replaced wholesale so removed/re-ordered TMDb credits don't linger.
  const { error: deleteError } = await supabase.from("title_credits").delete().eq("imdb_id", imdbId);
  if (deleteError) throw new Error(`title_credits delete failed for ${imdbId}: ${deleteError.message}`);
  if (result.credits.length > 0) {
    const { error } = await supabase.from("title_credits").insert(result.credits);
    if (error) throw new Error(`title_credits insert failed for ${imdbId}: ${error.message}`);
  }
}

/** Upserts a film's OMDb scores (creates a bare title_metadata row if TMDb had no match). */
export async function saveOmdbScores(supabase: SupabaseClient, scores: TitleMetadataOmdbFields): Promise<void> {
  const { error } = await supabase.from("title_metadata").upsert(scores, { onConflict: "imdb_id" });
  if (error) throw new Error(`title_metadata score upsert failed for ${scores.imdb_id}: ${error.message}`);
}

/** Saves a fully-fetched person (biography etc.), marking fetched_at. */
export async function savePersonDetails(supabase: SupabaseClient, person: PersonRow): Promise<void> {
  const { error } = await supabase.from("people").upsert(person, { onConflict: "tmdb_person_id" });
  if (error) throw new Error(`people upsert failed for ${person.tmdb_person_id}: ${error.message}`);
}
