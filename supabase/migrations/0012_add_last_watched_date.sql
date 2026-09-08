-- Optional last-watched date, alongside the existing `watched` boolean
-- (0011_backfill_rescan_fields.sql). Added ahead of a planned one-time Letterboxd diary
-- export import (Claude/TECH STACK AND ARCHITECTURE.md) - the user's own Letterboxd diary
-- entries carry a watch date, and asked for it to be optional/nullable rather than
-- required, matching how `watched` itself defaults to false/unknown rather than forcing an
-- answer. A plain `date` (not `timestamptz`) since Letterboxd's diary only ever records a
-- calendar day, same convention as the existing `release_date` column.
alter table titles add column if not exists last_watched_date date;
