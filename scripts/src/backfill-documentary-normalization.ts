/**
 * ONE-TIME migration script (already run against the real Sheet - kept for history/audit, not
 * meant to be re-run as a repeatable tool). The `documentary` column had never had an alias
 * table at all (unlike Rating/Animation/Format) - a full distinct-value audit of the real
 * ~3,077-row collection (2026-09-30, prompted by a real "Piece by Piece" scan that stayed
 * hardcoded "n" despite being a genuine biopic) found several typo'd/near-duplicate variants of
 * the same real claim, plus a trailing "?" a few rows used informally to flag the
 * data-enterer's own uncertainty. Every mapping applied here was confirmed directly with the
 * user first (see DOCUMENTARY_ALIASES's own comment in packages/shared/src/titleParsing.ts for
 * the full reasoning and the real audit behind each one).
 *
 * Does two passes per row:
 * 1. Normalizes whatever's already typed via `normalizeDocumentary` (typo/casing/near-duplicate
 *    cleanup - e.g. "Biopic"/"biography" -> "Biography", the whole "based on true events"
 *    family -> "Based on True Events", a trailing "?" stripped).
 * 2. ONLY for a row that's still exactly "n" (or blank) after step 1 - i.e. never overrides an
 *    already-deliberate non-"n" value someone chose by hand - tries `deriveDocumentaryValue`
 *    against the row's own Genre/Movie-or-TV columns, the same auto-fill logic
 *    `/api/scan/confirm` now applies to every future scan. This is what actually fixes Piece by
 *    Piece (genre: Biography, Comedy, Music, Documentary -> "Biography") and every other
 *    already-catalogued row whose Genre/Movie-or-TV already implied a Documentary/Biography
 *    answer that nothing had ever written down.
 *
 * Run by hand: `npx tsx src/backfill-documentary-normalization.ts [--apply]` from scripts/, then
 * re-run `npm run sync:sheet` from the repo root to push the corrected rows into Supabase.
 * Dry-run by default (prints what would change, writes nothing) - unlike the animation-
 * normalization script this was copied from, this one's real impact wasn't known ahead of time,
 * so `--apply` is required to actually write.
 */

import "dotenv/config";
import { google } from "googleapis";
import { buildColumnIndexes, columnLetter, deriveDocumentaryValue, normalizeDocumentary, toList } from "@danflix/shared";

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
  const docCol = columnIndexes["documentary"];
  const genreCol = columnIndexes["genre"];
  const movieOrTvCol = columnIndexes["movie_or_tv"];
  const titleCol = columnIndexes["title"];

  if (docCol === undefined || genreCol === undefined || movieOrTvCol === undefined) {
    console.error("documentary/genre/movie_or_tv column not found.");
    process.exit(1);
  }

  const updates: { range: string; values: string[][] }[] = [];
  const report: { title: string; before: string; after: string }[] = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const current = row[docCol] ?? "";

    let target = normalizeDocumentary(current) ?? "n";
    if (target === "n") {
      const derived = deriveDocumentaryValue(toList(row[genreCol]), row[movieOrTvCol] || "Movie");
      if (derived !== "n") target = derived;
    }

    if (target === current) continue;

    const sheetRow = i + 1;
    updates.push({ range: `${sheetTabName}!${columnLetter(docCol)}${sheetRow}`, values: [[target]] });
    report.push({ title: row[titleCol] ?? "(untitled)", before: current || "(blank)", after: target });
  }

  if (updates.length === 0) {
    console.log("Nothing to normalize.");
    return;
  }

  const apply = process.argv.includes("--apply");
  console.log(`${apply ? "Updating" : "Would update"} ${report.length} row(s):`);
  for (const r of report) console.log(`  ${r.title}: "${r.before}" -> "${r.after}"`);

  if (!apply) {
    console.log("\nDry run only - re-run with --apply to write these changes.");
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
