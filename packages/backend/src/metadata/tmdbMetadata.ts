import type { TmdbMediaType } from "../tmdb";
import { createRateLimiter, sleep } from "./rateLimit";
import type { CreditRow, PersonRow, TitleMetadataTmdbFields } from "./types";

/**
 * Film details + credits from TMDb for the web app's Movie/TV and Person pages (see
 * Claude/TECH STACK AND ARCHITECTURE/web-app-build-plan.md). Kept separate from ../tmdb.ts,
 * whose helpers answer the scan form's narrower questions (rating/studio) and don't return
 * credits - this module needs the full detail payload in one call per film.
 */

const TMDB_API_BASE = "https://api.themoviedb.org/3";
// TMDb's published soft limit is ~50 req/s; 40 per 10s is deliberately gentle.
const tmdbLimiter = createRateLimiter(40, 10_000);

// Plan caps: top 20 billed cast; crew limited to these jobs.
const CAST_LIMIT = 20;
const CREW_JOBS = new Set(["Director", "Writer", "Screenplay", "Producer", "Original Music Composer", "Director of Photography"]);
// A long-running show's aggregate crew can list dozens of episode directors/writers - keep the
// ones who worked on the most episodes per job so a Series page stays readable.
const TV_CREW_PER_JOB_LIMIT = 10;

function getAuthHeader(): string | null {
  const token = process.env.TMDB_READ_ACCESS_TOKEN;
  return token ? `Bearer ${token}` : null;
}

/** GET a TMDb path; null on any miss/failure (never throws). Retries once on 429. */
async function tmdbGet<T>(path: string): Promise<T | null> {
  const auth = getAuthHeader();
  if (!auth) return null;
  for (let attempt = 0; attempt < 2; attempt++) {
    await tmdbLimiter();
    try {
      const res = await fetch(`${TMDB_API_BASE}${path}`, {
        headers: { Authorization: auth, accept: "application/json" },
      });
      if (res.status === 429) {
        const retryAfter = Number(res.headers.get("retry-after")) || 2;
        await sleep(retryAfter * 1000);
        continue;
      }
      if (!res.ok) return null;
      return (await res.json()) as T;
    } catch {
      return null;
    }
  }
  return null;
}

interface FindResponse {
  movie_results?: { id: number }[];
  tv_results?: { id: number }[];
  // Some older rows link an individual episode's IMDb page (e.g. a single-story TV disc);
  // that film's "page" is then the parent show, so fall back to show_id.
  tv_episode_results?: { show_id: number }[];
}

interface PersonRef {
  id: number;
  name: string;
  profile_path: string | null;
  known_for_department?: string | null;
}

interface MovieCast extends PersonRef { character?: string | null; order?: number }
interface MovieCrew extends PersonRef { job?: string; department?: string }
interface AggCast extends PersonRef {
  roles?: { character?: string | null; episode_count?: number }[];
  order?: number;
}
interface AggCrew extends PersonRef {
  department?: string;
  jobs?: { job?: string; episode_count?: number }[];
}

interface DetailCommon {
  id: number;
  overview?: string | null;
  tagline?: string | null;
  poster_path?: string | null;
  backdrop_path?: string | null;
  genres?: { name: string }[];
}
interface MovieDetail extends DetailCommon {
  title?: string;
  original_title?: string;
  release_date?: string;
  runtime?: number | null;
  credits?: { cast?: MovieCast[]; crew?: MovieCrew[] };
}
interface TvDetail extends DetailCommon {
  name?: string;
  original_name?: string;
  first_air_date?: string;
  episode_run_time?: number[];
  number_of_seasons?: number | null;
  number_of_episodes?: number | null;
  created_by?: PersonRef[];
  aggregate_credits?: { cast?: AggCast[]; crew?: AggCrew[] };
}

export interface TmdbMetadataResult {
  metadata: TitleMetadataTmdbFields;
  people: PersonRow[];
  credits: CreditRow[];
}

/** Resolves an IMDb id to a TMDb movie/show id. Movies first - the collection is mostly films. */
export async function findTmdbByImdbId(imdbId: string): Promise<{ tmdbId: number; mediaType: TmdbMediaType } | null> {
  const data = await tmdbGet<FindResponse>(`/find/${encodeURIComponent(imdbId)}?external_source=imdb_id`);
  const movie = data?.movie_results?.[0]?.id;
  if (typeof movie === "number") return { tmdbId: movie, mediaType: "movie" };
  const tv = data?.tv_results?.[0]?.id;
  if (typeof tv === "number") return { tmdbId: tv, mediaType: "tv" };
  const episodeShow = data?.tv_episode_results?.[0]?.show_id;
  if (typeof episodeShow === "number") return { tmdbId: episodeShow, mediaType: "tv" };
  return null;
}

/**
 * Fetches a film's/show's details and credits by IMDb id and shapes them into rows for
 * title_metadata/people/title_credits. Returns null when TMDb has no match (or no token) -
 * a lookup miss is never an error.
 */
