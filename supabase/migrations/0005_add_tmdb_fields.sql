-- Adds TMDb integration bookkeeping (see Claude/TECH STACK AND ARCHITECTURE.md's TMDb
-- section). tmdb_id lets the periodic refresh job re-fetch a title without re-searching
-- by name; tmdb_synced_at tracks when it was last refreshed, since TMDb's own API Terms
-- of Use prohibit caching their data for longer than 6 months.
--
-- rating_is_manual/studio_is_manual protect anything the user actually typed in (from the
-- physical case, or already in the original Sheet before this feature existed) from ever
-- being overwritten by an automated refresh - defaulting to true means every existing row
-- is treated as manual/authoritative the moment this migration runs (nothing needs a
-- separate backfill), and only the scan-confirm pipeline's TMDb auto-fill path (when the
-- user left the field blank) ever sets one to false, making that specific value eligible
-- for future refresh. Run against BOTH Supabase projects.

alter table titles add column if not exists tmdb_id integer;
alter table titles add column if not exists tmdb_synced_at timestamptz;
alter table titles add column if not exists rating_is_manual boolean not null default true;
alter table titles add column if not exists studio_is_manual boolean not null default true;
