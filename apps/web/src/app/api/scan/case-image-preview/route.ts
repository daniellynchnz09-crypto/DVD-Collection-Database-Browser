import { NextResponse } from "next/server";
import { autocropImageBuffer, fetchRemoteImage } from "@danflix/backend";
import { IMAGE_RESPONSE_SECURITY_HEADERS, requireScanSecretHeaderOrQuery } from "@/lib/scanAuth";

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
 * `url` must be `http(s)`, and since 2026-10-07 (security pass) it's fetched through
 * remoteImageFetch.ts: public hosts only, raster images only, size-capped. Before that any
 * reachable URL's body came back as-is with its own Content-Type - an internal address could be
 * read through here, and an HTML page would be served from the site's own origin (where the
 * owner passcode sits in sessionStorage). The response also carries nosniff + a sandbox CSP.
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
  const authError = requireScanSecretHeaderOrQuery(request);
  if (authError) return authError;

  const imageUrl = new URL(request.url).searchParams.get("url");
  if (!imageUrl || !/^https?:\/\//i.test(imageUrl)) {
    return NextResponse.json({ error: "A valid http(s) url query param is required." }, { status: 400 });
  }

  try {
    const fetched = await fetchRemoteImage(imageUrl);
    if (!fetched.ok) return NextResponse.json({ error: fetched.reason }, { status: fetched.status });
    const cropped = await autocropImageBuffer(fetched.bytes, fetched.contentType);
    return new NextResponse(new Uint8Array(cropped), {
      headers: { "Content-Type": fetched.contentType, "Cache-Control": "no-store", ...IMAGE_RESPONSE_SECURITY_HEADERS },
    });
  } catch (err) {
    console.error("[case-image-preview] failed:", err);
    return NextResponse.json({ error: "Couldn't load the source image." }, { status: 500 });
  }
}
