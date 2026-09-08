import { NextResponse } from "next/server";
import { requireScanSecret } from "@/lib/scanAuth";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { extractDiscCountHint, extractFormatHint, normalizeTitleForMatch, omdbGetById } from "@danflix/shared";

interface ExistingTitleRow {
  unique_id: string;
  title: string;
  format: string;
  disc_count: number;
  disk_region: string | null;
  genre_location: string | null;
  franchise: string | null;
  rating: string | null;
  studio: string | null;
  animation_or_live_action: string;
  special_features: boolean;
  steelbook: boolean;
  barcode_id: string | null;
  case_image_url: string | null;
  imdb_id: string | null;
  release_date: string | null;
}

export interface ExistingTitleCandidate extends ExistingTitleRow {
  posterUrl: string | null;
}

/**
 * Similar/matching-entry check (Claude/TECH STACK AND ARCHITECTURE.md's "Backfill Rescan"
 * section) - runs right before /api/scan/confirm actually writes anything, so a rescan of
 * a title already in the collection (the whole point of the backfill pass) surfaces as a
 * choice (Overwrite / Is a new entry / Reject) instead of silently creating a duplicate
 * row. Broader than the original backfill-matching check it replaces: matches by base
 * title text (ignoring cut-suffix differences, see normalizeTitleForMatch) OR by a shared
 * imdb_id, and - unlike the original, which only ever looked at rows with no barcode yet -
 * checks EVERY row, since two real physical copies of the same film (a Blu-ray and a 4K
 * UHD) should also surface here so the user can deliberately choose "Is a new entry" for a
 * genuine second copy, not just for the legacy Sheet-only backfill case.
 *
 * Narrows using format/disc-count hints pulled from the UPC product text, only when doing
 * so actually narrows the set (an unreliable hint should never zero out a real candidate) -
 * same logic as before.
 *
 * Each candidate carries enough detail for a real side-by-side comparison (poster + key
 * fields), not just a title/format/disc-count summary - falls back to an OMDB poster fetch
 * via imdb_id when a legacy row has no case_image_url of its own (most of the collection,
 * pre-dating the barcode pipeline, has neither yet).
 */
export async function POST(request: Request) {
  const authError = requireScanSecret(request);
  if (authError) return authError;

  const body = await request.json().catch(() => null);
  const title = typeof body?.title === "string" ? body.title : null;
  const upcText = typeof body?.upcText === "string" ? body.upcText : "";
  const imdbId = typeof body?.imdbId === "string" ? body.imdbId : null;
  if (!title) {
    return NextResponse.json({ error: "title is required" }, { status: 400 });
  }

  const supabase = getSupabaseServerClient();
  const { data: rows, error } = await supabase
    .from("titles")
    .select(
      "unique_id, title, format, disc_count, disk_region, genre_location, franchise, rating, studio, " +
        "animation_or_live_action, special_features, steelbook, barcode_id, case_image_url, imdb_id, release_date"
    );
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const target = normalizeTitleForMatch(title);
  const candidates = ((rows ?? []) as unknown as ExistingTitleRow[]).filter(
    (r) => normalizeTitleForMatch(r.title) === target || (imdbId != null && r.imdb_id === imdbId)
  );
  if (candidates.length === 0) {
    return NextResponse.json({ status: "none" });
  }

  const formatHint = extractFormatHint(upcText);
  const discCountHint = extractDiscCountHint(upcText);

  let narrowed = candidates;
  if (formatHint) {
    const byFormat = narrowed.filter((r) => r.format?.toLowerCase() === formatHint.toLowerCase());
    if (byFormat.length > 0) narrowed = byFormat;
  }
  if (discCountHint != null) {
    const byDiscCount = narrowed.filter((r) => r.disc_count === discCountHint);
    if (byDiscCount.length > 0) narrowed = byDiscCount;
  }

  const withPosters: ExistingTitleCandidate[] = await Promise.all(
    narrowed.map(async (r) => {
      if (r.case_image_url) return { ...r, posterUrl: r.case_image_url };
      if (r.imdb_id) {
        const detail = await omdbGetById(r.imdb_id);
        if (detail?.Poster && detail.Poster !== "N/A") return { ...r, posterUrl: detail.Poster };
      }
      return { ...r, posterUrl: null };
    })
  );

  if (withPosters.length === 1) {
    return NextResponse.json({ status: "auto", match: withPosters[0] });
  }
  return NextResponse.json({ status: "ambiguous", candidates: withPosters });
}
