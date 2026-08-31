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
  const limit = typeof body?.limit === "number" ? Math.min(body.limit, 50) : 10;

  try {
    const result = await resolvePendingScansBatch(getSupabaseServerClient(), limit);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
