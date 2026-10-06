import { NextResponse } from "next/server";
import { requireScanSecret } from "@/lib/scanAuth";
import { getSupabaseServerClient } from "@/lib/supabaseServer";

/**
 * The scanner app's Pending Scans list (added 2026-10-06). The app used to read
 * `pending_scans` directly with the database's public (anon) key, but each row's
 * `resolved_candidates.existingMatch` holds a full copy of an already-catalogued title - private
 * columns included - and that key is embedded in the app bundle and the public website.
 * Migration 0044 removes the anon key's read access to `pending_scans`, so the list is served
 * here instead, behind the scan secret, using the service-role client.
 *
 * Body `{ idsOnly: true }` returns just the ids (SuccessScreen's "how many are left" count).
 */
export async function POST(request: Request) {
  const authError = requireScanSecret(request);
  if (authError) return authError;

  const body = await request.json().catch(() => null);
  const idsOnly = body?.idsOnly === true;

  const supabase = getSupabaseServerClient();
  const { data, error } = await supabase
    .from("pending_scans")
    .select(idsOnly ? "id" : "*")
    .in("status", ["resolved", "needs_manual"])
    .order("scanned_at", { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ scans: data ?? [] });
}
