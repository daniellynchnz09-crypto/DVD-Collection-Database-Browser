import "server-only";
import { extractImdbIdFromPage } from "@danflix/shared";
import { escapeLike, getCatalogClient, isMissingTableError, PAGE_SIZE, reportQueryError } from "./client";
import { TITLE_CARD_COLUMNS } from "./columns";
import { collectionHref, discHref, displayTitle, franchiseHref, personHref, shortFormatLabel, slugify, workHref, yearOf } from "./display";
import { resolveImages, tmdbImage, type TmdbPosterSize } from "./images";
import {
  EMPTY_FILTERS,
  FACETS,
  facetValueLabel,
  hasTitleFilters,
  SORTS,
  type FacetKey,
  type FacetOption,
  type Flag,
  type RangeKey,
  type SearchFacetOptions,
  type SearchFilters,
  type SortKey,
  type TriState,
} from "./searchFilters";
import type { CatalogImage, TitleCardRow, TitleMetadata } from "./types";

/**
 * Basic Search (WEB APP DESIGN.md): grouped results for films/TV, physical items, box sets,
 * franchises, directors and people - plus Advanced Search's filters and sorting
 * (searchFilters.ts, 2026-10-07), which also work with no query at all as a browse page
 * ("all 4K horror films").
 *
 * WHY an in-memory index instead of per-keystroke ilike queries: the collection is ~3,100 rows
 * and the searchable text (title, release_name, name_of_collection, director, franchise) is a
 * few hundred KB. Loading it once (4 paged requests) and re-loading every few minutes makes
 * each search a sub-millisecond scan with no database round-trip, ranking (exact > prefix >
 * word > substring, article-insensitive) happens in one place, and "related" results (the
 * director and box set of a matched film, per the Vertigo example) need no extra queries.
 * Several ilike queries per keystroke would cost ~100ms+ each on Supabase and couldn't rank.
 * The same index carries each row's filterable facts, so filtering costs nothing extra either.
 * The trade-off is up to INDEX_TTL_MS of staleness for a newly scanned disc - acceptable for
 * browsing. The `people` table is the exception (potentially tens of thousands of cast rows),
 * so it is queried by name per search, with a short result cache.
 */

// ---------------------------------------------------------------------------------------------
// Public types (client components may `import type` these)
// ---------------------------------------------------------------------------------------------

export type SearchKind = "film" | "item" | "collection" | "franchise" | "director" | "person";

export interface SearchHit {
  kind: SearchKind;
  key: string;
  href: string;
  title: string;
  year: string | null;
  /** Short format badge for physical items/collections ("4K UHD", "DVD"). */
  format: string | null;
  /** Secondary line: "Movie // 2 copies", "In: <box set>", "12 titles"... */
  subtitle: string | null;
  image: CatalogImage | null;
  /** True when it matched through another result (a matched film's director/box set). */
  related?: boolean;
}

export interface SearchGroup {
  kind: SearchKind;
  label: string;
  /** All matches in this group, before the per-group cap. */
  total: number;
  hits: SearchHit[];
}

export interface SearchResults {
  query: string;
  groups: SearchGroup[];
  total: number;
  /** The sort actually applied (a browse with no query can't sort by relevance). */
  sort: SortKey;
}

export const SEARCH_MIN_LENGTH = 2;
export const SEARCH_MAX_QUERY_LENGTH = 120;

const GROUP_LABELS: Record<SearchKind, string> = {
  film: "Films & TV",
  item: "Physical Releases",
  collection: "Collections",
  franchise: "Franchises",
  director: "Directors",
  person: "People",
};
/** Tie-break order between groups whose best match is equally good - films before their
 * physical releases before box sets before people, as in the Vertigo example. */
const GROUP_ORDER: SearchKind[] = ["film", "item", "collection", "franchise", "director", "person"];
const TITLE_KINDS: SearchKind[] = ["film", "item", "collection"];

// ---------------------------------------------------------------------------------------------
// Normalisation + match tiers
// ---------------------------------------------------------------------------------------------

/** Lowercase, accent-folded, punctuation -> spaces, "&" -> "and". "Amélie" matches "amelie",
 * "Star Wars: Episode IV" matches "star wars episode". */
export function normalizeSearchText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’]/g, "") // "Schindler's" -> "schindlers", so the apostrophe isn't a word break
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const ARTICLE_RE = /^(the|a|an) /;

/** Lower is better: 0 exact, 1 prefix, 2 whole-word/word-prefix, 3 substring, 4 every query
 * word appears as a word prefix in any order. null = no match. Leading articles are ignored
 * so "birds" ranks "The Birds" as exact. */
