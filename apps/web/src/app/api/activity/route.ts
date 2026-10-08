import { NextResponse } from "next/server";
import { ALL_JOBS, kickBackgroundJobs } from "@/lib/backgroundJobs";

// Room for after()'s work: one Estimated Value title can take a few minutes (backgroundJobs.ts).
export const maxDuration = 300;

// Every visitor's open tab pings this, so each server copy only passes a kick on once a minute;
// the database claim (background_job_runs) decides whether any job is actually due.
const KICK_GAP_MS = 60_000;
let lastKickAt = 0;

/**
 * The website's "someone is here" signal (ActivityBeacon, 2026-10-09): starts whichever
 * background jobs are due - resolving pending scans, the TMDb refresh, Estimated Value pricing.
 * Public on purpose (any page view counts); it takes no input and returns nothing, and a burst
 * of calls costs one in-memory check each.
 */
export async function POST() {
  if (Date.now() - lastKickAt >= KICK_GAP_MS) {
    lastKickAt = Date.now();
    kickBackgroundJobs(ALL_JOBS);
  }
  return new NextResponse(null, { status: 204 });
}
