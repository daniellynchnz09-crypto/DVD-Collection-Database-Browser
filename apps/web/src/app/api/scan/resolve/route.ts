import { NextResponse } from "next/server";
import { requireScanSecret } from "@/lib/scanAuth";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { resolvePendingScansBatch } from "@danflix/backend";

/**
 * Thin wrapper around the shared resolver (packages/backend/src/scanResolver.ts - a
 * separate Node-only workspace from packages/shared, since it pulls in Jimp for image
 * decoding and Metro can't bundle that for the mobile app) - meant to be called
 * periodically (a manual script for now, a Vercel Cron job once deployed) rather than
 * per-scan, since scanning and lookup are deliberately decoupled.
 */
export async function POST(request: Request) {
  const authError = requireScanSecret(request);
  if (authError) return authError;

  const body = await request.json().catch(() => ({}));
  // Clamped to a whole number in 1-50 (2026-10-07 security pass): the old Math.min alone let a
  // negative, fractional or NaN-ish limit straight through to the batch query.
  const limit =
    typeof body?.limit === "number" && Number.isFinite(body.limit)
      ? Math.max(1, Math.min(Math.floor(body.limit), 50))
      : 10;

  try {
    const result = await resolvePendingScansBatch(getSupabaseServerClient(), limit);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
