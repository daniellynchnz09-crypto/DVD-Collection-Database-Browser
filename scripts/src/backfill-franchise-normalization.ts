/**
 * ONE-TIME migration (kept for history/audit). Normalizes every Franchise tag in the Sheet to the
 * canonical spelling from packages/shared/src/titleParsing.ts's FRANCHISE_ALIASES (an audit on
 * 2026-09-20 found 733 distinct tags with 61 groups of look-alikes, e.g. four spellings of
 * Spider-Man), de-duplicating tags that merging makes identical. Sheet-first like the Studio/Format
 * backfills: run this, then `npm run sync:sheet` from the repo root to push into Supabase.
 * Dry run by default - `--apply` writes.
 *
 * Usage: npx tsx src/backfill-franchise-normalization.ts [--apply], from scripts/.
 */
import "dotenv/config";
import { google } from "googleapis";
import { buildColumnIndexes, columnLetter, normalizeFranchiseList, toList } from "@danflix/shared";

async function main() {
  const apply = process.argv.includes("--apply");
  const { GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY, GOOGLE_SHEET_ID, GOOGLE_SHEET_RANGE } = process.env;
  if (!GOOGLE_SERVICE_ACCOUNT_EMAIL || !GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || !GOOGLE_SHEET_ID || !GOOGLE_SHEET_RANGE) {
    console.error("Missing required env vars - see .env.example.");
    process.exit(1);
  }
  const tab = GOOGLE_SHEET_RANGE.split("!")[0];
  const auth = new google.auth.JWT({
    email: GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY.replace(/\n/g, "\n"),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const sheets = google.sheets({ version: "v4", auth });
  const { data } = await sheets.spreadsheets.values.get({ spreadsheetId: GOOGLE_SHEET_ID, range: GOOGLE_SHEET_RANGE });
  const rows = data.values ?? [];
  const idx = buildColumnIndexes(rows[0]);
  const col = idx["franchise"];
  const titleCol = idx["title"];
  if (col === undefined) { console.error("Franchise column not found."); process.exit(1); }

  const updates: { range: string; values: string[][] }[] = [];
  const changes = new Map<string, number>();
  for (let i = 1; i < rows.length; i++) {
    const current = rows[i][col] ?? "";
    if (!current.trim()) continue;
    const before = toList(current);
    const after = normalizeFranchiseList(before);
    if (before.join("|") === after.join("|")) continue;
    updates.push({ range: `${tab}!${columnLetter(col)}${i + 1}`, values: [[after.join(", ")]] });
    for (const b of before) if (!after.includes(b)) changes.set(`"${b}" -> ${after.map((a) => `"${a}"`).join(", ")}`, (changes.get(`"${b}" -> ${after.map((a) => `"${a}"`).join(", ")}`) ?? 0) + 1);
    void titleCol;
  }
  console.log(`${apply ? "Updating" : "Would update"} ${updates.length} row(s). Tag changes:`);
  for (const [c, n] of [...changes.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${n}x ${c}`);
  if (!apply) { console.log("\nDry run only - re-run with --apply."); return; }
  if (updates.length === 0) return;
  await sheets.spreadsheets.values.batchUpdate({ spreadsheetId: GOOGLE_SHEET_ID, requestBody: { valueInputOption: "RAW", data: updates } });
  console.log(`Done. Re-run "npm run sync:sheet" from the repo root to push these into Supabase.`);
}
main().catch((e) => { console.error(e); process.exit(1); });
