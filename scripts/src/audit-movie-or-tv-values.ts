/**
 * Read-only audit script, run by hand: lists every distinct `movie_or_tv` value currently
 * live in the private Supabase project, with row counts, split into:
 *   1. Values `normalizeMovieOrTv` (packages/shared/src/titleParsing.ts's MOVIE_OR_TV_ALIASES
 *      table) would already rewrite to something else - meaning these rows are stale (written
 *      before the alias table existed, or before their variant was added to it) and need a
 *      backfill + a re-run of `npm run sync:sheet` to actually land the fix.
 *   2. Remaining values, clustered by an aggressive alphanumeric-only key, to surface likely
 *      new typos/variants MOVIE_OR_TV_ALIASES doesn't know about yet (e.g. two different raw
 *      spellings that collapse to the same bare-alphanumeric key but aren't both mapped to the
 *      same canonical string).
 *
 * Built 2026-09-18 ahead of the TV-scanning feature - the Confirm screen's new Movie/TV type
 * dropdown needs its option list to reflect the real, live distinct values in the collection
 * (per the user's own instruction), not just RESOURCES.md's example list - but only after this
 * normalization pass, since the user also asked for a normalization sweep first rather than
 * baking known typos/spacing drift into the dropdown as if they were real categories.
 *
 * Read-only - never writes anything itself. Usage: npx tsx src/audit-movie-or-tv-values.ts
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { normalizeMovieOrTv } from "@danflix/shared";

interface TitleRow {
  unique_id: string;
  title: string;
  movie_or_tv: string;
}

function alnumKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

async function main() {
  const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

  const rows: TitleRow[] = [];
  const PAGE_SIZE = 1000;
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from("titles")
      .select("unique_id, title, movie_or_tv")
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as TitleRow[]));
    if ((data ?? []).length < PAGE_SIZE) break;
  }

  console.log(`Loaded ${rows.length} title(s).\n`);

  const byValue = new Map<string, TitleRow[]>();
  for (const row of rows) {
    const key = row.movie_or_tv ?? "";
    if (!byValue.has(key)) byValue.set(key, []);
    byValue.get(key)!.push(row);
  }

  console.log(`=== ${byValue.size} distinct raw movie_or_tv value(s) ===\n`);

  const stale: { raw: string; target: string; rows: TitleRow[] }[] = [];
  const passthrough: { raw: string; rows: TitleRow[] }[] = [];

  for (const [raw, rowsForValue] of byValue) {
    const target = normalizeMovieOrTv(raw);
    if (target && target !== raw) {
      stale.push({ raw, target, rows: rowsForValue });
    } else {
      passthrough.push({ raw, rows: rowsForValue });
    }
  }

  console.log(`--- 1. STALE (alias table already knows the fix, DB just hasn't caught up) - ${stale.length} value(s) ---`);
  if (stale.length === 0) {
    console.log("  None - every known-alias variant is already normalized in the DB.\n");
  } else {
    for (const s of stale.sort((a, b) => b.rows.length - a.rows.length)) {
      console.log(`  "${s.raw}" -> "${s.target}" (${s.rows.length} row(s))`);
      for (const r of s.rows.slice(0, 5)) console.log(`      - ${r.title} (${r.unique_id})`);
      if (s.rows.length > 5) console.log(`      ...and ${s.rows.length - 5} more`);
    }
    console.log("");
  }

  console.log(`--- 2. PASSTHROUGH (not in the alias table at all) - ${passthrough.length} distinct value(s) ---`);
  const clusters = new Map<string, { raw: string; rows: TitleRow[] }[]>();
  for (const p of passthrough) {
    const key = alnumKey(p.raw);
    if (!clusters.has(key)) clusters.set(key, []);
    clusters.get(key)!.push(p);
  }

  const suspicious = [...clusters.values()].filter((c) => c.length > 1);
  const clean = [...clusters.values()].filter((c) => c.length === 1);

  console.log(`\n  2a. Likely genuine, single-spelling categories - ${clean.length}:`);
  for (const c of clean.sort((a, b) => b[0].rows.length - a[0].rows.length)) {
    console.log(`      "${c[0].raw}" (${c[0].rows.length} row(s))`);
  }

  console.log(`\n  2b. SUSPICIOUS clusters - raw values that collapse to the same bare key but aren't unified - ${suspicious.length}:`);
  if (suspicious.length === 0) {
    console.log("      None.");
  } else {
    for (const cluster of suspicious) {
      console.log(`      Cluster (key "${alnumKey(cluster[0].raw)}"):`);
      for (const c of cluster) {
        console.log(`        "${c.raw}" (${c.rows.length} row(s)) - e.g. ${c.rows[0].title} (${c.rows[0].unique_id})`);
      }
    }
  }

  console.log(
    `\nSummary: ${stale.length} stale value(s) fixable by backfill+resync, ${suspicious.length} suspicious cluster(s) needing a manual decision on the canonical spelling, ${clean.length} distinct value(s) that look like real, singly-spelled categories already.`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
