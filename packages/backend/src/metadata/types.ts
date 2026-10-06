import type { TmdbMediaType } from "../tmdb";

/** Row shapes for supabase/migrations/0043_title_metadata.sql. */

/** title_metadata columns written from TMDb (scores are written separately from OMDb). */
export interface TitleMetadataTmdbFields {
  imdb_id: string;
  tmdb_id: number;
  tmdb_media_type: TmdbMediaType;
  title: string | null;
  original_title: string | null;
  tagline: string | null;
  overview: string | null;
  poster_path: string | null;
  backdrop_path: string | null;
  release_date: string | null;
  runtime_mins: number | null;
  genres: string[];
  number_of_seasons: number | null;
  number_of_episodes: number | null;
  tmdb_fetched_at: string;
}

/** title_metadata columns written from OMDb. */
export interface TitleMetadataOmdbFields {
  imdb_id: string;
  imdb_rating: number | null;
  imdb_votes: number | null;
  rotten_tomatoes_score: number | null;
  metacritic_score: number | null;
  omdb_fetched_at: string;
}

/** A people row. Credit refreshes only fill the first four fields; the rest are lazy. */
export interface PersonRow {
  tmdb_person_id: number;
  name: string;
  profile_path: string | null;
  known_for_department: string | null;
  biography?: string | null;
  birthday?: string | null;
  deathday?: string | null;
  place_of_birth?: string | null;
  fetched_at?: string | null;
}

export interface CreditRow {
  imdb_id: string;
  tmdb_person_id: number;
  credit_type: "cast" | "crew";
  character: string | null;
  job: string | null;
  department: string | null;
  credit_order: number;
}
