-- Adds a real, Storage-hosted product/case photo per title - added 2026-09-18 for the future
-- web app's DVD Pages (Claude/TECH STACK AND ARCHITECTURE/WEB APP DESIGN.md's "DVD Pages"
-- section: "Ajacent to this information will be the image of the collection"), kept entirely
-- separate from `poster_image_path` (the OMDB/TMDb movie poster, used on Movie/TV Pages and
-- for the private-only pricing feature's confidence-scoring comparisons) - the two are never
-- in competition, per the user's own explicit clarification: both images are kept, for
-- different page types.
--
-- Two write paths feed this same column, priority expressed as a plain "don't overwrite if
-- already set" guard rather than any comparison logic - the same idempotent pattern
-- `poster_image_path` itself already uses in resolveAndCachePosterUrl:
--   1. A barcode scan's own product photo (apps/web/src/app/api/scan/confirm/route.ts) -
--      unconditional, since a fresh photo of the user's actual physical copy is always
--      authoritative.
--   2. An accepted price candidate's own product photo (from the private-only pricing
--      feature's own response route) - only when case_image_path is still null, i.e. only
--      for a title with no barcode photo at all (typically an older, pre-barcode-pipeline
--      collection entry).
--
-- NOT private-project-only, unlike that pricing feature's own `retail-product-images`
-- bucket - the scan pipeline and DVD Pages are ordinary, public-repo-relevant functionality,
-- so this migration applies to both live Supabase projects and is never excluded from the
-- public repo/sanitizer the way 0021/0024/0025 are.

alter table titles add column if not exists case_image_path text;

-- Separate bucket from `retail-product-images` on purpose: that one lives entirely inside
-- the private-only pricing feature's own directory, excluded wholesale from the public repo -
-- this bucket needs to exist and work in both builds, so it can't share infrastructure with
-- something that only exists in one of them. Private (no public/anon policies), same
-- cautious-by-default posture as every other bucket in this project - accessed only via the
-- service-role key server-side, signed URLs minted on demand.
insert into storage.buckets (id, name, public)
values ('case-images', 'case-images', false)
on conflict (id) do nothing;
