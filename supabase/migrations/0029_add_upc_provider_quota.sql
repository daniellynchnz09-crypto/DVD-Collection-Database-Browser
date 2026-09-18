-- Mirrors UPCitemdb's own real-time trial-tier quota (see packages/backend/src/upcQuota.ts's
-- own comment for the full story) - a single row, always overwritten with the provider's own
-- `X-RateLimit-*` response headers from the most recent real lookup, rather than a locally
-- self-tracked counter.
--
-- SUPERSEDES this migration's own original shape (a day-keyed `requests_used` counter,
-- modeled on 0025_add_amazon_provider_quota.sql) - replaced the same day it shipped, before
-- any real data had accumulated in it, once the user tried the progress bar live and it read
-- 0/100 despite having scanned several titles earlier that day. A self-tracked counter can
-- never know about calls made before it existed; UPCitemdb's own headers already carry the
-- real number regardless of when this project started reading them. `drop table if exists`
-- first is safe here specifically because the superseded shape was live for under an hour
-- with zero real rows ever written to it (confirmed before writing this migration).
--
-- Written to only from resolvePendingScansBatch (packages/backend/src/scanResolver.ts), the
-- one real call site of upcLookup - never from upc.ts itself, which has no Supabase client and
-- is shared code with no side effects of its own.
--
-- Core barcode-scanning feature, present in both the public and private builds (unlike
-- amazon_provider_quota) - applies to both Supabase projects, not excluded from
-- scripts/src/sanitize-public-repo.ts.

drop table if exists upc_provider_quota;

create table if not exists upc_quota_status (
  id text primary key, -- always the fixed literal "current" - a singleton row
  limit_count integer not null,
  remaining_count integer not null,
  reset_at timestamptz,
  updated_at timestamptz not null default now()
);

-- RLS enabled with zero policies from the start (see 0027's own comment on why
-- amazon_provider_quota needed a dedicated follow-up fix for this exact gap, found live via
-- Supabase's Security Advisor) - pure internal bookkeeping only ever read/written by the
-- service-role key, which always bypasses RLS regardless of policies; anon/authenticated get
-- denied by default.
alter table upc_quota_status enable row level security;
