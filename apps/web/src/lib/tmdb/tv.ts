import "server-only";
import { tmdbGet } from "./client";

/** One episode as the Series browser shows it - a narrowed copy of TMDb's shape (its crew and
 * guest-star arrays are dropped before anything reaches a client component). */
export interface TvEpisode {
  episodeNumber: number;
  name: string;
  airDate: string | null;
  overview: string | null;
  runtime: number | null;
  stillPath: string | null;
}

export interface TvSeason {
  seasonNumber: number;
  name: string;
  airDate: string | null;
  overview: string | null;
  episodes: TvEpisode[];
}

interface RawSeason {
  season_number?: number;
  name?: string;
  air_date?: string | null;
  overview?: string | null;
  episodes?: Array<{
    episode_number?: number;
    name?: string;
    air_date?: string | null;
    overview?: string | null;
    runtime?: number | null;
    still_path?: string | null;
  }>;
}

const isPositiveInt = (n: number) => Number.isSafeInteger(n) && n >= 0;

/** A season's episode list from TMDb `/tv/{id}/season/{n}`, or null if unavailable. */
export async function getTvSeason(tvId: number, seasonNumber: number): Promise<TvSeason | null> {
  // Both values end up in a URL path, so only plain integers are accepted.
  if (!isPositiveInt(tvId) || tvId === 0 || !isPositiveInt(seasonNumber)) return null;
  const raw = await tmdbGet<RawSeason>(`/tv/${tvId}/season/${seasonNumber}`);
  if (!raw) return null;
  return {
    seasonNumber: raw.season_number ?? seasonNumber,
    name: raw.name?.trim() || (seasonNumber === 0 ? "Specials" : `Season ${seasonNumber}`),
    airDate: raw.air_date ?? null,
    overview: raw.overview?.trim() || null,
    episodes: (raw.episodes ?? [])
      .filter((e) => typeof e.episode_number === "number")
      .map((e) => ({
        episodeNumber: e.episode_number as number,
        name: e.name?.trim() || `Episode ${e.episode_number}`,
        airDate: e.air_date ?? null,
        overview: e.overview?.trim() || null,
        runtime: typeof e.runtime === "number" ? e.runtime : null,
        stillPath: e.still_path ?? null,
      })),
  };
}

/** Several seasons in parallel; missing ones are simply left out of the map. */
export async function getTvSeasons(tvId: number, seasonNumbers: number[]): Promise<Map<number, TvSeason>> {
  const results = await Promise.all(seasonNumbers.map(async (n) => [n, await getTvSeason(tvId, n)] as const));
  return new Map(results.filter((r): r is readonly [number, TvSeason] => r[1] !== null));
}
