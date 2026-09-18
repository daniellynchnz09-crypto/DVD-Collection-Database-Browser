/**
 * ONE-TIME backfill (see 0022_add_rental_and_language_fields.sql / the TMDb auto-fill added
 * 2026-09-15 in packages/backend/src/tmdb.ts): sets `original_language = "English"` on five
 * specific titles the user confirmed by hand, rather than waiting for a rescan. Every title
 * listed here was verified beforehand to resolve to exactly one row - see TARGET_TITLES below
 * for the exact spelling matched (`eq`, not `ilike`, so this never guesses a near-match).
 *
 * These five aren't run back through the scan pipeline itself, so `original_language_is_manual`
 * is also set true (0023_add_original_language_is_manual.sql) - once that migration is applied,
 * this protects the value from ever being silently overwritten by a future refreshTmdbFields
 * pass. Harmless no-op if that column doesn't exist yet: this script drops it from the patch
 * automatically when Supabase reports the column is missing, and just sets original_language on
 * its own in that case (re-run once the migration is applied to fill in the flag too).
 *
 * Dry run by default; only writes with `--apply`. Also mirrors the change to the Google Sheet
 * when the Sheet env vars are present, same pattern as backfill-commando-rental.ts.
 *
 * Usage: npx tsx src/backfill-original-language.ts [--apply], from scripts/.
 */

import "dotenv/config";
import { google } from "googleapis";
import { createClient } from "@supabase/supabase-js";
import { AUTO_CREATE_COLUMNS, buildColumnIndexes, cleanCell, columnLetter, formatFieldForSheet } from "@danflix/shared";

const TARGET_TITLES = [
  "Paper Planes",
  "Casper's Haunted Christmas",
  "Avengers: Infinity War",
  "Thor: Ragnarok",
  "Captain Marvel",
];
const LANGUAGE = "English";

interface TitleRow {
  unique_id: string;
  title: string;
  original_language: string | null;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const {
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY,
    GOOGLE_SERVICE_ACCOUNT_EMAIL,
    GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY,
    GOOGLE_SHEET_ID,
    GOOGLE_SHEET_RANGE,
  } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY. Copy .env.example to .env and fill them in.");
    process.exit(1);
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const resolved: TitleRow[] = [];
  for (const title of TARGET_TITLES) {
    const { data, error } = await supabase
      .from("titles")
      .select("unique_id, title, original_language")
      .eq("title", title);
    if (error) {
      console.error(`Failed to query "${title}":`, error.message);
      process.exit(1);
    }
    const rows = (data ?? []) as TitleRow[];
    if (rows.length === 0) {
      console.error(`No row with the exact title "${title}" found - skipping it.`);
      continue;
    }
    if (rows.length > 1) {
      console.error(`Found ${rows.length} rows for "${title}" - refusing to guess which one, skipping it. Candidates:`);
      for (const r of rows) console.error(`  ${r.unique_id}`);
      continue;
    }
    resolved.push(rows[0]);
  }

  const toChange = resolved.filter((r) => r.original_language !== LANGUAGE);
  console.log(`${resolved.length}/${TARGET_TITLES.length} titles resolved; ${toChange.length} need the value set.`);
  for (const r of resolved) {
    console.log(`  "${r.title}": original_language ${r.original_language ?? "(null)"} -> ${LANGUAGE}`);
  }

  if (!apply) {
    console.log("\nDry run only - re-run with --apply to write these changes.");
    return;
  }
  if (toChange.length === 0) {
    console.log("Nothing to change.");
    return;
  }

  // original_language_is_manual (0023_add_original_language_is_manual.sql) may not exist on
  // this project yet - try the full patch first, and fall back to just original_language if
  // Supabase reports the column is missing, rather than failing the whole backfill.
  let includeManualFlag = true;
  let updated = 0;
  for (const row of toChange) {
    const patch: Record<string, unknown> = { original_language: LANGUAGE };
    if (includeManualFlag) patch.original_language_is_manual = true;

    const { error } = await supabase.from("titles").update(patch).eq("unique_id", row.unique_id);
    if (error && includeManualFlag && /original_language_is_manual/.test(error.message)) {
      console.warn("original_language_is_manual column doesn't exist yet - retrying without it for the rest of this run.");
      includeManualFlag = false;
      const { error: retryError } = await supabase
        .from("titles")
        .update({ original_language: LANGUAGE })
        .eq("unique_id", row.unique_id);
      if (retryError) {
        console.error(`Failed to update "${row.title}":`, retryError.message);
        continue;
      }
    } else if (error) {
      console.error(`Failed to update "${row.title}":`, error.message);
      continue;
    }
    updated++;
  }
  console.log(`Updated ${updated}/${toChange.length} titles rows in Supabase.`);

  if (GOOGLE_SERVICE_ACCOUNT_EMAIL && GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY && GOOGLE_SHEET_ID && GOOGLE_SHEET_RANGE) {
    console.log("Mirroring changes to the Sheet...");
    const sheetTabName = GOOGLE_SHEET_RANGE.split("!")[0];
    const auth = new google.auth.JWT({
      email: GOOGLE_SERVICE_ACCOUNT_EMAIL,
      key: GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY.replace(/\\n/g, "\n"),
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    const sheets = google.sheets({ version: "v4", auth });
    const { data: sheetData } = await sheets.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: GOOGLE_SHEET_RANGE,
    });
    const rowsData = sheetData.values ?? [];
    const header = rowsData[0] ?? [];
    const columnIndexes = buildColumnIndexes(header);
    const uniqueIdColIndex = columnIndexes["unique_id"];

    const headerWrites: { range: string; values: string[][] }[] = [];
    let nextColIndex = header.length;
    for (const { field, headerText } of AUTO_CREATE_COLUMNS) {
      if (field !== "original_language" || columnIndexes[field] !== undefined) continue;
      columnIndexes[field] = nextColIndex;
      headerWrites.push({ range: `${sheetTabName}!${columnLetter(nextColIndex)}1`, values: [[headerText]] });
      console.log(`Adding missing "${headerText}" column to the Sheet at column ${columnLetter(nextColIndex)}.`);
      nextColIndex++;
    }
    if (headerWrites.length > 0) {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: GOOGLE_SHEET_ID,
        requestBody: { valueInputOption: "RAW", data: headerWrites },
      });
    }

    const rowNumberByUniqueId = new Map<string, number>();
    rowsData.slice(1).forEach((r, i) => {
      const uid = cleanCell(r[uniqueIdColIndex]);
      if (uid) rowNumberByUniqueId.set(uid, i + 2);
    });

    const cellUpdates: { range: string; values: string[][] }[] = [];
    for (const row of toChange) {
      const rowNumber = rowNumberByUniqueId.get(row.unique_id);
      if (!rowNumber) {
        console.warn(`"${row.title}" has no matching Sheet row (unique_id not found there) - skipped.`);
        continue;
      }
      const colIndex = columnIndexes["original_language"];
      if (colIndex === undefined) continue;
      cellUpdates.push({
        range: `${sheetTabName}!${columnLetter(colIndex)}${rowNumber}`,
        values: [[formatFieldForSheet("original_language", LANGUAGE)]],
      });
    }
    if (cellUpdates.length > 0) {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: GOOGLE_SHEET_ID,
        requestBody: { valueInputOption: "RAW", data: cellUpdates },
      });
      console.log(`Wrote ${cellUpdates.length} cell updates to the Sheet.`);
    }
  } else {
    console.log("Google Sheet env vars not set - skipped mirroring to the Sheet.");
  }

  console.log("\nDone.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
