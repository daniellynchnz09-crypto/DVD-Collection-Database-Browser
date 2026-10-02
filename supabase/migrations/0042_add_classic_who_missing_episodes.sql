-- Backs the classic-Who animated-reconstruction detection (classicWhoSerials.ts,
-- ConfirmScreen.tsx's Animation/Live Action prefill) - per the user's own explanation
-- (2026-10-01): several first/second Doctor serials are missing some or all of their
-- episodes from the BBC archive, and recently a number of these have been officially
-- released with the missing episode(s) redrawn as animation. A serial with any missing
-- episodes could never have a purely-live-action standalone DVD/Blu-ray release - the story
-- either has no disc release at all (only surviving fragments inside the "Doctor Who Lost in
-- Time" compilation) or the one that does exist is necessarily an animated reconstruction -
-- so matching a scanned title to one of these serials is itself strong evidence the disc in
-- hand is that reconstruction, on top of whatever the cover art itself looks like.
--
-- missing_episode_count defaults to 0 (the vast majority of classic serials are fully intact)
-- and is populated for the known incomplete ones by
-- scripts/src/backfill-classic-who-missing-episodes.ts, hand-verified against Wikipedia's
-- "List of incomplete Doctor Who serials" the same way CLASSIC_WHO_SEASONS itself was
-- hand-verified against documented broadcast history.
alter table classic_who_serial_index add column missing_episode_count integer not null default 0;

-- The function's return row shape is changing (a new OUT column), which `create or replace`
-- cannot do on its own - Postgres requires the old signature dropped first.
drop function if exists fuzzy_search_classic_who_serials(text, int);

create or replace function fuzzy_search_classic_who_serials(search_query text, match_limit int default 3)
returns table (
  title text,
  season integer,
  year integer,
  episode_count integer,
  missing_episode_count integer,
  primary_imdb_id text,
  imdb_ids text[],
  sim real
)
language sql
stable
as $$
  select title, season, year, episode_count, missing_episode_count, primary_imdb_id, imdb_ids,
         similarity(lower(title), lower(search_query)) as sim
  from classic_who_serial_index
  where lower(title) % lower(search_query)
  order by sim desc
  limit match_limit;
$$;
