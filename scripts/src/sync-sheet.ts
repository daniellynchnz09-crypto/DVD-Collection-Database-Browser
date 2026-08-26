/**
 * One-way sync: Google Sheet -> Supabase `titles` table.
 *
 * This is Phase 0's sync direction per Claude/TECH STACK AND ARCHITECTURE.md -
 * the ~3,000 existing entries live in the Sheet, so this script is how they get
 * into Postgres for the first time. Bidirectional sync (writes originating from
 * the app pushed back to the Sheet) is a later phase, once barcode scanning and
 * Direct Database Access exist.
 *
 * Prerequisites (see Claude/STEP BY STEP PROCESS AND AUTOMATION.md "UPDATING THE
 * GOOGLE SHEET" step 1):
 *   - The Sheet's header row must include a "Unique Identifier" column. Rows that
 *     don't have one yet get a UUID generated here and written back to the Sheet,
 *     so re-running this script is idempotent and re-scans aren't needed later.
 *   - A Google Cloud service account with Sheets API access, shared as an editor
 *     on the spreadsheet (needed because we write the generated unique_id back).
 *
 * Required env vars (see .env.example):
 *   GOOGLE_SERVICE_ACCOUNT_EMAIL
 *   GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY
 *   GOOGLE_SHEET_ID
 *   GOOGLE_SHEET_RANGE        (e.g. "All DVDs and Specs!A1:AF5000" - include the header row)
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY (service role, not anon - this script bypasses RLS deliberately)
 *
 * This script is NOT wired into a scheduler yet - it's meant to be run by hand
 * (`npm run sync:sheet` from the repo root) until the trigger design (Google Apps
 * Script onEdit -> this logic, per TECH STACK AND ARCHITECTURE.md) is built.
 */

import { randomUUID } from "node:crypto";
import { google } from "googleapis";
import { createClient } from "@supabase/supabase-js";

// Maps the Sheet's header text (Claude/RESOURCES.md column names) to our DB column names.
// Extend this if new columns are added to the Sheet.
const HEADER_TO_COLUMN: Record<string, string> = {
  "Unique Identifier": "unique_id",
  "Title": "title",
  "Movie or TV": "movie_or_tv",
  "Season No.": "season_no",
  "Part of a Season No.": "part_of_season_no",
  "Episode Count": "episode_count",
  "Release Date": "release_date",
  "Running time": "running_time_mins",
  "Genre": "genre",
  "Director": "director",
  "Franchise": "franchise",
  "Sub-franchise": "sub_franchise",
  "Rating": "rating",
  "Format": "format",
  "Disc Count": "disc_count",
  "Special Features": "special_features",
  "Special Features Disk Count": "special_features_disc_count",
  "Special Features Disk Format": "special_features_disc_format",
  "Animation or live action": "animation_or_live_action",
  "Documentary": "documentary",
  "Collection": "is_collection",
  "Name of collection": "name_of_collection",
  "Title in a collection": "title_in_a_collection",
  "Number of titles in a collection": "number_of_titles_in_collection",
  "Rotten Tomatoes Page": "rotten_tomatoes_page",
  "IMDB page": "imdb_page",
  "Studio": "studio",
  "Disk region": "disk_region",
  "Barcode Identifier": "barcode_id",
  "Genre Location": "genre_location",
};

const NA_VALUES = new Set(["", "n/a", "N/A", "na"]);
const YES_VALUES = new Set(["y", "yes", "Y", "Yes"]);

function cleanCell(value: string | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return NA_VALUES.has(trimmed) ? null : trimmed;
}

function toBoolean(value: string | undefined): boolean {
  const cleaned = cleanCell(value);
  return cleaned != null && YES_VALUES.has(cleaned);
}

function toInt(value: string | undefined): number | null {
  const cleaned = cleanCell(value);
  if (cleaned == null) return null;
  const n = parseInt(cleaned, 10);
  return Number.isNaN(n) ? null : n;
}

