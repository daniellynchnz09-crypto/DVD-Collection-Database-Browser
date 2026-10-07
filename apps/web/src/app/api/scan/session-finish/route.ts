import { NextResponse } from "next/server";
import { requireScanSecret } from "@/lib/scanAuth";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { logScanEvent } from "@/lib/scanLog";
import { deleteStagedCoverPhotos, STAGED_COVER_PATH_PATTERN } from "@danflix/backend";

// Each staged photo costs several Gemini calls at resolve time; no real session comes near this,
// it just stops one request from queueing an unbounded amount of work.
const MAX_STAGED_COVERS = 20;

/**
 * Renamed from /api/scan/queue (2026-09-28) as part of cover-photo scanning: ScannerScreen no
 * longer queues a barcode the instant it's detected. It now accumulates a whole scan session
 * client-side - a manually-captured barcode and/or any staged front/back cover photos already
 * uploaded via /api/scan/cover-photo - and calls this route exactly once, when the user taps
 * "Done". A session with no barcode at all is valid (cover-only); see decision 6 in
 * Claude/TECH STACK AND ARCHITECTURE/barcode-scanning-pipeline.md.
 *
 * Still creates exactly one `pending_scans` row, always status "pending" (even with
 * barcode: null) since a cover-only session still has real resolver work to do via
 * scanResolver.ts's cover-vision step - unlike manual-entry's "needs_manual", which has
 * nothing to look up at all.
 *
 * The stale-row supersede logic (unchanged from the old queue route - see its own original
 * comment) only runs when a barcode was actually captured this session, since it matches on
 * barcode. A superseded row's own staged cover photos are deleted too, not just the row -
 * otherwise re-scanning a barcode before its previous session ever reached "Done" would leak
 * that earlier session's staged photos forever.
 */
export async function POST(request: Request) {
  const authError = requireScanSecret(request);
  if (authError) return authError;

  const body = await request.json().catch(() => null);
  const barcode = typeof body?.barcode === "string" && body.barcode.trim() ? body.barcode.trim() : null;
  // Only paths shaped like cover-photo/route.ts's own output are kept (2026-10-07 security
  // pass): these get downloaded, promoted into case-images and deleted later, so an arbitrary
  // string here could point those steps at any other object in the staging bucket.
  const stagedCoverPaths: string[] = Array.isArray(body?.stagedCoverPaths)
    ? body.stagedCoverPaths
        .filter((p: unknown): p is string => typeof p === "string" && STAGED_COVER_PATH_PATTERN.test(p))
        .slice(0, MAX_STAGED_COVERS)
    : [];

  if (!barcode && stagedCoverPaths.length === 0) {
    return NextResponse.json(
      { error: "barcode or at least one staged cover photo is required" },
      { status: 400 }
    );
  }

  const supabase = getSupabaseServerClient();
  let replacedIds: string[] = [];

  if (barcode) {
    const { data: staleRows } = await supabase
      .from("pending_scans")
      .select("id, resolved_candidates, staged_cover_photos")
      .eq("barcode", barcode)
      .in("status", ["pending", "resolved", "needs_manual"]);

    replacedIds = (staleRows ?? []).map((row) => row.id as string);
    if (replacedIds.length > 0) {
      await supabase.from("pending_scans").delete().in("id", replacedIds);
      for (const row of staleRows ?? []) {
        const stalePaths = (row.staged_cover_photos as string[] | null) ?? [];
        if (stalePaths.length > 0) {
          await deleteStagedCoverPhotos(supabase, stalePaths);
        }
        logScanEvent({
          outcome: "superseded",
          pendingScanId: row.id as string,
          barcode,
          resolvedCandidates: row.resolved_candidates ?? null,
        });
      }
    }
  }

  const { data, error } = await supabase
    .from("pending_scans")
    .insert({ barcode, status: "pending", staged_cover_photos: stagedCoverPaths })
    .select("id")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ pendingScanId: data.id, replacedIds });
}
