-- Rotten Tomatoes audience score ("Popcornmeter") for title_metadata (2026-10-07).
-- OMDb only carries the critics' Tomatometer (rotten_tomatoes_score). The audience score comes
-- from MDBList (mdblist.com, free key, 1,000 requests/day, looked up by IMDb id), whose
-- "popcorn" rating source is the RT audience score. mdblist_fetched_at tracks when it was
-- last fetched, so refreshes can be spaced out like omdb_fetched_at.

alter table public.title_metadata
  add column if not exists rt_audience_score integer check (rt_audience_score between 0 and 100),
  add column if not exists mdblist_fetched_at timestamptz;
