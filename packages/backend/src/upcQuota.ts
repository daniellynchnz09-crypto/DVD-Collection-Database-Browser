import type { SupabaseClient } from "@supabase/supabase-js";
import type { UpcRateLimit } from "@danflix/shared";

/**
 * Mirrors UPCitemdb's own real-time trial-tier quota - added 2026-09-19 per the user's
 * request for a progress bar on the Pending Scans screen. Originally built as a self-tracked
 * counter (same shape as amazonQuota.ts), but corrected the same day: the user tried it right
 * after building it and found it reading 0/100 despite having scanned several titles earlier,
 * which traced back to this table only existing from the moment it was created - a
 * self-tracked counter can never account for calls made before tracking began. Checking
 * UPCitemdb's actual response headers live (`curl -D -`) found it DOES expose real
 * `X-RateLimit-Limit`/`X-RateLimit-Remaining`/`X-RateLimit-Reset` headers on every call -
 * unlike the RapidAPI Amazon providers, where this was checked and confirmed NOT to exist
 * (amazonQuota.ts's own comment) - so this now just mirrors that authoritative number
 * instead of counting anything itself, and is accurate immediately, including for the day's
 * earlier calls, the moment the next real lookup happens.
 *
 * A single row (`upc_quota_status`, one fixed id) rather than day-keyed like the original
 * design - UPCitemdb's own reset timestamp already tells us when the count goes back up, so
 * there's no need to bucket by day ourselves; the row is simply overwritten with whatever the
 * provider's own headers said on the most recent real call.
 *
 * Only ever written from resolvePendingScansBatch (scanResolver.ts), the one real call site
 * of upcLookup - upc.ts itself has no Supabase client and stays pure/shared.
 */

const STATUS_ROW_ID = "current";

export interface UpcQuotaStatus {
  used: number;
  limit: number;
  remaining: number;
  resetAt: string | null;
}

/** Reads the last-known UPCitemdb quota snapshot - rendered as a progress bar on
 * PendingScansScreen. No row yet (nothing scanned since this feature shipped) reads as fully
 * unused rather than an error, until the first real lookup populates it for real. */
export async function getUpcQuotaStatus(supabase: SupabaseClient): Promise<UpcQuotaStatus> {
  const { data } = await supabase
    .from("upc_quota_status")
    .select("limit_count, remaining_count, reset_at")
    .eq("id", STATUS_ROW_ID)
    .maybeSingle();
  const limit = (data?.limit_count as number | undefined) ?? 100;
  const remaining = (data?.remaining_count as number | undefined) ?? limit;
  return { used: Math.max(0, limit - remaining), limit, remaining, resetAt: (data?.reset_at as string | null | undefined) ?? null };
}

/** Overwrites the tracked snapshot with UPCitemdb's own real headers from the most recent
 * real lookup - a plain upsert, not a read-modify-write increment, since this is now mirroring
 * a value the provider itself already tracks rather than counting anything locally. */
export async function recordUpcRateLimit(supabase: SupabaseClient, rateLimit: UpcRateLimit | null): Promise<void> {
  if (!rateLimit) return;
  await supabase.from("upc_quota_status").upsert(
    {
      id: STATUS_ROW_ID,
      limit_count: rateLimit.limit,
      remaining_count: rateLimit.remaining,
      reset_at: rateLimit.resetAt,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "id" }
  );
}
