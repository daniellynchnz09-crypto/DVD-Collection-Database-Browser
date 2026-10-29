import { NextResponse } from "next/server";
import { requireScanSecret } from "@/lib/scanAuth";
import { fetchTmdbCutNotes } from "@danflix/backend";
import { findCutInfo, parseTmdbPseudoImdbId, suggestCutNames } from "@danflix/shared";

/**
 * Cut details for one film in a collection (2026-10-22, the user's request - see
 * packages/shared/src/movieCuts.ts). Called by the scanner's add-a-title form once a film is
 * picked: `suggestions` are the cut names TMDb's release notes mention for it, and `info` is
 * the named `cut`'s own release date and runtime when TMDb's notes have them (null for no cut,
 * a theatrical cut, or a film TMDb doesn't know). Read-only, two TMDb requests.
 */
export async function POST(request: Request) {
  const authError = requireScanSecret(request);
  if (authError) return authError;

  const body = await request.json().catch(() => null);
  // A real IMDb id, or a TMDb-only candidate's stand-in id (tmdbPseudoImdbId).
  const raw = typeof body?.imdbId === "string" ? body.imdbId : "";
  const imdbId = /^tt\d{5,10}$/.test(raw) || parseTmdbPseudoImdbId(raw) ? raw : null;
  if (!imdbId) return NextResponse.json({ error: "imdbId is required" }, { status: 400 });
  const cut = typeof body?.cut === "string" ? body.cut.slice(0, 120) : "";

  const tmdb = await fetchTmdbCutNotes(imdbId);
  if (!tmdb) return NextResponse.json({ suggestions: [], info: null });
  return NextResponse.json({
    suggestions: suggestCutNames(tmdb.notes),
    info: cut ? findCutInfo(cut, tmdb.notes, tmdb.altTitles) : null,
  });
}
