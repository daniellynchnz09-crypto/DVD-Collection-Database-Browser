-- Backs the manual title-search route's fuzzy-typo fallback (apps/web/src/app/api/scan/
-- title-search/route.ts): a local, periodically-refreshed copy of TMDb's public daily
-- movie-ID export (https://files.tmdb.org/p/exports/movie_ids_MM_DD_YYYY.json.gz -
-- verified live rather than assumed; each line is just {adult, id, original_title,
-- popularity, video}, no year/poster), imported by scripts/src/refresh-tmdb-title-index.ts.
--
-- Exists specifically because neither OMDB's nor TMDb's own search API is meaningfully
-- fuzzy for a realistic typo (verified live: "Jurrasic Park", "Lord of the Rngs" both
-- returned zero results from both providers) - a generic English-dictionary spellchecker
-- (packages/backend/src/spellcheck.ts) only catches typos of ordinary English words, not
-- invented/proper names like "Shawshank". Fuzzy-matching the user's exact typed text
-- against every real TMDb movie title (via pg_trgm) catches those too, since it matches
-- against actual title strings rather than English words.
--
-- No RLS policies are added (RLS stays enabled with none) - this table is only ever
-- touched via the service-role key (the bulk-import script, and the title-search route's
-- fuzzy_search_tmdb_titles RPC call), the same pattern as every other server-only table.
create extension if not exists pg_trgm;

create table tmdb_title_index (
  tmdb_id integer primary key,
  title text not null,
  popularity real not null default 0,
  updated_at timestamptz not null default now()
);

alter table tmdb_title_index enable row level security;

create index tmdb_title_index_trgm_idx on tmdb_title_index using gin (lower(title) gin_trgm_ops);

-- PostgREST can't express the `%` trigram operator directly through its filter syntax, so
-- this is called via supabase.rpc('fuzzy_search_tmdb_titles', ...) instead. Ranks by
-- similarity first, then popularity as a tie-breaker among comparably close matches.
create or replace function fuzzy_search_tmdb_titles(search_query text, match_limit int default 5)
returns table (tmdb_id integer, title text, popularity real, sim real)
language sql
stable
as $$
  select tmdb_id, title, popularity, similarity(lower(title), lower(search_query)) as sim
  from tmdb_title_index
  where lower(title) % lower(search_query)
  order by sim desc, popularity desc
  limit match_limit;
$$;
