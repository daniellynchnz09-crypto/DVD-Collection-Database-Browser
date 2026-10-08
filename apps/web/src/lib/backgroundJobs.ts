import { after } from "next/server";
import { refreshTmdbFields, removeAbandonedStagedCovers, resolvePendingScansBatch } from "@danflix/backend";
import { getSupabaseServerClient } from "@/lib/supabaseServer";

/**
 * Background work that only runs while someone is using the site or the scanner app
 * (2026-10-09, the user's call after the rate-limit report: "there's no point in updating it in
 * the background and taking quota every 5 minutes if no one is there to see it").
 *
 * Replaces instrumentation.ts's always-on loops (which also never run on Vercel, where nothing
 * stays running between requests) and the GitHub resolve-scans.yml schedule (every 5 minutes,
 * ~8,640 Actions minutes a month against a 2,000 allowance - now manual only). Instead:
 *   - a page view on the website pings /api/activity (ActivityBeacon), every 5 minutes while
 *     the tab is visible;
 *   - the scanner app's requests (session-finish, the Pending Scans list, confirm) kick the
 *     jobs they care about.
 * Each kick runs the work in after(), so it outlives the response, and each job claims its row
 * in background_job_runs first (0055) - a claim fails while another server is mid-run or the
 * job ran within its interval, so the kicks can arrive as often as they like.
 */

type JobName =
  | "resolve-scans"
  | "tmdb-refresh"
  | "staging-cleanup"
  ;

interface JobSpec {
  /** Minimum gap between two runs' starts. */
  minIntervalSeconds: number;
  /** How long a run holds the job. Longer than a run can last, so a run cut off without
   * releasing its claim (a function stopped mid-way) only blocks the job this long. */
  lockSeconds: number;
  run: () => Promise<void>;
}

// A Vercel function may run for 300s (Hobby plan, Fluid compute); work stops picking up new
// items after this so it finishes inside that.
const WORK_BUDGET_MS = 200_000;

const JOBS: Record<JobName, JobSpec> = {
  // Scans are picked up within seconds of a session finishing (session-finish kicks this with
  // no interval); the 15s otherwise just stops a busy page from re-querying constantly.
  "resolve-scans": { minIntervalSeconds: 15, lockSeconds: 600, run: resolveScans },
  // TMDb-sourced fields only need renewing every ~5 months (TMDb's 6-month cache rule), so a
  // check every 6 hours of use is plenty; it almost always finds nothing due.
  "tmdb-refresh": { minIntervalSeconds: 6 * 3600, lockSeconds: 600, run: refreshTmdb },
  // Weekly: staged cover photos left behind by scan sessions that never reached Done.
  "staging-cleanup": { minIntervalSeconds: 7 * 24 * 3600, lockSeconds: 600, run: cleanUpStaging },
};

/** Every job, for a page view or an app request: each one only runs if it's due. */
export const ALL_JOBS = Object.keys(JOBS) as JobName[];

/**
 * Starts the given jobs after the response is sent. `immediate` skips the minimum interval (a
 * claim still fails while another run is going) - for a new scan that should resolve right away.
 */
export function kickBackgroundJobs(jobs: readonly JobName[], options: { immediate?: boolean } = {}): void {
  after(() => Promise.all(jobs.map((job) => runJob(job, options.immediate ?? false))));
}

async function runJob(job: JobName, immediate: boolean): Promise<void> {
  const spec = JOBS[job];
  const supabase = getSupabaseServerClient();
  const { data: claimed, error } = await supabase.rpc("claim_background_job", {
    p_job: job,
    p_min_interval_seconds: immediate ? 0 : spec.minIntervalSeconds,
    p_lock_seconds: spec.lockSeconds,
  });
  if (error) {
    console.error(`[background] Couldn't claim ${job}:`, error.message);
    return;
  }
  if (!claimed) return;
  try {
    await spec.run();
  } catch (err) {
    console.error(`[background] ${job} failed:`, err);
  } finally {
    await supabase.from("background_job_runs").update({ locked_until: null }).eq("job", job);
  }
}

const RESOLVE_BATCH_LIMIT = 10;

/** Resolves pending scans until none are left (or the time budget runs out), so a scan finished
 * while this run was busy is still picked up on its next pass. */
async function resolveScans(): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < WORK_BUDGET_MS) {
    const result = await resolvePendingScansBatch(getSupabaseServerClient(), RESOLVE_BATCH_LIMIT);
    if (result.processed > 0) {
      console.log(`[auto-resolve] Processed ${result.processed}: ${result.resolved} resolved, ${result.needsManual} need manual review.`);
    }
    if (result.processed === 0) return;
  }
}

const TMDB_REFRESH_BATCH_LIMIT = 20;

async function refreshTmdb(): Promise<void> {
  const result = await refreshTmdbFields(getSupabaseServerClient(), TMDB_REFRESH_BATCH_LIMIT);
  if (result.processed > 0) console.log(`[tmdb-refresh] Processed ${result.processed}: ${result.updated} updated.`);
}

async function cleanUpStaging(): Promise<void> {
  const removed = await removeAbandonedStagedCovers(getSupabaseServerClient());
  if (removed > 0) console.log(`[staging-cleanup] Removed ${removed} abandoned staged cover photo(s).`);
}

