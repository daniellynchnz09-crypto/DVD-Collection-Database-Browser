-- Adds a dedicated Steelbook column, mirroring special_features's boolean convention
-- (see Claude/DEFINITIONS.md's Steelbook entry, Claude/TECH STACK AND ARCHITECTURE.md).
-- Previously "steelbook" was just a word typed into the Format column (e.g. "DVD
-- Steelbook") - packages/shared/src/titleParsing.ts's backfill strips that word back out
-- of existing rows' Format once this column exists. Run against BOTH Supabase projects.

alter table titles add column if not exists steelbook boolean not null default false;
