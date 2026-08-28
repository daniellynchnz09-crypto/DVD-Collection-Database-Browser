import { createSupabaseClient } from "@danflix/shared";

/**
 * Reads (pending scans list, existing genre_location/collection values for autocomplete)
 * go straight to Supabase with the publishable/anon key - both `titles` and
 * `pending_scans` have a public-read RLS policy (see supabase/migrations). Writes go
 * through apps/web's secret-gated API routes instead (see scanApi.ts) since the mobile
 * app must never hold the service-role key.
 */
export const supabase = createSupabaseClient(
  process.env.EXPO_PUBLIC_SUPABASE_URL!,
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!
);
