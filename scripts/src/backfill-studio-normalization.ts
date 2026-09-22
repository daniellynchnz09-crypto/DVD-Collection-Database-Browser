/**
 * ONE-TIME migration script (kept for history/audit, not meant to be re-run as a repeatable
 * tool). An audit of the real Studio column (2026-09-20, prompted by the user noticing
 * separate "Universal"/"Universal Pictures" entries when picking a Collection header's
 * Distributor) found 891 distinct values across ~3,065 rows - most are genuinely distinct
 * real production companies (expected, not a bug), but a real chunk were casing drift, a
 * recurring capital-I typo ("FIlm" for "Film"), and letter-level typos of well-known studios.
 * Normalizes every row to the canonical spelling from packages/shared/src/titleParsing.ts's
 * STUDIO_ALIASES - the same table normal syncs/scans now apply automatically (wired into
 * parseSheetRowToTitle and the scan-confirm route), so this only had messy pre-existing rows
 * left to fix, not an ongoing problem. See STUDIO_ALIASES's own doc comment for the full
 * reasoning behind each merge decision, confirmed with the user where genuinely ambiguous
 * (parent/sub-brand pairs, Warner Bros./Metro-Goldwyn-Mayer's exact canonical spelling).
 *
 * Run by hand: `npx tsx src/backfill-studio-normalization.ts` from scripts/, then re-run
 * `npm run sync:sheet` from the repo root to push the corrected rows into Supabase.
 */

import "dotenv/config";
import { google } from "googleapis";
import { buildColumnIndexes, columnLetter, normalizeStudio } from "@danflix/shared";

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
  const studioCol = columnIndexes["studio"];
  const titleCol = columnIndexes["title"];

  if (studioCol === undefined) {
    console.error("Studio column not found.");
    process.exit(1);
  }

  const apply = process.argv.includes("--apply");
  const updates: { range: string; values: string[][] }[] = [];
  const report: { title: string; before: string; after: string }[] = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const title = row[titleCol] ?? "(untitled)";
    const current = row[studioCol] ?? "";
    if (current.trim() === "") continue;

    const target = normalizeStudio(current);
    if (!target || target === current) continue;

    const sheetRow = i + 1;
    updates.push({ range: `${sheetTabName}!${columnLetter(studioCol)}${sheetRow}`, values: [[target]] });
    report.push({ title, before: current, after: target });
  }

  if (updates.length === 0) {
    console.log("Nothing to normalize.");
    return;
  }

  console.log(`${apply ? "Updating" : "Would update"} ${report.length} row(s):`);
  const counts: Record<string, number> = {};
  for (const r of report) counts[`"${r.before}" -> "${r.after}"`] = (counts[`"${r.before}" -> "${r.after}"`] ?? 0) + 1;
  for (const [change, count] of Object.entries(counts).sort((a, b) => b[1] - a[1])) console.log(`  ${count}x ${change}`);

  if (!apply) {
    console.log("\nDry run only - re-run with --apply to write these changes to the Sheet.");
    return;
  }

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
