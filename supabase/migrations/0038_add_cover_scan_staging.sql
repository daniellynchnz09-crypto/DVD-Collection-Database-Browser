-- Cover-photo scanning (added 2026-09-28) - a temporary holding area for freshly-captured
-- front/back cover photos, staged from the moment they're captured in ScannerScreen's new
-- "Scan Cover" flow until the pending scan they belong to reaches a terminal state: confirmed
-- (a classified-front photo is promoted into case-images via promoteStagedCoverToCaseImage,
-- see coverStagingStorage.ts), dismissed (promoted onto the already-existing matched title
-- instead - the user just photographed that exact disc), or discarded/superseded (deleted
-- outright). See Claude/TECH STACK AND ARCHITECTURE/barcode-scanning-pipeline.md.
--
-- Uploaded before any pending_scans row exists (a scan session accumulates barcode/cover
-- captures client-side and only creates the row once the user taps "Done" - see
-- session-finish/route.ts), so staged photos are namespaced by a client-generated session id,
-- not a pending_scans id, and this column just records which staged paths belong to the row
-- once it's created.
--
-- NOT private-project-only, same reasoning as 0026/0036: physical cataloguing data, no
-- dollar values - applies to both live Supabase projects, never excluded from the public
-- repo/sanitizer.

alter table pending_scans add column if not exists staged_cover_photos jsonb not null default '[]';

-- Private (no public/anon policies) - accessed only via the service-role key server-side,
-- same posture as case-images/poster-images. Files here are always short-lived: uploaded
-- per-capture during an in-progress scan session, deleted the moment that session's
-- pending_scans row reaches any terminal state.
insert into storage.buckets (id, name, public)
values ('cover-scan-staging', 'cover-scan-staging', false)
on conflict (id) do nothing;
