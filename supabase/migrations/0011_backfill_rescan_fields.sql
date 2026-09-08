-- Fields added ahead of the full-collection backfill rescan (Claude/TECH STACK AND
-- ARCHITECTURE.md's "Backfill Rescan" section). The user is about to re-scan every disc
-- in the physical collection over several weeks and wants to do that exactly once, so this
-- migration adds two kinds of column: (a) a clean canonical film id/link on every row, so
-- every other metadata-driven feature in the planning docs (scores, cast/crew, synopsis,
-- Letterboxd, ...) can be backfilled later by a script keyed on that id, without ever
-- touching the shelf again, and (b) the handful of fields that genuinely can only be
-- captured by looking at the physical disc/case itself (condition, alternate-edition
-- notes, watched status) and so would require a second rescan if skipped now. Run against
-- BOTH Supabase projects.

-- Clean lookup keys, distinct from the existing imdb_page (a full URL) and tmdb_id (an
-- internal numeric id with no existing human-clickable link column) - added per the user's
-- own request "so future lookups are easier" from the Sheet/web app.
alter table titles add column if not exists imdb_id text;
alter table titles add column if not exists tmdb_page text;

create index if not exists titles_imdb_id_idx on titles using btree (imdb_id);

-- True "added to this database" timestamp, distinct from last_updated (which the
-- set_last_updated trigger bumps on every write, including unrelated corrections - see the
-- misspelling/format/rating/animation backfill scripts - so it can never reliably answer
-- "recently added" on its own). Deliberately NOT backfilled for existing rows: nobody
-- actually knows when each of the ~3,000 already-imported rows was first added, and
-- guessing "now" for all of them would be actively misleading. Only gets a value going
-- forward, via the column default below, which the app never overrides in an insert.
alter table titles add column if not exists date_added timestamptz;
alter table titles alter column date_added set default now();

-- Disc/case condition, split into two columns per the user's own distinction: playback
-- damage (a closed set of severities, see DISC_CONDITION_VALUES in
-- packages/shared/src/titleParsing.ts) vs. free-text case/mismatch notes (the rarer
-- "blank case" scenario from Claude/DEFINITIONS.md and STEP BY STEP PROCESS AND
-- AUTOMATION.md, which isn't a severity scale at all). Defaults to 'None' - the user's own
-- choice, to keep the rescan itself fast (only touch this when something's actually wrong),
-- with 'Visual Unchecked' available for a disc that looks scratched but has never been
-- played to find out how badly.
alter table titles add column if not exists disc_condition text not null default 'None';
alter table titles add column if not exists case_notes text;

-- Alternate physical edition/release-variant info - explicitly flagged as an unsolved,
-- still-wanted feature in Claude/Prompt Journal.md and Claude/To Do list.md ("no database
-- of DVD/Blu-ray edition data appears to exist anywhere online ... invent new spreadsheet
-- categories/columns and manual workarounds"). This is that first workaround column: plain
-- free text captured now, so the raw information isn't lost even before the full feature
-- around it is designed.
alter table titles add column if not exists release_variant_note text;

-- Simple self-reported watched flag, independent of any future Letterboxd integration -
-- the user's own collection may hold multiple physical copies of the same film (e.g. a
-- Blu-ray and a 4K UHD), and Letterboxd's diary has no way to say which specific copy was
-- watched, so this stays a manual, per-disc flag rather than something Letterboxd data can
-- safely overwrite later. Defaults to false/unwatched, same "don't slow the rescan down"
-- reasoning as disc_condition.
alter table titles add column if not exists watched boolean not null default false;

-- Display-only worded era label for History Documentary titles (e.g. "Spanish Civil War",
-- "1980s"), alongside the existing depicted_era_start (0002_pending_scans.sql) - that
-- column stays the sortable integer used by computeShelfLocation and is never shown to a
-- user; this is the human-readable text a browsing user would actually see on the web app.
alter table titles add column if not exists depicted_era_label text;
