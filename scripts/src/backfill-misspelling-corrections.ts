/**
 * ONE-TIME migration script (already run against the real Sheet - kept for history/audit,
 * not meant to be re-run as a repeatable tool). Applies the 197 corrections from the
 * collection-wide misspelling audit (Claude/To Do list.md, chat report "Title Proof") -
 * every title flagged as a genuine typo against TMDb's real movie/TV catalogue, except
 * "Devilship Pirates" and "The Compelete Claymation Minifigger Collection" (the user asked
 * for those two to be left alone).
 *
 * Matches by exact current title text (misspelling-corrections-data.json), so a title that
 * appears more than once in the Sheet (e.g. two physical copies of the same misspelled box
 * set) gets every matching row fixed, not just the first.
 *
 * Run by hand: `npx tsx src/backfill-misspelling-corrections.ts` from scripts/, then re-run
 * `npm run sync:sheet` from the repo root to push the corrected rows into Supabase.
 */

import "dotenv/config";
import { google } from "googleapis";
import { buildColumnIndexes, columnLetter } from "@danflix/shared";
import corrections from "./misspelling-corrections-data.json";

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

  const correctionMap = new Map(corrections.map((c) => [c.title, c.corrected]));

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
  const titleCol = columnIndexes["title"];

  if (titleCol === undefined) {
    console.error("Title column not found.");
    process.exit(1);
  }

  const updates: { range: string; values: string[][] }[] = [];
  const report: { before: string; after: string; row: number }[] = [];
  const matchedTitles = new Set<string>();

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const current = row[titleCol] ?? "";
    const corrected = correctionMap.get(current);
    if (!corrected || corrected === current) continue;

    const sheetRow = i + 1;
    updates.push({ range: `${sheetTabName}!${columnLetter(titleCol)}${sheetRow}`, values: [[corrected]] });
    report.push({ before: current, after: corrected, row: sheetRow });
    matchedTitles.add(current);
  }

  const unmatched = corrections.filter((c) => !matchedTitles.has(c.title));
  if (unmatched.length > 0) {
    console.log(`${unmatched.length} correction(s) had no matching row in the Sheet (title text may have drifted):`);
    for (const u of unmatched) console.log(`  "${u.title}"`);
  }

  if (updates.length === 0) {
    console.log("Nothing to correct.");
    return;
  }

  console.log(`Updating ${report.length} row(s):`);
  for (const r of report) console.log(`  row ${r.row}: "${r.before}" -> "${r.after}"`);

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
