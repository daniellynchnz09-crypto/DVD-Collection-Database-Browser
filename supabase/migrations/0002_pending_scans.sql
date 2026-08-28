-- Phase 1 (barcode scanning): a scan queue decoupled from lookup, plus the
-- documentary chronological-ordering field. See Claude/TECH STACK AND
-- ARCHITECTURE.md's "BARCODE SCANNING PIPELINE" section for the design.

create table if not exists pending_scans (
  id uuid primary key default gen_random_uuid(),
  barcode text not null,
  scanned_at timestamptz not null default now(),
  status text not null default 'pending' check (
    status in ('pending', 'resolved', 'needs_manual', 'confirmed')
  ),
  -- Best-guess candidates from the resolver: UPC product info, OMDB movie/series
  -- candidates, collection sub-title suggestions, inferred depicted_era_start, etc.
  resolved_candidates jsonb not null default '{}',
  resolved_title_id uuid references titles (unique_id),
  last_updated timestamptz not null default now()
);

create index if not exists pending_scans_status_idx on pending_scans using btree (status);
create index if not exists pending_scans_barcode_idx on pending_scans using btree (barcode);

drop trigger if exists pending_scans_set_last_updated on pending_scans;
create trigger pending_scans_set_last_updated
  before update on pending_scans
  for each row
  execute function set_last_updated();

-- Same access boundary as titles: public read, owner/service write.
alter table pending_scans enable row level security;

drop policy if exists pending_scans_public_read on pending_scans;
create policy pending_scans_public_read
  on pending_scans for select
  using (true);

drop policy if exists pending_scans_owner_write on pending_scans;
create policy pending_scans_owner_write
  on pending_scans for all
  using (auth.role() = 'authenticated')
  with check (auth.role() = 'authenticated');

-- Documentary chronological ordering (Claude/AIM.md Aim Five, refined per the
-- user's "History Documentary" shelf section): the era a documentary depicts,
-- not when it was made. Nullable - filled by regex inference or manually.
alter table titles add column if not exists depicted_era_start integer;
