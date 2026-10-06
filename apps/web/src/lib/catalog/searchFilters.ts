/**
 * Search filters and sorting (WEB APP DESIGN.md's Advanced Search: "an option to add filters to
 * find specific entries or block other entries from showing, as well as a sort by option").
 * Built 2026-10-07. Shared by the server (search.ts applies them) and the client filter panel
 * (FilterPanel.tsx edits them), so this file has no server-only imports.
 *
 * Everything lives in the URL, so a filtered search can be bookmarked or shared:
 *   facet values   ?genre=Horror&genre=!Comedy   (a leading "!" blocks that value)
 *   ranges         ?year=1940-1960  ?rt=70-  ?imdb=-6.5   (either end optional)
 *   flags          ?steel=1  ?set=only|no  ?inset=only|no
 *   result types   ?type=film&type=item
 *   sorting        ?sort=released&dir=asc
 *   taste profiles ?profile=<id>&profile=<id>   (titles must suit every chosen profile)
 */

export type ResultType = "film" | "item" | "collection" | "franchise" | "director" | "person";

export const RESULT_TYPES: Array<{ value: ResultType; label: string }> = [
  { value: "film", label: "Films & TV" },
  { value: "item", label: "Physical titles" },
  { value: "collection", label: "Box sets" },
  { value: "franchise", label: "Franchises" },
  { value: "director", label: "Directors" },
  { value: "person", label: "Actors & crew" },
];

/** Multi-value facets, each value either required ("include") or blocked ("exclude"). */
export const FACETS = [
  { key: "kind", label: "Movie or TV" },
  { key: "fmt", label: "Format" },
  { key: "genre", label: "Genre" },
  { key: "fr", label: "Franchise" },
  { key: "age", label: "Age rating" },
  { key: "anim", label: "Animation / live action" },
  { key: "doc", label: "Documentary / realism" },
  { key: "studio", label: "Studio" },
  { key: "region", label: "Disc region" },
  { key: "month", label: "Release month" },
] as const;
export type FacetKey = (typeof FACETS)[number]["key"];

/** Numeric ranges, shown as two-handled sliders. `year`'s bounds come from the collection. */
export const RANGES = [
  { key: "year", label: "Release year", min: 1900, max: 2030, step: 1, unit: "" },
  { key: "run", label: "Runtime", min: 0, max: 300, step: 5, unit: " min" },
  { key: "imdb", label: "IMDb rating", min: 0, max: 10, step: 0.1, unit: "" },
  { key: "rt", label: "Rotten Tomatoes", min: 0, max: 100, step: 1, unit: "%" },
  { key: "mc", label: "Metacritic", min: 0, max: 100, step: 1, unit: "" },
  // The owner's own 1-10 score. Only offered by the private build's page; the public build's
  // index has no scores, so it would match nothing there.
  { key: "my", label: "My score", min: 1, max: 10, step: 1, unit: "/10" },
] as const;
export type RangeKey = (typeof RANGES)[number]["key"];

export const SORTS = [
  { value: "relevance", label: "Best match", dir: "asc" },
  { value: "title", label: "Alphabetical", dir: "asc" },
  { value: "released", label: "Release date", dir: "desc" },
  { value: "added", label: "Recently added", dir: "desc" },
  { value: "popularity", label: "Popularity (IMDb votes)", dir: "desc" },
  { value: "runtime", label: "Runtime", dir: "desc" },
  { value: "imdb", label: "IMDb rating", dir: "desc" },
  { value: "rt", label: "Rotten Tomatoes", dir: "desc" },
  { value: "mc", label: "Metacritic", dir: "desc" },
  { value: "my", label: "My score", dir: "desc" },
] as const;
export type SortKey = (typeof SORTS)[number]["value"];

export type TriState = "include" | "exclude";
export type Flag = "only" | "no" | null;

export interface SearchFilters {
  types: ResultType[];
  facets: Partial<Record<FacetKey, Record<string, TriState>>>;
  ranges: Partial<Record<RangeKey, [number | null, number | null]>>;
  steelbook: Flag;
  /** Is a box set. */
  boxSet: Flag;
  /** Is a title inside a box set. */
  inBoxSet: Flag;
  sort: SortKey | null;
  dir: "asc" | "desc" | null;
  /** Taste profile ids (the taste_profiles table) - a title must pass every one. */
  profiles: string[];
}

export const EMPTY_FILTERS: SearchFilters = {
  types: [],
  facets: {},
  ranges: {},
  steelbook: null,
  boxSet: null,
  inBoxSet: null,
  sort: null,
  dir: null,
  profiles: [],
};

export const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** Display text for a facet value (the stored value stays in the URL). */
export function facetValueLabel(key: FacetKey, value: string): string {
  if (key === "doc") {
    if (value.toLowerCase() === "y") return "Documentary";
    if (value.toLowerCase() === "n") return "Not a documentary";
  }
  if (key === "month") return MONTHS[Number(value) - 1] ?? value;
  return value;
}

// Bounds on what the URL can ask for - a filter link is user input like any other.
const MAX_VALUES_PER_KEY = 40;
const PROFILE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_VALUE_LENGTH = 80;

