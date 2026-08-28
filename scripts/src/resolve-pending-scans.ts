/**
 * Manual runner for the shared resolver (packages/shared/src/scanResolver.ts) - works
 * through pending_scans at a safe rate against UPCitemdb's free 100/day tier. Run by
 * hand (`npm run resolve-scans` from the repo root) until a Vercel Cron job can call
 * apps/web's /api/scan/resolve automatically once deployed. See Claude/TECH STACK AND
 * ARCHITECTURE.md's "BARCODE SCANNING PIPELINE" section.
 *
 * Required env vars (see .env.example): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
 * OMDB_API_KEY.
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { resolvePendingScansBatch } from "@danflix/shared";

async function main() {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OMDB_API_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !OMDB_API_KEY) {
    console.error(
      "Missing required env vars. Copy .env.example to .env and fill in SUPABASE_URL, " +
        "SUPABASE_SERVICE_ROLE_KEY, and OMDB_API_KEY, then re-run."
    );
    process.exit(1);
  }

  const limit = parseInt(process.argv[2] ?? "20", 10);
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  console.log(`Resolving up to ${limit} pending scan(s)...`);
  const result = await resolvePendingScansBatch(supabase, limit);
  console.log(
    `Processed ${result.processed}: ${result.resolved} resolved, ${result.needsManual} need manual review.`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
