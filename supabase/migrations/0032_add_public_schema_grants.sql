-- Explicit Data API grants for every existing table shared by both Supabase projects - added
-- 2026-09-24, in response to Supabase's own announcement that from 2026-10-30 it stops
-- auto-granting Data API access to new tables in the public schema. "Nothing changes for your
-- existing tables" per that email - this migration doesn't loosen or tighten anything today,
-- it just makes today's already-implicit default grants explicit and permanent, so they
-- survive the one real scenario that DOES change: a full `supabase db reset`, a fresh project
-- built from this migration history, or a new preview branch, all replayed after 2026-10-30.
-- Without this, any of those would silently leave every table below unreachable through
-- supabase-js/PostgREST/GraphQL even though the *rows* and RLS policies are all still correct -
-- a "permission denied" error, not a missing-data one.
--
-- Grants mirror Supabase's own recommended template exactly (their email's own example), and
-- match how this app actually uses each role today:
-- - `anon` gets SELECT only - the mobile app's own supabase.ts is explicit that the publishable/
--   anon key is read-only in this codebase ("Reads... go straight to Supabase with the
--   publishable/anon key... Writes go through apps/web's secret-gated API routes instead,
--   since the mobile app must never hold the service-role key") - RLS policies (defined
--   elsewhere, unchanged by this migration) are what actually decide which anon reads succeed.
-- - `authenticated` gets full CRUD per Supabase's own template, though nothing in this app
--   currently authenticates via Supabase Auth at all (this is a single-owner app gated by a
--   shared secret header, not per-user login) - harmless to grant, since no code path ever
--   holds an `authenticated` JWT to use it with.
-- - `service_role` gets full CRUD, matching what every server-side route (apps/web's API
--   routes, scripts/) already uses via the service role key.
--
-- Deliberately split from the private-only tables (amazon_provider_quota,
-- pending_value_review, title_price_observations - see
-- 0033_add_estimated_value_schema_grants.sql) rather than one combined file, mirroring how
-- every other Estimated-Value-only migration (0021, 0024, 0025, 0029) is already excluded from
-- the public repo by filename in scripts/src/sanitize-public-repo.ts - this file's own table
-- list is exactly what both live projects actually have in common.

grant select on public.titles to anon;
grant select, insert, update, delete on public.titles to authenticated;
grant select, insert, update, delete on public.titles to service_role;

grant select on public.pending_scans to anon;
grant select, insert, update, delete on public.pending_scans to authenticated;
grant select, insert, update, delete on public.pending_scans to service_role;

grant select on public.taste_profiles to anon;
grant select, insert, update, delete on public.taste_profiles to authenticated;
grant select, insert, update, delete on public.taste_profiles to service_role;

grant select on public.tmdb_title_index to anon;
grant select, insert, update, delete on public.tmdb_title_index to authenticated;
grant select, insert, update, delete on public.tmdb_title_index to service_role;

grant select on public.tmdb_tv_title_index to anon;
grant select, insert, update, delete on public.tmdb_tv_title_index to authenticated;
grant select, insert, update, delete on public.tmdb_tv_title_index to service_role;

grant select on public.upc_quota_status to anon;
grant select, insert, update, delete on public.upc_quota_status to authenticated;
grant select, insert, update, delete on public.upc_quota_status to service_role;
