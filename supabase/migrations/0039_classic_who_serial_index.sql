-- Backs the classic-Doctor-Who-serial detection in searchTitleCandidates
-- (packages/backend/src/classicWhoSerials.ts). OMDB's own s= title-search endpoint cannot
-- find a classic-era (1963-1989) Doctor Who serial at all - each serial's individual
-- episodes are nested under the classic show's own IMDb entry (tt0056751) and are only
-- reachable via its season/episode listing (i=tt0056751&Season=N), never through a plain
-- title search. Verified live: searching "Underwater Menace" returns zero real hits and
-- instead false-matches an unrelated 1969 short film ("Look at Life: Underwater Menace",
-- Type "movie"), which is exactly what caused a real scan of that serial to come back
-- wrongly classified as a Movie instead of the classic-serial TV convention.
--
-- This table is a one-time cached index of every classic-era serial (populated by
-- scripts/src/build-classic-who-serial-index.ts from a hand-verified season/story
-- breakdown, cross-checked story-by-story against OMDB's own per-season episode counts),
-- fuzzy-matched via pg_trgm the same way tmdb_title_index already is (see
-- 0006_tmdb_title_index.sql) - but deliberately scoped to classic Doctor Who only, per the
-- user's own instruction, rather than generalized into a rule for every OMDB "episode"-
-- Type match (which is the right guess for an ordinary modern TV show disc as-is).
--
-- No RLS policies are added (RLS stays enabled with none) - this table is only ever
-- touched via the service-role key (the one-time build script, and the
-- fuzzy_search_classic_who_serials RPC call from searchTitleCandidates), the same pattern
-- as every other server-only local index table.
create extension if not exists pg_trgm;

create table classic_who_serial_index (
  id bigint generated always as identity primary key,
  title text not null,
  season integer not null,
  year integer not null,
  episode_count integer not null,
  primary_imdb_id text not null,
  imdb_ids text[] not null,
  updated_at timestamptz not null default now(),
  unique (season, title)
);

alter table classic_who_serial_index enable row level security;

create index classic_who_serial_index_trgm_idx on classic_who_serial_index using gin (lower(title) gin_trgm_ops);

-- PostgREST can't express the `%` trigram operator directly through its filter syntax, so
-- this is called via supabase.rpc('fuzzy_search_classic_who_serials', ...) instead.
create or replace function fuzzy_search_classic_who_serials(search_query text, match_limit int default 3)
returns table (
  title text,
  season integer,
  year integer,
  episode_count integer,
  primary_imdb_id text,
  imdb_ids text[],
  sim real
)
language sql
stable
as $$
  select title, season, year, episode_count, primary_imdb_id, imdb_ids,
         similarity(lower(title), lower(search_query)) as sim
  from classic_who_serial_index
  where lower(title) % lower(search_query)
  order by sim desc
  limit match_limit;
$$;
