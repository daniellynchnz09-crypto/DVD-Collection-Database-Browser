/**
 * Runs once when the Next.js server process starts (stable Next.js hook, no config
 * needed - see https://nextjs.org/docs/app/guides/instrumentation). Used here to poll
 * `pending_scans` on an interval and resolve them automatically, so a scan shows up on
 * PendingScansScreen without anyone having to remember to run `npm run resolve-scans`
 * by hand - that was a recurring point of confusion during real-device testing.
 *
 * Deliberately still a poll, not a resolve-on-every-queue call: scanning and lookup stay
 * decoupled (Claude/TECH STACK AND ARCHITECTURE.md's "BARCODE SCANNING PIPELINE"), since
 * UPCitemdb's free tier is only 100 lookups/day and a bulk shelf-scanning session can
 * queue far faster than that. A short interval just means a small handful of scans gets
 * picked up within seconds during normal testing, while a large backlog still drains
 * gradually over many ticks instead of all firing UPC lookups back-to-back.
 *
 * The dynamic imports (rather than top-level ones) keep `@danflix/backend` - which pulls
 * in Jimp for image decoding - out of any edge-runtime bundle Next might build for this
 * file; register() itself runs for every runtime, so the module-level code can't assume
 * Node is available.
 */

const RESOLVE_INTERVAL_MS = 15_000;
const RESOLVE_BATCH_LIMIT = 20;

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // next dev's Fast Refresh can re-run this module without restarting the process -
  // guard against stacking a second interval on top of an existing one.
  const globalForResolver = globalThis as unknown as { __scanAutoResolveInterval?: NodeJS.Timeout };
  if (globalForResolver.__scanAutoResolveInterval) return;

  const { resolvePendingScansBatch } = await import("@danflix/backend");
  const { getSupabaseServerClient } = await import("@/lib/supabaseServer");

  globalForResolver.__scanAutoResolveInterval = setInterval(async () => {
    try {
      const result = await resolvePendingScansBatch(getSupabaseServerClient(), RESOLVE_BATCH_LIMIT);
      if (result.processed > 0) {
        console.log(
          `[auto-resolve] Processed ${result.processed}: ${result.resolved} resolved, ${result.needsManual} need manual review.`
        );
      }
    } catch (err) {
      console.error("[auto-resolve] Failed:", err);
    }
  }, RESOLVE_INTERVAL_MS);

  console.log(`[auto-resolve] Watching pending_scans every ${RESOLVE_INTERVAL_MS / 1000}s.`);
}
