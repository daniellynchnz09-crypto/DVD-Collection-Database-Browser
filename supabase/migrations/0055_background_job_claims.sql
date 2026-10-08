-- Background work only while someone is using the site or the scanner app (2026-10-09). Both
-- projects.
--
-- The GitHub resolve-scans.yml schedule (every 5 minutes, ~8,640 Actions minutes a month against
-- a 2,000 allowance) and instrumentation.ts's always-on loops are replaced by work that a page
-- view or a scanner-app request starts (apps/web/src/lib/backgroundJobs.ts). On Vercel several
-- copies of the server can run at once, so the "is a run already going / did one run recently"
-- check has to live in the database rather than in memory:
--
-- * background_job_runs + claim_background_job(): one row per job. A claim succeeds only when
--   no run holds the lock and the last run started at least p_min_interval_seconds ago. The
--   single UPDATE ... WHERE is atomic, so two servers can never both win.
-- * pending_scans.claimed_until: a resolver takes each scan before working on it, so two
--   resolver runs never spend two UPCitemdb lookups on the same barcode. A scan whose lookups
--   failed, or which has to wait for UPCitemdb/Gemini quota, is left "pending" with
--   claimed_until set to when it may be tried again (this replaces the resolver's per-process
--   retry map, which a serverless deploy would forget between requests).

create table if not exists public.background_job_runs (
  job text primary key,
  last_started_at timestamptz,
  locked_until timestamptz
);

alter table public.background_job_runs enable row level security;
revoke all privileges on public.background_job_runs from anon, authenticated;

alter table public.pending_scans add column if not exists claimed_until timestamptz;

create or replace function public.claim_background_job(p_job text, p_min_interval_seconds integer, p_lock_seconds integer)
returns boolean
language plpgsql
set search_path = public
as $$
declare
  claimed boolean;
begin
  insert into public.background_job_runs (job) values (p_job) on conflict (job) do nothing;
  update public.background_job_runs
     set last_started_at = now(),
         locked_until = now() + make_interval(secs => p_lock_seconds)
   where job = p_job
     and (locked_until is null or locked_until < now())
     and (last_started_at is null or last_started_at <= now() - make_interval(secs => p_min_interval_seconds))
  returning true into claimed;
  return coalesce(claimed, false);
end;
$$;

revoke all on function public.claim_background_job(text, integer, integer) from public, anon, authenticated;
