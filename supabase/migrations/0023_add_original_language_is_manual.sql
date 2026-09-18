-- Wires original_language (0022_add_rental_and_language_fields.sql) up to TMDb's own
-- per-title `original_language` field, following the exact rating_is_manual/studio_is_manual
-- precedent from 0005_add_tmdb_fields.sql: original_language_is_manual protects anything the
-- user actually typed in (only possible when TMDb had no match for the title at all) from
-- ever being overwritten by a later refreshTmdbFields pass. Defaulting to true means every
-- existing row (backfilled from the original Sheet, long before this auto-fill existed) is
-- treated as manual/authoritative the moment this migration runs - only the scan-confirm
-- pipeline's TMDb auto-fill path (title had no manual value AND a real TMDb match) ever sets
-- one to false. Run against BOTH Supabase projects.

alter table titles add column if not exists original_language_is_manual boolean not null default true;
