import { NextResponse } from "next/server";
import { requireScanSecret } from "@/lib/scanAuth";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { extractDiscCountHint, extractFormatHint, normalizeTitleForMatch } from "@danflix/shared";

/**
 * Backfill matching (Claude/TECH STACK AND ARCHITECTURE.md): before creating a brand-new
 * title for a scanned disc, check whether it's actually a disc for a title you already
 * catalogued (e.g. entered from the Sheet years ago, never scanned). Matches by base title
 * text first (ignoring cut-suffix differences - see normalizeTitleForMatch), then narrows
 * using format/disc-count hints pulled from the UPC product text, only when doing so
 * actually narrows the set (an unreliable hint should never zero out a real candidate).
 */
export async function POST(request: Request) {
  const authError = requireScanSecret(request);
  if (authError) return authError;

  const body = await request.json().catch(() => null);
  const title = typeof body?.title === "string" ? body.title : null;
  const upcText = typeof body?.upcText === "string" ? body.upcText : "";
  if (!title) {
    return NextResponse.json({ error: "title is required" }, { status: 400 });
  }

  const supabase = getSupabaseServerClient();
  const { data: rows, error } = await supabase
    .from("titles")
    .select("unique_id, title, format, disc_count")
    .is("barcode_id", null);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const target = normalizeTitleForMatch(title);
  const candidates = (rows ?? []).filter((r) => normalizeTitleForMatch(r.title) === target);
  if (candidates.length === 0) {
    return NextResponse.json({ status: "none" });
  }

  const formatHint = extractFormatHint(upcText);
  const discCountHint = extractDiscCountHint(upcText);

  let narrowed = candidates;
  if (formatHint) {
    const byFormat = narrowed.filter((r) => r.format?.toLowerCase() === formatHint.toLowerCase());
    if (byFormat.length > 0) narrowed = byFormat;
  }
  if (discCountHint != null) {
    const byDiscCount = narrowed.filter((r) => r.disc_count === discCountHint);
    if (byDiscCount.length > 0) narrowed = byDiscCount;
  }

  if (narrowed.length === 1) {
    return NextResponse.json({ status: "auto", match: narrowed[0] });
  }
  return NextResponse.json({ status: "ambiguous", candidates: narrowed });
}
