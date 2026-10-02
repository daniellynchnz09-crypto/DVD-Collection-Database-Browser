import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { downloadStagedCoverPhoto } from "@danflix/backend";

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
const STAGED_PATH_PATTERN = /^sessions\/[A-Za-z0-9_-]+\/[0-9a-f-]+\.jpg$/i;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const expectedSecret = process.env.SCAN_API_SECRET;
  if (!expectedSecret) {
    return NextResponse.json({ error: "SCAN_API_SECRET is not configured on the server." }, { status: 500 });
  }
  const providedSecret = request.headers.get("x-scan-secret") ?? url.searchParams.get("secret");
  if (providedSecret !== expectedSecret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const path = url.searchParams.get("path") ?? "";
  if (!STAGED_PATH_PATTERN.test(path)) {
    return NextResponse.json({ error: "A valid staged cover path is required." }, { status: 400 });
  }

  const staged = await downloadStagedCoverPhoto(getSupabaseServerClient(), path);
  if (!staged) return NextResponse.json({ error: "Staged cover photo not found." }, { status: 404 });
  return new NextResponse(new Uint8Array(staged.bytes), {
    headers: { "Content-Type": staged.contentType, "Cache-Control": "no-store" },
  });
}
