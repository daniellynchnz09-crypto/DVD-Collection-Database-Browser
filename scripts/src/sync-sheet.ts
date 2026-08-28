/**
 * One-way sync: Google Sheet -> Supabase `titles` table.
 *
 * This is Phase 0's sync direction per Claude/TECH STACK AND ARCHITECTURE.md -
 * the ~3,000 existing entries live in the Sheet, so this script is how they get
 * into Postgres for the first time. Bidirectional sync (writes originating from
 * the app pushed back to the Sheet) is Phase 1's `/api/sheet-webhook` route.
 *
 * Prerequisites:
 *   - A Google Cloud service account with Sheets API access, shared as an editor
 *     on the spreadsheet (needed because we write generated IDs back).
 *
 * If the Sheet doesn't yet have "Unique Identifier" / "Barcode Identifier" /
 * "Genre Location" header columns (per Claude/STEP BY STEP PROCESS AND
 * AUTOMATION.md "UPDATING THE GOOGLE SHEET" step 1), this script adds them
 * itself rather than requiring a manual edit first, and backfills a UUID into
 * every row's Unique Identifier cell. Re-running later is idempotent - rows
 * that already have a unique_id keep it.
 *
 * Header matching and field parsing live in packages/shared/src/titleParsing.ts,
 * shared with the sheet-webhook route so both interpret the Sheet identically.
 *
 * Required env vars (see .env.example):
 *   GOOGLE_SERVICE_ACCOUNT_EMAIL
 *   GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY
 *   GOOGLE_SHEET_ID
 *   GOOGLE_SHEET_RANGE        (e.g. "Sheet1!A1:AF5000" - include the header row)
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY (service role, not anon - this script bypasses RLS deliberately)
 *
 * This script is NOT wired into a scheduler yet - it's meant to be run by hand
 * (`npm run sync:sheet` from the repo root).
 */

import "dotenv/config";
import { randomUUID } from "node:crypto";
import { google } from "googleapis";
import { createClient } from "@supabase/supabase-js";
import {
  AUTO_CREATE_COLUMNS,
  buildColumnIndexes,
  cleanCell,
  columnLetter,
  parseSheetRowToTitle,
} from "@danflix/shared";

async function main() {
  const {
    GOOGLE_SERVICE_ACCOUNT_EMAIL,
    GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY,
    GOOGLE_SHEET_ID,
    GOOGLE_SHEET_RANGE,
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY,
  } = process.env;

  if (
    !GOOGLE_SERVICE_ACCOUNT_EMAIL ||
    !GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY ||
    !GOOGLE_SHEET_ID ||
    !GOOGLE_SHEET_RANGE ||
    !SUPABASE_URL ||
    !SUPABASE_SERVICE_ROLE_KEY
  ) {
    console.error(
      "Missing required env vars. Copy .env.example to .env, fill in the Google service " +
        "account + Sheet ID and Supabase service role key, then re-run."
    );
    process.exit(1);
  }

  const sheetTabName = GOOGLE_SHEET_RANGE.split("!")[0];

  const auth = new google.auth.JWT({
    email: GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY.replace(/\\n/g, "\n"),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const sheets = google.sheets({ version: "v4", auth });
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId: GOOGLE_SHEET_ID,
    range: GOOGLE_SHEET_RANGE,
  });
  const rows = data.values ?? [];
  if (rows.length < 2) {
    console.log("No data rows found (sheet needs a header row plus at least one entry).");
    return;
  }

  const header = rows[0];
  const columnIndexes = buildColumnIndexes(header);

  // Add any missing auto-create columns to the Sheet itself, appending after the
  // last existing column, and queue their header-cell writes.
  const headerWrites: { range: string; values: string[][] }[] = [];
  let nextColIndex = header.length;
  for (const { field, headerText } of AUTO_CREATE_COLUMNS) {
    if (columnIndexes[field] !== undefined) continue;
    columnIndexes[field] = nextColIndex;
    headerWrites.push({
      range: `${sheetTabName}!${columnLetter(nextColIndex)}1`,
      values: [[headerText]],
    });
    console.log(`Adding missing "${headerText}" column to the Sheet at column ${columnLetter(nextColIndex)}.`);
    nextColIndex++;
  }

  // A Sheet's grid (rows/columns it actually has cells for) is fixed independently of how
  // much data it holds, and writing past it is rejected outright - expand it first if the
  // new columns above would exceed the current grid size.
  if (headerWrites.length > 0) {
    const meta = await sheets.spreadsheets.get({ spreadsheetId: GOOGLE_SHEET_ID });
    const targetSheet = meta.data.sheets?.find((s) => s.properties?.title === sheetTabName);
    const sheetId = targetSheet?.properties?.sheetId;
    const currentColumnCount = targetSheet?.properties?.gridProperties?.columnCount ?? 0;
    if (sheetId != null && nextColIndex > currentColumnCount) {
      console.log(`Expanding sheet grid to ${nextColIndex} columns (was ${currentColumnCount}).`);
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: GOOGLE_SHEET_ID,
        requestBody: {
          requests: [
            {
              updateSheetProperties: {
                properties: { sheetId, gridProperties: { columnCount: nextColIndex } },
                fields: "gridProperties.columnCount",
              },
            },
          ],
        },
      });
    }
  }

  const uniqueIdColIndex = columnIndexes["unique_id"];

  const dataRows = rows.slice(1);
  const uniqueIdBackfills: { row: number; uniqueId: string }[] = [];
  const upserts: Record<string, unknown>[] = [];

  dataRows.forEach((row, i) => {
    let uniqueId = cleanCell(row[uniqueIdColIndex]);
    if (!uniqueId) {
      uniqueId = randomUUID();
      uniqueIdBackfills.push({ row: i + 2, uniqueId }); // +2: 1-indexed, plus header row
    }
    upserts.push(parseSheetRowToTitle(row, columnIndexes, uniqueId));
  });

  console.log(`Parsed ${upserts.length} rows. Upserting into Supabase...`);
  const { error } = await supabase.from("titles").upsert(upserts, { onConflict: "unique_id" });
  if (error) {
    console.error("Supabase upsert failed:", error.message);
    process.exit(1);
  }

  const writes = [
    ...headerWrites,
    ...uniqueIdBackfills.map(({ row, uniqueId }) => ({
      range: `${sheetTabName}!${columnLetter(uniqueIdColIndex)}${row}`,
      values: [[uniqueId]],
    })),
  ];

  if (writes.length > 0) {
    console.log(`Writing ${headerWrites.length} new column header(s) and ${uniqueIdBackfills.length} unique_id value(s) back to the Sheet...`);
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: GOOGLE_SHEET_ID,
      requestBody: { data: writes, valueInputOption: "RAW" },
    });
  }

  console.log("Sync complete.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