type Getter = (key: string) => string[];

function cleanValue(v: string): string {
  return v.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, MAX_VALUE_LENGTH);
}

function parseRange(raw: string | undefined): [number | null, number | null] | null {
  if (!raw) return null;
  // "1940-1960", "70-", "-6.5", or a bare "70" (a minimum).
  const m = raw.match(/^\s*(\d+(?:\.\d+)?)?\s*-\s*(\d+(?:\.\d+)?)?\s*$/) ?? raw.match(/^\s*(\d+(?:\.\d+)?)()\s*$/);
  if (!m) return null;
  const lo = m[1] ? Number(m[1]) : null;
  const hi = m[2] ? Number(m[2]) : null;
  if (lo === null && hi === null) return null;
  return lo !== null && hi !== null && lo > hi ? [hi, lo] : [lo, hi];
}

function parseFlag(raw: string | undefined): Flag {
  return raw === "only" || raw === "1" ? "only" : raw === "no" || raw === "0" ? "no" : null;
}

export function parseFilters(get: Getter): SearchFilters {
  const typeValues = new Set(RESULT_TYPES.map((t) => t.value));
  const facets: SearchFilters["facets"] = {};
  for (const { key } of FACETS) {
    const values = get(key).slice(0, MAX_VALUES_PER_KEY);
    const map: Record<string, TriState> = {};
    for (const raw of values) {
      const exclude = raw.startsWith("!");
      const value = cleanValue(exclude ? raw.slice(1) : raw);
      if (value) map[value] = exclude ? "exclude" : "include";
    }
    if (Object.keys(map).length) facets[key] = map;
  }
  const ranges: SearchFilters["ranges"] = {};
  for (const { key } of RANGES) {
    const r = parseRange(get(key)[0]);
    if (r) ranges[key] = r;
  }
  const sortRaw = get("sort")[0];
  const dirRaw = get("dir")[0];
  return {
    types: get("type").filter((t): t is ResultType => typeValues.has(t as ResultType)),
    facets,
    ranges,
    steelbook: parseFlag(get("steel")[0]),
    boxSet: parseFlag(get("set")[0]),
    inBoxSet: parseFlag(get("inset")[0]),
    sort: SORTS.some((s) => s.value === sortRaw) ? (sortRaw as SortKey) : null,
    dir: dirRaw === "asc" || dirRaw === "desc" ? dirRaw : null,
    profiles: [...new Set(get("profile").filter((id) => PROFILE_ID_RE.test(id)))].slice(0, 10),
  };
}

/** From Next's `searchParams` object. */
export function parseFiltersFromRecord(params: Record<string, string | string[] | undefined>): SearchFilters {
  return parseFilters((key) => {
    const v = params[key];
    return v === undefined ? [] : Array.isArray(v) ? v : [v];
  });
}

function formatNumber(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

/** The filters as URL params (everything but `q`). */
export function filtersToParams(f: SearchFilters, params = new URLSearchParams()): URLSearchParams {
  for (const t of f.types) params.append("type", t);
  for (const { key } of FACETS) {
    for (const [value, state] of Object.entries(f.facets[key] ?? {})) params.append(key, state === "exclude" ? `!${value}` : value);
  }
  for (const { key } of RANGES) {
    const r = f.ranges[key];
    if (r && (r[0] !== null || r[1] !== null)) params.set(key, `${r[0] === null ? "" : formatNumber(r[0])}-${r[1] === null ? "" : formatNumber(r[1])}`);
  }
  if (f.steelbook) params.set("steel", f.steelbook === "only" ? "1" : "0");
  if (f.boxSet) params.set("set", f.boxSet);
  if (f.inBoxSet) params.set("inset", f.inBoxSet);
  if (f.sort) params.set("sort", f.sort);
  if (f.dir) params.set("dir", f.dir);
  for (const id of f.profiles) params.append("profile", id);
  return params;
}

/** True when anything narrows which titles show (sorting and result types don't count). */
export function hasTitleFilters(f: SearchFilters): boolean {
  return (
    f.profiles.length > 0 ||
    Object.values(f.facets).some((m) => m && Object.keys(m).length > 0) ||
    Object.values(f.ranges).some((r) => r && (r[0] !== null || r[1] !== null)) ||
    !!f.steelbook ||
    !!f.boxSet ||
    !!f.inBoxSet
  );
}

export function activeFilterCount(f: SearchFilters): number {
  return (
    f.profiles.length +
    f.types.length +
    Object.values(f.facets).reduce((n, m) => n + Object.keys(m ?? {}).length, 0) +
    Object.values(f.ranges).filter((r) => r && (r[0] !== null || r[1] !== null)).length +
    (f.steelbook ? 1 : 0) +
    (f.boxSet ? 1 : 0) +
    (f.inBoxSet ? 1 : 0)
  );
}

/** Options the filter panel offers, built from the scanned collection. */
export interface FacetOption {
  value: string;
  label: string;
  count: number;
}
export interface SearchFacetOptions {
  facets: Record<FacetKey, FacetOption[]>;
  yearBounds: [number, number];
}
