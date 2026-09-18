-- Four independent additions, bundled into one migration since none of them touch the
-- others: personal_rating (a star rating sourced from a one-time watch-history import,
-- doubled onto a 10-point scale - see the backfill/rescan planning doc under Claude/TECH
-- STACK AND ARCHITECTURE/), rental tracking (is_currently_rented_out/
-- rented_by_who/date_rented - a real physical loan can happen to any disc at any time,
-- independent of any scan/rescan event), and original_language (manual entry, autocomplete
-- on ConfirmScreen - see Claude/TECH STACK AND ARCHITECTURE/barcode-review-screen-fields.md).
-- All four ship to both the private and public builds/repos - generic collection-management
-- fields with no privacy concern, same tier as disc_condition/case_notes (which already ship
-- to both); only the one-time import *script* that populates personal_rating is public-repo
-- excluded (already true before this migration - see sanitize-public-repo.ts's
-- EXCLUDE_FILENAMES), not the column itself.

-- The import source's own scale is 5 stars in half-star increments (0.5, 1, 1.5, ... 5.0).
-- Stored here doubled onto a whole-number 10-point scale (0.5 -> 1, 1 -> 2, ... 5.0 -> 10) so
-- the column can stay a plain integer rather than a numeric/decimal type for a value that's
-- always exactly one of 10 possible halves. Nullable/no default - most rows will never have
-- been matched to that source at all, and "hasn't been matched yet" must stay distinct from
-- "rated zero", which that source doesn't even allow as a real rating.
alter table titles add column if not exists personal_rating integer;

-- A real, specific need right now (a physical disc on loan to someone), not a speculative
-- feature - see scripts/src/backfill-commando-rental.ts for the one-time backfill this was
-- added for. `rented_by_who`/`date_rented` are only ever meaningful while
-- `is_currently_rented_out` is true; ConfirmScreen clears both client-side the moment the
-- checkbox is unticked (same "hide + clear on submit" precedent already used for the
-- Special Features Disc Count/Format fields), so there's no separate CHECK constraint
-- enforcing that here - matching how this schema already trusts the app layer for
-- analogous conditional-field pairs.
alter table titles add column if not exists is_currently_rented_out boolean not null default false;
alter table titles add column if not exists rented_by_who text;
alter table titles add column if not exists date_rented date;

-- Manual entry only for this pass (autocomplete dropdown of previously-entered values, same
-- AutocompleteInput/fieldOptions.ts pattern as Studio/Rating) - see
-- barcode-review-screen-fields.md for why TMDb's per-title original_language field (a bare
-- ISO 639-1 code, e.g. "en") wasn't wired in as an auto-fill source this pass.
alter table titles add column if not exists original_language text;
