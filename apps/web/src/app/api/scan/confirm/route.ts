import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { requireScanSecret } from "@/lib/scanAuth";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { appendRowToSheet, getSheetHeaderAndColumns } from "@/lib/googleSheets";
import {
  buildColumnIndexes,
  buildSheetRowFromTitle,
  inferDepictedEraStart,
  omdbGetById,
  parseOmdbReleaseDate,
  parseOmdbRuntimeMins,
} from "@danflix/shared";
import type { SupabaseClient } from "@supabase/supabase-js";

interface ConfirmEntry {
  imdbId?: string;
  barcodeId?: string;
  manualFields?: Record<string, unknown>;
}

function omdbTypeToMovieOrTv(type: string | undefined): string {
  if (type === "series") return "TV Series";
  if (type === "episode") return "TV Episode";
  return "Movie";
}

async function computeShelfLocation(
  supabase: SupabaseClient,
  genreLocation: string | null | undefined,
  newTitleName: string,
  newEraStart: number | null,
  excludeUniqueId: string
): Promise<{ before: string | null; after: string | null }> {
  if (!genreLocation) return { before: null, after: null };

  const { data: siblings } = await supabase
    .from("titles")
    .select("title, depicted_era_start")
    .eq("genre_location", genreLocation)
    .neq("unique_id", excludeUniqueId);
  if (!siblings || siblings.length === 0) return { before: null, after: null };

  const isHistoryDoc = /history document/i.test(genreLocation);
  const sorted = [...siblings].sort((a, b) =>
    isHistoryDoc
      ? (a.depicted_era_start ?? Infinity) - (b.depicted_era_start ?? Infinity)
      : a.title.localeCompare(b.title)
  );

  let before: string | null = null;
  let after: string | null = null;
  for (const sibling of sorted) {
    const isBeforeNew = isHistoryDoc
      ? (sibling.depicted_era_start ?? Infinity) <= (newEraStart ?? Infinity)
      : sibling.title.localeCompare(newTitleName) <= 0;
    if (isBeforeNew) {
      before = sibling.title;
    } else {
      after = sibling.title;
      break;
    }
  }
  return { before, after };
}

/**
 * Writes a reviewed/confirmed pending scan to Supabase + the Sheet. `entries` is usually
 * one item, but is an array to support a collection scan producing the collection entry
 * plus every checked sub-title in one request (Claude/TECH STACK AND ARCHITECTURE.md's
 * collections mechanism). The first entry's shelf-location is what's returned.
 *
 * `{ pendingScanId, dismiss: true }` (no entries) instead marks the pending scan
 * confirmed without creating anything - for the re-scan case, where the resolver already
 * found an existingMatch and there's nothing new to write.
 *
 * `{ pendingScanId, discard: true }` deletes the pending scan outright - for a stray/junk
 * read (e.g. a barcode briefly glimpsed on a neighbouring disc while lining up a shot)
 * that was never meant to be catalogued at all.
 */
