-- Film-level metadata for the web app's Movie/TV, Person and Search pages - added 2026-10-06
-- (Claude/TECH STACK AND ARCHITECTURE/web-app-build-plan.md, "New tables"). One row per film
-- keyed by its IMDb id (the id already embedded in titles.imdb_page), so every physical copy of
-- the same film shares one metadata row. Details/cast/crew come from TMDb, scores from OMDb -
-- stored rather than fetched live so search can match by actor and person pages can list
-- everything owned. Written only by packages/backend/src/metadata/ (scan-confirm hook +
-- scripts/src/backfill-title-metadata.ts) through the service-role key.
--
-- Not a foreign key to titles: titles has no imdb_id column (dropped in 0019 - the id lives
-- inside imdb_page), and a film's metadata stays valid even if a copy is removed.
--
-- TMDb's terms forbid caching its data for more than 6 months - tmdb_fetched_at lets the
-- backfill re-fetch rows approaching that limit, same reasoning as titles.tmdb_synced_at.

create table if not exists title_metadata (
  imdb_id text primary key check (imdb_id ~ '^tt[0-9]+$'),
  tmdb_id integer,
  tmdb_media_type text check (tmdb_media_type in ('movie', 'tv')),
  title text,
  original_title text,
  tagline text,
  overview text,
  poster_path text,
  backdrop_path text,
  release_date date,
  runtime_mins integer,
  genres text[] not null default '{}',
  imdb_rating numeric(3, 1),
  imdb_votes integer,
  rotten_tomatoes_score integer check (rotten_tomatoes_score between 0 and 100),
  metacritic_score integer check (metacritic_score between 0 and 100),
  number_of_seasons integer,
  number_of_episodes integer,
  tmdb_fetched_at timestamptz,
  omdb_fetched_at timestamptz
);

-- biography/birthday/deathday/place_of_birth (and fetched_at, which tracks them) are filled
-- lazily - credit refreshes only ever write name/profile_path/known_for_department.
create table if not exists people (
  tmdb_person_id integer primary key,
  name text not null,
  profile_path text,
  biography text,
  known_for_department text,
  birthday date,
  deathday date,
  place_of_birth text,
  fetched_at timestamptz
);

-- A film's credits are replaced wholesale on each refresh (delete + insert), so a surrogate
-- key is enough - no natural unique key survives nullable character/job columns cleanly.
create table if not exists title_credits (
  id bigint generated always as identity primary key,
  imdb_id text not null references title_metadata (imdb_id) on delete cascade,
  tmdb_person_id integer not null references people (tmdb_person_id) on delete cascade,
  credit_type text not null check (credit_type in ('cast', 'crew')),
  character text,
  job text,
  department text,
  credit_order integer
);

create index if not exists title_credits_imdb_id_idx on title_credits (imdb_id);
create index if not exists title_credits_tmdb_person_id_idx on title_credits (tmdb_person_id);
-- Search matches people by name ("search by actor"), case-insensitively.
create index if not exists people_name_lower_idx on people (lower(name));

-- Public-read like titles (the site needs no login to browse); no write policies at all, so
-- only the service-role key (which bypasses RLS) can write.
alter table title_metadata enable row level security;
alter table people enable row level security;
alter table title_credits enable row level security;

drop policy if exists title_metadata_public_read on title_metadata;
create policy title_metadata_public_read on title_metadata for select using (true);

drop policy if exists people_public_read on people;
create policy people_public_read on people for select using (true);

drop policy if exists title_credits_public_read on title_credits;
create policy title_credits_public_read on title_credits for select using (true);

-- Explicit Data API grants (Supabase stops auto-granting new public tables from 2026-10-30 -
-- see 0032). anon is SELECT-only per 0034. authenticated is also SELECT-only here (tighter than
-- 0032's template) since nothing writes these tables except server-side service-role code.
revoke all privileges on public.title_metadata from anon, authenticated;
revoke all privileges on public.people from anon, authenticated;
revoke all privileges on public.title_credits from anon, authenticated;

grant select on public.title_metadata to anon, authenticated;
grant select on public.people to anon, authenticated;
grant select on public.title_credits to anon, authenticated;

grant select, insert, update, delete on public.title_metadata to service_role;
grant select, insert, update, delete on public.people to service_role;
grant select, insert, update, delete on public.title_credits to service_role;