function matchTier(text: string, q: string, qWords: string[]): number | null {
  if (!text) return null;
  const bare = text.replace(ARTICLE_RE, "");
  if (text === q || bare === q) return 0;
  if (text.startsWith(q) || bare.startsWith(q)) return 1;
  if (` ${text}`.includes(` ${q}`)) return 2;
  if (text.includes(q)) return 3;
  if (qWords.length > 1) {
    const padded = ` ${text}`;
    if (qWords.every((w) => padded.includes(` ${w}`))) return 4;
  }
  return null;
}

/** Best tier across several candidate strings. */
function bestTier(texts: string[], q: string, qWords: string[]): number | null {
  let best: number | null = null;
  for (const t of texts) {
    const tier = matchTier(t, q, qWords);
    if (tier !== null && (best === null || tier < best)) best = tier;
    if (best === 0) break;
  }
  return best;
}

// ---------------------------------------------------------------------------------------------
// The index
// ---------------------------------------------------------------------------------------------

type IndexRow = TitleCardRow & {
  director: string[] | null;
  franchise: string[] | null;
  genre: string[] | null;
  rating: string | null;
  running_time_mins: number | null;
  animation_or_live_action: string | null;
  documentary: string | null;
  studio: string | null;
  disk_region: string | null;
};

type IndexMeta = Pick<
  TitleMetadata,
  "imdb_id" | "title" | "poster_path" | "release_date" | "runtime_mins" | "imdb_rating" | "imdb_votes" | "rotten_tomatoes_score" | "metacritic_score"
>;

/** What the filters and sorts look at, worked out once per row when the index is built. */
interface RowFacts {
  facets: Record<FacetKey, string[]>;
  ranges: Record<RangeKey, number | null>;
  /** yyyy-mm-dd, the film's own release date where TMDb knows it (the Sheet often has the
   * disc's), for sorting. */
  date: string | null;
  added: string | null;
  votes: number | null;
}

interface IndexedRow {
  row: IndexRow;
  imdbId: string | null;
  /** Normalised own-name strings (title, release_name; plus name_of_collection for a header). */
  names: string[];
  /** Normalised box-set name for a member row - a weaker match than its own title. */
  collectionName: string | null;
  facts: RowFacts;
}

interface IndexedFilm {
  imdbId: string;
  title: string;
  names: string[];
  year: string | null;
  isTv: boolean;
  rows: IndexedRow[];
  metadata: IndexMeta | null;
}

interface IndexedFacet {
  name: string;
  norm: string;
  count: number;
  /** Rows carrying it, for "related" lookups and a representative image. */
  rows: IndexedRow[];
}

interface SearchIndex {
  rows: IndexedRow[];
  films: IndexedFilm[];
  filmById: Map<string, IndexedFilm>;
  /** Box-set header rows by normalised name_of_collection, so members can find their set. */
  headerByCollection: Map<string, IndexedRow>;
  /** Member rows by normalised name_of_collection - a box set passes a filter its discs pass. */
  membersByCollection: Map<string, IndexedRow[]>;
  franchises: IndexedFacet[];
  directors: IndexedFacet[];
  metadata: Map<string, IndexMeta>;
  builtAt: number;
}

// Only what search displays/matches/filters on - never the private columns (columns.ts guards
// the base list; the extra columns here are all in its DETAIL list too).
const INDEX_COLUMNS = `${TITLE_CARD_COLUMNS},director,franchise,genre,rating,running_time_mins,animation_or_live_action,documentary,studio,disk_region`;
const INDEX_TTL_MS = 5 * 60_000;

let index: SearchIndex | null = null;
let building: Promise<SearchIndex | null> | null = null;

async function fetchAllRows(): Promise<IndexRow[] | null> {
  const supabase = getCatalogClient();
  if (!supabase) return null;
  const rows: IndexRow[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from("titles")
      .select(INDEX_COLUMNS)
      .eq("scanned", true)
      .order("unique_id")
      .range(from, from + PAGE_SIZE - 1);
    if (error) {
      reportQueryError("search index (titles)", error);
      return null;
    }
    rows.push(...((data ?? []) as unknown as IndexRow[]));
    if (!data || data.length < PAGE_SIZE) break;
  }
  return rows;
}

/** title_metadata's display, date and score fields for every film; empty if 0043 isn't
 * applied yet. */
async function fetchAllMetadata(): Promise<Map<string, IndexMeta>> {
  const map = new Map<string, IndexMeta>();
  const supabase = getCatalogClient();
  if (!supabase) return map;
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from("title_metadata")
      .select("imdb_id,title,poster_path,release_date,runtime_mins,imdb_rating,imdb_votes,rotten_tomatoes_score,metacritic_score")
      .order("imdb_id")
      .range(from, from + PAGE_SIZE - 1);
    if (error) {
      reportQueryError("search index (title_metadata)", error);
      return map;
    }
    for (const m of (data ?? []) as unknown as IndexMeta[]) map.set(m.imdb_id, m);
    if (!data || data.length < PAGE_SIZE) break;
  }
  return map;
}

