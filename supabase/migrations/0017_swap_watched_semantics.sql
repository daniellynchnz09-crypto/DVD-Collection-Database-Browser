-- Swaps the meaning of `watched` and `watched_title`, per the user's own clarification of
-- the two-metric design (0013_add_watched_title.sql): `watched` now means "I have seen this
-- film at some point, on any format" (the broader claim), while `watched_title` means "I
-- have watched this specific physical disc/title release" (the narrower, per-row claim) -
-- the reverse of the original mapping. A single UPDATE swaps every row correctly in one
-- pass: Postgres evaluates every expression on the right-hand side of SET against the row's
-- OLD values before writing any of them, so this can't half-apply.
update titles set watched = watched_title, watched_title = watched;
