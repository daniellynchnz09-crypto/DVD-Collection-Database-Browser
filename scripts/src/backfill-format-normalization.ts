/**
 * ONE-TIME migration script (already run against the real Sheet - kept for history/audit,
 * not meant to be re-run as a repeatable tool). The Format column had accumulated ~19
 * distinct spellings for really 7 physical formats (casing drift, missing hyphens, double
 * spaces - e.g. "4k UHD", "BLu-Ray", "DVD  (custom Burn)"). Normalizes every row to the
 * canonical spelling from packages/shared/src/titleParsing.ts's FORMAT_ALIASES - the same
 * table normal syncs now apply automatically, so this only had messy pre-existing rows
 * left to fix, not an ongoing problem.
 *
 * The one row with a genuinely blank Format cell ("Justice League Paradise Lost (episode
 * Collection)") isn't touched by FORMAT_ALIASES (there's nothing to normalize a blank
 * string to) - confirmed directly with the user that it's a DVD, so it's special-cased
 * here by title match rather than assuming every future blank format defaults to DVD.
 *
 * Run by hand: `npx tsx src/backfill-format-normalization.ts` from scripts/, then re-run
 * `npm run sync:sheet` from the repo root to push the corrected rows into Supabase.
 */

import "dotenv/config";
import { google } from "googleapis";
import { buildColumnIndexes, columnLetter, normalizeFormat } from "@danflix/shared";

const BLANK_FORMAT_FIX: Record<string, string> = {
  "Justice League Paradise Lost (episode Collection)": "DVD",
};

async function main() {
  const {
    GOOGLE_SERVICE_ACCOUNT_EMAIL,
    GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY,
    GOOGLE_SHEET_ID,
    GOOGLE_SHEET_RANGE,
  } = process.env;

  if (
    !GOOGLE_SERVICE_ACCOUNT_EMAIL ||
    !GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY ||
    !GOOGLE_SHEET_ID ||
    !GOOGLE_SHEET_RANGE
  ) {
    console.error("Missing required env vars - see .env.example.");
    process.exit(1);
  }

  const sheetTabName = GOOGLE_SHEET_RANGE.split("!")[0];
  const auth = new google.auth.JWT({
    email: GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY.replace(/\\n/g, "\n"),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const sheets = google.sheets({ version: "v4", auth });

  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId: GOOGLE_SHEET_ID,
    range: GOOGLE_SHEET_RANGE,
  });
  const rows = data.values ?? [];
  const header = rows[0];
  const columnIndexes = buildColumnIndexes(header);
  const formatCol = columnIndexes["format"];
  const titleCol = columnIndexes["title"];

  if (formatCol === undefined) {
    console.error("Format column not found.");
    process.exit(1);
  }

  const updates: { range: string; values: string[][] }[] = [];
  const report: { title: string; before: string; after: string }[] = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const title = row[titleCol] ?? "(untitled)";
    const current = row[formatCol] ?? "";

    const target = current.trim() === "" ? BLANK_FORMAT_FIX[title] : normalizeFormat(current);
    if (!target || target === current) continue;

    const sheetRow = i + 1;
    updates.push({ range: `${sheetTabName}!${columnLetter(formatCol)}${sheetRow}`, values: [[target]] });
    report.push({ title, before: current, after: target });
  }

  if (updates.length === 0) {
    console.log("Nothing to normalize.");
    return;
  }

  console.log(`Updating ${report.length} row(s):`);
  const counts: Record<string, number> = {};
  for (const r of report) counts[`"${r.before}" -> "${r.after}"`] = (counts[`"${r.before}" -> "${r.after}"`] ?? 0) + 1;
  for (const [change, count] of Object.entries(counts)) console.log(`  ${count}x ${change}`);

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: GOOGLE_SHEET_ID,
    requestBody: { valueInputOption: "RAW", data: updates },
  });

  console.log(`Done. Re-run "npm run sync:sheet" from the repo root to push these into Supabase.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
