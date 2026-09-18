/**
 * ONE-TIME migration script (already run against the real Sheet - kept for history/audit, not
 * meant to be re-run as a repeatable tool). Built 2026-09-18 ahead of TV scanning support, after
 * auditing the live season_no/movie_or_tv/running_time_mins data turned up several real,
 * pre-existing conventions the original RESOURCES.md spec never named - resolved with the user
 * and now formalized in packages/shared/src/titleParsing.ts's SEASON_NO_ALIASES/
 * normalizeSeasonNo. See Claude/TECH STACK AND ARCHITECTURE/barcode-review-screen-fields.md's
 * TV Scanning section for the full discussion.
 *
 * Does four things:
 *   1. Runs every season_no cell through normalizeSeasonNo - fixes "various"/"Various" ->
 *      "Assorted", casing drift on "all"/"specials", and mis-punctuated multi-season lists
 *      ("1 and 2" -> "1,2", "6-7" -> "6,7").
 *   2. Three rows said the bare word "Multiple" (doesn't say which seasons at all, unlike a
 *      mis-punctuated list) - resolved by hand from each title's own wording, per the user's
 *      instruction to let the title decide "All" vs "Assorted": none of the three mention
 *      covering every season, so all three become "Assorted".
 *   3. "Miss Marple: The Blue Geranium" / "Miss Marples: The Pale Horse" were typed
 *      movie_or_tv="Movie" with the stray season_no="Unknown" - these are BBC TV movies IMDb
 *      groups into a nominal "series" with an "Unknown" season for exactly this kind of entry,
 *      which is why they looked odd in the Sheet. Reclassified to "TV Movie" with season_no
 *      cleared - the user separately flagged these (and the wider question of whether they
 *      should really be modeled as a 2-disc collection of 2 TV movies) for revisiting once
 *      Collection support is built - see Claude/To Do list.md's BACKLOG.
 *   4. Clears the legacy "long ig" running_time_mins value (wherever it appears, case-
 *      insensitive) to "n/a", per the user's explicit instruction.
 *
 * Run by hand: `npx tsx src/backfill-season-no-normalization.ts` from scripts/, then re-run
 * `npm run sync:sheet` from the repo root to push the corrected rows into Supabase.
 */

import "dotenv/config";
import { google } from "googleapis";
import { buildColumnIndexes, columnLetter, normalizeSeasonNo } from "@danflix/shared";

const MULTIPLE_TO_ASSORTED_TITLES = new Set([
  "Batman the Animated Series, Secrets of the Caped Crusader",
  "The Adventures of Timtin: The Calculus Affair, The Red Sea Sharks, Tintin in Tibet",
  "The Simpsons Treehouse of Horror",
]);

const RECLASSIFY_TO_TV_MOVIE_TITLES = new Set(["Miss Marple: The Blue Geranium", "Miss Marples: The Pale Horse"]);

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
  const seasonCol = columnIndexes["season_no"];
  const movieOrTvCol = columnIndexes["movie_or_tv"];
  const runtimeCol = columnIndexes["running_time_mins"];

  if (seasonCol === undefined || movieOrTvCol === undefined || runtimeCol === undefined) {
    console.error("Required column(s) not found (season_no / movie_or_tv / running_time_mins).");
    process.exit(1);
  }

  const updates: { range: string; values: string[][] }[] = [];
  const report: { title: string; field: string; before: string; after: string }[] = [];

  function queueUpdate(rowIndex: number, col: number, title: string, field: string, before: string, after: string) {
    if (after === before) return;
    const sheetRow = rowIndex + 1;
    updates.push({ range: `${sheetTabName}!${columnLetter(col)}${sheetRow}`, values: [[after]] });
    report.push({ title, field, before, after });
  }

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const title = row[titleCol] ?? "(untitled)";

    const seasonBefore = (row[seasonCol] ?? "").trim();
    if (MULTIPLE_TO_ASSORTED_TITLES.has(title)) {
      queueUpdate(i, seasonCol, title, "season_no", seasonBefore, "Assorted");
    } else if (RECLASSIFY_TO_TV_MOVIE_TITLES.has(title)) {
      queueUpdate(i, seasonCol, title, "season_no", seasonBefore, "n/a");
      const movieOrTvBefore = (row[movieOrTvCol] ?? "").trim();
      queueUpdate(i, movieOrTvCol, title, "movie_or_tv", movieOrTvBefore, "TV Movie");
    } else if (seasonBefore !== "") {
      const normalized = normalizeSeasonNo(seasonBefore) ?? "n/a";
      queueUpdate(i, seasonCol, title, "season_no", seasonBefore, normalized);
    }

    const runtimeBefore = (row[runtimeCol] ?? "").trim();
    if (/^long\s*ig$/i.test(runtimeBefore)) {
      queueUpdate(i, runtimeCol, title, "running_time_mins", runtimeBefore, "n/a");
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
