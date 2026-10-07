-- Closes the `authenticated` role's write access (2026-10-07 security pass). Both projects.
-- Applied to both projects 2026-10-07.
--
-- The hole: 0001/0002 gave titles, taste_profiles and pending_scans an "owner write" policy of
-- `auth.role() = 'authenticated'`, and 0032 granted that role full CRUD, on the reasoning that
-- "no code path ever holds an authenticated JWT". But anyone can get one: the anon key is public
-- (scanner app bundle, website), and with it they can call Supabase Auth's sign-up endpoint (or
-- anonymous sign-in, if that's switched on) and get a session for a brand-new user. That user's
-- role is `authenticated`, so the policies above let them update or delete every row of
-- `titles`, rewrite taste profiles and pending scans, and also SELECT the private columns 0044
-- hid from anon (rented_by_who, personal ratings, condition notes, barcodes) - 0044 only
-- narrowed anon's grant, not authenticated's.
--
-- Nothing in this app signs in through Supabase Auth (every write goes through the server's
-- service-role key, which bypasses RLS and these grants), so the role gets no access to these
-- tables at all, and the over-broad policies are dropped so a future re-grant doesn't silently
-- reopen them. When Phase 4's real owner login arrives, its policies should check the owner's
-- own user id, not just "is signed in".
--
-- Also worth doing in the dashboard, on both projects: Authentication > Sign In / Providers >
-- turn off "Allow new users to sign up" and anonymous sign-ins.

revoke all privileges on public.titles from authenticated;
revoke all privileges on public.pending_scans from authenticated;
revoke all privileges on public.taste_profiles from authenticated;
revoke all privileges on public.tmdb_title_index from authenticated;
revoke all privileges on public.tmdb_tv_title_index from authenticated;
revoke all privileges on public.upc_quota_status from authenticated;

drop policy if exists titles_owner_write on public.titles;
drop policy if exists pending_scans_owner_write on public.pending_scans;
drop policy if exists taste_profiles_owner_write on public.taste_profiles;

-- Extended before applying (2026-10-07): the live grants also gave `authenticated` the read
-- tables below, and gave both roles write/TRUNCATE rights on weird_movie_list (Supabase's default
-- privileges hand every new table to anon/authenticated). RLS (read-only policies) already
-- blocks those writes through the API, and PostgREST can't TRUNCATE, so this is defence in
-- depth: the site only ever needs anon SELECT.
revoke all privileges on public.weird_movie_list from authenticated;
revoke all privileges on public.people from authenticated;
revoke all privileges on public.title_credits from authenticated;
revoke all privileges on public.title_metadata from authenticated;
revoke insert, update, delete, truncate, references, trigger on public.weird_movie_list from anon;

-- Future tables created by migrations (run as postgres) no longer start with these rights;
-- anon keeps the default SELECT, which each table's RLS read policy still gates.
alter default privileges for role postgres in schema public revoke all on tables from authenticated;
alter default privileges for role postgres in schema public revoke insert, update, delete, truncate, references, trigger on tables from anon;
