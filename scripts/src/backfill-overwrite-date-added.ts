/**
 * ONE-TIME backfill (2026-10-11): rows that first reached the website through a scanner
 * Overwrite (a Sheet-only row replaced by a full scan) never got `date_added` - only inserts
 * get it, from the column default - so they sat at the bottom of the website's Recently Added
 * row. /api/scan/confirm now stamps it on the first overwrite; this fills in the rows
 * overwritten before that fix.
 *
 * Date used, per row, in order of preference:
 *   1. The earliest "confirmed" event in apps/web/scan-log/*.jsonl whose submittedEntries
 *      overwrote that row (the log's `loggedAt`).
 *   2. The `scanned_at` of the earliest confirmed pending scan whose resolved_title_id is
 *      that row (covers overwrites from before the scan log existed).
 *   3. For a collection member with neither: its collection header's date (from the steps
 *      above, or the header's existing date_added). Migration 0046 marked those members
 *      scanned through their header, so the header's confirm is when they arrived.
 * Rows with none of these are reported and left alone. Only rows that are `scanned` and still have
 * a null `date_added` are touched, so it is safe to re-run.
 *
 * Dry run by default; writes only with `--apply`.
 * Usage: npx tsx src/backfill-overwrite-date-added.ts [--apply], from scripts/.
 */

import "dotenv/config";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";

const SCAN_LOG_DIR = join(__dirname, "..", "..", "apps", "web", "scan-log");

interface ScanLogLine {
  loggedAt?: string;
  outcome?: string;
  submittedEntries?: { overwriteUniqueId?: string }[];
}

function firstOverwriteTimes(): Map<string, string> {
  const times = new Map<string, string>();
  if (!existsSync(SCAN_LOG_DIR)) return times;
  for (const file of readdirSync(SCAN_LOG_DIR).filter((f) => f.endsWith(".jsonl"))) {
    for (const line of readFileSync(join(SCAN_LOG_DIR, file), "utf8").split("\n")) {
      if (!line.trim()) continue;
      let event: ScanLogLine;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event.outcome !== "confirmed" || !event.loggedAt) continue;
      for (const entry of event.submittedEntries ?? []) {
        const id = entry.overwriteUniqueId;
        if (!id) continue;
        const prev = times.get(id);
        if (!prev || event.loggedAt < prev) times.set(id, event.loggedAt);
      }
    }
  }
  return times;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY. Copy .env.example to .env and fill them in.");
    process.exit(1);
  }
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const rows: { unique_id: string; title: string; title_in_a_collection: boolean; name_of_collection: string | null; is_collection: boolean }[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("titles")
      .select("unique_id, title, title_in_a_collection, name_of_collection, is_collection")
      .eq("scanned", true)
      .is("date_added", null)
      .order("unique_id")
      .range(from, from + 999);
    if (error) throw new Error(`Reading titles failed: ${error.message}`);
    rows.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  console.log(`${rows.length} scanned row(s) with no date_added.`);
  if (rows.length === 0) return;

  const logTimes = firstOverwriteTimes();
  const scanTimes = new Map<string, string>();
  const ids = rows.map((r) => r.unique_id);
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await supabase
      .from("pending_scans")
      .select("resolved_title_id, scanned_at")
      .eq("status", "confirmed")
      .in("resolved_title_id", ids.slice(i, i + 200));
    if (error) throw new Error(`Reading pending_scans failed: ${error.message}`);
    for (const p of data ?? []) {
      const prev = scanTimes.get(p.resolved_title_id);
      if (!prev || p.scanned_at < prev) scanTimes.set(p.resolved_title_id, p.scanned_at);
    }
  }

  const dateFor = (id: string) => logTimes.get(id) ?? scanTimes.get(id);
  const headerDates = new Map<string, string>();
  for (const r of rows) {
    const when = dateFor(r.unique_id);
    if (r.is_collection && r.name_of_collection && when) headerDates.set(r.name_of_collection, when);
  }
  const orphanCollections = [
    ...new Set(rows.filter((r) => r.title_in_a_collection && r.name_of_collection && !dateFor(r.unique_id)).map((r) => r.name_of_collection as string)),
  ].filter((name) => !headerDates.has(name));
  if (orphanCollections.length) {
    const { data, error } = await supabase
      .from("titles")
      .select("name_of_collection, date_added")
      .eq("is_collection", true)
      .in("name_of_collection", orphanCollections)
      .not("date_added", "is", null);
    if (error) throw new Error(`Reading collection headers failed: ${error.message}`);
    for (const h of data ?? []) headerDates.set(h.name_of_collection, h.date_added);
  }

  let updated = 0;
  const unknown: string[] = [];
  for (const row of rows) {
    const own = dateFor(row.unique_id);
    const when = own ?? (row.title_in_a_collection && row.name_of_collection ? headerDates.get(row.name_of_collection) : undefined);
    if (!when) {
      unknown.push(row.title);
      continue;
    }
    const source = logTimes.has(row.unique_id) ? "scan log" : own ? "pending scan" : "collection header";
    console.log(`${apply ? "Setting" : "Would set"} ${row.title} -> ${when} (${source})`);
    if (apply) {
      const { error } = await supabase
        .from("titles")
        .update({ date_added: when })
        .eq("unique_id", row.unique_id)
        .is("date_added", null);
      if (error) {
        console.error(`  failed: ${error.message}`);
        continue;
      }
    }
    updated++;
  }

  console.log(`\n${apply ? "Updated" : "Would update"} ${updated} row(s).`);
  if (unknown.length) {
    console.log(`${unknown.length} row(s) have no overwrite record, left as-is: ${unknown.join(", ")}`);
  }
  if (!apply) console.log("Dry run - re-run with --apply to write.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
