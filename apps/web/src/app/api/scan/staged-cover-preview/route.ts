import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { downloadStagedCoverPhoto, STAGED_COVER_PATH_PATTERN } from "@danflix/backend";
import { IMAGE_RESPONSE_SECURITY_HEADERS, requireScanSecretHeaderOrQuery } from "@/lib/scanAuth";

/**
 * Serves a staged cover photo (the private `cover-scan-staging` bucket - see
 * coverStagingStorage.ts) to ConfirmScreen.tsx's "Your scanned item" image - added 2026-10-03
 * after a real "Pumping Iron" scan showed an empty box there: its UPC listing's only image was
 * Alibris's generic `no_image.gif` placeholder (a dead link), and the front cover the user had
 * photographed in the same session was never shown at all, even though that photo is exactly
 * what the confirm route promotes to the saved case image (a captured front cover always wins
 * over the listing photo). The staging bucket is private with no fetchable URL, so the photo
 * has to be streamed through here.
 *
 * Same auth as case-image-preview/route.ts: header OR `secret` query param, since a native
 * `<Image>` tag can't be trusted to deliver custom headers (see that route's own comment).
 * `path` is restricted to the exact `sessions/{sessionId}/{uuid}.jpg` shape cover-photo/route.ts
 * writes, so this can't be pointed at anything else in the bucket (or traverse out of it).
 * Nothing cached - staged photos are deleted once their scan reaches a terminal state.
 */
export async function GET(request: Request) {
  const authError = requireScanSecretHeaderOrQuery(request);
  if (authError) return authError;

  const path = new URL(request.url).searchParams.get("path") ?? "";
  if (!STAGED_COVER_PATH_PATTERN.test(path)) {
    return NextResponse.json({ error: "A valid staged cover path is required." }, { status: 400 });
  }

  const staged = await downloadStagedCoverPhoto(getSupabaseServerClient(), path);
  if (!staged) return NextResponse.json({ error: "Staged cover photo not found." }, { status: 404 });
  // Only a raster image type is echoed back (2026-10-07) - the stored type came from the upload
  // request, so anything else is served as plain JPEG rather than trusted.
  const contentType = /^image\/(jpeg|png|webp)$/i.test(staged.contentType) ? staged.contentType : "image/jpeg";
  return new NextResponse(new Uint8Array(staged.bytes), {
    headers: { "Content-Type": contentType, "Cache-Control": "no-store", ...IMAGE_RESPONSE_SECURITY_HEADERS },
  });
}
