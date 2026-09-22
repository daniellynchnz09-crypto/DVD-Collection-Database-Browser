/**
 * ONE-TIME sweep (2026-09-20): "Animation" is a medium, not a genre - removes it from the Genre list
 * of every row that still has it (Supabase + Sheet). Dry run by default, `--apply` writes.
 * Usage: npx tsx src/backfill-remove-animation-genre.ts [--apply], from scripts/.
 */
import "dotenv/config";
import { google } from "googleapis";
import { createClient } from "@supabase/supabase-js";
import { buildColumnIndexes, cleanCell, columnLetter, formatFieldForSheet, removeNonGenreTags } from "@danflix/shared";

async function main() {
  const apply = process.argv.includes("--apply");
  const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const hits: { unique_id: string; title: string; genre: string[]; animation_or_live_action: string | null }[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from("titles").select("unique_id,title,genre,animation_or_live_action").range(from, from + 999);
    if (error) throw error;
    for (const r of data ?? []) if ((r.genre ?? []).some((g: string) => /^animation$/i.test(g.trim()))) hits.push(r as any);
    if (!data || data.length < 1000) break;
  }
  for (const h of hits) console.log(`  ${h.title}  genre ${JSON.stringify(h.genre)} -> ${JSON.stringify(removeNonGenreTags(h.genre))}  (style: ${h.animation_or_live_action})`);
  if (!apply) { console.log(`\n${hits.length} row(s). Dry run only - re-run with --apply.`); return; }
  const auth = new google.auth.JWT({ email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL!, key: process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY!.replace(/\n/g, "\n"), scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
  const sheets = google.sheets({ version: "v4", auth });
  const range = process.env.GOOGLE_SHEET_RANGE!;
  const tab = range.split("!")[0];
  const { data: sd } = await sheets.spreadsheets.values.get({ spreadsheetId: process.env.GOOGLE_SHEET_ID!, range });
  const sheetRows = sd.values ?? [];
  const idx = buildColumnIndexes(sheetRows[0]);
  for (const h of hits) {
    const genre = removeNonGenreTags(h.genre);
    const { error } = await supabase.from("titles").update({ genre }).eq("unique_id", h.unique_id);
    if (error) throw error;
    const rowIndex = sheetRows.findIndex((r, i) => i > 0 && cleanCell(r[idx["unique_id"]]) === h.unique_id);
    if (rowIndex === -1) { console.warn(`no Sheet row for ${h.title}`); continue; }
    await sheets.spreadsheets.values.update({ spreadsheetId: process.env.GOOGLE_SHEET_ID!, range: `${tab}!${columnLetter(idx["genre"])}${rowIndex + 1}`, valueInputOption: "RAW", requestBody: { values: [[formatFieldForSheet("genre", genre)]] } });
  }
  console.log(`\nUpdated ${hits.length} row(s).`);
}
main().catch((e) => { console.error(e); process.exit(1); });
