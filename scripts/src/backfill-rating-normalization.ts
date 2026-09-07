/**
 * ONE-TIME migration script (already run against the real Sheet - kept for history/audit,
 * not meant to be re-run as a repeatable tool). Rating had accumulated casing drift ("pg",
 * "m") and a couple of stray typos ("R`16", "Rr16") on top of the real NZ classification
 * scheme (G/PG/M/R13/R15/R16/R18/...). Normalizes every row to the canonical spelling from
 * packages/shared/src/titleParsing.ts's RATING_ALIASES - the same table normal syncs now
 * apply automatically, so this only had messy pre-existing rows left to fix.
 *
 * Run by hand: `npx tsx src/backfill-rating-normalization.ts` from scripts/, then re-run
 * `npm run sync:sheet` from the repo root to push the corrected rows into Supabase.
 */

import "dotenv/config";
import { google } from "googleapis";
import { buildColumnIndexes, columnLetter, normalizeRating } from "@danflix/shared";

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
  const ratingCol = columnIndexes["rating"];
  const titleCol = columnIndexes["title"];

  if (ratingCol === undefined) {
    console.error("Rating column not found.");
    process.exit(1);
  }

  const updates: { range: string; values: string[][] }[] = [];
  const report: { title: string; before: string; after: string }[] = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const current = row[ratingCol] ?? "";
    if (current.trim() === "") continue;

    const target = normalizeRating(current);
    if (!target || target === current) continue;

    const sheetRow = i + 1;
    updates.push({ range: `${sheetTabName}!${columnLetter(ratingCol)}${sheetRow}`, values: [[target]] });
    report.push({ title: row[titleCol] ?? "(untitled)", before: current, after: target });
  }

  if (updates.length === 0) {
    console.log("Nothing to normalize.");
    return;
  }

  console.log(`Updating ${report.length} row(s):`);
  for (const r of report) console.log(`  ${r.title}: "${r.before}" -> "${r.after}"`);

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
