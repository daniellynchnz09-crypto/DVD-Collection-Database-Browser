/**
 * ONE-TIME migration script (already run against the real Sheet - kept for history/audit,
 * not meant to be re-run as a repeatable tool). formatValueForSheet's blanket
 * boolean -> "y"/"n" was silently wrong for Special Features specifically - the real
 * Sheet's existing convention there is full "Yes"/"No" (confirmed: 1587 "no"/1429 "yes" vs.
 * a single stray "y"), only noticed once a scan-confirmed row (Paper Planes) got written
 * with "y" instead. Also normalizes Steelbook to the same "Yes"/"No" convention for
 * consistency, since it's this project's own new column with only a handful of rows.
 *
 * Deliberately does NOT touch Collection/Title in a Collection - their headers literally
 * say "(y/n)" and the real data genuinely uses that abbreviated spelling as its dominant
 * convention, unlike Special Features/Steelbook.
 *
 * Run by hand: `npx tsx src/backfill-yesno-normalization.ts` from scripts/, then re-run
 * `npm run sync:sheet` from the repo root to push the corrected rows into Supabase.
 */

import "dotenv/config";
import { google } from "googleapis";
import { buildColumnIndexes, columnLetter } from "@danflix/shared";

const YES_VALUES = new Set(["y", "Y"]);
const NO_VALUES = new Set(["n", "N"]);

function toYesNo(current: string): string | null {
  if (YES_VALUES.has(current)) return "Yes";
  if (NO_VALUES.has(current)) return "No";
  return null;
}

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
  const titleCol = columnIndexes["title"];

  const targetCols: { field: string; col: number }[] = [
    { field: "special_features", col: columnIndexes["special_features"] },
    { field: "steelbook", col: columnIndexes["steelbook"] },
  ].filter((t): t is { field: string; col: number } => t.col !== undefined);

  const updates: { range: string; values: string[][] }[] = [];
  const report: { title: string; field: string; before: string; after: string }[] = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    for (const { field, col } of targetCols) {
      const current = (row[col] ?? "").trim();
      const target = toYesNo(current);
      if (!target || target === current) continue;

      const sheetRow = i + 1;
      updates.push({ range: `${sheetTabName}!${columnLetter(col)}${sheetRow}`, values: [[target]] });
      report.push({ title: row[titleCol] ?? "(untitled)", field, before: current, after: target });
    }
  }

  if (updates.length === 0) {
    console.log("Nothing to normalize.");
    return;
  }

  console.log(`Updating ${report.length} cell(s):`);
  for (const r of report) console.log(`  ${r.title} (${r.field}): "${r.before}" -> "${r.after}"`);

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