function toDate(value: string | undefined): string | null {
  // Sheet dates are dd/mm/yyyy per Claude/RESOURCES.md; Postgres wants yyyy-mm-dd.
  const cleaned = cleanCell(value);
  if (cleaned == null) return null;
  const [day, month, year] = cleaned.split("/");
  if (!day || !month || !year) return null;
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

function toList(value: string | undefined): string[] {
  const cleaned = cleanCell(value);
  if (cleaned == null) return [];
  return cleaned.split(",").map((s) => s.trim()).filter(Boolean);
}

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
  const columnIndexes: Record<string, number> = {};
  header.forEach((headerText, index) => {
    const column = HEADER_TO_COLUMN[headerText.trim()];
    if (column) columnIndexes[column] = index;
  });

  const uniqueIdColIndex = columnIndexes["unique_id"];
  if (uniqueIdColIndex === undefined) {
    console.error(
      'Sheet is missing a "Unique Identifier" header column - add it first, per ' +
        "STEP BY STEP PROCESS AND AUTOMATION.md's UPDATING THE GOOGLE SHEET section."
    );
    process.exit(1);
  }

  const dataRows = rows.slice(1);
  const uniqueIdBackfills: { row: number; uniqueId: string }[] = [];
  const upserts: Record<string, unknown>[] = [];

  dataRows.forEach((row, i) => {
    let uniqueId = cleanCell(row[uniqueIdColIndex]);
    if (!uniqueId) {
      uniqueId = randomUUID();
      uniqueIdBackfills.push({ row: i + 2, uniqueId }); // +2: 1-indexed, plus header row
    }

    upserts.push({
      unique_id: uniqueId,
      title: cleanCell(row[columnIndexes["title"]]),
      movie_or_tv: cleanCell(row[columnIndexes["movie_or_tv"]]) ?? "Movie",
      season_no: cleanCell(row[columnIndexes["season_no"]]),
      part_of_season_no: cleanCell(row[columnIndexes["part_of_season_no"]]),
      episode_count: toInt(row[columnIndexes["episode_count"]]),
      release_date: toDate(row[columnIndexes["release_date"]]),
      running_time_mins: toInt(row[columnIndexes["running_time_mins"]]),
      genre: toList(row[columnIndexes["genre"]]),
      director: toList(row[columnIndexes["director"]]),
      franchise: cleanCell(row[columnIndexes["franchise"]]),
      sub_franchise: cleanCell(row[columnIndexes["sub_franchise"]]),
      rating: cleanCell(row[columnIndexes["rating"]]),
      format: cleanCell(row[columnIndexes["format"]]) ?? "DVD",
      disc_count: toInt(row[columnIndexes["disc_count"]]) ?? 1,
      special_features: toBoolean(row[columnIndexes["special_features"]]),
      special_features_disc_count: toInt(row[columnIndexes["special_features_disc_count"]]),
      special_features_disc_format: cleanCell(row[columnIndexes["special_features_disc_format"]]),
      animation_or_live_action:
        cleanCell(row[columnIndexes["animation_or_live_action"]]) ?? "Live Action",
      documentary: cleanCell(row[columnIndexes["documentary"]]) ?? "n",
      is_collection: toBoolean(row[columnIndexes["is_collection"]]),
      name_of_collection: cleanCell(row[columnIndexes["name_of_collection"]]),
      title_in_a_collection: toBoolean(row[columnIndexes["title_in_a_collection"]]),
      number_of_titles_in_collection: toInt(row[columnIndexes["number_of_titles_in_collection"]]),
      rotten_tomatoes_page: cleanCell(row[columnIndexes["rotten_tomatoes_page"]]),
      imdb_page: cleanCell(row[columnIndexes["imdb_page"]]),
      studio: cleanCell(row[columnIndexes["studio"]]),
      disk_region: cleanCell(row[columnIndexes["disk_region"]]),
      barcode_id: cleanCell(row[columnIndexes["barcode_id"]]),
      genre_location: cleanCell(row[columnIndexes["genre_location"]]),
    });
  });

  console.log(`Parsed ${upserts.length} rows. Upserting into Supabase...`);
  const { error } = await supabase.from("titles").upsert(upserts, { onConflict: "unique_id" });
  if (error) {
    console.error("Supabase upsert failed:", error.message);
    process.exit(1);
  }

  if (uniqueIdBackfills.length > 0) {
    console.log(
      `Writing ${uniqueIdBackfills.length} generated unique_id value(s) back to the Sheet...`
    );
    const columnLetter = String.fromCharCode("A".charCodeAt(0) + uniqueIdColIndex);
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: GOOGLE_SHEET_ID,
      requestBody: {
        data: uniqueIdBackfills.map(({ row, uniqueId }) => ({
          range: `${GOOGLE_SHEET_RANGE.split("!")[0]}!${columnLetter}${row}`,
          values: [[uniqueId]],
        })),
        valueInputOption: "RAW",
      },
    });
  }

  console.log("Sync complete.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
