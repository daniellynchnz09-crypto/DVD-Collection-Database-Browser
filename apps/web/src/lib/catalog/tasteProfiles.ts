import "server-only";
import { getCatalogClient, isMissingTableError, reportQueryError } from "./client";
import { parseFilters, type SearchFilters } from "./searchFilters";

/**
 * Taste profiles: named Advanced Search filter presets (2026-10-07). The table has existed
 * since migration 0001 (`taste_profiles`: id, name, filters jsonb, created_at), unused until
 * now. `filters` holds the profile's filters in /search's URL-parameter form as a JSON string,
 * e.g. "genre=Horror&genre=!Comedy&rt=70-", re-parsed and validated on every read. Choosing several in
 * search shows only titles that pass every one of them - the "middle ground" in WEB APP
 * DESIGN.md. Read with the anon client like the rest of the catalogue; writes go through
 * /api/taste-profiles, which needs the owner passcode.
 */

export interface TasteProfile {
  id: string;
  name: string;
  /** The stored filter params, as written. */
  params: string;
  /** Those params parsed and validated. Result types and sorting are dropped - a profile is
   * about which titles suit someone, not how to list them. */
  filters: SearchFilters;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isProfileId = (id: string) => UUID_RE.test(id);

export function parseProfileParams(params: string): SearchFilters {
  const usp = new URLSearchParams(params);
  return { ...parseFilters((key) => usp.getAll(key)), types: [], sort: null, dir: null, profiles: [] };
}

export async function listTasteProfiles(): Promise<TasteProfile[]> {
  const supabase = getCatalogClient();
  if (!supabase) return [];
  const { data, error } = await supabase.from("taste_profiles").select("id, name, filters").order("name").limit(200);
  if (error) {
    if (!isMissingTableError(error)) reportQueryError("taste profiles", error);
    return [];
  }
  return ((data ?? []) as Array<{ id: string; name: string; filters: unknown }>).map((r) => {
    // Anything that isn't the string form (e.g. 0001's default `{}`) reads as no filters.
    const params = typeof r.filters === "string" ? r.filters.slice(0, 4000) : "";
    return { id: r.id, name: r.name, params, filters: parseProfileParams(params) };
  });
}
