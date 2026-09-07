import { NextResponse } from "next/server";
import { requireScanSecret } from "@/lib/scanAuth";
import { lookupTmdbFields } from "@danflix/backend";

/**
 * A read-only "would TMDb find anything for this title" check, called from ConfirmScreen
 * as soon as a candidate is picked - so the Rating/Studio manual fields (see
 * apps/mobile/src/screens/ConfirmScreen.tsx) can stay hidden by default and only appear
 * once TMDb has genuinely come up empty for that specific field, rather than asking the
 * user to fill in something TMDb is about to auto-fill anyway.
 *
 * Purely informational: /api/scan/confirm does its own independent TMDb lookup at the
 * moment a scan is actually confirmed (the authoritative one that gets stored), so a stale
 * or duplicate preview call here has no correctness impact either way.
 */
export async function POST(request: Request) {
  const authError = requireScanSecret(request);
  if (authError) return authError;

  const body = await request.json().catch(() => null);
  const imdbId = typeof body?.imdbId === "string" ? body.imdbId : null;
  if (!imdbId) {
    return NextResponse.json({ error: "imdbId is required" }, { status: 400 });
  }

  const { rating, studio } = await lookupTmdbFields(imdbId);
  return NextResponse.json({ rating, studio });
}
