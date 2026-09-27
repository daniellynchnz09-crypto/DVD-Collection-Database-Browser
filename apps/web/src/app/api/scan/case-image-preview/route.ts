import { NextResponse } from "next/server";
import { autocropImageBuffer } from "@danflix/backend";

/**
 * On-the-fly crop-preview proxy for `ConfirmScreen.tsx`'s "Your scanned item" image (added
 * 2026-09-22, per the user's own follow-up request right after the case-image auto-crop
 * shipped: "that way if it is cropped wrong I can give you an early warning"). Previously the
 * review screen showed the UPC listing's RAW image, white border and all, and only the
 * permanently-stored `case_image_path` (written at Confirm time, via `uploadCaseImage`) was
 * ever cropped - meaning a bad crop would only ever be discovered after it was already saved.
 *
 * Deliberately a pure GET pass-through, not a Storage write - nothing here is cached or
 * persisted; every request re-fetches the source URL and re-crops it fresh with the exact
 * same `autocropImageBuffer` (`imageCrop.ts`) the real storage path uses, so what's shown here
 * is a true preview of what Confirm would actually save, not a separate/approximate version
 * of it. A GET (not the usual POST) so it can be used directly as a React Native `<Image
 * source={{uri}}>` - the secret still gates it via the same `x-scan-secret` header every other
 * scan route uses (RN's `Image` source supports a `headers` field), rather than putting the
 * secret in the URL's own query string where it could end up in logs.
 *
 * `url` must be `http(s)` - a basic sanity check, not a hardened SSRF defense (this app has no
 * untrusted external users; the `url` value only ever comes from this app's own
 * UPCitemdb-sourced `upcProduct.imageUrl`), but cheap enough to keep regardless.
 *
 * Auth accepts the secret via `x-scan-secret` header OR a `secret` query param, unlike every
 * other scan route (which is header-only via `requireScanSecret`). Found live 2026-09-23: the
 * header this route was originally written to require never actually reaches the server from a
 * real device - React Native's `<Image source={{uri, headers}}>` does NOT reliably attach custom
 * headers to the native image-fetch request on Android (unlike `Image.getSizeWithHeaders`, a
 * separate native call that does send them correctly, which is why the image box sized itself
 * right while the photo itself came back 401 and never rendered, showing the placeholder's dark
 * background instead). A query param is the only auth channel a native `<Image>` tag can reach
 * reliably on both platforms - the header the client still sends is harmless, cheap-to-keep
 * defense in depth for platforms/paths where it does work.
 *
 * A general scan-pipeline route, not an Estimated Value one - ships in both the public and
 * private builds like every other `/api/scan/*` route, no sanitizer exclusion needed.
 */
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

  const imageUrl = url.searchParams.get("url");
  if (!imageUrl || !/^https?:\/\//i.test(imageUrl)) {
    return NextResponse.json({ error: "A valid http(s) url query param is required." }, { status: 400 });
  }

  try {
    const res = await fetch(imageUrl);
    if (!res.ok) return NextResponse.json({ error: `Source image fetch failed (${res.status}).` }, { status: 502 });
    const contentType = res.headers.get("content-type") ?? "image/jpeg";
    const rawBytes = Buffer.from(await res.arrayBuffer());
    const cropped = await autocropImageBuffer(rawBytes, contentType);
    return new NextResponse(new Uint8Array(cropped), {
      headers: { "Content-Type": contentType, "Cache-Control": "no-store" },
    });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
