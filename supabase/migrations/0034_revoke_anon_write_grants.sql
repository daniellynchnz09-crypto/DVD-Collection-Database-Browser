-- Tightens `anon` down to SELECT-only on every table shared by both Supabase projects - added
-- 2026-09-24, right after 0032_add_public_schema_grants.sql. Applying that migration's own
-- verification query turned up something predating it: `anon` already held full INSERT/
-- UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER grants on every table (an older, more permissive
-- Supabase project default), with Row Level Security as the ONLY thing actually stopping the
-- public anon key from writing directly to any table. That matches neither this app's own
-- design (the mobile app's own supabase.ts is explicit: "Writes go through apps/web's
-- secret-gated API routes instead, since the mobile app must never hold the service-role key")
-- nor real defense-in-depth - a single RLS policy bug or omission would otherwise be the only
-- thing standing between the public anon key and a direct write.
--
-- Revokes everything except SELECT from `anon`, then re-grants SELECT explicitly so the net
-- result is unambiguous regardless of exactly what combination existed before. `authenticated`
-- and `service_role` are untouched - `authenticated` is unused today (nothing in this app signs
-- in via Supabase Auth) but harmless to leave matching Supabase's own template, and
-- `service_role` is exactly what every server-side route already relies on for real writes.

revoke all privileges on public.titles from anon;
grant select on public.titles to anon;

revoke all privileges on public.pending_scans from anon;
grant select on public.pending_scans to anon;

revoke all privileges on public.taste_profiles from anon;
grant select on public.taste_profiles to anon;

revoke all privileges on public.tmdb_title_index from anon;
grant select on public.tmdb_title_index to anon;

revoke all privileges on public.tmdb_tv_title_index from anon;
grant select on public.tmdb_tv_title_index to anon;

revoke all privileges on public.upc_quota_status from anon;
grant select on public.upc_quota_status to anon;
