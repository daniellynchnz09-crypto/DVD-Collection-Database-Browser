/**
 * Page-facing data types. These are deliberately NOT `Title` from @danflix/shared: that type
 * includes private columns (estimated value, renter, notes...), so pages get narrower row
 * types that match the explicit column lists in columns.ts one-to-one.
 */

/** Row shape for TITLE_CARD_COLUMNS. */
export interface TitleCardRow {
  unique_id: string;
  title: string;
  release_name: string | null;
  format: string;
  movie_or_tv: string;
  release_date: string | null;
  is_collection: boolean;
  title_in_a_collection: boolean;
  name_of_collection: string | null;
  imdb_page: string | null;
  movie_poster_path: string | null;
  case_image_path: string | null;
  case_image_url: string | null;
  steelbook: boolean;
  date_added: string | null;
}

/** Row shape for TITLE_DETAIL_COLUMNS. */
export interface TitleDetailRow extends TitleCardRow {
  season_no: string | null;
  part_of_season_no: string | null;
  episode_count: number | null;
  running_time_mins: number | null;
  genre: string[];
  director: string[];
  franchise: string[];
  rating: string | null;
  disc_count: number;
  special_features: boolean;
  special_features_disc_count: number | null;
  special_features_disc_format: string | null;
  special_features_disc_number_in_set: string | null;
  animation_or_live_action: string;
  documentary: string;
  number_of_titles_in_collection: number | null;
  disc_number_in_set: string | null;
  rotten_tomatoes_page: string | null;
  tmdb_page: string | null;
  tmdb_id: number | null;
  tmdb_media_type: "movie" | "tv" | null;
  studio: string | null;
  disk_region: string | null;
  original_language: string | null;
  release_variant_note: string | null;
  /** Fine to show; WHO has it (rented_by_who) is never selected. */
  is_currently_rented_out: boolean;
  watched: boolean;
  last_updated: string;
}

/** `title_metadata` (0043) - one row per film, keyed by IMDb id. */
export interface TitleMetadata {
  imdb_id: string;
  tmdb_id: number | null;
  tmdb_media_type: "movie" | "tv" | null;
  title: string | null;
  original_title: string | null;
  tagline: string | null;
  overview: string | null;
  poster_path: string | null;
  backdrop_path: string | null;
  release_date: string | null;
  runtime_mins: number | null;
  genres: string[];
  imdb_rating: number | null;
  imdb_votes: number | null;
  rotten_tomatoes_score: number | null;
  /** Rotten Tomatoes audience score (MDBList's "popcorn"), migration 0050. */
  rt_audience_score: number | null;
  metacritic_score: number | null;
  number_of_seasons: number | null;
  number_of_episodes: number | null;
}

/** `people` (0043). */
export interface Person {
  tmdb_person_id: number;
  name: string;
  profile_path: string | null;
  biography: string | null;
  known_for_department: string | null;
  birthday: string | null;
  deathday: string | null;
  place_of_birth: string | null;
}

/** One `title_credits` row joined to its person. */
export interface Credit {
  credit_type: "cast" | "crew";
  character: string | null;
  job: string | null;
  department: string | null;
  credit_order: number | null;
  person: Pick<Person, "tmdb_person_id" | "name" | "profile_path">;
}

/** Where a resolved image came from - pages may style a case photo differently from a poster. */
export type ImageSource = "tmdb" | "movie_poster" | "case_image" | "case_url";

export interface CatalogImage {
  src: string;
  source: ImageSource;
  /** Pass straight to next/image: TMDb already serves pre-sized files and case_url can be any
   * host, so only our own Storage images go through the optimizer (see next.config.ts). */
  unoptimized: boolean;
}

/** Everything a PosterCard needs - built server-side so the card itself stays dumb. */
export interface PosterCardData {
  key: string;
  href: string;
  title: string;
  year: string | null;
  format: string | null;
  image: CatalogImage | null;
  /** Optional second line (e.g. "Disc 2", a character name). */
  caption?: string | null;
  /** Width/height of the frame. Case photos start at their format's case shape (caseAspect in
   * display.ts) and then settle on the photo's own shape; posters use 2/3. */
  aspect?: number;
}

/** A physical item (DVD Page) with its resolved images and links. */
export interface Disc {
  row: TitleDetailRow;
  imdbId: string | null;
  metadata: TitleMetadata | null;
  /** Card image priority: case_image_path > TMDb > movie_poster_path > case_image_url (images.ts). */
  poster: CatalogImage | null;
  /** The physical case photo (case_image_path > case_image_url), for DVD/Collection pages. */
  caseImage: CatalogImage | null;
  /** The box set this disc belongs to, when title_in_a_collection. */
  collection: { uniqueId: string; title: string } | null;
}

export interface Collection {
  header: Disc;
  /** Rows with title_in_a_collection = true and the same name_of_collection. */
  members: Disc[];
}

/** A film/series (Movie/TV Page): every physical row sharing one IMDb id. */
export interface Work {
  imdbId: string;
  /** Best display title: metadata title, else the first physical row's title. */
  title: string;
  metadata: TitleMetadata | null;
  poster: CatalogImage | null;
  backdrop: CatalogImage | null;
  items: Disc[];
}

export interface FacetValue {
  name: string;
  slug: string;
  count: number;
}

export interface ListOptions {
  limit?: number;
  offset?: number;
  /** Leave out box-set header rows (is_collection = true). */
  excludeCollectionHeaders?: boolean;
  /** Leave out rows that live inside a box set (title_in_a_collection = true). */
  excludeCollectionMembers?: boolean;
}
