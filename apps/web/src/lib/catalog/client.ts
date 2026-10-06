import "server-only";
import { createClient, type PostgrestError, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Read-only Supabase client for the public-by-link website's pages. Deliberately the ANON
 * key, never the service-role one: RLS (`titles_public_read`, and 0043's public-read
 * policies) is the real access boundary, so a page bug can at worst read what anon can read.
 * `server-only` keeps it (and every query module importing it) out of client bundles.
 */
let client: SupabaseClient | null = null;

export function getCatalogClient(): SupabaseClient | null {
  if (client) return client;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    console.error("[catalog] NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY not configured.");
    return null;
  }
  client = createClient(url, anonKey, {
    // No user sessions on the read path - nothing to persist or refresh.
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return client;
}

/** True when a query failed only because a table doesn't exist yet (e.g. 0043's
 * title_metadata/people/title_credits before the migration is applied) - callers treat
 * that as "no data" rather than an error worth logging. */
export function isMissingTableError(error: PostgrestError | null): boolean {
  if (!error) return false;
  return error.code === "PGRST205" || error.code === "42P01";
}

/** Logs a query failure (unless it's just a not-yet-created table) and lets the caller fall
 * back to an empty result, so one failed row/section never takes a whole page down. */
export function reportQueryError(context: string, error: PostgrestError | null): void {
  if (!error || isMissingTableError(error)) return;
  console.error(`[catalog] ${context}: ${error.code ?? ""} ${error.message}`);
}

/** PostgREST caps a single response at 1,000 rows, so anything that needs the whole
 * collection (distinct franchise/genre lists) pages through in chunks of this size. */
export const PAGE_SIZE = 1000;

/** Escapes LIKE/ILIKE wildcards so user/DB text is matched literally. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}
