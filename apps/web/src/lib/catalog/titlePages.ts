import "server-only";
import { getCatalogClient, isMissingTableError, reportQueryError } from "./client";
import { TITLE_CARD_COLUMNS } from "./columns";
import { directorHref, discNumberLabel, displayTitle, frameAspect, personHref, shortFormatLabel, yearOf } from "./display";
import { isImdbId } from "./metadata";
import { getCollection, isUniqueId, rowHref, toPosterCards } from "./queries";
import type { Collection, Disc, PosterCardData, TitleCardRow, TitleDetailRow, Work } from "./types";
import { getTvSeasons, type TvEpisode } from "@/lib/tmdb/tv";

/**
 * Data shaping for the three title pages (/title, /disc, /collection) on top of the
 * Foundation queries. Kept separate from queries.ts so the shared layer stays generic.
 */

// ---------------------------------------------------------------------------------------------
// Small display helpers
// ---------------------------------------------------------------------------------------------

/** "1h 52m" / "48m". */
export function formatRuntime(mins: number | null | undefined): string | null {
  if (!mins || mins <= 0) return null;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}h${m ? ` ${m}m` : ""}` : `${m}m`;
}

/** disk_region is free text from the Sheet ("2,4", "A, B, C", "idk"...) - tidy the obvious
 * cases and hide the "don't know" ones rather than printing them. */
export function formatRegion(region: string | null | undefined): string | null {
  const value = region?.trim();
  if (!value || /^(idk|not listed|unknown|\?)$/i.test(value)) return null;
  if (/^all( regions)?$/i.test(value)) return "All regions";
  if (value === "0") return "Region free (0)";
  return value
    .replace(/[()]/g, "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .join(", ");
}

/** formatRegion's value as a meta-line chip: "Region 2, 4" but "All regions" as-is. */
export function regionChip(region: string | null): string | null {
  if (!region) return null;
  return /^(all|region)/i.test(region) ? region : `Region ${region}`;
}

/** "Disc 2 of 4" / "Discs 3, 4 of 8" for a box-set member (WEB APP DESIGN.md, 2026-09-20). */
export function discOfSetLabel(discNumberInSet: string | null | undefined, setDiscCount: number | null | undefined): string | null {
  const base = discNumberLabel(discNumberInSet);
  if (!base) return null;
  return setDiscCount && setDiscCount > 0 ? `${base} of ${setDiscCount}` : base;
}

/** Card for an already-resolved Disc (poster signed once by the Foundation query). */
export function discToCard(disc: Disc, caption?: string | null): PosterCardData {
  return {
    key: disc.row.unique_id,
    href: rowHref(disc.row),
    title: displayTitle(disc.row),
    year: yearOf(disc.row.release_date) ?? yearOf(disc.metadata?.release_date),
    format: shortFormatLabel(disc.row.format),
    image: disc.poster,
    aspect: frameAspect(disc.poster, disc.row.format),
    caption: caption ?? null,
  };
}

// ---------------------------------------------------------------------------------------------
// Movie/TV Page
// ---------------------------------------------------------------------------------------------

const TV_KIND_RE = /series|serial|episode|special/i;

/** TV if TMDb says so, or any owned copy is a series/serial (or a non-movie with a season). */
export function isTvWork(work: Work): boolean {
  if (work.metadata?.tmdb_media_type === "tv") return true;
  if (work.metadata?.tmdb_media_type === "movie") return false;
  return work.items.some((d) => TV_KIND_RE.test(d.row.movie_or_tv) || (d.row.season_no && d.row.movie_or_tv !== "Movie"));
}

// "Friends Season 1", "Doctor Who the Collection Season 9", "The Sweeney Series 4 Disc 1 and 2"
const SEASON_SUFFIX_RE = /[\s:,-]*(the\s+collection\s+)?(the\s+)?(complete\s+)?(season|series|volume|vol\.?)\s*\d+.*$/i;

/**
 * The series' own name. Metadata has it once backfilled; before that every owned row is named
 * after its season, so strip the season suffix from each and take the most common result
 * (ties -> the shorter name).
 */
export function workDisplayTitle(work: Work): string {
  if (work.metadata?.title) return work.metadata.title;
  if (!isTvWork(work)) return work.title;
  const counts = new Map<string, number>();
  for (const d of work.items) {
    const name = d.row.title.replace(SEASON_SUFFIX_RE, "").trim();
    if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)[0];
  return best?.[0] ?? work.title;
}

/** The TMDb TV id, only when actually known (metadata, else a row explicitly typed 'tv' -
 * some Doctor Who rows carry a *movie* id for an animated special, which must not be used). */
function tvIdForWork(work: Work): number | null {
  if (work.metadata?.tmdb_media_type === "tv" && work.metadata.tmdb_id) return work.metadata.tmdb_id;
  return work.items.find((d) => d.row.tmdb_media_type === "tv" && d.row.tmdb_id)?.row.tmdb_id ?? null;
}

/** season_no is free text: "3", "1,2", "1-3", "All", "Assorted", "Specials". */
function parseSeasonNo(value: string | null, totalSeasons: number | null): { numbers: number[]; label: string | null } {
  const raw = value?.trim();
  if (!raw) return { numbers: [], label: null };
  if (/^specials?$/i.test(raw)) return { numbers: [0], label: null };
  if (/^all$/i.test(raw) && totalSeasons && totalSeasons > 0 && totalSeasons <= 60) {
    return { numbers: Array.from({ length: totalSeasons }, (_, i) => i + 1), label: null };
  }
  const numbers = new Set<number>();
  for (const part of raw.split(",")) {
    const range = part.trim().match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      const [a, b] = [Number(range[1]), Number(range[2])];
      for (let n = Math.min(a, b); n <= Math.max(a, b) && n - Math.min(a, b) < 60; n++) numbers.add(n);
    } else if (/^\d+$/.test(part.trim())) numbers.add(Number(part.trim()));
  }
  return numbers.size > 0 ? { numbers: [...numbers].sort((x, y) => x - y), label: null } : { numbers: [], label: raw };
}

export interface SeasonHolder {
  uniqueId: string;
  href: string;
  title: string;
  format: string | null;
  partOfSeason: string | null;
  episodeCount: number | null;
}

export interface BrowserSeason {
  /** null = an unnumbered group such as "Assorted". */
  number: number | null;
  label: string;
  overview: string | null;
  /** Live from TMDb; null when no TMDb id is known or the fetch failed. */
  episodes: TvEpisode[] | null;
  holders: SeasonHolder[];
}

export interface SeriesBrowserData {
  seasons: BrowserSeason[];
  /** True when episode lists came from TMDb (drives the attribution notice). */
  usedTmdb: boolean;
  tmdbLinked: boolean;
}

/** Max seasons fetched live per page view - keeps one long-running series from fanning out
 * into dozens of TMDb requests. */
const MAX_LIVE_SEASONS = 40;

/** Builds the Series browser: only seasons the collection actually holds (WEB APP DESIGN.md),
 * with episode lists from TMDb when the show's TMDb id is known. */
export async function getSeriesBrowser(work: Work): Promise<SeriesBrowserData> {
  const bySeason = new Map<number, SeasonHolder[]>();
  const unnumbered = new Map<string, SeasonHolder[]>();

  for (const d of work.items) {
    const parsed = parseSeasonNo(d.row.season_no, work.metadata?.number_of_seasons ?? null);
    const holder: SeasonHolder = {
      uniqueId: d.row.unique_id,
      href: rowHref(d.row),
      title: displayTitle(d.row),
      format: shortFormatLabel(d.row.format),
      partOfSeason: d.row.part_of_season_no,
      episodeCount: d.row.episode_count,
    };
    if (parsed.numbers.length > 0) {
      for (const n of parsed.numbers) bySeason.set(n, [...(bySeason.get(n) ?? []), holder]);
    } else {
      const label = parsed.label ?? "Other releases";
      unnumbered.set(label, [...(unnumbered.get(label) ?? []), holder]);
    }
  }

  const tvId = tvIdForWork(work);
  const numbers = [...bySeason.keys()].sort((a, b) => a - b);
  const live = tvId ? await getTvSeasons(tvId, numbers.slice(0, MAX_LIVE_SEASONS)) : new Map();

  const seasons: BrowserSeason[] = numbers.map((n) => {
    const s = live.get(n);
    return {
      number: n,
      label: n === 0 ? "Specials" : `Season ${n}`,
      overview: s?.overview ?? null,
      episodes: s?.episodes ?? null,
      holders: bySeason.get(n) ?? [],
    };
  });
  for (const [label, holders] of unnumbered) seasons.push({ number: null, label, overview: null, episodes: null, holders });

  return { seasons, usedTmdb: live.size > 0, tmdbLinked: tvId !== null };
}

/**
 * "Items in my collection that contain this movie": every owned copy, plus the box set each
 * boxed copy lives in (the Vertigo example in WEB APP DESIGN.md lists the set as its own
 * result). Set headers not already among the items are fetched in one query.
 */
export async function getWorkItemCards(work: Work): Promise<PosterCardData[]> {
  const cards: PosterCardData[] = [];
  const seen = new Set<string>();
  const setIds: string[] = [];

  for (const d of work.items) {
    if (seen.has(d.row.unique_id)) continue;
    seen.add(d.row.unique_id);
    const caption = d.row.is_collection
      ? "Box set"
      : d.collection
        ? (discNumberLabel(d.row.disc_number_in_set) ?? "In a box set")
        : d.row.season_no && /^\d/.test(d.row.season_no)
          ? `Season ${d.row.season_no}`
          : null;
    cards.push(discToCard(d, caption));
    if (d.collection && !seen.has(d.collection.uniqueId)) setIds.push(d.collection.uniqueId);
  }

  const headerRows = await getCardRowsByIds([...new Set(setIds)].filter((id) => !seen.has(id)));
  const headerCards = await toPosterCards(headerRows, "w500");
  for (const c of headerCards) cards.push({ ...c, caption: "Box set" });
  return cards;
}

async function getCardRowsByIds(ids: string[]): Promise<TitleCardRow[]> {
  const valid = ids.filter(isUniqueId);
  const supabase = getCatalogClient();
  if (!supabase || valid.length === 0) return [];
  const { data, error } = await supabase.from("titles").select(TITLE_CARD_COLUMNS).eq("scanned", true).in("unique_id", valid.slice(0, 100));
  reportQueryError("getCardRowsByIds", error);
  return (data ?? []) as unknown as TitleCardRow[];
}

// ---------------------------------------------------------------------------------------------
// DVD Page
// ---------------------------------------------------------------------------------------------

export interface DiscSetContext {
  collection: Collection;
  /** The other titles in the same box set, as cards. */
  siblings: PosterCardData[];
}

/** For a box-set member: the set (for "Disc 2 of 4" and its total disc count) and its other
 * titles. getCollection is React-cached, so this costs one query set per request. */
export async function getDiscSetContext(disc: Disc): Promise<DiscSetContext | null> {
  if (!disc.collection) return null;
  const collection = await getCollection(disc.collection.uniqueId);
  if (!collection) return null;
  const siblings = collection.members
    .filter((m) => m.row.unique_id !== disc.row.unique_id)
    .map((m) => discToCard(m, discNumberLabel(m.row.disc_number_in_set)));
  return { collection, siblings };
}

// ---------------------------------------------------------------------------------------------
// Collection Page
// ---------------------------------------------------------------------------------------------

export interface PersonLink {
  name: string;
  tmdbPersonId: number | null;
}

/**
 * Directors per film for a list of IMDb ids, in one title_credits query; falls back to the
 * titles.director names (no person id -> no person page link) when credits aren't there yet.
 */
export async function getDirectorsByImdbId(imdbIds: Array<string | null>): Promise<Map<string, PersonLink[]>> {
  const out = new Map<string, PersonLink[]>();
  const ids = [...new Set(imdbIds.filter((id): id is string => !!id && isImdbId(id)))];
  const supabase = getCatalogClient();
  if (supabase && ids.length > 0) {
    const { data, error } = await supabase
      .from("title_credits")
      .select("imdb_id,person:people(tmdb_person_id,name)")
      .eq("credit_type", "crew")
      .eq("job", "Director")
      .in("imdb_id", ids.slice(0, 200));
    if (error && !isMissingTableError(error)) reportQueryError("getDirectorsByImdbId", error);
    for (const c of (data ?? []) as unknown as Array<{ imdb_id: string; person: { tmdb_person_id: number; name: string } | null }>) {
      if (!c.person) continue;
      out.set(c.imdb_id, [...(out.get(c.imdb_id) ?? []), { name: c.person.name, tmdbPersonId: c.person.tmdb_person_id }]);
    }
  }
  return out;
}

/** Directors for one row: credits when present, else the Sheet's director names. */
export function directorsFor(row: Pick<TitleDetailRow, "director">, imdbId: string | null, credits: Map<string, PersonLink[]>): PersonLink[] {
  const fromCredits = imdbId ? credits.get(imdbId) : undefined;
  if (fromCredits && fromCredits.length > 0) return fromCredits;
  return (row.director ?? []).filter((n) => n?.trim()).map((name) => ({ name: name.trim(), tmdbPersonId: null }));
}

/** Person page when the TMDb id is known; before metadata exists only the Sheet's director name
 * is available, so link the name-keyed director page (/people/[slug]) instead. */
export function personLinkHref(p: PersonLink): string {
  return p.tmdbPersonId ? personHref(p.tmdbPersonId) : directorHref(p.name);
}

/** De-duplication that ignores case, spacing and punctuation (the Sheet has "Star Wars" and
 * "star wars", "C.E. Webber" and "C. E. Webber"), keeping the first spelling seen. */
export function distinctCi(values: Array<string | null | undefined>): string[] {
  const seen = new Map<string, string>();
  for (const v of values) {
    const t = v?.trim();
    const key = t?.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
    if (t && key && !seen.has(key)) seen.set(key, t);
  }
  return [...seen.values()];
}

/** "Yes (1 bonus disc, Blu-ray, disc 9)" / "Yes" / "No". */
export function specialFeaturesText(
  row: Pick<TitleDetailRow, "special_features" | "special_features_disc_count" | "special_features_disc_format" | "special_features_disc_number_in_set">,
): string {
  if (!row.special_features) return "No";
  const count = row.special_features_disc_count;
  const extras = [
    count ? `${count} bonus disc${count === 1 ? "" : "s"}` : null,
    shortFormatLabel(row.special_features_disc_format),
    row.special_features_disc_number_in_set ? `disc ${row.special_features_disc_number_in_set}` : null,
  ].filter(Boolean);
  return extras.length > 0 ? `Yes (${extras.join(", ")})` : "Yes";
}

/** Sort key for a member's position in the set: its first disc number, then release date. */
export function memberDiscSortKey(disc: Disc): number {
  const first = Number((disc.row.disc_number_in_set ?? "").split(",")[0]);
  return Number.isFinite(first) && first > 0 ? first : Number.MAX_SAFE_INTEGER;
}
