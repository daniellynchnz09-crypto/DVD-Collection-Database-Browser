/**
 * ONE-TIME migration script (already run against the real Sheet - kept for history/audit,
 * not meant to be re-run as a repeatable tool). Animation/Live Action had accumulated the
 * same casing/typo drift Format and Rating already had - 13+ distinct misspellings of
 * "Live Action" alone ("Live Aciton", "LIve Action", "Live Acrion", "Lice Action", ...)
 * found while investigating why Casper's Haunted Christmas got logged with the wrong value
 * for this field. Normalizes every row to the canonical spelling from packages/shared/src/
 * titleParsing.ts's ANIMATION_ALIASES - deliberately leaves genuine hybrid descriptions
 * ("Live Action/Animation Hybrid", "2D Animation and 3D Animation", ...) untouched, since
 * those are real combination values, not typos.
 *
 * Run by hand: `npx tsx src/backfill-animation-normalization.ts` from scripts/, then re-run
 * `npm run sync:sheet` from the repo root to push the corrected rows into Supabase.
 */

import "dotenv/config";
import { google } from "googleapis";
import { buildColumnIndexes, columnLetter, normalizeAnimationOrLiveAction } from "@danflix/shared";

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
  const animCol = columnIndexes["animation_or_live_action"];
  const titleCol = columnIndexes["title"];

  if (animCol === undefined) {
    console.error("animation_or_live_action column not found.");
    process.exit(1);
  }

  const updates: { range: string; values: string[][] }[] = [];
  const report: { title: string; before: string; after: string }[] = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const current = row[animCol] ?? "";
    if (current.trim() === "") continue;

    const target = normalizeAnimationOrLiveAction(current);
    if (!target || target === current) continue;

    const sheetRow = i + 1;
    updates.push({ range: `${sheetTabName}!${columnLetter(animCol)}${sheetRow}`, values: [[target]] });
    report.push({ title: row[titleCol] ?? "(untitled)", before: current, after: target });
  }

  if (updates.length === 0) {
    console.log("Nothing to normalize.");
    return;
  }

  console.log(`Updating ${report.length} row(s):`);
  for (const r of report) console.log(`  ${r.title}: "${r.before}" -> "${r.after}"`);

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
