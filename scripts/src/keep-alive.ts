/**
 * Pings both Supabase projects with a trivial read so Supabase's activity scan
 * doesn't flag them for auto-pause (their free tier pauses a project after 7 days
 * with no activity - see Claude/TECH STACK AND ARCHITECTURE.md's "Hosting" section).
 * Run on a schedule via .github/workflows/keep-alive.yml every 3 days, well inside
 * the 7-day window. Also runnable by hand: `npm run keep-alive` from the repo root.
 *
 * Both projects are pinged with their anon key, not the service-role key the other
 * scripts in this folder need - a read against titles' public-read RLS policy is
 * all a keep-alive ping requires, so there's no reason to hand a more powerful key
 * to a scheduled CI job than the task actually needs. Either target is skipped (not
 * treated as a failure) if its env vars are unset, so this doubles as a local
 * single-project check if you only fill in one side.
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

interface KeepAliveTarget {
  name: string;
  url?: string;
  key?: string;
}

const targets: KeepAliveTarget[] = [
  {
    name: "private",
    url: process.env.SUPABASE_URL,
    key: process.env.SUPABASE_ANON_KEY,
  },
  {
    name: "public",
    url: process.env.PUBLIC_SUPABASE_URL,
    key: process.env.PUBLIC_SUPABASE_ANON_KEY,
  },
];

async function pingTarget(target: KeepAliveTarget): Promise<boolean> {
  if (!target.url || !target.key) {
    console.log(`[keep-alive] Skipping "${target.name}" - no URL/key configured for it.`);
    return true;
  }

  const supabase = createClient(target.url, target.key);
  const { error } = await supabase.from("titles").select("unique_id").limit(1);

  if (error) {
    console.error(`[keep-alive] "${target.name}" ping FAILED: ${error.message}`);
    return false;
  }

  console.log(`[keep-alive] "${target.name}" ping OK.`);
  return true;
}

async function main() {
  const results = await Promise.all(targets.map(pingTarget));

  if (!results.every(Boolean)) {
    console.error("[keep-alive] One or more Supabase projects failed to respond.");
    process.exit(1);
  }

  console.log("[keep-alive] Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
