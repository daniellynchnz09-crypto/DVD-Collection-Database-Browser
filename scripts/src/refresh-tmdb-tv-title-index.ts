/**
 * TV counterpart to refresh-tmdb-title-index.ts - bulk-imports TMDb's public daily TV
 * series export (https://files.tmdb.org/p/exports/tv_series_ids_MM_DD_YYYY.json.gz -
 * schema {id, original_name, popularity} confirmed live by downloading and inspecting a
 * real file; unlike the movie export, there is no "adult" field at all) into
 * tmdb_tv_title_index (supabase/migrations/0009_tmdb_tv_title_index.sql).
 *
 * ~230k rows, much smaller than the movie export - run by hand (`npm run refresh:tmdb-tv-
 * title-index` from the repo root) until a Vercel Cron job can call this on a schedule;
 * weekly is plenty since the file is regenerated daily and new titles are the only thing
 * that changes.
 *
 * Required env vars (see .env.example): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
 * Optional first CLI arg: a row limit, for a quick test import instead of the full file.
 */

import "dotenv/config";
import { gunzipSync } from "node:zlib";
import { createClient } from "@supabase/supabase-js";

const BATCH_SIZE = 2000;

interface TmdbTvExportRow {
  id: number;
  original_name: string;
  popularity: number;
}

function yesterdayUtcDateSuffix(): string {
  const d = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const yyyy = d.getUTCFullYear();
  return `${mm}_${dd}_${yyyy}`;
}

async function downloadExport(): Promise<TmdbTvExportRow[]> {
  const dateSuffix = yesterdayUtcDateSuffix();
  const url = `https://files.tmdb.org/p/exports/tv_series_ids_${dateSuffix}.json.gz`;
  console.log(`Downloading ${url} ...`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download TMDb TV export: ${res.status} ${res.statusText}`);

  const gzBuffer = Buffer.from(await res.arrayBuffer());
  const json = gunzipSync(gzBuffer).toString("utf8");
  const rows: TmdbTvExportRow[] = [];
  for (const line of json.split("\n")) {
    if (!line.trim()) continue;
    rows.push(JSON.parse(line));
  }
  return rows;
}

async function main() {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error(
      "Missing required env vars. Copy .env.example to .env and fill in SUPABASE_URL and " +
        "SUPABASE_SERVICE_ROLE_KEY, then re-run."
    );
    process.exit(1);
  }
  const rowLimit = process.argv[2] ? parseInt(process.argv[2], 10) : undefined;
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const exportRows = await downloadExport();
  console.log(`Downloaded ${exportRows.length} rows.`);

  let rows = exportRows
    .filter((r) => r.original_name)
    .map((r) => ({ tmdb_id: r.id, title: r.original_name, popularity: r.popularity ?? 0 }));
  if (rowLimit) rows = rows.slice(0, rowLimit);
  console.log(`Importing ${rows.length} rows in batches of ${BATCH_SIZE}...`);

  let imported = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const { error } = await supabase.from("tmdb_tv_title_index").upsert(batch, { onConflict: "tmdb_id" });
    if (error) {
      console.error(`Batch starting at row ${i} failed:`, error.message);
      process.exit(1);
    }
    imported += batch.length;
    if (imported % (BATCH_SIZE * 20) === 0 || imported === rows.length) {
      console.log(`  ${imported}/${rows.length} imported...`);
    }
  }

  console.log(`Done. Imported ${imported} titles into tmdb_tv_title_index.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
