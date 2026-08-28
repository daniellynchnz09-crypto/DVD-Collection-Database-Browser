-- Initial schema for the DVD/physical media collection database.
-- Mirrors the "All DVDs and Specs" Google Sheet (Claude/RESOURCES.md) plus the
-- additional columns specified in Claude/TECH STACK AND ARCHITECTURE.md.
-- Run this against BOTH the private and public Supabase projects.

create extension if not exists pgcrypto;

create table if not exists titles (
  unique_id uuid primary key default gen_random_uuid(),

  -- Core spreadsheet columns (Claude/RESOURCES.md)
  title text not null,
  -- Free text, not a fixed enum: RESOURCES.md's own spec lists this as open-ended ("... etc.")
  -- and the real collection has legitimate categories beyond the original 7
  -- (TV Movie, TV Episode, Live Performance, ...). sync-sheet.ts normalizes casing/typos
  -- on the way in, but does not force values into a closed set.
  movie_or_tv text not null,
  season_no text,
  part_of_season_no text,
  episode_count integer,
  release_date date,
  running_time_mins integer,
  genre text[] not null default '{}',
  director text[] not null default '{}',
  franchise text,
  sub_franchise text,
  rating text,
  format text not null,
  disc_count integer not null default 1,
  special_features boolean not null default false,
  special_features_disc_count integer,
  special_features_disc_format text,
  animation_or_live_action text not null default 'Live Action',
  documentary text not null default 'n',
  is_collection boolean not null default false,
  name_of_collection text,
  title_in_a_collection boolean not null default false,
  number_of_titles_in_collection integer,
  rotten_tomatoes_page text,
  imdb_page text,
  studio text,
  disk_region text,

  -- Added columns per STEP BY STEP PROCESS AND AUTOMATION.md / TECH STACK AND ARCHITECTURE.md
  barcode_id text,
  case_image_url text,
  genre_location text,

  last_updated timestamptz not null default now()
);

create index if not exists titles_title_idx on titles using btree (title);
create index if not exists titles_genre_idx on titles using gin (genre);
create index if not exists titles_genre_location_idx on titles using btree (genre_location);
create index if not exists titles_barcode_id_idx on titles using btree (barcode_id);
create index if not exists titles_franchise_idx on titles using btree (franchise);

-- Keep last_updated current on every write, so the Google Sheet sync can tell
-- which side changed most recently (see TECH STACK AND ARCHITECTURE.md's Google Sheet Sync section).
create or replace function set_last_updated()
returns trigger as $$
begin
  new.last_updated = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists titles_set_last_updated on titles;
create trigger titles_set_last_updated
  before update on titles
  for each row
  execute function set_last_updated();

-- Row Level Security: public read, owner-only write.
-- (See TECH STACK AND ARCHITECTURE.md's Security & Secrets and Auth sections -
-- this is the real access boundary, not just hidden UI.)
alter table titles enable row level security;

drop policy if exists titles_public_read on titles;
create policy titles_public_read
  on titles for select
  using (true);

drop policy if exists titles_owner_write on titles;
create policy titles_owner_write
  on titles for all
  using (auth.role() = 'authenticated')
  with check (auth.role() = 'authenticated');

-- Taste profiles (Claude/AIM.md Aim Four). Not tied to Supabase Auth users -
-- these are household presets, not personal logins (see TECH STACK AND ARCHITECTURE.md's Auth section).
create table if not exists taste_profiles (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  filters jsonb not null default '{}',
  created_at timestamptz not null default now()
);

alter table taste_profiles enable row level security;

drop policy if exists taste_profiles_public_read on taste_profiles;
create policy taste_profiles_public_read
  on taste_profiles for select
  using (true);

drop policy if exists taste_profiles_owner_write on taste_profiles;
create policy taste_profiles_owner_write
  on taste_profiles for all
  using (auth.role() = 'authenticated')
  with check (auth.role() = 'authenticated');
