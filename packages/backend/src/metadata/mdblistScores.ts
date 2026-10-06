import type { SupabaseClient } from "@supabase/supabase-js";
import { createRateLimiter } from "./rateLimit";

/**
 * Rotten Tomatoes audience score ("Popcornmeter") from MDBList (mdblist.com) - OMDb only has the
 * critics' Tomatometer. Free key, 1,000 requests/day (2026-10-07). MDBList's batch endpoint
 * takes many IMDb ids per request, so a whole-collection backfill costs a few dozen requests;
 * the "popcorn" rating source is the audience score.
 *
 * Movies and TV are separate endpoints (/imdb/movie, /imdb/show); an id that MDBList doesn't
 * know, or that was sent to the wrong one, is simply left out of the reply.
 */

const MDBLIST_BASE = "https://api.mdblist.com";
/** Ids per batch request. */
export const MDBLIST_BATCH_SIZE = 100;

const mdblistLimiter = createRateLimiter(5, 1_000);

export type MdblistMediaType = "movie" | "show";

/** What one MDBList reply gives per film. */
export interface MdblistScores {
  /** RT audience score, 0-100 (null when MDBList has the title but no audience score). */
  audience: number | null;
  /** The film's Metacritic / Rotten Tomatoes pages (migration 0052), when MDBList knows them. */
  metacriticUrl: string | null;
  rottenTomatoesUrl: string | null;
}

export type MdblistBatchResult =
  /** Scores per id MDBList returned. */
  | { status: "ok"; scores: Map<string, MdblistScores> }
  | { status: "limit_reached" }
  | { status: "error"; message: string };

interface MdblistItem {
  ids?: { imdb?: string | null };
  ratings?: { source?: string; value?: number | null; score?: number | null; url?: string | number | null }[];
}

/** MDBList gives site-relative paths ("/the-godfather", "/m/the_godfather"); only well-formed
 * slugs become links. Metacritic's path has no movie/TV prefix, so the media type adds it. */
function metacriticUrl(path: unknown, mediaType: MdblistMediaType): string | null {
  return typeof path === "string" && /^\/[a-z0-9][a-z0-9-]*$/i.test(path) ? `https://www.metacritic.com/${mediaType === "show" ? "tv" : "movie"}${path}/` : null;
}
function rottenTomatoesUrl(path: unknown): string | null {
  return typeof path === "string" && /^\/(m|tv)\/[a-z0-9_-]+$/i.test(path) ? `https://www.rottentomatoes.com${path}` : null;
}

/** Audience scores for up to MDBLIST_BATCH_SIZE ids of one media type - one request. */
export async function fetchMdblistAudienceScores(imdbIds: string[], mediaType: MdblistMediaType): Promise<MdblistBatchResult> {
  const key = process.env.MDBLIST_API_KEY;
  if (!key) return { status: "error", message: "MDBLIST_API_KEY not configured." };
  if (!imdbIds.length) return { status: "ok", scores: new Map() };
  if (imdbIds.length > MDBLIST_BATCH_SIZE) return { status: "error", message: `At most ${MDBLIST_BATCH_SIZE} ids per request.` };
  await mdblistLimiter();
  let res: Response;
  try {
    res = await fetch(`${MDBLIST_BASE}/imdb/${mediaType}?apikey=${encodeURIComponent(key)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: imdbIds }),
    });
  } catch (err) {
    return { status: "error", message: err instanceof Error ? err.message : String(err) };
  }
  if (res.status === 429) return { status: "limit_reached" };
  if (!res.ok) return { status: "error", message: `MDBList HTTP ${res.status}` };

  let data: unknown;
  try {
    data = await res.json();
  } catch {
    return { status: "error", message: "MDBList returned invalid JSON." };
  }
  if (!Array.isArray(data)) {
    const message = (data as { error?: string } | null)?.error ?? "Unexpected MDBList reply.";
    return /limit/i.test(message) ? { status: "limit_reached" } : { status: "error", message };
  }

  const wanted = new Set(imdbIds);
  const scores = new Map<string, MdblistScores>();
  for (const item of data as MdblistItem[]) {
    const imdbId = item.ids?.imdb;
    if (!imdbId || !wanted.has(imdbId)) continue;
    const popcorn = item.ratings?.find((r) => r.source === "popcorn");
    const value = popcorn?.score ?? popcorn?.value ?? null;
    const entry: MdblistScores = {
      audience: typeof value === "number" && value >= 0 && value <= 100 ? Math.round(value) : null,
      metacriticUrl: metacriticUrl(item.ratings?.find((r) => r.source === "metacritic")?.url, mediaType),
      rottenTomatoesUrl: rottenTomatoesUrl(item.ratings?.find((r) => r.source === "tomatoes")?.url ?? popcorn?.url),
    };
    scores.set(imdbId, entry);
  }
  return { status: "ok", scores };
}

/**
 * Fetches and saves audience scores for one media type, in batches. Every id asked about gets
 * mdblist_fetched_at stamped (a miss saves a null score), so it isn't asked again until it's
 * due. Stops early on MDBList's daily limit. Never throws.
 */
export async function refreshMdblistAudienceScores(
  supabase: SupabaseClient,
  imdbIds: string[],
  mediaType: MdblistMediaType,
  onBatch?: (done: number, total: number) => void
): Promise<{ requests: number; saved: number; withScore: number; status: "ok" | "limit_reached" | "error"; message?: string }> {
  let requests = 0;
  let saved = 0;
  let withScore = 0;
  for (let i = 0; i < imdbIds.length; i += MDBLIST_BATCH_SIZE) {
    const batch = imdbIds.slice(i, i + MDBLIST_BATCH_SIZE);
    const result = await fetchMdblistAudienceScores(batch, mediaType);
    requests++;
    if (result.status !== "ok") return { requests, saved, withScore, status: result.status, message: result.status === "error" ? result.message : undefined };

    const fetchedAt = new Date().toISOString();
    const rows = batch.map((imdbId) => {
      const found = result.scores.get(imdbId);
      const row: Record<string, string | number | null> = {
        imdb_id: imdbId,
        rt_audience_score: found?.audience ?? null,
        metacritic_url: found?.metacriticUrl ?? null,
        rotten_tomatoes_url: found?.rottenTomatoesUrl ?? null,
        mdblist_fetched_at: fetchedAt,
      };
      return row;
    });
    const { error } = await supabase.from("title_metadata").upsert(rows, { onConflict: "imdb_id" });
    if (error) return { requests, saved, withScore, status: "error", message: `title_metadata upsert failed: ${error.message}` };
    saved += rows.length;
    withScore += rows.filter((r) => r.rt_audience_score !== null).length;
    onBatch?.(Math.min(i + MDBLIST_BATCH_SIZE, imdbIds.length), imdbIds.length);
  }
  return { requests, saved, withScore, status: "ok" };
}
