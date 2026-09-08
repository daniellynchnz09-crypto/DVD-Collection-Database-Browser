-- TV/documentary counterpart to tmdb_title_index (0006). The user's original request was
-- to check the whole collection ("movies or tv") for misspellings - the movie-only index
-- covered the majority (2352 of 3064 rows) but every TV-type entry (TV Series/Movie/
-- Mini-Series/Episode/Special, ~625 rows) had nothing to fuzzy-match against, since TMDb's
-- movie export obviously has no TV titles. TMDb also publishes a daily TV-series export
-- (https://files.tmdb.org/p/exports/tv_series_ids_MM_DD_YYYY.json.gz - verified live by
-- downloading and inspecting a real file: each line is {id, original_name, popularity},
-- no "adult" field at all unlike the movie export, so no filtering is needed on import).
--
-- Mirrors 0006/0008 exactly - trigram GIN index for the fuzzy `%` operator, a btree index
-- for fast exact lookups, and the same exact-match-always-wins-first ranking (baked in from
-- the start this time, having already found and fixed that bug once on the movie index).
create table tmdb_tv_title_index (
  tmdb_id integer primary key,
  title text not null,
  popularity real not null default 0,
  updated_at timestamptz not null default now()
);

alter table tmdb_tv_title_index enable row level security;

create index tmdb_tv_title_index_trgm_idx on tmdb_tv_title_index using gin (lower(title) gin_trgm_ops);
create index tmdb_tv_title_index_lower_title_btree on tmdb_tv_title_index (lower(title));

create or replace function fuzzy_search_tmdb_tv_titles(search_query text, match_limit int default 5)
returns table (tmdb_id integer, title text, popularity real, sim real)
language sql
stable
as $$
  select tmdb_id, title, popularity, similarity(lower(title), lower(search_query)) as sim
  from tmdb_tv_title_index
  where lower(title) % lower(search_query)
  order by
    (similarity(lower(title), lower(search_query)) >= 0.999) desc,
    round(similarity(lower(title), lower(search_query))::numeric, 1) desc,
    popularity desc,
    similarity(lower(title), lower(search_query)) desc
  limit match_limit;
$$;
