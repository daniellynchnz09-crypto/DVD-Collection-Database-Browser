/**
 * Runner for the shared resolver (packages/backend/src/scanResolver.ts) - works through
 * pending_scans at a safe rate against UPCitemdb's free 100/day tier. Runnable by hand
 * (`npm run resolve-scans` from the repo root), and also the script
 * .github/workflows/resolve-scans.yml runs every 5 minutes - a backstop for whenever
 * apps/web's own instrumentation.ts poller (15s, but only while that Node process is
 * actually running - e.g. a local `next dev` left closed) isn't up. See Claude/TECH STACK
 * AND ARCHITECTURE/barcode-scanning-pipeline.md's "BARCODE SCANNING PIPELINE" section.
 *
 * Required env vars (see .env.example): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
 * OMDB_API_KEY. GEMINI_API_KEY is optional but should be set too - without it, cover-photo
 * scans still resolve on any barcode/text signal they have, but silently skip the
 * cover-vision read (coverVision.ts's own documented degrade-to-null behavior when the key
 * is missing), so this script wouldn't warn you about it either.
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { resolvePendingScansBatch } from "@danflix/backend";

async function main() {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OMDB_API_KEY, GEMINI_API_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !OMDB_API_KEY) {
    console.error(
      "Missing required env vars. Copy .env.example to .env and fill in SUPABASE_URL, " +
        "SUPABASE_SERVICE_ROLE_KEY, and OMDB_API_KEY, then re-run."
    );
    process.exit(1);
  }
  if (!GEMINI_API_KEY) {
    console.warn("GEMINI_API_KEY not set - cover-photo scans will resolve without a cover-vision read.");
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
