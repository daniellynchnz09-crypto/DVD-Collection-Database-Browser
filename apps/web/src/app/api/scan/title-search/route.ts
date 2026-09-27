import { NextResponse } from "next/server";
import { requireScanSecret } from "@/lib/scanAuth";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { searchTitleCandidates } from "@danflix/backend";

/**
 * Thin wrapper around searchTitleCandidates (packages/backend/src/titleTextSearch.ts) - the
 * actual search logic was extracted out of this route (2026-09-28, part of cover-photo
 * scanning) so a cover-derived title (read straight off a cover photo by coverVision.ts, then
 * fed into the resolver via scanResolver.ts) can call the exact same best-match logic ConfirmScreen's
 * manual "what's the title?" fallback already used, rather than a re-implementation. See that
 * function's own comment for the full three-pass search design.
 */
export async function POST(request: Request) {
  const authError = requireScanSecret(request);
  if (authError) return authError;

  const body = await request.json().catch(() => null);
  const typedTitle = typeof body?.title === "string" ? body.title.trim() : "";
  const skipCorrections = body?.skipCorrections === true;
  if (!typedTitle) {
    return NextResponse.json({ error: "title is required" }, { status: 400 });
  }

  const supabase = getSupabaseServerClient();
  const candidates = await searchTitleCandidates(supabase, typedTitle, { skipCorrections });

  return NextResponse.json({ candidates });
}
