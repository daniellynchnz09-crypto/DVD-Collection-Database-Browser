-- Adds a "Release Name" column: the verbatim edition/packaging title as printed on the
-- disc/case (e.g. "Gladiator Special Edition"), distinct from the canonical `title`
-- ("Gladiator") that OMDB matching and cataloguing use. Null/"n/a" whenever the release
-- name and the canonical title are the same, per the user's own spec. Run against BOTH
-- Supabase projects.

alter table titles add column if not exists release_name text;
