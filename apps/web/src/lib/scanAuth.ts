import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

/**
 * Gates the barcode-scanning + sheet-webhook routes behind a shared-secret header.
 * Not real per-user auth - a proportionate guard for a single-owner app against
 * someone stumbling on the deployed URL (Claude.md's "prevent outside actors from
 * spamming links" concern). See Claude/TECH STACK AND ARCHITECTURE.md.
 *
 * Compared in constant time (2026-10-07 security pass): a plain `!==` returns as soon as one
 * character differs, which leaks how much of a guess was right. Both sides are hashed first so
 * the lengths always match, the same approach ownerAuth.ts uses for the owner passcode.
 */
const digest = (s: string) => createHash("sha256").update(s, "utf8").digest();

function checkScanSecret(provided: string | null): NextResponse | null {
  const expected = process.env.SCAN_API_SECRET;
  if (!expected) {
    return NextResponse.json(
      { error: "SCAN_API_SECRET is not configured on the server." },
      { status: 500 }
    );
  }
  if (!provided || !timingSafeEqual(digest(provided), digest(expected))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}

export function requireScanSecret(request: Request): NextResponse | null {
  return checkScanSecret(request.headers.get("x-scan-secret"));
}

/**
 * Header OR `secret` query param - only for the two GET image routes a React Native `<Image>`
 * loads directly (case-image-preview, staged-cover-preview), since a native image fetch on
 * Android doesn't reliably send custom headers (see case-image-preview/route.ts). Every other
 * scan route stays header-only, so the secret only ever appears in a URL where it has to.
 */
export function requireScanSecretHeaderOrQuery(request: Request): NextResponse | null {
  return checkScanSecret(request.headers.get("x-scan-secret") ?? new URL(request.url).searchParams.get("secret"));
}

/**
 * Extra headers for the two routes above that hand back image bytes (2026-10-07): browsers
 * mustn't sniff them into HTML, and if one is ever opened directly as a page it runs sandboxed
 * with no script, so a bad upload can't act on the site's origin.
 */
export const IMAGE_RESPONSE_SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; img-src 'self'; sandbox",
} as const;
