import { NextResponse } from "next/server";
import { requireScanSecret } from "@/lib/scanAuth";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { getSheetHeaderAndColumns, updateSheetFieldsByUniqueId } from "@/lib/googleSheets";
import {
  buildColumnIndexes,
  isCutVariantTitle,
  omdbGetById,
  parseOmdbReleaseDate,
  parseOmdbRuntimeMins,
} from "@danflix/shared";

/**
 * Attaches a scanned barcode (+ image, + a conservative metadata refresh) to a title you
 * already have catalogued, instead of creating a duplicate row. Per the user's own rule
 * (Claude/TECH STACK AND ARCHITECTURE.md): only ever refresh fields that genuinely come
 * from IMDb/OMDB (release date, genre, director, rating, IMDb page) - never packaging
 * fields the user already entered by hand (format, disc count, disk region, franchise,
 * genre location, etc.), and never runtime when the matched title looks like a specific
 * cut/edition, since OMDB only has one canonical runtime per film.
 */
export async function POST(request: Request) {
  const authError = requireScanSecret(request);
  if (authError) return authError;

  const body = await request.json().catch(() => null);
  const pendingScanId = typeof body?.pendingScanId === "string" ? body.pendingScanId : null;
  const existingUniqueId = typeof body?.existingUniqueId === "string" ? body.existingUniqueId : null;
  const barcode = typeof body?.barcode === "string" ? body.barcode : null;
  const imdbId = typeof body?.imdbId === "string" ? body.imdbId : undefined;
  const caseImageUrl = typeof body?.caseImageUrl === "string" ? body.caseImageUrl : undefined;

  if (!pendingScanId || !existingUniqueId || !barcode) {
    return NextResponse.json(
      { error: "pendingScanId, existingUniqueId and barcode are required" },
      { status: 400 }
    );
  }

  const supabase = getSupabaseServerClient();
  const { data: existing, error: fetchError } = await supabase
    .from("titles")
    .select("title")
    .eq("unique_id", existingUniqueId)
    .maybeSingle();
  if (fetchError || !existing) {
    return NextResponse.json({ error: "Existing title not found" }, { status: 404 });
  }

  const updateFields: Record<string, unknown> = {
    barcode_id: barcode,
    ...(caseImageUrl ? { case_image_url: caseImageUrl } : {}),
  };

  if (imdbId) {
    const detail = await omdbGetById(imdbId);
    if (detail) {
      updateFields.release_date = parseOmdbReleaseDate(detail.Released);
      updateFields.genre = detail.Genre?.split(",").map((g) => g.trim()).filter(Boolean) ?? [];
      updateFields.director = detail.Director?.split(",").map((d) => d.trim()).filter(Boolean) ?? [];
      updateFields.rating = detail.Rated !== "N/A" ? detail.Rated : null;
      updateFields.imdb_page = `https://www.imdb.com/title/${detail.imdbID}/`;
      // A different cut/edition (e.g. "Final Cut") almost certainly has a different
      // runtime than OMDB's single canonical entry for the film - don't overwrite it.
      if (!isCutVariantTitle(existing.title)) {
        updateFields.running_time_mins = parseOmdbRuntimeMins(detail.Runtime);
      }
    }
  }

  const { error: updateError } = await supabase
    .from("titles")
    .update(updateFields)
    .eq("unique_id", existingUniqueId);
  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }

  const { header } = await getSheetHeaderAndColumns();
  const columnIndexes = buildColumnIndexes(header);
  await updateSheetFieldsByUniqueId(existingUniqueId, updateFields, header, columnIndexes);

  await supabase
    .from("pending_scans")
    .update({ status: "confirmed", resolved_title_id: existingUniqueId })
    .eq("id", pendingScanId);

  return NextResponse.json({ success: true, linkedTitle: existing.title });
}
