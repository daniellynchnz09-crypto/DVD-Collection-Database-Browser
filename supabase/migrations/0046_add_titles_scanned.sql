-- `titles.scanned` (2026-10-06): true once a row has been through the scanner app. The website
-- only shows scanned rows for now - the user's own rule: everything scanned so far, and
-- everything scanned from here on, appears on the site; Sheet-only rows wait until the scanning
-- backlog reaches them.
--
-- Set by /api/scan/confirm on every row a confirm creates or overwrites (collection header and
-- members included), and on the already-catalogued row a "dismiss" re-scan matched. The Sheet
-- sync never writes it, so a Sheet edit can't un-scan a row.
--
-- Backfill rule for rows scanned before this column existed: a confirmed pending scan points at
-- it, or it has a case photo or date_added (both only ever set by the scan-confirm flow), or it
-- is a member of a collection header that is itself scanned (a confirm only records its first
-- created row in pending_scans.resolved_title_id).
--
-- PUBLIC demo project: its rows are a fixed demo subset, not scans, so whatever seeds it must
-- also set `scanned = true` on every row it writes (it held no rows yet when this was applied).

alter table public.titles add column if not exists scanned boolean not null default false;

update public.titles t
   set scanned = true
 where t.date_added is not null
    or t.case_image_path is not null
    or exists (
         select 1 from public.pending_scans p
          where p.status = 'confirmed' and p.resolved_title_id = t.unique_id
       );

update public.titles m
   set scanned = true
  from public.titles h
 where h.is_collection
   and h.scanned
   and m.title_in_a_collection
   and m.name_of_collection = h.name_of_collection
   and not m.scanned;

create index if not exists titles_scanned_idx on public.titles (scanned) where scanned;

-- 0044 switched anon to per-column grants, so a new column is invisible to it until granted.
grant select (scanned) on public.titles to anon;
