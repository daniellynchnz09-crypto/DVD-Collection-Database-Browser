import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { requireScanSecret } from "@/lib/scanAuth";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { uploadStagedCoverPhoto } from "@danflix/backend";

/**
 * Receives a cover photo's bytes straight from the device - the one genuinely new upload
 * path this feature needs. Every other scan/image route in this codebase only ever fetches
 * an image from a URL it already has server-side (the UPC listing's own photo); a camera-
 * captured cover photo has no URL at all, just local bytes, so this is the first route that
 * accepts an upload rather than a fetch target.
 *
 * Called once per capture, before any `pending_scans` row exists - ScannerScreen.tsx's scan
 * session accumulates a client-generated `sessionId` plus whatever's captured (barcode,
 * front/back cover paths) and only creates the real row once the user taps "Done" (see
 * session-finish/route.ts). `sessionId` here is purely a Storage-path namespace, never a DB
 * key - it lets a session's photos be uploaded as they're taken instead of batched until the
 * end, while still being easy to find and delete together if the session is cancelled or
 * superseded before it's ever finished.
 *
 * Plain JSON body (base64), matching every other scan route's convention, rather than
 * multipart - the client already has a base64 string in hand from expo-image-manipulator's
 * own `base64: true` crop/resize output, so there's nothing multipart would save here.
 */
export async function POST(request: Request) {
  const authError = requireScanSecret(request);
  if (authError) return authError;

  const body = await request.json().catch(() => null);
  const sessionId = typeof body?.sessionId === "string" ? body.sessionId.trim() : "";
  const imageBase64 = typeof body?.imageBase64 === "string" ? body.imageBase64 : "";
  const contentType = typeof body?.contentType === "string" ? body.contentType : "image/jpeg";
  if (!sessionId || !imageBase64) {
    return NextResponse.json({ error: "sessionId and imageBase64 are required" }, { status: 400 });
  }

  const supabase = getSupabaseServerClient();
  const bytes = Buffer.from(imageBase64, "base64");
  const path = `sessions/${sessionId}/${randomUUID()}.jpg`;

  const stagedPath = await uploadStagedCoverPhoto(supabase, path, bytes, contentType);
  if (!stagedPath) {
    return NextResponse.json({ error: "Failed to store the cover photo" }, { status: 500 });
  }

  return NextResponse.json({ stagedPath });
}

/**
 * Cleans up every staged photo for a session the user explicitly cancels before ever tapping
 * "Done" - the one abandonment path this feature can proactively clean up itself (a crashed
 * app with no chance to call this at all is an accepted, documented gap - see
 * barcode-scanning-pipeline.md). `sessionId` as a query param, matching case-image-preview's
 * own precedent for a simple GET-shaped input rather than requiring a body on a method that
 * doesn't always carry one reliably across clients.
 */
export async function DELETE(request: Request) {
  const authError = requireScanSecret(request);
  if (authError) return authError;

  const sessionId = new URL(request.url).searchParams.get("sessionId")?.trim();
  if (!sessionId) {
    return NextResponse.json({ error: "sessionId is required" }, { status: 400 });
  }

  const supabase = getSupabaseServerClient();
  const { data: files } = await supabase.storage.from("cover-scan-staging").list(`sessions/${sessionId}`);
  const paths = (files ?? []).map((f) => `sessions/${sessionId}/${f.name}`);
  if (paths.length > 0) {
    await supabase.storage.from("cover-scan-staging").remove(paths);
  }

  return NextResponse.json({ success: true });
}
