/**
 * Manual runner for the shared TMDb refresher (packages/backend/src/tmdb.ts) - re-fetches
 * and renews Rating/Studio for whatever's overdue (never synced, or synced more than ~5
 * months ago), required to stay within TMDb's own 6-month cache limit. Never touches a
 * value the user typed in themselves (rating_is_manual/studio_is_manual). Run by hand
 * (`npm run refresh:tmdb` from the repo root) until a Vercel Cron job can call this
 * automatically once deployed - the same interval also runs continuously inside
 * apps/web/instrumentation.ts while `next dev`/the deployed server is up, so this script
 * is mainly for testing or forcing an immediate catch-up pass.
 *
 * Required env vars (see .env.example): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
 * TMDB_READ_ACCESS_TOKEN.
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { refreshTmdbFields } from "@danflix/backend";

async function main() {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TMDB_READ_ACCESS_TOKEN } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !TMDB_READ_ACCESS_TOKEN) {
    console.error(
      "Missing required env vars. Copy .env.example to .env and fill in SUPABASE_URL, " +
        "SUPABASE_SERVICE_ROLE_KEY, and TMDB_READ_ACCESS_TOKEN, then re-run."
    );
    process.exit(1);
  }

  const limit = parseInt(process.argv[2] ?? "20", 10);
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  console.log(`Refreshing up to ${limit} overdue TMDb-sourced title(s)...`);
  const result = await refreshTmdbFields(supabase, limit);
  console.log(`Processed ${result.processed}: ${result.updated} updated.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
