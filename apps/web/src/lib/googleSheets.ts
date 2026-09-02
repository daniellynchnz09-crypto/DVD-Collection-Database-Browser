import { google, sheets_v4 } from "googleapis";
import { columnLetter, formatFieldForSheet } from "@danflix/shared";

let cachedSheets: sheets_v4.Sheets | null = null;

/** Server-only authenticated Sheets client (service account) - see scripts/src/sync-sheet.ts. */
export function getSheetsClient(): sheets_v4.Sheets {
  if (cachedSheets) return cachedSheets;
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY;
  if (!email || !privateKey) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY not configured.");
  }
  const auth = new google.auth.JWT({
    email,
    key: privateKey.replace(/\\n/g, "\n"),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  cachedSheets = google.sheets({ version: "v4", auth });
  return cachedSheets;
}

export function getSheetConfig(): { sheetId: string; range: string; tabName: string } {
  const sheetId = process.env.GOOGLE_SHEET_ID;
  const range = process.env.GOOGLE_SHEET_RANGE;
  if (!sheetId || !range) {
    throw new Error("GOOGLE_SHEET_ID / GOOGLE_SHEET_RANGE not configured.");
  }
  return { sheetId, range, tabName: range.split("!")[0] };
}

/**
 * Appends one new row to the Sheet (after the last row with data - Sheets API handles
 * finding the right row for us) and returns the header row + column-index map used,
 * so callers can build the row array via buildSheetRowFromTitle.
 */
export async function getSheetHeaderAndColumns(): Promise<{
  header: string[];
  headerRowValues: string[][];
}> {
  const sheets = getSheetsClient();
  const { sheetId, tabName } = getSheetConfig();
  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${tabName}!1:1`,
  });
  const header = data.values?.[0] ?? [];
  return { header, headerRowValues: data.values ?? [[]] };
}

export async function appendRowToSheet(row: string[]): Promise<void> {
  const sheets = getSheetsClient();
  const { sheetId, tabName } = getSheetConfig();

  // values.append's own "find the table, append after it" auto-detection is unreliable
  // on this sheet: its grid is fixed at exactly 4000 rows, and appends kept landing at
  // row 4000 regardless of where the real data actually ended (confirmed live - it
  // misplaced the first real scan-confirmed row, "Paper Planes", leaving ~935 blank rows
  // above it). Computing the target row explicitly - via the Title column, which is
  // NOT NULL so it's non-blank on every real row - sidesteps that auto-detection
  // entirely instead of trying to out-guess it.
  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${tabName}!A:A`,
  });
  const nextRow = (data.values?.length ?? 1) + 1;

  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `${tabName}!${nextRow}:${nextRow}`,
    valueInputOption: "RAW",
    requestBody: { values: [row] },
  });
}

/**
 * Patches just a few cells of an existing Sheet row (found by matching the Unique
 * Identifier column), leaving every other cell untouched - for the barcode-backfill
 * "link to an existing entry" flow (Claude/TECH STACK AND ARCHITECTURE.md), which only
 * ever refreshes a handful of OMDB-sourced fields, never the whole row. Fields with no
 * Sheet column (e.g. case_image_url) are simply skipped. Returns false if no row in the
 * Sheet has that unique_id (shouldn't normally happen - every DB row was synced from the
 * Sheet originally - but callers should treat it as "the Sheet wasn't updated", not throw.
 */
export async function updateSheetFieldsByUniqueId(
  uniqueId: string,
  fields: Record<string, unknown>,
  header: string[],
  columnIndexes: Record<string, number>
): Promise<boolean> {
  const uniqueIdCol = columnIndexes["unique_id"];
  if (uniqueIdCol == null) return false;

  const sheets = getSheetsClient();
  const { sheetId, tabName } = getSheetConfig();
  const idColLetter = columnLetter(uniqueIdCol);

  const { data: idColumnData } = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${tabName}!${idColLetter}2:${idColLetter}`,
  });
  const ids = idColumnData.values ?? [];
  const rowOffset = ids.findIndex((r) => r[0] === uniqueId);
  if (rowOffset === -1) return false;
  const rowNumber = rowOffset + 2; // +1 for the header row, +1 for 1-indexing

  const { data: rowData } = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${tabName}!${rowNumber}:${rowNumber}`,
  });
  const row = rowData.values?.[0] ?? [];
  while (row.length < header.length) row.push("");

  for (const [field, value] of Object.entries(fields)) {
    const index = columnIndexes[field];
    if (index == null) continue;
    row[index] = formatFieldForSheet(field, value);
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `${tabName}!${rowNumber}:${rowNumber}`,
    valueInputOption: "RAW",
    requestBody: { values: [row] },
  });
  return true;
}
