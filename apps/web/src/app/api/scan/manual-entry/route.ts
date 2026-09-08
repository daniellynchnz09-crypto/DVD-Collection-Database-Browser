import { NextResponse } from "next/server";
import { requireScanSecret } from "@/lib/scanAuth";
import { getSupabaseServerClient } from "@/lib/supabaseServer";

/**
 * Creates a pending_scans row for a disc that was never scanned at all - the "+" button in
 * PendingScansScreen, for the user's own custom-burned DVDs that have no barcode
 * whatsoever (some aren't even listed on IMDb/OMDB/TMDb, being the user's own creations).
 * Inserted directly with status "needs_manual" and barcode null, bypassing "pending"
 * entirely - there is nothing for the resolver to look up (no barcode, no UPC listing), so
 * resolvePendingScansBatch's `.eq("status", "pending")` query never touches this row. The
 * empty resolved_candidates makes ConfirmScreen's needsTitleSearch (candidates.length === 0
 * && !upcProduct) true immediately, landing straight on the manual title-search step -
 * exactly the same flow as a barcode that scanned but returned no product data at all.
 */
export async function POST(request: Request) {
  const authError = requireScanSecret(request);
  if (authError) return authError;

  const supabase = getSupabaseServerClient();
  const { data, error } = await supabase
    .from("pending_scans")
    .insert({ barcode: null, status: "needs_manual", resolved_candidates: {} })
    .select("*")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ scan: data });
}
