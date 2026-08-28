import { NextResponse } from "next/server";
import { requireScanSecret } from "@/lib/scanAuth";
import { getSupabaseServerClient } from "@/lib/supabaseServer";

/**
 * Scan-then-resolve-later (see Claude/TECH STACK AND ARCHITECTURE.md): the mobile app
 * calls this on every camera scan and gets an instant response, so the UPC/OMDB lookup
 * rate limit never gates how fast the user can physically scan their shelves. Actual
 * lookup happens later via /api/scan/resolve.
 */
export async function POST(request: Request) {
  const authError = requireScanSecret(request);
  if (authError) return authError;

  const body = await request.json().catch(() => null);
  const barcode = typeof body?.barcode === "string" ? body.barcode.trim() : "";
  if (!barcode) {
    return NextResponse.json({ error: "barcode is required" }, { status: 400 });
  }

  const supabase = getSupabaseServerClient();
  const { data, error } = await supabase
    .from("pending_scans")
    .insert({ barcode, status: "pending" })
    .select("id")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ pendingScanId: data.id });
}
