/**
 * Mirrors the "All DVDs and Specs" Google Sheet columns (see Claude/RESOURCES.md)
 * plus the extra columns called for in Claude/STEP BY STEP PROCESS AND AUTOMATION.md
 * and specified in Claude/TECH STACK AND ARCHITECTURE.md. Column names match the
 * `titles` table in supabase/migrations/0001_init.sql exactly.
 */

// Common values, useful as suggestions in a filter/entry UI - not an exhaustive
// enum. The `titles` table stores movie_or_tv as free text (see 0001_init.sql):
// the real collection has legitimate categories beyond these (TV Movie, TV
// Episode, Live Performance, ...), matching RESOURCES.md's own "... etc.".
export type MovieOrTv =
  | "Movie"
  | "Short"
  | "Video"
  | "Documentary"
  | "TV Series"
  | "TV Mini-Series"
  | "TV Special";

export type YesNo = "y" | "n";

export interface Title {
  unique_id: string;
  title: string;
  movie_or_tv: string;
  season_no: string | null;
  part_of_season_no: string | null;
  episode_count: number | null;
  release_date: string | null;
  running_time_mins: number | null;
  genre: string[];
  director: string[];
  // Merged with the former sub_franchise column (0020_merge_franchise_columns.sql) into one
  // multi-value list, same shape as genre - a film can genuinely belong to several
  // franchises at once at different specificities (e.g. Captain Marvel (2019): Marvel,
  // Marvel Cinematic Universe, and the Captain Marvel character franchise itself), which a
  // single scalar plus one "sub" slot could never represent for more than two.
  franchise: string[];
  rating: string | null;
  format: string;
  disc_count: number;
  special_features: boolean;
  special_features_disc_count: number | null;
  special_features_disc_format: string | null;
  animation_or_live_action: string;
  documentary: string;
  is_collection: boolean;
  name_of_collection: string | null;
  title_in_a_collection: boolean;
  number_of_titles_in_collection: number | null;
  rotten_tomatoes_page: string | null;
  imdb_page: string | null;
  studio: string | null;
  disk_region: string | null;

  // Added 0022_add_rental_and_language_fields.sql. Auto-filled from TMDb's own per-title
  // `original_language` field (0023_add_original_language_is_manual.sql wired this up - a
  // bare ISO 639-1 code like "en" mapped to a human-readable name via
  // packages/backend/src/iso639.ts), same Rating/Studio precedent: hidden on the scan form
  // whenever TMDb resolves a value, shown as a manual AutocompleteInput only when there's no
  // TMDb match at all (see barcode-review-screen-fields.md).
  original_language: string | null;
  original_language_is_manual: boolean;

  // Added per STEP BY STEP PROCESS AND AUTOMATION.md / TECH STACK AND ARCHITECTURE.md
  barcode_id: string | null;
  case_image_url: string | null;
  // Storage path in the `case-images` bucket (0026_add_case_image_path.sql) - the real,
  // Supabase-hosted product/case photo for the future web app's DVD Pages, distinct from
  // `case_image_url` above (a raw external URL, never cached) and from `poster_image_path`
  // below (the OMDB/TMDb movie poster, used on Movie/TV Pages - the two are never in
  // competition, both kept for their own separate page types). Resolved to a signed URL
  // server-side on demand, same convention as poster_image_path.
  case_image_path: string | null;
  genre_location: string | null;
  steelbook: boolean;
  release_name: string | null;
  tmdb_id: number | null;
  // 0028_add_tmdb_media_type.sql - "movie" or "tv", since TMDb ids for each are separate
  // number spaces. Backfilled to "movie" for every row that predates TV scanning support.
  tmdb_media_type: "movie" | "tv" | null;
  tmdb_synced_at: string | null;
  rating_is_manual: boolean;
  studio_is_manual: boolean;
  depicted_era_start: number | null;

  // Added ahead of the full-collection backfill rescan (0011_backfill_rescan_fields.sql) -
  // see Claude/TECH STACK AND ARCHITECTURE.md's "Backfill Rescan" section. `imdb_id` itself
  // was dropped (0019_drop_imdb_id.sql) - redundant with imdb_page, which already contains
  // it; use extractImdbIdFromPage(imdb_page) when the bare id is needed.
  tmdb_page: string | null;
  date_added: string | null;
  disc_condition: string;
  case_notes: string | null;
  release_variant_note: string | null;
  // `watched` means "seen this film at some point, on any format" - the broad claim.
  watched: boolean;
  last_watched_date: string | null;
  depicted_era_label: string | null;

  // Added for the one-time watch-history import (0013_add_watched_title.sql, renamed from
  // `watched_title` in 0018_rename_watched_title_to_watched_disc.sql) - `watched_disc` means
  // "watched this specific physical disc/title release", the narrow claim - distinct from
  // `watched` above, per the user's own clarification of the two-metric design.
  watched_disc: boolean;

  // The source export's own 5-star/half-star scale, doubled onto a whole-number 10-point
  // scale (0.5 -> 1, 1 -> 2, ... 5.0 -> 10) - see 0022_add_rental_and_language_fields.sql
  // and the one-time star-rating import script. Populated automatically by that script
  // wherever it already has a confident title match for `watched`/`watched_disc` above, not
  // asked for anywhere in ConfirmScreen - there's no other data source for the user's own
  // personal rating of a film, and the import script already carries the exact same-title-
  // match confidence logic this reuses. Null means "not yet rating-matched", not "rated
  // zero" (the source scale has no zero rating at all).
  personal_rating: number | null;

  // Rental tracking (0022_add_rental_and_language_fields.sql) - a real physical loan can
  // happen to any disc at any time, independent of any scan/rescan event. `rented_by_who`/
  // `date_rented` are only meaningful while `is_currently_rented_out` is true; ConfirmScreen
  // clears both client-side the moment the checkbox is unticked, same precedent as the
  // Special Features Disc Count/Format fields.
  is_currently_rented_out: boolean;
  rented_by_who: string | null;
  date_rented: string | null;


  last_updated: string;
}

/** A saved filter preset, per AIM.md Aim Four and WEB APP DESIGN.md's Advanced Search. */
export interface TasteProfile {
  id: string;
  name: string;
  filters: TitleFilters;
}

/** Range and set filters usable in Advanced Search and taste profiles. */
export interface TitleFilters {
  movieOrTv?: string[];
  releaseYearRange?: [number, number];
  runtimeRange?: [number, number];
  genre?: string[];
  franchise?: string[];
  rating?: string[];
  format?: string[];
  animationOrLiveAction?: string[];
  documentary?: string[];
  isCollection?: boolean;
  titleInACollection?: boolean;
  studio?: string[];
  diskRegion?: string[];
  rottenTomatoesScoreRange?: [number, number];
}
