import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { requireScanSecret } from "@/lib/scanAuth";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { STAGED_SESSION_ID_PATTERN, uploadStagedCoverPhoto } from "@danflix/backend";

// A full-resolution phone photo at quality 0.9 is a few MB; base64 adds a third. 25M characters
// (~18MB of image) leaves plenty of room while still bounding one request.
const MAX_UPLOAD_BODY_CHARS = 25_000_000;
const ALLOWED_UPLOAD_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

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

  // Size checked off the declared length before the body is parsed, then again on the decoded
  // bytes (2026-10-07 security pass) - nothing else limits how much one request can make the
  // server buffer and push into Storage.
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_UPLOAD_BODY_CHARS) {
    return NextResponse.json({ error: "That photo is too large." }, { status: 413 });
  }

  const body = await request.json().catch(() => null);
  const sessionId = typeof body?.sessionId === "string" ? body.sessionId.trim() : "";
  const imageBase64 = typeof body?.imageBase64 === "string" ? body.imageBase64 : "";
  const requestedType = typeof body?.contentType === "string" ? body.contentType.toLowerCase() : "image/jpeg";
  if (!sessionId || !imageBase64) {
    return NextResponse.json({ error: "sessionId and imageBase64 are required" }, { status: 400 });
  }
  // sessionId becomes part of a Storage path, so it must be the app's own id shape - no `/` or
  // `..` to reach outside this session's folder.
  if (!STAGED_SESSION_ID_PATTERN.test(sessionId)) {
    return NextResponse.json({ error: "Invalid sessionId" }, { status: 400 });
  }
  // The stored type is what staged-cover-preview serves the photo back as, so only real photo
  // types are kept (the app always sends image/jpeg).
  const contentType = ALLOWED_UPLOAD_TYPES.has(requestedType) ? requestedType : "image/jpeg";
  if (imageBase64.length > MAX_UPLOAD_BODY_CHARS) {
    return NextResponse.json({ error: "That photo is too large." }, { status: 413 });
  }

  const supabase = getSupabaseServerClient();
  const bytes = Buffer.from(imageBase64, "base64");
  if (bytes.length === 0) {
    return NextResponse.json({ error: "imageBase64 isn't valid image data" }, { status: 400 });
  }
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
  if (!STAGED_SESSION_ID_PATTERN.test(sessionId)) {
    return NextResponse.json({ error: "Invalid sessionId" }, { status: 400 });
  }

  const supabase = getSupabaseServerClient();
  const { data: files } = await supabase.storage.from("cover-scan-staging").list(`sessions/${sessionId}`);
  const paths = (files ?? []).map((f) => `sessions/${sessionId}/${f.name}`);
  if (paths.length > 0) {
    await supabase.storage.from("cover-scan-staging").remove(paths);
  }

  return NextResponse.json({ success: true });
}
