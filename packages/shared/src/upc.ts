export interface UpcProduct {
  title: string;
  description?: string;
  imageUrl?: string;
  // UPCitemdb's own crowdsourced category string (e.g. "Food, Beverages & Tobacco > Food
  // Items > Snack Foods > Chips"), when they have one - see looksLikeNonMediaCategory below.
  category?: string;
}

// UPCitemdb's own real-time trial-tier quota, read straight off its response headers rather
// than self-counted - confirmed live (2026-09-19) that the trial endpoint actually returns
// these on every call (`X-RateLimit-Limit`/`X-RateLimit-Remaining`/`X-RateLimit-Reset`, the
// last a Unix timestamp for when it resets), unlike the RapidAPI Amazon providers where this
// was checked and found NOT to exist (see amazonQuota.ts's own comment) - so unlike that
// self-tracked counter, this is the provider's own authoritative number, accurate even for
// calls made before this project started reading it.
export interface UpcRateLimit {
  limit: number;
  remaining: number;
  resetAt: string | null; // ISO timestamp, null if the header was missing/unparseable
}

function parseRateLimitHeaders(headers: Headers): UpcRateLimit | null {
  const limit = parseInt(headers.get("x-ratelimit-limit") ?? "", 10);
  const remaining = parseInt(headers.get("x-ratelimit-remaining") ?? "", 10);
  if (Number.isNaN(limit) || Number.isNaN(remaining)) return null;
  const resetRaw = parseInt(headers.get("x-ratelimit-reset") ?? "", 10);
  const resetAt = Number.isNaN(resetRaw) ? null : new Date(resetRaw * 1000).toISOString();
  return { limit, remaining, resetAt };
}

export interface UpcLookupResult {
  product: UpcProduct | null;
  // null only when the fetch itself failed outright (network error) before any response -
  // every real HTTP response, ok or not, still carries the rate-limit headers.
  rateLimit: UpcRateLimit | null;
}

/**
 * UPCitemdb trial lookup - free, no signup/API key, 100 requests/day (see
 * Claude/TECH STACK AND ARCHITECTURE.md for why this one and not the alternatives).
 */
export async function upcLookup(barcode: string): Promise<UpcLookupResult> {
  const res = await fetch(`https://api.upcitemdb.com/prod/trial/lookup?upc=${encodeURIComponent(barcode)}`);
  const rateLimit = parseRateLimitHeaders(res.headers);
  if (!res.ok) return { product: null, rateLimit };
  const data = (await res.json()) as {
    items?: { title: string; description?: string; images?: string[]; category?: string }[];
  };
  const item = data?.items?.[0];
  if (!item?.title) return { product: null, rateLimit };
  return {
    product: { title: item.title, description: item.description, imageUrl: item.images?.[0], category: item.category },
    rateLimit,
  };
}

// Present (not absent) in the category string whenever the listing genuinely is physical
// media - checked as an allowlist of keywords rather than a denylist of unrelated categories,
// since UPCitemdb's crowdsourced category taxonomy is huge and inconsistent (verified live:
// a real "Blade Runner The Final Cut" DVD from this very collection came back categorized as
// "Electronics > Video > Video Players & Recorders > DVD & Blu-ray Players" - filed under
// hardware, not "Movies", because that's genuinely how some sellers list it). A denylist of
// "non-media" category roots would have wrongly flagged that real, correct scan.
const MEDIA_CATEGORY_KEYWORDS = /movie|film|tv|television|dvd|blu-?ray|vhs|video|media|cd\b/i;

/**
 * True only when UPCitemdb gave a real category AND it contains none of the above keywords -
 * a deliberately soft, warn-don't-block signal (see ConfirmScreen's categoryWarning banner),
 * never used to silently reject a scan outright. No category at all (very common - most
 * listings this project scans don't have one) returns false, not true - an absent category is
 * "unknown", not "suspicious", and must never be treated as a reason to flag a real scan.
 */
export function looksLikeNonMediaCategory(category: string | undefined): boolean {
  if (!category || !category.trim()) return false;
  return !MEDIA_CATEGORY_KEYWORDS.test(category);
}