function buildFacets(rows: IndexedRow[], pick: (r: IndexRow) => string[] | null): IndexedFacet[] {
  // Case-insensitive merge ("Star Wars" / "star wars"), keeping the most common spelling.
  const byNorm = new Map<string, { spellings: Map<string, number>; rows: IndexedRow[] }>();
  for (const r of rows) {
    for (const raw of pick(r.row) ?? []) {
      const name = raw.trim();
      const norm = normalizeSearchText(name);
      if (!norm) continue;
      let entry = byNorm.get(norm);
      if (!entry) byNorm.set(norm, (entry = { spellings: new Map(), rows: [] }));
      entry.spellings.set(name, (entry.spellings.get(name) ?? 0) + 1);
      entry.rows.push(r);
    }
  }
  return [...byNorm.entries()].map(([norm, e]) => ({
    name: [...e.spellings.entries()].sort((a, b) => b[1] - a[1])[0][0],
    norm,
    count: e.rows.length,
    rows: e.rows,
  }));
}

// "Friends Season 10", "Popeye Volume 2", "Daria - The Complete Series" -> the show's name.
const SEASON_SUFFIX_RE = /(?:\s+|\s*[-:,(]\s*)(?:the\s+)?(?:complete\s+(?:series|seasons?)\b.*|(?:season|series|volume|vol\.?|part)\s*\d.*)$/i;

/** Without TMDb metadata, a TV entry's rows are per-season discs; name it after the show
 * (the most common season-stripped row title) rather than whichever season sorts first. */
function seriesName(rows: IndexedRow[]): string | null {
  const counts = new Map<string, number>();
  for (const r of rows) {
    if (r.row.is_collection) continue;
    const name = r.row.title.replace(SEASON_SUFFIX_RE, "").trim();
    if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)[0]?.[0] ?? null;
}

const toNumber = (v: unknown): number | null => (v === null || v === undefined || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const clean = (values: Array<string | null | undefined>): string[] => [...new Set(values.map((v) => v?.trim()).filter((v): v is string => !!v))];

function rowFacts(row: IndexRow, meta: IndexMeta | null, ownScore: number | null): RowFacts {
  const date = meta?.release_date ?? row.release_date ?? null;
  const month = date && date.length >= 7 ? String(Number(date.slice(5, 7))) : null;
  return {
    facets: {
      kind: clean([row.movie_or_tv]),
      fmt: clean([shortFormatLabel(row.format) ?? "Other"]),
      genre: clean(row.genre ?? []),
      fr: clean(row.franchise ?? []),
      age: clean([row.rating]),
      anim: clean([row.animation_or_live_action]),
      doc: clean([row.documentary]),
      studio: clean([row.studio]),
      region: clean([row.disk_region]),
      month: month && month !== "0" ? [month] : [],
    },
    ranges: {
      year: date ? Number(date.slice(0, 4)) || null : null,
      run: toNumber(row.running_time_mins) ?? toNumber(meta?.runtime_mins),
      imdb: toNumber(meta?.imdb_rating),
      rt: toNumber(meta?.rotten_tomatoes_score),
      mc: toNumber(meta?.metacritic_score),
      my: ownScore,
    },
    date,
    added: row.date_added,
    votes: toNumber(meta?.imdb_votes),
  };
}

async function buildIndex(): Promise<SearchIndex | null> {
  const [rawRows, metadata] = await Promise.all([fetchAllRows(), fetchAllMetadata()]);
  if (!rawRows) return null;
  // The owner's own scores, for the "My score" filter/sort - private build only.
  const ownScores = new Map<string, number>();

  const rows: IndexedRow[] = rawRows.map((row) => {
    const names = [row.title, row.release_name].filter((s): s is string => !!s?.trim()).map(normalizeSearchText);
    const coll = row.name_of_collection ? normalizeSearchText(row.name_of_collection) : null;
    if (row.is_collection && coll) names.push(coll);
    const imdbId = extractImdbIdFromPage(row.imdb_page);
    return {
      row,
      imdbId,
      names: [...new Set(names)],
      collectionName: !row.is_collection && row.title_in_a_collection ? coll : null,
      facts: rowFacts(row, imdbId ? (metadata.get(imdbId) ?? null) : null, ownScores.get(row.unique_id) ?? null),
    };
  });

  const headerByCollection = new Map<string, IndexedRow>();
  const membersByCollection = new Map<string, IndexedRow[]>();
  for (const r of rows) {
    if (r.row.is_collection && r.row.name_of_collection) {
      const key = normalizeSearchText(r.row.name_of_collection);
      if (!headerByCollection.has(key)) headerByCollection.set(key, r);
    } else if (r.collectionName) {
      membersByCollection.set(r.collectionName, [...(membersByCollection.get(r.collectionName) ?? []), r]);
    }
  }

  const filmRows = new Map<string, IndexedRow[]>();
  for (const r of rows) if (r.imdbId) {
    const list = filmRows.get(r.imdbId);
    if (list) list.push(r);
    else filmRows.set(r.imdbId, [r]);
  }
  const films: IndexedFilm[] = [...filmRows.entries()].map(([imdbId, frows]) => {
    const meta = metadata.get(imdbId) ?? null;
    // A standalone row's own title reads better than a box-set header's long name.
    const primary = frows.find((r) => !r.row.is_collection) ?? frows[0];
    const isTv = frows.some((r) => /tv/i.test(r.row.movie_or_tv));
    const title = meta?.title?.trim() || (isTv ? seriesName(frows) : null) || primary.row.title;
    const names = new Set([normalizeSearchText(title)]);
    for (const r of frows) if (!r.row.is_collection) names.add(normalizeSearchText(r.row.title));
    const years = frows.map((r) => yearOf(r.row.release_date)).filter((y): y is string => !!y).sort();
    return {
      imdbId,
      title,
      names: [...names].filter(Boolean),
      year: yearOf(meta?.release_date) ?? years[0] ?? null,
      isTv,
      rows: frows,
      metadata: meta,
    };
  });

  return {
    rows,
    films,
    filmById: new Map(films.map((f) => [f.imdbId, f])),
    headerByCollection,
    membersByCollection,
    franchises: buildFacets(rows, (r) => r.franchise),
    directors: buildFacets(rows, (r) => r.director),
    metadata,
    builtAt: Date.now(),
  };
}

/** Drops the index so the next search rebuilds it - after a scan confirm (cacheRefresh.ts). */
export function invalidateSearchIndex(): void {
  index = null;
}

/** Stale-while-revalidate: a stale index is served immediately while one rebuild runs in the
 * background; concurrent first requests share a single build. A failed rebuild keeps the old
 * index. */
async function getIndex(): Promise<SearchIndex | null> {
  const fresh = index && Date.now() - index.builtAt < INDEX_TTL_MS;
  if (!fresh && !building) {
    building = buildIndex()
      .then((built) => {
        if (built) index = built;
        return index;
      })
      .catch((err) => {
        console.error("[catalog] search index build failed:", err);
        return index;
      })
      .finally(() => {
        building = null;
      });
  }
  if (index) return index;
  return building;
}

// ---------------------------------------------------------------------------------------------
// Filters (searchFilters.ts)
// ---------------------------------------------------------------------------------------------

function facetPasses(values: string[], selection: Record<string, TriState> | undefined): boolean {
  if (!selection) return true;
  const have = new Set(values.map((v) => v.toLowerCase()));
  let wantsSome = false;
  let hasWanted = false;
  for (const [value, state] of Object.entries(selection)) {
    const present = have.has(value.toLowerCase());
    if (state === "exclude" && present) return false;
    if (state === "include") {
      wantsSome = true;
      if (present) hasWanted = true;
    }
  }
  return !wantsSome || hasWanted;
}

function flagPasses(value: boolean, flag: Flag): boolean {
  return !flag || (flag === "only" ? value : !value);
}

/** Facets and ranges - the parts a box set can pass through any one of its discs. */
function attributesPass(r: IndexedRow, f: SearchFilters): boolean {
  for (const { key } of FACETS) if (!facetPasses(r.facts.facets[key], f.facets[key])) return false;
  for (const [key, range] of Object.entries(f.ranges) as Array<[RangeKey, [number | null, number | null]]>) {
    const v = r.facts.ranges[key];
    if (range[0] === null && range[1] === null) continue;
    if (v === null) return false;
    if (range[0] !== null && v < range[0]) return false;
    if (range[1] !== null && v > range[1]) return false;
  }
  return true;
}

/** Steelbook / box set / in a box set - always about the row itself. */
function flagsPass(r: IndexedRow, f: SearchFilters): boolean {
  return (
    flagPasses(r.row.steelbook, f.steelbook) &&
    flagPasses(r.row.is_collection, f.boxSet) &&
    flagPasses(!r.row.is_collection && r.row.title_in_a_collection, f.inBoxSet)
  );
}

function rowPasses(r: IndexedRow, f: SearchFilters, idx: SearchIndex): boolean {
  if (!flagsPass(r, f)) return false;
  if (attributesPass(r, f)) return true;
  // A box set counts as horror/4K/1980s... when any disc inside it does.
  if (r.row.is_collection && r.row.name_of_collection) {
    const members = idx.membersByCollection.get(normalizeSearchText(r.row.name_of_collection)) ?? [];
    return members.some((m) => attributesPass(m, f));
  }
  return false;
}

/** A film passes when any copy of it does. */
const filmPasses = (film: IndexedFilm, f: SearchFilters, idx: SearchIndex) => film.rows.some((r) => rowPasses(r, f, idx));

/** Filter panel options: every value in the scanned collection, with how many rows carry it. */
export async function getSearchFacetOptions(): Promise<SearchFacetOptions | null> {
  const idx = await getIndex();
  if (!idx) return null;
  const counts = Object.fromEntries(FACETS.map(({ key }) => [key, new Map<string, { label: string; count: number }>()])) as Record<
    FacetKey,
    Map<string, { label: string; count: number }>
  >;
  let minYear = Infinity;
  let maxYear = -Infinity;
  for (const r of idx.rows) {
    for (const { key } of FACETS) {
      for (const value of r.facts.facets[key]) {
        const norm = value.toLowerCase();
        const entry = counts[key].get(norm);
        if (entry) entry.count++;
        else counts[key].set(norm, { label: value, count: 1 });
      }
    }
    const y = r.facts.ranges.year;
    if (y) {
      minYear = Math.min(minYear, y);
      maxYear = Math.max(maxYear, y);
    }
  }
  const FORMAT_ORDER = ["DVD", "Blu-ray", "4K UHD", "VHS", "VCD", "DVD-R"];
  const facets = {} as Record<FacetKey, FacetOption[]>;
  for (const { key } of FACETS) {
    const list = [...counts[key].values()].map(({ label, count }) => ({ value: label, label: facetValueLabel(key, label), count }));
    if (key === "month") list.sort((a, b) => Number(a.value) - Number(b.value));
    else if (key === "fmt") list.sort((a, b) => (FORMAT_ORDER.indexOf(a.value) + 1 || 99) - (FORMAT_ORDER.indexOf(b.value) + 1 || 99));
    else list.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
    facets[key] = list;
  }
  const yearBounds: [number, number] = Number.isFinite(minYear) ? [minYear, maxYear] : [1900, new Date().getFullYear()];
  return { facets, yearBounds };
}

// ---------------------------------------------------------------------------------------------
// People (queried per search - see the header comment)
// ---------------------------------------------------------------------------------------------

interface PersonRow {
  tmdb_person_id: number;
  name: string;
  profile_path: string | null;
  known_for_department: string | null;
}

let peopleMissingUntil = 0;
const peopleCache = new Map<string, { at: number; rows: PersonRow[] }>();
const PEOPLE_CACHE_MS = 2 * 60_000;
const PEOPLE_CACHE_MAX = 300;

async function searchPeople(rawQuery: string, norm: string): Promise<PersonRow[]> {
  if (Date.now() < peopleMissingUntil) return [];
  const cached = peopleCache.get(norm);
  if (cached && Date.now() - cached.at < PEOPLE_CACHE_MS) return cached.rows;
  const supabase = getCatalogClient();
  if (!supabase) return [];

  const { data, error } = await supabase
    .from("people")
    .select("tmdb_person_id,name,profile_path,known_for_department")
    .ilike("name", `%${escapeLike(rawQuery.trim())}%`)
    .limit(50);
  if (error) {
    // `people` arrives with migration 0043; until then, stop asking for a minute at a time.
    if (isMissingTableError(error)) peopleMissingUntil = Date.now() + 60_000;
    else reportQueryError("search people", error);
    return [];
  }
  const rows = (data ?? []) as unknown as PersonRow[];
  if (peopleCache.size >= PEOPLE_CACHE_MAX) peopleCache.delete(peopleCache.keys().next().value!);
  peopleCache.set(norm, { at: Date.now(), rows });
  return rows;
}

// ---------------------------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------------------------

export interface SearchOptions {
  /** Max hits returned per group (totals are still reported). */
  perGroup?: number;
  /** TMDb size for poster thumbnails - w92 for the dropdown, w342 for the results page. */
  posterSize?: TmdbPosterSize;
  /** Advanced Search filters and sort. With filters, an empty query browses the collection. */
  filters?: SearchFilters;
  /** The chosen taste profiles' own filters (filters.profiles, loaded by the caller). A
   * title must pass the filters AND every profile - the "middle ground". */
  profileFilters?: SearchFilters[];
}

/** Values a candidate can be sorted by (null = unknown, always listed last). */
interface SortValues {
  title: string;
  released: string | null;
  added: string | null;
  popularity: number | null;
  runtime: number | null;
  imdb: number | null;
  rt: number | null;
  mc: number | null;
  my: number | null;
}

/** A scored candidate before images are resolved. */
interface Candidate {
  kind: SearchKind;
  key: string;
  /** Lower is better; tier * 10 + small penalties. */
  score: number;
  sortName: string;
  related: boolean;
  /** Row whose poster/case image represents it (null for people/directors without one). */
  imageRow: IndexedRow | null;
  build: () => Omit<SearchHit, "image" | "kind" | "key" | "related">;
  /** An image that isn't a disc's: a person's photo, or a film's own TMDb poster. Wins over
   * imageRow - a Film/TV result shows the film's poster, not one copy's case photo (the user,
   * 2026-10-06: disc images put the case photo first, which leaked into film results). */
  ownImage?: CatalogImage | null;
  sortValues: SortValues;
}

const FORMAT_RANK = (format: string | null | undefined) => {
  const f = (format ?? "").toLowerCase();
  if (f.includes("4k")) return 0;
  if (f.includes("blu")) return 1;
  if (f.includes("dvd")) return 2;
  return 3;
};

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** Earliest-released row with any image source, to stand in for a franchise or director. */
function representativeRow(rows: IndexedRow[], metadata: SearchIndex["metadata"]): IndexedRow | null {
  const withImage = rows.filter(
    (r) => r.row.movie_poster_path || r.row.case_image_path || r.row.case_image_url || (r.imdbId && metadata.get(r.imdbId)?.poster_path),
  );
  const pool = withImage.length ? withImage : rows;
  return [...pool].sort((a, b) => (a.row.release_date ?? "9999").localeCompare(b.row.release_date ?? "9999"))[0] ?? null;
}

const maxOf = (values: Array<number | null>): number | null => values.reduce<number | null>((m, v) => (v === null ? m : m === null ? v : Math.max(m, v)), null);
const latestOf = (values: Array<string | null>): string | null => values.reduce<string | null>((m, v) => (v && (!m || v > m) ? v : m), null);
const earliestOf = (values: Array<string | null>): string | null => values.reduce<string | null>((m, v) => (v && (!m || v < m) ? v : m), null);

function rowSortValues(r: IndexedRow): SortValues {
  return {
    title: displayTitle(r.row),
    released: r.facts.date,
    added: r.facts.added,
    popularity: r.facts.votes,
    runtime: r.facts.ranges.run,
    imdb: r.facts.ranges.imdb,
    rt: r.facts.ranges.rt,
    mc: r.facts.ranges.mc,
    my: r.facts.ranges.my,
  };
}

function filmSortValues(film: IndexedFilm): SortValues {
  const own = film.rows.filter((r) => !r.row.is_collection);
  const rows = own.length ? own : film.rows;
  return {
    title: film.title,
    released: film.metadata?.release_date ?? earliestOf(rows.map((r) => r.facts.date)),
    added: latestOf(rows.map((r) => r.facts.added)),
    popularity: rows[0]?.facts.votes ?? null,
    runtime: rows.find((r) => r.facts.ranges.run !== null)?.facts.ranges.run ?? null,
    imdb: rows[0]?.facts.ranges.imdb ?? null,
    rt: rows[0]?.facts.ranges.rt ?? null,
    mc: rows[0]?.facts.ranges.mc ?? null,
    my: maxOf(rows.map((r) => r.facts.ranges.my)),
  };
}

const NAME_ONLY = (title: string): SortValues => ({
  title,
  released: null,
  added: null,
  popularity: null,
  runtime: null,
  imdb: null,
  rt: null,
  mc: null,
  my: null,
});

export function cleanSearchQuery(raw: string | string[] | null | undefined): string {
  const value = Array.isArray(raw) ? raw[0] : raw;
  // Strip control characters and cap the length before anything else touches it.
  return (value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, SEARCH_MAX_QUERY_LENGTH);
}

export async function searchCatalog(rawQuery: string, opts: SearchOptions = {}): Promise<SearchResults> {
  const query = cleanSearchQuery(rawQuery);
  const q = normalizeSearchText(query);
  const filters = opts.filters ?? EMPTY_FILTERS;
  // Every set of filters a title has to pass: the panel's own, plus each chosen profile's.
  const filterSets = [filters, ...(opts.profileFilters ?? [])].filter((f) => hasTitleFilters({ ...f, profiles: [] }));
  const titleFilters = hasTitleFilters(filters);
  const filmOk = (film: IndexedFilm) => filterSets.every((f) => filmPasses(film, f, idx!));
  const rowOk = (r: IndexedRow) => filterSets.every((f) => rowPasses(r, f, idx!));
  // No query: a browse, which needs something to browse by.
  const browsing = q.length < SEARCH_MIN_LENGTH;
  const sort: SortKey = filters.sort && !(browsing && filters.sort === "relevance") ? filters.sort : browsing ? "title" : "relevance";
  const empty: SearchResults = { query, groups: [], total: 0, sort };
  if (browsing && !titleFilters && filters.types.length === 0 && !filters.sort) return empty;
  const qWords = q.split(" ");
  const perGroup = Math.min(Math.max(opts.perGroup ?? 5, 1), 500);

  // Which groups to show: the ones picked, else every group - or just titles once a title
  // filter is on (a "Horror" filter says nothing about which people to list).
  const allowed = new Set<SearchKind>(filters.types.length ? filters.types : titleFilters ? TITLE_KINDS : GROUP_ORDER);
  // People come from a name search, so a browse can't list them.
  if (browsing) allowed.delete("person");

  const [idx, people] = await Promise.all([getIndex(), browsing || !allowed.has("person") ? Promise.resolve([]) : searchPeople(query, q)]);
  if (!idx) return empty;

  const candidates = new Map<string, Candidate>();
  const add = (c: Candidate) => {
    if (!allowed.has(c.kind)) return;
    const id = `${c.kind}:${c.key}`;
    const prev = candidates.get(id);
    if (!prev) candidates.set(id, c);
    // Best score wins, but it only counts as "related" if it never matched directly.
    else candidates.set(id, { ...(c.score < prev.score ? c : prev), related: c.related && prev.related });
  };

  // Films / TV (the IMDb-like entries).
  const matchedFilms: Array<{ film: IndexedFilm; tier: number }> = [];
  for (const film of idx.films) {
    const tier = browsing ? 0 : bestTier(film.names, q, qWords);
    if (tier === null) continue;
    if (titleFilters && !filmOk(film)) continue;
    matchedFilms.push({ film, tier });
    const owned = film.rows.filter((r) => !r.row.is_collection).length || film.rows.length;
    add({
      kind: "film",
      key: film.imdbId,
      score: tier * 10,
      sortName: film.title,
      related: false,
      imageRow: film.rows.find((r) => !r.row.is_collection && r.row.movie_poster_path) ?? film.rows.find((r) => !r.row.is_collection) ?? film.rows[0],
      ownImage: tmdbImage(idx.metadata.get(film.imdbId)?.poster_path, opts.posterSize ?? "w342"),
      sortValues: filmSortValues(film),
      build: () => ({
        href: workHref(film.imdbId),
        title: film.title,
        year: film.year,
        format: null,
        subtitle: `${film.isTv ? "TV" : "Movie"} // ${owned} ${owned === 1 ? "copy" : "copies"} owned`,
      }),
    });
  }

  // Physical items + box sets: own names first; a member matching only by its box set's name
  // is a weaker (+2) match so "hitchcock" lists the sets before every disc inside them.
  for (const r of idx.rows) {
    let score: number | null;
    if (browsing) {
      score = 0;
    } else {
      const tier = bestTier(r.names, q, qWords);
      score = tier === null ? null : tier * 10;
      if (score === null && r.collectionName) {
        const ct = matchTier(r.collectionName, q, qWords);
        if (ct !== null) score = ct * 10 + 25;
      }
    }
    if (score === null) continue;
    if (titleFilters && !rowOk(r)) continue;
    addRow(r, score, false);
  }

  function addRow(r: IndexedRow, score: number, related: boolean) {
    const row = r.row;
    const isSet = row.is_collection;
    const header = !isSet && r.collectionName ? idx!.headerByCollection.get(r.collectionName) : undefined;
    add({
      kind: isSet ? "collection" : "item",
      key: row.unique_id,
      score: score + FORMAT_RANK(row.format) * 0.1,
      sortName: displayTitle(row),
      related,
      imageRow: r,
      sortValues: rowSortValues(r),
      build: () => ({
        href: isSet ? collectionHref(row.unique_id) : discHref(row.unique_id),
        title: displayTitle(row),
        year: yearOf(row.release_date) ?? (r.imdbId ? idx!.filmById.get(r.imdbId)?.year ?? null : null),
        format: shortFormatLabel(row.format),
        subtitle: isSet
          ? `${row.format} box set`
          : header
            ? `${row.format} // In: ${displayTitle(header.row)}`
            : row.format || null,
      }),
    });
  }

  // Franchises.
  for (const f of idx.franchises) {
    const tier = browsing ? 0 : matchTier(f.norm, q, qWords);
    if (tier === null) continue;
    add({
      kind: "franchise",
      key: f.norm,
      score: tier * 10,
      sortName: f.name,
      related: false,
      imageRow: representativeRow(f.rows, idx.metadata),
      sortValues: NAME_ONLY(f.name),
      build: () => ({ href: franchiseHref(f.name), title: f.name, year: null, format: null, subtitle: `Franchise // ${plural(f.count, "item")}` }),
    });
  }

  // Directors (from titles.director). Linked to the /people/[slug] director route.
  const directorByNorm = new Map(idx.directors.map((d) => [d.norm, d]));
  const addDirector = (d: IndexedFacet, score: number, related: boolean) =>
    add({
      kind: "director",
      key: d.norm,
      score,
      sortName: d.name,
      related,
      imageRow: null,
      sortValues: NAME_ONLY(d.name),
      build: () => ({ href: `/people/${slugify(d.name)}`, title: d.name, year: null, format: null, subtitle: `Director // ${plural(d.count, "item")}` }),
    });
  for (const d of idx.directors) {
    const tier = browsing ? 0 : matchTier(d.norm, q, qWords);
    if (tier !== null) addDirector(d, tier * 10, false);
  }

  // Related results (Vertigo example): a strongly matched film (exact/prefix) pulls in its
  // director(s) and the box set(s) holding it. +15 ranks them after the film's own physical
  // releases (film -> its discs -> its box set -> its director). Not while browsing, where
  // every title is a "match".
  for (const { film, tier } of browsing ? [] : matchedFilms) {
    if (tier > 1) continue;
    const relScore = tier * 10 + 15;
    for (const r of film.rows) {
      for (const name of r.row.director ?? []) {
        const d = directorByNorm.get(normalizeSearchText(name));
        if (d) addDirector(d, relScore, true);
      }
      const header = r.collectionName ? idx.headerByCollection.get(r.collectionName) : undefined;
      if (header && (!titleFilters || rowOk(header))) addRow(header, relScore, true);
    }
  }

  // People (TMDb credits) - skip anyone already listed as a director to avoid a duplicate entry.
  for (const p of people) {
    const norm = normalizeSearchText(p.name);
    if (directorByNorm.has(norm) && candidates.has(`director:${norm}`)) continue;
    const tier = matchTier(norm, q, qWords);
    if (tier === null) continue;
    add({
      kind: "person",
      key: String(p.tmdb_person_id),
      score: tier * 10,
      sortName: p.name,
      related: false,
      imageRow: null,
      ownImage: tmdbImage(p.profile_path, "w185"),
      sortValues: NAME_ONLY(p.name),
      build: () => ({ href: personHref(p.tmdb_person_id), title: p.name, year: null, format: null, subtitle: p.known_for_department }),
    });
  }

  // Group, rank, cap.
  const byKind = new Map<SearchKind, Candidate[]>();
  for (const c of candidates.values()) {
    const list = byKind.get(c.kind);
    if (list) list.push(c);
    else byKind.set(c.kind, [c]);
  }
  const relevance = (a: Candidate, b: Candidate) =>
    // Direct matches before related ones ("hitchcock": Alfred Hitchcock before the director
    // of the film "Hitchcock"), then by score, then shorter (closer) names.
    Number(a.related) - Number(b.related) ||
    a.score - b.score ||
    a.sortName.length - b.sortName.length ||
    a.sortName.localeCompare(b.sortName);
  const dir = filters.dir ?? SORTS.find((s) => s.value === sort)!.dir;
  const sign = dir === "asc" ? 1 : -1;
  const bySort = (a: Candidate, b: Candidate): number => {
    if (sort === "relevance") return relevance(a, b);
    if (sort === "title") return sign * a.sortValues.title.replace(ARTICLE_RE_TITLE, "").localeCompare(b.sortValues.title.replace(ARTICLE_RE_TITLE, "")) || relevance(a, b);
    const av = a.sortValues[sort];
    const bv = b.sortValues[sort];
    if (av === null && bv === null) return relevance(a, b);
    if (av === null) return 1;
    if (bv === null) return -1;
    const cmp = typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv));
    return sign * cmp || relevance(a, b);
  };
  const ranked = [...byKind.entries()].map(([kind, list]) => {
    list.sort(bySort);
    return { kind, list, best: Math.min(...list.map((c) => c.score)) };
  });
  // Groups ordered by their best match, so "star wars" leads with the franchise and "alfred
  // hitchcock" with the director; ties fall back to the Vertigo-example order.
  // Bucketed to half-tiers so the small format tie-break doesn't reorder groups.
  ranked.sort((a, b) =>
    sort === "relevance"
      ? Math.round(a.best / 5) - Math.round(b.best / 5) || GROUP_ORDER.indexOf(a.kind) - GROUP_ORDER.indexOf(b.kind)
      : GROUP_ORDER.indexOf(a.kind) - GROUP_ORDER.indexOf(b.kind),
  );

  const shown = ranked.map((g) => ({ ...g, list: g.list.slice(0, perGroup) }));
  const imageRows = shown.flatMap((g) => g.list.map((c) => c.imageRow)).filter((r): r is IndexedRow => !!r);
  const uniqueImageRows = [...new Map(imageRows.map((r) => [r.row.unique_id, r])).values()];
  // One signing batch per bucket for every shown hit (signed URLs are cached in images.ts).
  const images = await resolveImages(
    uniqueImageRows.map((r) => r.row),
    (row) => {
      const id = extractImdbIdFromPage(row.imdb_page);
      return id ? (idx.metadata.get(id) as TitleMetadata | undefined) : undefined;
    },
    opts.posterSize ?? "w342",
  );

  const groups: SearchGroup[] = shown.map(({ kind, list }) => ({
    kind,
    label: GROUP_LABELS[kind],
    total: byKind.get(kind)!.length,
    hits: list.map((c) => ({
      kind,
      key: c.key,
      related: c.related || undefined,
      image: c.ownImage ?? (c.imageRow ? (images.get(c.imageRow.row.unique_id)?.poster ?? null) : null),
      ...c.build(),
    })),
  }));
  return { query, groups, total: groups.reduce((n, g) => n + g.total, 0), sort };
}

/** Alphabetical sorting ignores a leading article, like a shop shelf. */
const ARTICLE_RE_TITLE = /^(the|a|an)\s+/i;
