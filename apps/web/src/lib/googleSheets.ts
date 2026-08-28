import { google, sheets_v4 } from "googleapis";

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
  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: tabName,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [row] },
  });
}
