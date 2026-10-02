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

// TMDb-sourced fields (packages/backend/src/tmdb.ts) only need renewing every ~5 months
// (a safety buffer under TMDb's own 6-month cache limit), so this checks far less often
// than the pending_scans poller above - it'll almost always find nothing due, which is
// expected and cheap. Runs once shortly after startup too, not just on the interval, so a
// long-running dev/deployed server doesn't wait a full hour before its first check.
const TMDB_REFRESH_INTERVAL_MS = 60 * 60 * 1000;
const TMDB_REFRESH_BATCH_LIMIT = 20;


export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // next dev's Fast Refresh can re-run this module without restarting the process -
  // guard against stacking a second loop on top of an existing one.
  const globalForResolver = globalThis as unknown as {
    __scanAutoResolveStarted?: boolean;
    __tmdbRefreshStarted?: boolean;
  };
  if (globalForResolver.__scanAutoResolveStarted) return;
  globalForResolver.__scanAutoResolveStarted = true;

  const { resolvePendingScansBatch, refreshTmdbFields } = await import("@danflix/backend");
  const { getSupabaseServerClient } = await import("@/lib/supabaseServer");

  // Self-rescheduling (setTimeout-after-completion), NOT setInterval - found live 2026-09-30
  // after a real scan's UPCitemdb quota jumped from 6 to 9 lookups for one single barcode
  // scan. Root cause: a plain `setInterval` fires unconditionally every RESOLVE_INTERVAL_MS
  // regardless of whether the previous tick's async work has finished, and a cover-photo
  // scan's own resolution (rotate + bounding-box + text-read Gemini calls per staged photo,
  // sequential, plus the UPC lookup and OMDB/TMDb search) can easily take longer than 15s -
  // the row hasn't had its `status` flipped away from "pending" yet, so the NEXT tick's own
  // `status = "pending"` query happily picks up the exact same row and reprocesses it,
  // spending a second real UPC lookup (and repeating every other API call in that scan's
  // resolution) - repeatedly, for as many overlapping ticks as it takes for one pass to
  // finally finish. Scheduling the next run only from inside `finally`, after the current
  // one has fully settled, makes two runs overlapping the same row impossible.
  async function runAutoResolve() {
    try {
      const result = await resolvePendingScansBatch(getSupabaseServerClient(), RESOLVE_BATCH_LIMIT);
      if (result.processed > 0) {
        console.log(
          `[auto-resolve] Processed ${result.processed}: ${result.resolved} resolved, ${result.needsManual} need manual review.`
        );
      }
    } catch (err) {
      console.error("[auto-resolve] Failed:", err);
    } finally {
      setTimeout(runAutoResolve, RESOLVE_INTERVAL_MS);
    }
  }
  setTimeout(runAutoResolve, RESOLVE_INTERVAL_MS);

  console.log(`[auto-resolve] Watching pending_scans every ${RESOLVE_INTERVAL_MS / 1000}s.`);

  // Same self-rescheduling fix applied to the other two loops below, for the same reason -
  // neither has actually been observed overlapping (much longer intervals, lighter batches),
  // but the underlying setInterval hazard is identical, so there's no reason to leave two
  // known-vulnerable copies of it in place once the real cause was found.
  async function runTmdbRefresh() {
    try {
      const result = await refreshTmdbFields(getSupabaseServerClient(), TMDB_REFRESH_BATCH_LIMIT);
      if (result.processed > 0) {
        console.log(`[tmdb-refresh] Processed ${result.processed}: ${result.updated} updated.`);
      }
    } catch (err) {
      console.error("[tmdb-refresh] Failed:", err);
    } finally {
      setTimeout(runTmdbRefresh, TMDB_REFRESH_INTERVAL_MS);
    }
  }

  if (!globalForResolver.__tmdbRefreshStarted) {
    globalForResolver.__tmdbRefreshStarted = true;
    void runTmdbRefresh();
  }
  console.log(`[tmdb-refresh] Watching overdue TMDb-sourced titles every ${TMDB_REFRESH_INTERVAL_MS / 1000}s.`);

}