export async function fetchTmdbMetadata(imdbId: string): Promise<TmdbMetadataResult | null> {
  const found = await findTmdbByImdbId(imdbId);
  if (!found) return null;
  const fetchedAt = new Date().toISOString();

  if (found.mediaType === "movie") {
    const d = await tmdbGet<MovieDetail>(`/movie/${found.tmdbId}?append_to_response=credits`);
    if (!d) return null;
    const cast = [...(d.credits?.cast ?? [])].sort((a, b) => (a.order ?? 999) - (b.order ?? 999)).slice(0, CAST_LIMIT);
    const crew = (d.credits?.crew ?? []).filter((c) => c.job && CREW_JOBS.has(c.job));
    const credits: CreditRow[] = [
      ...cast.map((c, i) => castRow(imdbId, c.id, c.character ?? null, i)),
      ...crew.map((c, i) => crewRow(imdbId, c.id, c.job ?? null, c.department ?? null, i)),
    ];
    return {
      metadata: {
        imdb_id: imdbId,
        tmdb_id: d.id,
        tmdb_media_type: "movie",
        title: d.title ?? null,
        original_title: d.original_title ?? null,
        tagline: emptyToNull(d.tagline),
        overview: emptyToNull(d.overview),
        poster_path: d.poster_path ?? null,
        backdrop_path: d.backdrop_path ?? null,
        release_date: validDate(d.release_date),
        runtime_mins: positiveOrNull(d.runtime),
        genres: (d.genres ?? []).map((g) => g.name),
        number_of_seasons: null,
        number_of_episodes: null,
        tmdb_fetched_at: fetchedAt,
      },
      people: uniquePeople([...cast, ...crew]),
      credits,
    };
  }

  // aggregate_credits covers every season (plain `credits` is only the latest season's cast).
  const d = await tmdbGet<TvDetail>(`/tv/${found.tmdbId}?append_to_response=aggregate_credits`);
  if (!d) return null;
  const cast = [...(d.aggregate_credits?.cast ?? [])].sort((a, b) => (a.order ?? 999) - (b.order ?? 999)).slice(0, CAST_LIMIT);
  // Flatten each person's jobs[], keep the allowed ones, then cap per job by episode count.
  const flatCrew = (d.aggregate_credits?.crew ?? []).flatMap((c) =>
    (c.jobs ?? [])
      .filter((j) => j.job && CREW_JOBS.has(j.job))
      .map((j) => ({ person: c, job: j.job as string, episodes: j.episode_count ?? 0 }))
  );
  const byJob = new Map<string, typeof flatCrew>();
  for (const entry of flatCrew) byJob.set(entry.job, [...(byJob.get(entry.job) ?? []), entry]);
  const crew = [...byJob.values()].flatMap((list) =>
    list.sort((a, b) => b.episodes - a.episodes).slice(0, TV_CREW_PER_JOB_LIMIT)
  );
  // A show's creator is its closest equivalent of a film's director (same reasoning as OMDb's
  // Writer-for-series note in packages/shared/src/omdb.ts), so it's kept as a "Creator" crew job.
  const creators = d.created_by ?? [];
  const credits: CreditRow[] = [
    ...cast.map((c, i) => castRow(imdbId, c.id, c.roles?.[0]?.character ?? null, i)),
    ...creators.map((c, i) => crewRow(imdbId, c.id, "Creator", "Writing", i)),
    ...crew.map((c, i) => crewRow(imdbId, c.person.id, c.job, c.person.department ?? null, creators.length + i)),
  ];
  return {
    metadata: {
      imdb_id: imdbId,
      tmdb_id: d.id,
      tmdb_media_type: "tv",
      title: d.name ?? null,
      original_title: d.original_name ?? null,
      tagline: emptyToNull(d.tagline),
      overview: emptyToNull(d.overview),
      poster_path: d.poster_path ?? null,
      backdrop_path: d.backdrop_path ?? null,
      release_date: validDate(d.first_air_date),
      // Often empty on long-running shows; left null rather than guessed from one episode (Friends'
      // latest episode is its double-length finale).
      runtime_mins: positiveOrNull(d.episode_run_time?.[0]),
      genres: (d.genres ?? []).map((g) => g.name),
      number_of_seasons: positiveOrNull(d.number_of_seasons),
      number_of_episodes: positiveOrNull(d.number_of_episodes),
      tmdb_fetched_at: fetchedAt,
    },
    people: uniquePeople([...cast, ...creators, ...crew.map((c) => c.person)]),
    credits,
  };
}

interface PersonDetail {
  id: number;
  name?: string;
  profile_path?: string | null;
  biography?: string | null;
  known_for_department?: string | null;
  birthday?: string | null;
  deathday?: string | null;
  place_of_birth?: string | null;
}

/** Full person details (biography etc.) for the lazily-filled people columns; null on a miss. */
export async function fetchTmdbPerson(tmdbPersonId: number): Promise<PersonRow | null> {
  const d = await tmdbGet<PersonDetail>(`/person/${tmdbPersonId}`);
  if (!d || !d.name) return null;
  return {
    tmdb_person_id: d.id,
    name: d.name,
    profile_path: d.profile_path ?? null,
    known_for_department: d.known_for_department ?? null,
    biography: emptyToNull(d.biography),
    birthday: validDate(d.birthday),
    deathday: validDate(d.deathday),
    place_of_birth: emptyToNull(d.place_of_birth),
    fetched_at: new Date().toISOString(),
  };
}

function castRow(imdbId: string, personId: number, character: string | null, order: number): CreditRow {
  return { imdb_id: imdbId, tmdb_person_id: personId, credit_type: "cast", character: emptyToNull(character), job: null, department: null, credit_order: order };
}

function crewRow(imdbId: string, personId: number, job: string | null, department: string | null, order: number): CreditRow {
  return { imdb_id: imdbId, tmdb_person_id: personId, credit_type: "crew", character: null, job, department, credit_order: order };
}

// The same person can appear several times (e.g. director + writer); people needs one row each.
function uniquePeople(refs: PersonRef[]): PersonRow[] {
  const map = new Map<number, PersonRow>();
  for (const p of refs) {
    if (map.has(p.id) || !p.name) continue;
    map.set(p.id, { tmdb_person_id: p.id, name: p.name, profile_path: p.profile_path ?? null, known_for_department: p.known_for_department ?? null });
  }
  return [...map.values()];
}

function emptyToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function validDate(value: string | null | undefined): string | null {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

function positiveOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && value > 0 ? value : null;
}