export async function POST(request: Request) {
  const authError = requireScanSecret(request);
  if (authError) return authError;

  const body = await request.json().catch(() => null);
  const pendingScanId = typeof body?.pendingScanId === "string" ? body.pendingScanId : null;
  if (!pendingScanId) {
    return NextResponse.json({ error: "pendingScanId is required" }, { status: 400 });
  }

  const supabase = getSupabaseServerClient();

  if (body?.discard === true) {
    await supabase.from("pending_scans").delete().eq("id", pendingScanId);
    return NextResponse.json({ success: true, createdTitleIds: [], shelfLocation: null });
  }

  if (body?.dismiss === true) {
    await supabase.from("pending_scans").update({ status: "confirmed" }).eq("id", pendingScanId);
    return NextResponse.json({ success: true, createdTitleIds: [], shelfLocation: null });
  }

  const entries: ConfirmEntry[] = Array.isArray(body?.entries) ? body.entries : [];
  if (entries.length === 0) {
    return NextResponse.json({ error: "entries is required unless dismiss is true" }, { status: 400 });
  }
  const { header } = await getSheetHeaderAndColumns();
  const columnIndexes = buildColumnIndexes(header);

  const createdIds: string[] = [];
  let primaryShelfLocation: { before: string | null; after: string | null } | null = null;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const manual = entry.manualFields ?? {};

    let omdbFields: Record<string, unknown> = {};
    let synopsis: string | null = null;
    if (entry.imdbId) {
      const detail = await omdbGetById(entry.imdbId);
      if (detail) {
        synopsis = detail.Plot;
        omdbFields = {
          title: detail.Title,
          movie_or_tv: omdbTypeToMovieOrTv(detail.Type),
          release_date: parseOmdbReleaseDate(detail.Released),
          running_time_mins: parseOmdbRuntimeMins(detail.Runtime),
          genre: detail.Genre?.split(",").map((g) => g.trim()).filter(Boolean) ?? [],
          director: detail.Director?.split(",").map((d) => d.trim()).filter(Boolean) ?? [],
          rating: detail.Rated !== "N/A" ? detail.Rated : null,
          imdb_page: `https://www.imdb.com/title/${detail.imdbID}/`,
        };
      }
    }

    const uniqueId = randomUUID();
    const title: Record<string, unknown> = {
      unique_id: uniqueId,
      title: manual.title ?? omdbFields.title ?? "Unknown Title",
      movie_or_tv: manual.movie_or_tv ?? omdbFields.movie_or_tv ?? "Movie",
      season_no: manual.season_no ?? null,
      part_of_season_no: manual.part_of_season_no ?? null,
      episode_count: manual.episode_count ?? null,
      release_date: manual.release_date ?? omdbFields.release_date ?? null,
      running_time_mins: manual.running_time_mins ?? omdbFields.running_time_mins ?? null,
      genre: manual.genre ?? omdbFields.genre ?? [],
      director: manual.director ?? omdbFields.director ?? [],
      franchise: manual.franchise ?? null,
      sub_franchise: manual.sub_franchise ?? null,
      rating: manual.rating ?? omdbFields.rating ?? null,
      format: manual.format ?? "DVD",
      disc_count: manual.disc_count ?? 1,
      special_features: manual.special_features ?? false,
      special_features_disc_count: manual.special_features_disc_count ?? null,
      special_features_disc_format: manual.special_features_disc_format ?? null,
      animation_or_live_action: manual.animation_or_live_action ?? "Live Action",
      documentary: manual.documentary ?? "n",
      is_collection: manual.is_collection ?? false,
      name_of_collection: manual.name_of_collection ?? null,
      title_in_a_collection: manual.title_in_a_collection ?? false,
      number_of_titles_in_collection: manual.number_of_titles_in_collection ?? null,
      rotten_tomatoes_page: manual.rotten_tomatoes_page ?? null,
      imdb_page: manual.imdb_page ?? omdbFields.imdb_page ?? null,
      studio: manual.studio ?? null,
      disk_region: manual.disk_region ?? null,
      barcode_id: entry.barcodeId ?? null,
      case_image_url: manual.case_image_url ?? null,
      genre_location: manual.genre_location ?? null,
      depicted_era_start:
        manual.depicted_era_start ??
        inferDepictedEraStart(String(manual.title ?? omdbFields.title ?? ""), synopsis),
    };

    const { error: insertError } = await supabase.from("titles").insert(title);
    if (insertError) {
      return NextResponse.json({ error: insertError.message }, { status: 500 });
    }

    const row = buildSheetRowFromTitle(title, columnIndexes, header.length);
    await appendRowToSheet(row);
    createdIds.push(uniqueId);

    if (i === 0) {
      primaryShelfLocation = await computeShelfLocation(
        supabase,
        title.genre_location as string | null,
        title.title as string,
        title.depicted_era_start as number | null,
        uniqueId
      );
    }
  }

  await supabase
    .from("pending_scans")
    .update({ status: "confirmed", resolved_title_id: createdIds[0] })
    .eq("id", pendingScanId);

  return NextResponse.json({
    success: true,
    createdTitleIds: createdIds,
    shelfLocation: primaryShelfLocation,
  });
}
