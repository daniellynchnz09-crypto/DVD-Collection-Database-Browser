/**
 * Explicit column lists for every `titles` read the website makes - never `select("*")`.
 *
 * The site is public-by-link, so these lists ARE the privacy boundary on top of RLS (anon can
 * technically select every column today). Never add any of FORBIDDEN_TITLE_COLUMNS here: see
 * Claude/TECH STACK AND ARCHITECTURE/web-app-build-plan.md's "Privacy rules". Adding a column
 * means adding it to the matching row type in types.ts too.
 */

/** Columns that must never reach a page (financial, third-party names, personal notes). */
export const FORBIDDEN_TITLE_COLUMNS = [
  "poster_image_path",
  "unintentional_collection",
  "rented_by_who",
  "date_rented",
  "personal_rating",
  "case_notes",
  "disc_condition",
  "barcode_id",
] as const;

/** Enough to draw a poster card / list row and work out its image and link. */
const CARD_COLUMN_LIST = [
  "unique_id",
  "title",
  "release_name",
  "format",
  "movie_or_tv",
  "release_date",
  "is_collection",
  "title_in_a_collection",
  "name_of_collection",
  "imdb_page",
  "movie_poster_path",
  "case_image_path",
  "case_image_url",
  "steelbook",
  "date_added",
] as const;

/** Everything a DVD / Collection page may show about one physical item. */
const DETAIL_COLUMN_LIST = [
  ...CARD_COLUMN_LIST,
  "season_no",
  "part_of_season_no",
  "episode_count",
  "running_time_mins",
  "genre",
  "director",
  "franchise",
  "rating",
  "disc_count",
  "special_features",
  "special_features_disc_count",
  "special_features_disc_format",
  "special_features_disc_number_in_set",
  "animation_or_live_action",
  "documentary",
  "number_of_titles_in_collection",
  "disc_number_in_set",
  "rotten_tomatoes_page",
  "tmdb_page",
  "tmdb_id",
  "tmdb_media_type",
  "studio",
  "disk_region",
  "original_language",
  "release_variant_note",
  "is_currently_rented_out",
  "watched",
  "last_updated",
] as const;

function assertNoForbidden(list: readonly string[]): string {
  const forbidden = list.filter((c) => (FORBIDDEN_TITLE_COLUMNS as readonly string[]).includes(c));
  // Fails loudly at module load (dev and build) rather than leaking quietly.
  if (forbidden.length > 0) throw new Error(`Private column(s) in a page select: ${forbidden.join(", ")}`);
  return list.join(",");
}

export const TITLE_CARD_COLUMNS = assertNoForbidden(CARD_COLUMN_LIST);
export const TITLE_DETAIL_COLUMNS = assertNoForbidden(DETAIL_COLUMN_LIST);

export const TITLE_METADATA_COLUMNS =
  "imdb_id,tmdb_id,tmdb_media_type,title,original_title,tagline,overview,poster_path,backdrop_path,release_date,runtime_mins,genres,imdb_rating,imdb_votes,rotten_tomatoes_score,rt_audience_score,metacritic_score,number_of_seasons,number_of_episodes";

export const PERSON_COLUMNS =
  "tmdb_person_id,name,profile_path,biography,known_for_department,birthday,deathday,place_of_birth";
