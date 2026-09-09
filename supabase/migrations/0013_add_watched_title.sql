-- Splits "watched" into two metrics, per the user's own distinction: `watched` (existing,
-- 0011_backfill_rescan_fields.sql) now specifically means "played THIS physical disc",
-- while `watched_title` means "seen this film/season at all, on any format" - true across
-- every physical copy a matched Letterboxd log resolves to, even when the log's disc-format
-- tag doesn't confirm which specific copy. Defaults to false, same reasoning as `watched`:
-- a blank/unknown answer is not the same as a confirmed "no".
alter table titles add column if not exists watched_title boolean not null default false;
