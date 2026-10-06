-- Score-site links for title_metadata (2026-10-07). The Metacritic tile had nowhere to link: OMDb
-- gives only the score and the Sheet has no Metacritic column. MDBList's replies (already
-- fetched for the RT audience score, migration 0050) carry each film's Metacritic and Rotten
-- Tomatoes page paths, so they're stored as full URLs. rotten_tomatoes_url backs up the Sheet's
-- own rotten_tomatoes_page where that's empty.

alter table public.title_metadata
  add column if not exists metacritic_url text check (metacritic_url ~ '^https://www\.metacritic\.com/'),
  add column if not exists rotten_tomatoes_url text check (rotten_tomatoes_url ~ '^https://www\.rottentomatoes\.com/');
