/**
 * ONE-TIME migration script (already run against the real Sheet - kept for history/audit,
 * not meant to be re-run as a repeatable tool). Before the dedicated Steelbook column
 * existed, "Steelbook" was just a word typed into the Format cell (e.g. "DVD Steelbook",
 * "4K UHD (Steelbook)"). This finds every row where Format mentions it, strips the word
 * back out of Format, and sets Steelbook to "y" - per the user's own instruction when
 * this column was added (see Claude/TECH STACK AND ARCHITECTURE.md).
 *
 * Run by hand: `npx tsx src/backfill-steelbook.ts` from scripts/, then re-run
 * `npm run sync:sheet` from the repo root to push the corrected rows into Supabase.
 */

import "dotenv/config";
import { google } from "googleapis";
import { buildColumnIndexes, columnLetter } from "@danflix/shared";

function stripSteelbookFromFormat(format: string): string {
  return format
    .replace(/\(\s*steelbook\s*\)/i, "")
    .replace(/\bsteelbook\b/i, "")
    .replace(/\s+/g, " ")
    .trim();
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
  const formatCol = columnIndexes["format"];
  const steelbookCol = columnIndexes["steelbook"];
  const titleCol = columnIndexes["title"];

  if (formatCol === undefined || steelbookCol === undefined) {
    console.error('Format or Steelbook column not found - run "npm run sync:sheet" first.');
    process.exit(1);
  }

  const updates: { range: string; values: string[][] }[] = [];
  const report: { title: string; before: string; after: string }[] = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const format = row[formatCol] ?? "";
    if (!/steelbook/i.test(format)) continue;

    const cleaned = stripSteelbookFromFormat(format);
    const sheetRow = i + 1; // 1-indexed, +1 more for the header already accounted by i starting at 1

    updates.push({ range: `${sheetTabName}!${columnLetter(formatCol)}${sheetRow}`, values: [[cleaned]] });
    updates.push({ range: `${sheetTabName}!${columnLetter(steelbookCol)}${sheetRow}`, values: [["y"]] });
    report.push({ title: row[titleCol] ?? "(untitled)", before: format, after: cleaned });
  }

  if (updates.length === 0) {
    console.log("No rows mention Steelbook in Format - nothing to do.");
    return;
  }

  console.log(`Updating ${report.length} row(s):`);
  for (const r of report) {
    console.log(`  ${r.title}: "${r.before}" -> "${r.after}" (Steelbook: y)`);
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
