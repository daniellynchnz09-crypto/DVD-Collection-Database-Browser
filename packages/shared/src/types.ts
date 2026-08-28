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
  franchise: string | null;
  sub_franchise: string | null;
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

  // Added per STEP BY STEP PROCESS AND AUTOMATION.md / TECH STACK AND ARCHITECTURE.md
  barcode_id: string | null;
  case_image_url: string | null;
  genre_location: string | null;
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
