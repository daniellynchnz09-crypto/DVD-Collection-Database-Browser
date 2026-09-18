-- Ahead of TV scanning support: TMDb ids for movies and TV shows are separate number spaces
-- (a movie id 550 and a TV id 550 are unrelated), so `tmdb_id` alone no longer tells the
-- periodic refresh job (refreshTmdbFields, packages/backend/src/tmdb.ts) which endpoint to
-- call - "/movie/{id}" or "/tv/{id}". tmdb_media_type records that explicitly rather than
-- re-deriving it from movie_or_tv at refresh time, which would silently go stale if
-- movie_or_tv is ever corrected later (e.g. via Direct Database Access) without this column
-- being re-derived too.
--
-- Every row with a tmdb_id already set predates TV scanning support entirely (the live
-- lookup only ever called TMDb's /movie endpoints until this feature), so every one of them
-- is genuinely a movie id - backfilled as "movie" here rather than left null, per the user's
-- own instruction. New rows get "movie"/"tv" written by the confirm route going forward,
-- same as tmdb_id itself; DB-only, no Sheet column (same treatment as tmdb_id/tmdb_page).
--
-- Run against BOTH Supabase projects.

alter table titles add column if not exists tmdb_media_type text;

update titles set tmdb_media_type = 'movie' where tmdb_id is not null and tmdb_media_type is null;
