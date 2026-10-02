/**
 * ONE-TIME sweep (2026-10-03): normalizes every title's Genre list with
 * packages/shared/src/titleParsing.ts's normalizeGenreList (casing/typo fixes, combined tags
 * like "Action/Crime" split apart, Kids -> Family and Fighting -> Martial Arts merges, non-genre
 * tags like director names dropped) - the same normalization every Sheet sync and scan
 * confirm now applies automatically via removeNonGenreTags, so this only has the messy
 * pre-existing rows to fix. Writes both Supabase and the Sheet's Genre cell so the two stay in
 * step. Dry run by default (prints every distinct change with its count), `--apply` writes.
 *
 * Usage: npx tsx src/backfill-genre-normalization.ts [--apply], from scripts/.
 */
import "dotenv/config";
import { google } from "googleapis";
import { createClient } from "@supabase/supabase-js";
import { buildColumnIndexes, cleanCell, columnLetter, formatFieldForSheet, removeNonGenreTags } from "@danflix/shared";

async function main() {
  const apply = process.argv.includes("--apply");
  const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

  const changes: { unique_id: string; title: string; before: string[]; after: string[] }[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from("titles").select("unique_id,title,genre").range(from, from + 999);
    if (error) throw error;
    for (const r of data ?? []) {
      const before = (r.genre ?? []) as string[];
      const after = removeNonGenreTags(before);
      if (JSON.stringify(before) !== JSON.stringify(after)) changes.push({ unique_id: r.unique_id, title: r.title, before, after });
    }
    if (!data || data.length < 1000) break;
  }

  const tagChanges: Record<string, number> = {};
  for (const c of changes) {
    const key = `${JSON.stringify(c.before)} -> ${JSON.stringify(c.after)}`;
    tagChanges[key] = (tagChanges[key] ?? 0) + 1;
  }
  for (const [change, count] of Object.entries(tagChanges).sort((a, b) => b[1] - a[1])) console.log(`  ${count}x ${change}`);
  if (!apply) {
    console.log(`\n${changes.length} row(s) would change. Dry run only - re-run with --apply.`);
    return;
  }

  const auth = new google.auth.JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL!,
    key: process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY!.replace(/\\n/g, "\n"),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const sheets = google.sheets({ version: "v4", auth });
  const range = process.env.GOOGLE_SHEET_RANGE!;
  const tab = range.split("!")[0];
  const { data: sd } = await sheets.spreadsheets.values.get({ spreadsheetId: process.env.GOOGLE_SHEET_ID!, range });
  const sheetRows = sd.values ?? [];
  const idx = buildColumnIndexes(sheetRows[0]);
  const rowById = new Map<string, number>();
  sheetRows.forEach((r, i) => {
    const id = i > 0 ? cleanCell(r[idx["unique_id"]]) : null;
    if (id) rowById.set(id, i);
  });

  const sheetUpdates: { range: string; values: string[][] }[] = [];
  for (const c of changes) {
    const { error } = await supabase.from("titles").update({ genre: c.after }).eq("unique_id", c.unique_id);
    if (error) throw error;
    const rowIndex = rowById.get(c.unique_id);
    if (rowIndex === undefined) {
      console.warn(`  no Sheet row for ${c.title} (${c.unique_id}) - Supabase updated only`);
      continue;
    }
    sheetUpdates.push({ range: `${tab}!${columnLetter(idx["genre"])}${rowIndex + 1}`, values: [[formatFieldForSheet("genre", c.after)]] });
  }
  for (let i = 0; i < sheetUpdates.length; i += 500) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: process.env.GOOGLE_SHEET_ID!,
      requestBody: { valueInputOption: "RAW", data: sheetUpdates.slice(i, i + 500) },
    });
  }
  console.log(`\nUpdated ${changes.length} row(s) in Supabase, ${sheetUpdates.length} in the Sheet.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
