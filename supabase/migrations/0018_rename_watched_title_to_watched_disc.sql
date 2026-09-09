-- Renames `watched_title` to `watched_disc`, following the semantic swap in
-- 0017_swap_watched_semantics.sql - the column now means "watched this specific physical
-- disc/title release" (the narrow claim), and its old name was actively misleading once its
-- meaning flipped to the opposite of "watched" (which now means "seen this film at some
-- point, any format" - the broad claim). Data was already correctly swapped by 0017; this
-- migration only renames the column, it doesn't touch any values.
alter table titles rename column watched_title to watched_disc;
