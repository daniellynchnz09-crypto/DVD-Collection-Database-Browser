import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { requireScanSecret } from "@/lib/scanAuth";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { buildColumnIndexes, cleanCell, parseSheetRowToTitle } from "@danflix/shared";

/**
 * Sheet -> DB half of the bidirectional sync (Claude/TECH STACK AND ARCHITECTURE.md's
 * "GOOGLE SHEET SYNC" section). Called by the onEdit Apps Script trigger
 * (apps/sheet-scripts/onEdit.gs) on every manual edit, so the database never goes stale
 * relative to hand-made Sheet edits, not just app-originated writes.
 *
 * The Apps Script sends the current header row (so column meaning is always read live,
 * not assumed) plus the single edited row's values. If that row has no Unique Identifier
 * yet, one is generated here and returned for the Apps Script to write into the cell
 * itself (it already has direct sheet access - no need to round-trip through the
 * Sheets API a second time for a single cell).
 */
export async function POST(request: Request) {
  const authError = requireScanSecret(request);
  if (authError) return authError;

  const body = await request.json().catch(() => null);
  const header: string[] = Array.isArray(body?.header) ? body.header : [];
  const row: string[] = Array.isArray(body?.row) ? body.row : [];
  if (header.length === 0 || row.length === 0) {
    return NextResponse.json({ error: "header and row are required" }, { status: 400 });
  }

  const columnIndexes = buildColumnIndexes(header);
  const uniqueIdColIndex = columnIndexes["unique_id"];
  if (uniqueIdColIndex === undefined) {
    return NextResponse.json(
      { error: 'Sheet is missing a "Unique Identifier" column - run the sync script first.' },
      { status: 400 }
    );
  }

  const existingUniqueId = cleanCell(row[uniqueIdColIndex]);
  const uniqueId = existingUniqueId ?? randomUUID();
  const isNew = existingUniqueId == null;

  const title = parseSheetRowToTitle(row, columnIndexes, uniqueId);
  const supabase = getSupabaseServerClient();
  const { error } = await supabase.from("titles").upsert(title, { onConflict: "unique_id" });
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ uniqueId, isNew });
}
