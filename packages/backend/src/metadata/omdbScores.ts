import { createRateLimiter } from "./rateLimit";
import type { TitleMetadataOmdbFields } from "./types";

/**
 * IMDb rating, Rotten Tomatoes and Metacritic scores from OMDb by IMDb id. OMDb's free tier is
 * 1,000 requests/day, so callers that loop (the backfill) must budget - the result's `status`
 * tells them when the daily limit has actually been hit so they can stop rather than burn
 * through failures.
 */

// OMDb publishes no per-second limit; this just keeps a backfill polite.
const omdbLimiter = createRateLimiter(10, 1_000);

export type OmdbScoresResult =
  | { status: "ok"; scores: TitleMetadataOmdbFields }
  // OMDb answered but has no entry for this id - still worth recording so it isn't retried daily.
  | { status: "not_found"; scores: TitleMetadataOmdbFields }
  | { status: "limit_reached" }
  | { status: "error"; message: string };

interface OmdbScoreResponse {
  Response?: string;
  Error?: string;
  imdbRating?: string;
  imdbVotes?: string;
  Metascore?: string;
  Ratings?: { Source?: string; Value?: string }[];
}

export async function fetchOmdbScores(imdbId: string): Promise<OmdbScoresResult> {
  const key = process.env.OMDB_API_KEY;
  if (!key) return { status: "error", message: "OMDB_API_KEY not configured." };
  await omdbLimiter();
  let data: OmdbScoreResponse;
  try {
    const res = await fetch(`https://www.omdbapi.com/?i=${encodeURIComponent(imdbId)}&apikey=${encodeURIComponent(key)}`);
    data = (await res.json()) as OmdbScoreResponse;
  } catch (err) {
    return { status: "error", message: err instanceof Error ? err.message : String(err) };
  }

  const fetchedAt = new Date().toISOString();
  if (data.Response === "False") {
    const error = data.Error ?? "";
    if (/limit/i.test(error)) return { status: "limit_reached" };
    if (/not found|incorrect imdb id/i.test(error)) {
      return { status: "not_found", scores: emptyScores(imdbId, fetchedAt) };
    }
    // Invalid key etc. - don't mark the id as fetched.
    return { status: "error", message: error || "OMDb returned Response=False" };
  }

  const rt = data.Ratings?.find((r) => r.Source === "Rotten Tomatoes")?.Value;
  return {
    status: "ok",
    scores: {
      imdb_id: imdbId,
      imdb_rating: parseOmdbDecimal(data.imdbRating),
      imdb_votes: parseOmdbInteger(data.imdbVotes),
      rotten_tomatoes_score: clampPercent(parseOmdbInteger(rt)),
      metacritic_score: clampPercent(parseOmdbInteger(data.Metascore)),
      omdb_fetched_at: fetchedAt,
    },
  };
}

function emptyScores(imdbId: string, fetchedAt: string): TitleMetadataOmdbFields {
  return { imdb_id: imdbId, imdb_rating: null, imdb_votes: null, rotten_tomatoes_score: null, metacritic_score: null, omdb_fetched_at: fetchedAt };
}

/** "8.3" -> 8.3; "N/A"/""/undefined -> null. */
export function parseOmdbDecimal(value: string | null | undefined): number | null {
  if (!value) return null;
  const n = Number(value.replace(/,/g, "").trim());
  return Number.isFinite(n) && value.trim() !== "" && !/n\/a/i.test(value) ? n : null;
}

/** "1,234" -> 1234; "91%" -> 91; "78" -> 78; "78/100" -> 78; "N/A" -> null. */
export function parseOmdbInteger(value: string | null | undefined): number | null {
  if (!value || /n\/a/i.test(value)) return null;
  const match = value.replace(/,/g, "").match(/\d+/);
  return match ? parseInt(match[0], 10) : null;
}

function clampPercent(n: number | null): number | null {
  return n !== null && n >= 0 && n <= 100 ? n : null;
}
