import "server-only";
import { getCatalogClient, isMissingTableError, reportQueryError } from "./client";
import { PERSON_COLUMNS, TITLE_METADATA_COLUMNS } from "./columns";
import type { Credit, Person, TitleMetadata } from "./types";

/**
 * Reads from 0043's title_metadata / people / title_credits. Those tables may not exist yet
 * (or be partly backfilled), so every function here returns empty/null on a missing table and
 * pages fall back to what `titles` itself holds.
 */

const IMDB_ID_RE = /^tt\d+$/;
export const isImdbId = (value: string) => IMDB_ID_RE.test(value);

/** Once we've seen the tables are missing, stop asking for a while (saves a round-trip per
 * page); re-checked periodically so applying the migration needs no restart. */
let tablesMissingUntil = 0;
const MISSING_RECHECK_MS = 60_000;
function tablesKnownMissing() {
  return Date.now() < tablesMissingUntil;
}
function noteError(context: string, error: Parameters<typeof reportQueryError>[1]) {
  if (isMissingTableError(error)) tablesMissingUntil = Date.now() + MISSING_RECHECK_MS;
  else reportQueryError(context, error);
}

export async function getTitleMetadataMap(imdbIds: Array<string | null | undefined>): Promise<Map<string, TitleMetadata>> {
  const map = new Map<string, TitleMetadata>();
  const ids = [...new Set(imdbIds.filter((id): id is string => !!id && isImdbId(id)))];
  const supabase = getCatalogClient();
  if (!supabase || ids.length === 0 || tablesKnownMissing()) return map;

  // Chunked so a long `in (...)` list never blows the URL length limit.
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await supabase
      .from("title_metadata")
      .select(TITLE_METADATA_COLUMNS)
      .in("imdb_id", ids.slice(i, i + 200));
    if (error) {
      noteError("title_metadata", error);
      return map;
    }
    for (const row of (data ?? []) as unknown as TitleMetadata[]) map.set(row.imdb_id, row);
  }
  return map;
}

export async function getTitleMetadata(imdbId: string): Promise<TitleMetadata | null> {
  return (await getTitleMetadataMap([imdbId])).get(imdbId) ?? null;
}

/** Cast (by billing) and crew for one film; empty until 0043 is applied and backfilled. */
export async function getWorkCredits(imdbId: string): Promise<{ cast: Credit[]; crew: Credit[] }> {
  const empty = { cast: [], crew: [] };
  const supabase = getCatalogClient();
  if (!supabase || !isImdbId(imdbId) || tablesKnownMissing()) return empty;

  const { data, error } = await supabase
    .from("title_credits")
    .select("credit_type,character,job,department,credit_order,person:people(tmdb_person_id,name,profile_path)")
    .eq("imdb_id", imdbId)
    .order("credit_order", { ascending: true, nullsFirst: false });
  if (error) {
    noteError("title_credits", error);
    return empty;
  }
  const credits = ((data ?? []) as unknown as Credit[]).filter((c) => c.person);
  return {
    cast: credits.filter((c) => c.credit_type === "cast"),
    crew: credits.filter((c) => c.credit_type === "crew"),
  };
}

export async function getPerson(tmdbPersonId: number): Promise<Person | null> {
  const supabase = getCatalogClient();
  if (!supabase || !Number.isSafeInteger(tmdbPersonId) || tablesKnownMissing()) return null;
  const { data, error } = await supabase.from("people").select(PERSON_COLUMNS).eq("tmdb_person_id", tmdbPersonId).maybeSingle();
  if (error) {
    noteError("people", error);
    return null;
  }
  return (data as unknown as Person | null) ?? null;
}
