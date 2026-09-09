import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { requireScanSecret } from "@/lib/scanAuth";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { appendRowToSheet, getSheetHeaderAndColumns, updateSheetFieldsByUniqueId } from "@/lib/googleSheets";
import { canonicalizeValue } from "@/lib/canonicalizeValue";
import {
  buildColumnIndexes,
  buildSheetRowFromTitle,
  cleanFreeText,
  inferDepictedEraStart,
  normalizeAnimationOrLiveAction,
  normalizeDiscCondition,
  normalizeFormat,
  normalizeRating,
  omdbGetById,
  parseOmdbReleaseDate,
  parseOmdbRuntimeMins,
} from "@danflix/shared";
import { fetchTmdbFieldsById, lookupRottenTomatoesPage, lookupTmdbFields, type TmdbFields } from "@danflix/backend";
import type { SupabaseClient } from "@supabase/supabase-js";

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Accepts either a bare TMDb numeric id or a pasted themoviedb.org movie URL, for the
 * manual-override field ConfirmScreen shows when the automatic /find lookup comes up
 * empty (see the hard-requirement check below). */
function parseTmdbIdOverride(value: string | undefined): number | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/(\d+)/);
  if (!match) return null;
  const id = parseInt(match[1], 10);
  return Number.isNaN(id) ? null : id;
}

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
 *
 * `overwriteUniqueId` (single-entry submissions only): instead of inserting a new row,
 * fully replaces every field of the already-catalogued title at that unique_id with this
 * scan's data (Supabase update + a full Sheet row rewrite via updateSheetFieldsByUniqueId,
 * not appendRowToSheet). This is the "Overwrite" option ConfirmScreen's pre-submit
 * similar-entry check offers (Claude/TECH STACK AND ARCHITECTURE.md's "Backfill Rescan"
 * section) - functionally equivalent to deleting the old entry and re-adding it as
 * described, but implemented as an update-in-place so the row's unique_id (and anything
 * that already references it, e.g. a confirmed pending_scans row) never has to change.
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
  const overwriteUniqueId = typeof body?.overwriteUniqueId === "string" ? body.overwriteUniqueId : null;
  if (overwriteUniqueId && entries.length !== 1) {
    return NextResponse.json({ error: "overwriteUniqueId only supports a single entry." }, { status: 400 });
  }
  const { header } = await getSheetHeaderAndColumns();
  const columnIndexes = buildColumnIndexes(header);

  // A box set's cover only ever shows one rating/studio for the whole collection, not
  // necessarily any single film's own - so manual rating/studio only ever applies to a
  // single-entry submission, regardless of what the client sends. Enforced here (not just
  // in ConfirmScreen) since manualFields is otherwise shared verbatim across every member
  // of a multi-title collection.
  const isMultiTitleEntry = entries.length > 1;

  // Resolved fully before any writes happen, not inline in the write loop below - the
  // hard-requirement check right after this must never leave an earlier entry in a
  // multi-title collection already written to Supabase/the Sheet while a later one fails.
  // Genuinely per-film data (an NZ/Oceania certification, the primary production company,
  // now also the canonical TMDb id itself), so - unlike the manual Rating/Studio fields
  // below - this runs for every entry regardless of isMultiTitleEntry; it's exactly what
  // solves the collection-member case where there's no single physical case to read a
  // rating off. See packages/backend/src/tmdb.ts for why this needed TMDb rather than IMDb.
  const resolvedTmdb: TmdbFields[] = [];
  for (const entry of entries) {
    const manual = entry.manualFields ?? {};
    let fields: TmdbFields = entry.imdbId
      ? await lookupTmdbFields(entry.imdbId)
      : { tmdbId: null, rating: null, studio: null, isAnimated: null };

    // TMDb's own /find-by-imdb-id lookup sometimes has nothing (a genuinely obscure title,
    // or an IMDb id TMDb hasn't indexed yet) - the manual override field ConfirmScreen
    // shows in that case lets the user paste a TMDb link/id themselves rather than being
    // stuck. Still worth a real detail fetch so rating/studio/isAnimated get populated too,
    // not just the bare id.
    const override = parseTmdbIdOverride(asString(manual.tmdb_id_override));
    if (fields.tmdbId == null && override != null) {
      const overrideDetails = await fetchTmdbFieldsById(override);
      fields = { tmdbId: override, ...overrideDetails };
    }

    // Hard requirement (Claude/TECH STACK AND ARCHITECTURE.md's "Backfill Rescan" section):
    // any entry backed by a real OMDB/TMDb candidate (entry.imdbId set) must end up with a
    // real TMDb id, so every other metadata-driven feature (scores, cast/crew, synopsis,
    // third-party review-tracking integrations, ...) can be backfilled later for the whole
    // collection at once, without ever re-touching the physical disc. A fully manual entry
    // (no candidate at all - the user's own custom-burned discs) has nothing to look up and
    // is exempt.
    if (entry.imdbId && fields.tmdbId == null) {
      return NextResponse.json(
        {
          error:
            "TMDb has no match for this title, and no manual TMDb link/id was given - " +
            "enter one in the TMDb field on the confirm screen to continue.",
        },
        { status: 400 }
      );
    }
    resolvedTmdb.push(fields);
  }

  const createdIds: string[] = [];
  let primaryShelfLocation: { before: string | null; after: string | null } | null = null;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const manual = entry.manualFields ?? {};
    const tmdbFields = resolvedTmdb[i];

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

        // Only bother looking Rotten Tomatoes up at all once OMDB's own Ratings array has
        // already confirmed a critics score exists - skips the fetch entirely for titles
        // with none, and never overrides a link the user already typed in themselves.
        if (!asString(manual.rotten_tomatoes_page)) {
          const rtRating = detail.Ratings?.find((r) => r.Source === "Rotten Tomatoes");
          const percent = rtRating ? parseInt(rtRating.Value, 10) : NaN;
          if (!Number.isNaN(percent)) {
            omdbFields.rotten_tomatoes_page = await lookupRottenTomatoesPage(detail.Title, percent);
          }
        }
      }
    }

    // Normalizes scanner-entered free text so random capitalization/spacing never creates
    // a near-duplicate of a category the collection already uses. `format` has a small
    // fixed set of legitimate spellings (normalizeFormat's FORMAT_ALIASES); Genre Location
    // is genuinely open-ended, so canonicalizeValue resolves against whatever's already in
    // `titles` instead. Title/Release Name only get whitespace tidied, never case-folded -
    // they're proper nouns/verbatim text where casing matters. Disk Region needs none of
    // this - ConfirmScreen's MultiSelectChips only ever sends a comma-joined string built
    // from a small fixed set of codes, never free-typed text.
    const cleanGenreLocation = await canonicalizeValue(
      supabase,
      "genre_location",
      cleanFreeText(asString(manual.genre_location))
    );
    // Franchise is exactly as open-ended as Genre Location (an ever-growing list the user
    // builds up themselves, not a small fixed set like Format/Rating) - same dedup
    // treatment, so "casper" vs "Casper" never creates a near-duplicate franchise entry.
    const cleanFranchise = await canonicalizeValue(
      supabase,
      "franchise",
      cleanFreeText(asString(manual.franchise))
    );

    // Priority: a manual entry (the physical case, or a single-title scan) always wins
    // when given; otherwise TMDb's per-title lookup above; otherwise whatever OMDB itself
    // had (rating only - OMDB's own Production field proved unreliable, confirmed live
    // against a real title, so it's not chained in for studio at all). *_is_manual records
    // which branch actually won, so refreshTmdbFields (packages/backend/src/tmdb.ts) knows
    // never to touch a value that came from a human rather than TMDb.
    const manualRating = isMultiTitleEntry ? undefined : normalizeRating(asString(manual.rating));
    const manualStudio = isMultiTitleEntry ? undefined : cleanFreeText(asString(manual.studio));
    const finalRating = manualRating ?? tmdbFields.rating ?? (omdbFields.rating as string | null) ?? null;
    const finalStudio = manualStudio ?? tmdbFields.studio ?? null;

    const uniqueId = overwriteUniqueId ?? randomUUID();
    const title: Record<string, unknown> = {
      unique_id: uniqueId,
      title: cleanFreeText(asString(manual.title)) ?? omdbFields.title ?? "Unknown Title",
      movie_or_tv: manual.movie_or_tv ?? omdbFields.movie_or_tv ?? "Movie",
      season_no: manual.season_no ?? null,
      part_of_season_no: manual.part_of_season_no ?? null,
      episode_count: manual.episode_count ?? null,
      release_date: manual.release_date ?? omdbFields.release_date ?? null,
      running_time_mins: manual.running_time_mins ?? omdbFields.running_time_mins ?? null,
      genre: manual.genre ?? omdbFields.genre ?? [],
      director: manual.director ?? omdbFields.director ?? [],
      franchise: cleanFranchise,
      sub_franchise: manual.sub_franchise ?? null,
      rating: finalRating,
      rating_is_manual: manualRating != null,
      format: normalizeFormat(asString(manual.format)) ?? "DVD",
      disc_count: manual.disc_count ?? 1,
      steelbook: manual.steelbook ?? false,
      special_features: manual.special_features ?? false,
      special_features_disc_count: manual.special_features_disc_count ?? null,
      special_features_disc_format: normalizeFormat(asString(manual.special_features_disc_format)),
      animation_or_live_action:
        normalizeAnimationOrLiveAction(asString(manual.animation_or_live_action)) ?? "Live Action",
      documentary: manual.documentary ?? "n",
      is_collection: manual.is_collection ?? false,
      name_of_collection: manual.name_of_collection ?? null,
      title_in_a_collection: manual.title_in_a_collection ?? false,
      number_of_titles_in_collection: manual.number_of_titles_in_collection ?? null,
      rotten_tomatoes_page: manual.rotten_tomatoes_page ?? omdbFields.rotten_tomatoes_page ?? null,
      imdb_page: manual.imdb_page ?? omdbFields.imdb_page ?? null,
      studio: finalStudio,
      studio_is_manual: manualStudio != null,
      tmdb_id: tmdbFields.tmdbId,
      tmdb_synced_at: tmdbFields.tmdbId != null ? new Date().toISOString() : null,
      // Clean lookup keys, added ahead of the backfill rescan so every future metadata
      // feature can be keyed off them without re-touching the physical disc - see the
      // hard-requirement check above. entry.imdbId is already the clean id OMDB/TMDb
      // search itself returned, not the imdb_page URL built from it above.
      imdb_id: entry.imdbId ?? null,
      tmdb_page: tmdbFields.tmdbId != null ? `https://www.themoviedb.org/movie/${tmdbFields.tmdbId}` : null,
      disk_region: cleanFreeText(asString(manual.disk_region)),
      barcode_id: entry.barcodeId ?? null,
      case_image_url: manual.case_image_url ?? null,
      genre_location: cleanGenreLocation,
      release_name: cleanFreeText(asString(manual.release_name)),
      depicted_era_start:
        manual.depicted_era_start ??
        inferDepictedEraStart(String(manual.title ?? omdbFields.title ?? ""), synopsis),
      depicted_era_label: cleanFreeText(asString(manual.depicted_era_label)),
      disc_condition: normalizeDiscCondition(asString(manual.disc_condition)),
      case_notes: cleanFreeText(asString(manual.case_notes)),
      release_variant_note: cleanFreeText(asString(manual.release_variant_note)),
      // Seen this film at all, on any format/copy - distinct from `watched_disc` below (this
      // specific disc). Both default false and are otherwise only ever set by the one-time
      // watch-history import or manually here, for prior viewings the user remembers but
      // that import can't discover on its own (see 0013_add_watched_title.sql,
      // 0018_rename_watched_title_to_watched_disc.sql).
      watched: manual.watched === true,
      watched_disc: manual.watched_disc === true,
    };

    if (overwriteUniqueId) {
      const { error: updateError } = await supabase.from("titles").update(title).eq("unique_id", overwriteUniqueId);
      if (updateError) {
        return NextResponse.json({ error: updateError.message }, { status: 500 });
      }
      await updateSheetFieldsByUniqueId(overwriteUniqueId, title, header, columnIndexes);
    } else {
      const { error: insertError } = await supabase.from("titles").insert(title);
      if (insertError) {
        return NextResponse.json({ error: insertError.message }, { status: 500 });
      }
      const row = buildSheetRowFromTitle(title, columnIndexes, header.length);
      await appendRowToSheet(row);
    }
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
