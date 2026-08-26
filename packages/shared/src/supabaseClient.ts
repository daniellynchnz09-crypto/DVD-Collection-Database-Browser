import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Reads SUPABASE_URL/SUPABASE_ANON_KEY from whichever env the calling app exposes them
 * through (Next.js: process.env.NEXT_PUBLIC_SUPABASE_*, Expo: process.env.EXPO_PUBLIC_SUPABASE_*).
 * Never hardcode keys here - see Claude/TECH STACK AND ARCHITECTURE.md's Security & Secrets section.
 */
export function createSupabaseClient(url: string, anonKey: string): SupabaseClient {
  if (!url || !anonKey) {
    throw new Error(
      "Supabase URL/anon key missing. Set them in .env.local (web) or app config (mobile) - see .env.example."
    );
  }
  return createClient(url, anonKey);
}
