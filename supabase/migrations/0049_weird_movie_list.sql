-- "Weird and Wonderful" from a real list (2026-10-06). The home row used to pick titles by rule
-- (rare genres, puppetry, 3D discs...); the user asked for it to come from the 366 Weird Movies
-- site's lists instead (366weirdmovies.com), plus films in the collection with a similar level
-- of weirdness in plot and aesthetic.
--
-- weird_movie_list: the site's Canonical 366, Apocrypha (films that just missed) and Apocrypha
-- Candidates (the shortlist still under consideration). Public data, filled by
-- scripts/src/import-weird-movie-list.ts.
--
-- titles.weird_tag: 'canon' / 'apocrypha' / 'candidate' for a title on those lists (set by the
-- import script for the whole collection, and by /api/scan/confirm for new scans), or 'similar'
-- for one judged comparably weird by hand. The import script never overwrites 'similar'.

create table if not exists public.weird_movie_list (
  section text not null check (section in ('canon', 'apocrypha', 'candidate')),
  title text not null,
  alt_titles text[] not null default '{}',
  year integer not null,
  match_key text not null,
  primary key (title, year)
);
create index if not exists weird_movie_list_match_key_idx on public.weird_movie_list (match_key);

alter table public.weird_movie_list enable row level security;
drop policy if exists "weird_movie_list public read" on public.weird_movie_list;
create policy "weird_movie_list public read" on public.weird_movie_list for select using (true);
grant select on public.weird_movie_list to anon, authenticated;
grant all on public.weird_movie_list to service_role;

alter table public.titles add column if not exists weird_tag text
  check (weird_tag in ('canon', 'apocrypha', 'candidate', 'similar'));
create index if not exists titles_weird_tag_idx on public.titles (weird_tag) where weird_tag is not null;

-- 0044 switched anon to per-column grants on titles, so a new column needs its own grant.
grant select (weird_tag) on public.titles to anon;
