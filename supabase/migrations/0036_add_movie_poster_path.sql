-- Adds a real, Storage-hosted, general-purpose movie poster per title - added 2026-09-25
-- per the user's own explicit request: "I would prefer if we had both a poster image and a
-- case image ... for each title in the database so that we already have all the images we
-- need for the web app once we get to that stage." This came out of a real, narrower bug
-- (rescanning an already-cataloged barcode whose UPC lookup keeps failing had no poster to
-- show on the "best match" step, since nothing permanent was ever cached for a title
-- confirmed via manual search with no product photo) - the user asked, correctly, why the
-- app doesn't just reuse a saved poster instead of hitting OMDB fresh every time.
--
-- Deliberately a NEW column, not a reuse of the existing `poster_image_path`
-- (0021_estimated_value.sql) - that one is populated only lazily, as a side effect of the
-- private-only Estimated Value feature happening to run on a title, into the private-only
-- `retail-product-images` bucket that doesn't exist at all in the public build. The user
-- explicitly asked for this to be general-purpose (works the same in both builds), so it
-- needed its own column and its own bucket, same reasoning `case_image_path`
-- (0026_add_case_image_path.sql) already used to justify NOT sharing that private bucket -
-- see that migration's own comment. The two poster-ish columns are not in competition:
-- `poster_image_path` stays exactly as-is for Estimated Value's own confidence-scoring use,
-- `movie_poster_path` is the general "this film's official poster" cache everything else
-- (the scan resolver's "best match" step, the future web app's Movie/TV Pages) should read
-- from first, before ever falling back to a live OMDB/TMDb lookup.
--
-- Populated unconditionally at scan-confirm time (apps/web/src/app/api/scan/confirm/
-- route.ts) whenever a real OMDB/TMDb candidate was picked (entry.imdbId set) and this
-- column isn't already populated - skipped once cached, unlike case_image_path's own
-- "always refresh" rule, since a film's official poster essentially never changes for a
-- given imdb_id the way a user's own physical case photo can (different edition/printing).

alter table titles add column if not exists movie_poster_path text;

-- Separate bucket from both `case-images` and the private-only `retail-product-images` -
-- private (no public/anon policies), same cautious-by-default posture as every other bucket
-- in this project, accessed only via the service-role key server-side with signed URLs
-- minted on demand. NOT private-project-only - applies to both live Supabase projects and is
-- never excluded from the public repo/sanitizer the way 0021/0024/0025/0033/0035 are.
insert into storage.buckets (id, name, public)
values ('poster-images', 'poster-images', false)
on conflict (id) do nothing;
