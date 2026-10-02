-- Adds a within-season broadcast position to classic_who_serial_index (0039), needed for the
-- Doctor Who shelf-ordering feature (2026-09-30): the user wants their "BOX TV Sci-Fi" shelf
-- ordered by real release order rather than alphabetically for Doctor Who specifically, with
-- an individual serial disc placed directly before the season box set it belongs to. That
-- requires a per-serial position within its own season (1st story of the season, 2nd, ...),
-- not just which season it's from - see scripts/src/build-classic-who-serial-index.ts, which
-- re-populates this column from the same broadcast-order-verified CLASSIC_WHO_SEASONS list
-- already used to build every other column.
alter table classic_who_serial_index add column story_order_in_season integer;
