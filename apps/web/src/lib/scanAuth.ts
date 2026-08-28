import { NextResponse } from "next/server";

/**
 * Gates the barcode-scanning + sheet-webhook routes behind a shared-secret header.
 * Not real per-user auth - a proportionate guard for a single-owner app against
 * someone stumbling on the deployed URL (Claude.md's "prevent outside actors from
 * spamming links" concern). See Claude/TECH STACK AND ARCHITECTURE.md.
 */
export function requireScanSecret(request: Request): NextResponse | null {
  const expected = process.env.SCAN_API_SECRET;
  if (!expected) {
    return NextResponse.json(
      { error: "SCAN_API_SECRET is not configured on the server." },
      { status: 500 }
    );
  }
  const provided = request.headers.get("x-scan-secret");
  if (provided !== expected) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}
