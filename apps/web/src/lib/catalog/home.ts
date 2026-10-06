import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getCatalogClient, PAGE_SIZE, reportQueryError } from "./client";
import { TITLE_CARD_COLUMNS } from "./columns";
import { collectionHref, discHref, franchiseHref, slugify, workHref, yearOf, shortFormatLabel, displayTitle } from "./display";
import { tmdbImage } from "./images";
import {
  getDisc,
  listCollectionMembers,
  listFranchises,
  listGenres,
  listRecentlyAdded,
  listTitlesByFranchise,
  listTitlesByGenre,
  toPosterCards,
} from "./queries";
import type { CatalogImage, PosterCardData, TitleCardRow } from "./types";

/**
 * Data for the Home/Browse page (WEB APP DESIGN.md "Home/browse page").
 *
 * The page is a fixed head of rows (Recently Added, New Releases, Classics, TV, Weird and
 * Wonderful) followed by an endless-feeling tail built from a "plan": every franchise, genre,
 * box set and a few extra facets (decades, formats, animation styles) shuffled with a seed and
 * interleaved. The seed is chosen once per page render and handed to the client, so the
 * /home-rows route can continue the SAME plan by cursor - no row repeats on one page load, and
 * every row itself ends (no looping).
 */

/** A row needs at least this many titles to be worth a whole row on the page. */
export const HOME_MIN_ROW_TITLES = 6;
/** Box sets are complete units, so a 5-film set still makes a full row. */
const MIN_COLLECTION_MEMBERS = 5;
const ROW_LIMIT = 30;
const FRANCHISE_ROW_LIMIT = 40;
/** Seeds are clamped to a small space so /home-rows responses stay CDN-cacheable. */
export const HOME_SEED_SPACE = 10_000;
/** Rows server-rendered from the plan before the client starts loading more. */
export const HOME_INITIAL_PLAN_ROWS = 3;
/** Rows per /home-rows request. */
export const HOME_BATCH_ROWS = 3;

export interface HomeRowData {
  /** Stable per page load (`kind:slug`) - used as the React key and to dedupe. */
  id: string;
  title: string;
  /** Full name when `title` was shortened (long box-set names). */
  fullTitle?: string;
  /** Tiny uppercase tag before the title ("Franchise", "Genre", "Box Set"...). */
  label: string;
  href: string | null;
  hrefLabel?: string;
  cards: PosterCardData[];
}

// ---------------------------------------------------------------------------------------------
// Seeded randomness - the same seed must rebuild the same plan in the page and in the route.
// ---------------------------------------------------------------------------------------------

export function normalizeSeed(value: unknown): number | null {
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n >= HOME_SEED_SPACE) return null;
  return n;
}

export function randomHomeSeed(): number {
  return Math.floor(Math.random() * HOME_SEED_SPACE);
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A generator per (seed, purpose), so one row's random window doesn't depend on which rows
 * happened to be drawn before it. */
function rngFor(seed: number, key: string): () => number {
  let h = 2166136261 ^ seed;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  return mulberry32(h);
}

function shuffle<T>(items: T[], rand: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------------------------

function cardQuery(supabase: SupabaseClient) {
  // Box-set header rows are left out of browse rows: their members appear instead, and a
  // header would just duplicate them.
  return supabase.from("titles").select(TITLE_CARD_COLUMNS, { count: "exact" }).eq("scanned", true).eq("is_collection", false);
}
type CardQuery = ReturnType<typeof cardQuery>;

/**
 * A random contiguous window of up to `limit` matching rows (in `order`), so big pools like
 * "Classics" (~790 rows) show a different slice per page load without fetching them all.
 * Costs one query when everything fits, two otherwise.
 */
async function windowedRows(
  context: string,
  filter: (q: CardQuery) => CardQuery,
  order: (q: CardQuery) => CardQuery,
  rand: () => number,
  limit = ROW_LIMIT,
): Promise<TitleCardRow[]> {
  const supabase = getCatalogClient();
  if (!supabase) return [];
  const first = await order(filter(cardQuery(supabase))).range(0, limit - 1);
  reportQueryError(context, first.error);
  const total = first.count ?? 0;
  if (first.error || total <= limit) return (first.data ?? []) as unknown as TitleCardRow[];

  const offset = Math.floor(rand() * (total - limit + 1));
  const second = await order(filter(cardQuery(supabase))).range(offset, offset + limit - 1);
  reportQueryError(context, second.error);
  return (second.data ?? first.data ?? []) as unknown as TitleCardRow[];
}

const byReleaseAsc = (q: CardQuery) => q.order("release_date", { ascending: true, nullsFirst: false }).order("title").order("unique_id");
const byTitle = (q: CardQuery) => q.order("title").order("release_date", { ascending: true, nullsFirst: false }).order("unique_id");

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Converts many rows' title lists to Film/TV cards in ONE image/metadata pass, then splits
 * them back: one card per film per row (copies collapse), and rows without an IMDb id left out
 * - the home page shows Film/TV entries only (toPosterCards' `asWork`). */
async function toCardGroups(groups: TitleCardRow[][]): Promise<PosterCardData[][]> {
  const all = groups.flat();
  const unique = [...new Map(all.map((r) => [r.unique_id, r])).values()];
  const built = await toPosterCards(unique, "w342", { asWork: true });
  const byRow = new Map(unique.map((r, i) => [r.unique_id, built[i]]));
  return groups.map((rows) => {
    const seen = new Set<string>();
    const cards: PosterCardData[] = [];
    for (const r of rows) {
      const card = byRow.get(r.unique_id);
      if (!card?.href || seen.has(card.key)) continue;
      seen.add(card.key);
      cards.push(card);
    }
    return cards;
  });
}

// ---------------------------------------------------------------------------------------------
// Box sets (for "specific DVD Collection Set" rows)
// ---------------------------------------------------------------------------------------------

interface CollectionSet {
  name: string;
  count: number;
  headerId: string | null;
}

const SET_TTL_MS = 5 * 60_000;
let setCache: { at: number; sets: CollectionSet[] } | null = null;

/** Every box set name with its member count and header row id. Paged (PostgREST's 1,000-row
 * cap) and cached for a few minutes, like the franchise/genre facets. */
async function listCollectionSets(): Promise<CollectionSet[]> {
  if (setCache && Date.now() - setCache.at < SET_TTL_MS) return setCache.sets;
  const supabase = getCatalogClient();
  if (!supabase) return [];

  const sets = new Map<string, CollectionSet>();
  const key = (name: string) => name.trim().toLowerCase();
  for (const headers of [false, true]) {
    for (let from = 0; ; from += PAGE_SIZE) {
      const { data, error } = await supabase
        .from("titles")
        .select("unique_id,name_of_collection")
        .eq("scanned", true)
        .eq(headers ? "is_collection" : "title_in_a_collection", true)
        .not("name_of_collection", "is", null)
        .order("unique_id")
        .range(from, from + PAGE_SIZE - 1);
      if (error) {
        reportQueryError("listCollectionSets", error);
        return setCache?.sets ?? [];
      }
      for (const row of (data ?? []) as Array<{ unique_id: string; name_of_collection: string }>) {
        const name = row.name_of_collection.trim();
        if (!name) continue;
        const set = sets.get(key(name)) ?? { name, count: 0, headerId: null };
        if (headers) set.headerId ??= row.unique_id;
        else set.count += 1;
        sets.set(key(name), set);
      }
      if (!data || data.length < PAGE_SIZE) break;
    }
  }
  const list = [...sets.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  setCache = { at: Date.now(), sets: list };
  return list;
}

/**
 * Box-set names in this collection are the full cover text ("Alfred Hitchcock A Collection of
 * 10 Classic Alfred Hitchcock Movies: Murder, The Skin Game, ..."), too long for a row header.
 * Keep the part before the colon - unless that part is just a count ("8 Discs, 7 Movies: A
 * Nightmare on Elm Street Collection"), in which case the part after names the set.
 */
export function shortCollectionName(name: string): string {
  const [head, ...rest] = name.split(":");
  const tail = rest.join(":").trim();
  let short = head.trim();
  if (tail && /^\d/.test(short) && /\b(movies?|films?|discs?|disks?|dvds?)\b/i.test(short) && !tail.includes(",")) short = tail;
  return short.length > 64 ? `${short.slice(0, 61).trimEnd()}...` : short;
}

// ---------------------------------------------------------------------------------------------
// The plan (endless tail)
// ---------------------------------------------------------------------------------------------

type PlanRow =
  | { kind: "franchise"; id: string; name: string }
  | { kind: "genre"; id: string; name: string; count: number }
  | { kind: "collection"; id: string; set: CollectionSet }
  | { kind: "decade"; id: string; decade: number }
  | { kind: "facet"; id: string; title: string; label: string; filter: (q: CardQuery) => CardQuery };

/** Extra, non-franchise/genre/set rows sprinkled between the others for variety. */
function extraRows(): PlanRow[] {
  const decades: PlanRow[] = [];
  for (let d = 1920; d <= 2020; d += 10) decades.push({ kind: "decade", id: `decade:${d}`, decade: d });
  return [
    ...decades,
    { kind: "facet", id: "format:4k", title: "In 4K Ultra HD", label: "Format", filter: (q) => q.ilike("format", "4K%") },
    { kind: "facet", id: "format:bluray", title: "On Blu-ray", label: "Format", filter: (q) => q.ilike("format", "Blu-Ray%") },
    { kind: "facet", id: "type:tv-movie", title: "TV Movies", label: "Category", filter: (q) => q.eq("movie_or_tv", "TV Movie") },
    { kind: "facet", id: "type:mini-series", title: "Mini-Series", label: "TV", filter: (q) => q.eq("movie_or_tv", "TV Mini-Series") },
    { kind: "facet", id: "type:short", title: "Shorts", label: "Category", filter: (q) => q.eq("movie_or_tv", "Short") },
    { kind: "facet", id: "anim:2d", title: "Hand-Drawn Animation", label: "Animation", filter: (q) => q.ilike("animation_or_live_action", "%2D%") },
    { kind: "facet", id: "anim:3d", title: "Computer Animation", label: "Animation", filter: (q) => q.ilike("animation_or_live_action", "%3D Animation%") },
  ];
}

/** Interleave order, so the tail alternates between kinds instead of 60 franchises in a row. */
const PLAN_PATTERN = ["franchise", "collection", "genre", "franchise", "extra", "collection", "genre"] as const;

export async function buildHomePlan(seed: number): Promise<PlanRow[]> {
  const [franchises, genres, sets] = await Promise.all([listFranchises(), listGenres(), listCollectionSets()]);

  // Case variants ("Star Wars" / "star wars") are one franchise - merge by slug.
  const franchiseCounts = new Map<string, { name: string; count: number }>();
  for (const f of franchises) {
    const cur = franchiseCounts.get(f.slug);
    franchiseCounts.set(f.slug, { name: cur?.name ?? f.name, count: (cur?.count ?? 0) + f.count });
  }

  const buckets: Record<(typeof PLAN_PATTERN)[number], PlanRow[]> = {
    franchise: shuffle(
      [...franchiseCounts.entries()]
        .filter(([, f]) => f.count >= HOME_MIN_ROW_TITLES)
        .map(([slug, f]): PlanRow => ({ kind: "franchise", id: `franchise:${slug}`, name: f.name })),
      rngFor(seed, "plan:franchise"),
    ),
    genre: shuffle(
      genres.filter((g) => g.count >= HOME_MIN_ROW_TITLES).map((g): PlanRow => ({ kind: "genre", id: `genre:${g.slug}`, name: g.name, count: g.count })),
      rngFor(seed, "plan:genre"),
    ),
    collection: shuffle(
      sets.filter((s) => s.count >= MIN_COLLECTION_MEMBERS).map((s): PlanRow => ({ kind: "collection", id: `collection:${slugify(s.name)}`, set: s })),
      rngFor(seed, "plan:collection"),
    ),
    extra: shuffle(extraRows(), rngFor(seed, "plan:extra")),
  };

  const plan: PlanRow[] = [];
  const seen = new Set<string>();
  while (PLAN_PATTERN.some((k) => buckets[k].length > 0)) {
    for (const kind of PLAN_PATTERN) {
      const next = buckets[kind].shift();
      if (next && !seen.has(next.id)) {
        seen.add(next.id);
        plan.push(next);
      }
    }
  }
  return plan;
}

async function fetchPlanRowTitles(row: PlanRow, seed: number): Promise<TitleCardRow[]> {
  const rand = rngFor(seed, row.id);
  switch (row.kind) {
    case "franchise":
      // Whole franchise in release order (it's a set worth seeing complete), capped.
      return listTitlesByFranchise(row.name, { limit: FRANCHISE_ROW_LIMIT, excludeCollectionHeaders: true });
    case "genre": {
      // Big genres (540 comedies) show a random slice so repeat visits see different titles.
      const offset = Math.floor(rand() * Math.max(0, row.count - ROW_LIMIT * 1.5));
      return listTitlesByGenre(row.name, { limit: ROW_LIMIT, offset, excludeCollectionHeaders: true });
    }
    case "collection":
      return listCollectionMembers(row.set.name, { limit: 60, excludeCollectionHeaders: true });
    case "decade":
      return windowedRows(
        `decade ${row.decade}`,
        (q) => q.gte("release_date", `${row.decade}-01-01`).lt("release_date", `${row.decade + 10}-01-01`),
        byReleaseAsc,
        rand,
      );
    case "facet":
      return windowedRows(row.id, row.filter, byTitle, rand);
  }
}

function planRowHeader(row: PlanRow): Omit<HomeRowData, "cards"> {
  switch (row.kind) {
    case "franchise":
      return { id: row.id, title: row.name, label: "Franchise", href: franchiseHref(row.name), hrefLabel: "Franchise page" };
    case "genre":
      return { id: row.id, title: row.name, label: "Genre", href: null };
    case "collection": {
      const title = shortCollectionName(row.set.name);
      return {
        id: row.id,
        title,
        fullTitle: title !== row.set.name ? row.set.name : undefined,
        label: "Box Set",
        href: row.set.headerId ? collectionHref(row.set.headerId) : null,
        hrefLabel: "View set",
      };
    }
    case "decade":
      return { id: row.id, title: `The ${row.decade}s`, label: "Decade", href: null };
    case "facet":
      return { id: row.id, title: row.title, label: row.label, href: null };
  }
}

/**
 * Rows from the plan starting at `cursor`. Rows with too few titles are skipped (and more plan
 * entries tried, up to a bound) so a batch is usually full. `nextCursor` is null at the end.
 */
export async function loadHomePlanRows(
  seed: number,
  cursor: number,
  want: number,
): Promise<{ rows: HomeRowData[]; nextCursor: number | null }> {
  const plan = await buildHomePlan(seed);
  const rows: HomeRowData[] = [];
  let pos = Math.max(0, cursor);
  // Fetch in small parallel waves; at most 3 waves so one request stays cheap.
  for (let wave = 0; wave < 3 && rows.length < want && pos < plan.length; wave++) {
    const slice = plan.slice(pos, pos + (want - rows.length));
    pos += slice.length;
    const titleLists = await Promise.all(slice.map((r) => fetchPlanRowTitles(r, seed)));
    const keep = slice
      .map((r, i) => ({ r, titles: titleLists[i] }))
      .filter(({ r, titles }) => titles.length >= (r.kind === "collection" ? MIN_COLLECTION_MEMBERS : HOME_MIN_ROW_TITLES));
    const cardGroups = await toCardGroups(keep.map((k) => k.titles));
    keep.forEach(({ r }, i) => {
      if (cardGroups[i].length > 0) rows.push({ ...planRowHeader(r), cards: cardGroups[i] });
    });
  }
  return { rows, nextCursor: pos < plan.length ? pos : null };
}

// ---------------------------------------------------------------------------------------------
// The fixed head of the page
// ---------------------------------------------------------------------------------------------

/** "Weird and Wonderful" (rebuilt 2026-10-06, the user's request): titles on the 366 Weird
 * Movies lists - the Canon, Apocrypha and Apocrypha Candidates - plus ones judged comparably
 * weird by hand, all via titles.weird_tag (migration 0049, scripts/src/import-weird-movie-list.ts).
 * Replaces the old rule-based pick (rare genres, puppetry, 3D discs). */
async function listWeirdAndWonderful(seed: number): Promise<TitleCardRow[]> {
  const supabase = getCatalogClient();
  if (!supabase) return [];
  const { data, error } = await cardQuery(supabase).not("weird_tag", "is", null).order("unique_id").limit(200);
  reportQueryError("weird", error);
  return shuffle((data ?? []) as unknown as TitleCardRow[], rngFor(seed, "weird")).slice(0, 36);
}

/** Newest releases up to today (release_date has a few typo'd far-future years, e.g. 2946).
 * Titled "This Year" only when this year alone fills a row - otherwise "New Releases". */
async function listNewReleases(): Promise<{ rows: TitleCardRow[]; title: string; label: string }> {
  const supabase = getCatalogClient();
  const year = new Date().getFullYear();
  if (!supabase) return { rows: [], title: "New Releases", label: String(year) };
  const { data, error } = await cardQuery(supabase)
    .lte("release_date", todayIso())
    .order("release_date", { ascending: false })
    .order("unique_id")
    .limit(24);
  reportQueryError("listNewReleases", error);
  const rows = (data ?? []) as unknown as TitleCardRow[];
  const thisYear = rows.filter((r) => yearOf(r.release_date) === String(year)).length;
  const oldest = yearOf(rows.at(-1)?.release_date);
  return thisYear >= HOME_MIN_ROW_TITLES
    ? { rows: rows.filter((r) => yearOf(r.release_date) === String(year)), title: "New This Year", label: String(year) }
    : { rows, title: "New Releases", label: oldest && oldest !== String(year) ? `${oldest}-${year}` : String(year) };
}

export async function loadHomeHeadRows(seed: number): Promise<HomeRowData[]> {
  const [recent, fresh, classics, tv, mini, weird] = await Promise.all([
    // Box-set members are left out here (the set itself shows) so one new box set doesn't
    // fill the whole row with its own discs.
    listRecentlyAdded({ limit: 24, excludeCollectionMembers: true }),
    listNewReleases(),
    windowedRows("classics", (q) => q.lt("release_date", "1970-01-01").in("movie_or_tv", ["Movie", "TV Movie"]), byReleaseAsc, rngFor(seed, "classics")),
    // Separate rows for series and mini-series (the user, 2026-10-06).
    windowedRows("tv", (q) => q.eq("movie_or_tv", "TV Series"), byTitle, rngFor(seed, "tv")),
    windowedRows("miniseries", (q) => q.eq("movie_or_tv", "TV Mini-Series"), byTitle, rngFor(seed, "miniseries")),
    listWeirdAndWonderful(seed),
  ]);
  const [recentCards, freshCards, classicCards, tvCards, miniCards, weirdCards] = await toCardGroups([recent, fresh.rows, classics, tv, mini, weird]);

  const rows: HomeRowData[] = [
    { id: "head:recent", title: "Recently Added", label: "New In", href: null, cards: recentCards },
    { id: "head:new", title: fresh.title, label: fresh.label, href: null, cards: freshCards },
    { id: "head:classics", title: "Classics", label: "Pre-1970", href: null, cards: classicCards },
    { id: "head:tv", title: "TV Series", label: "TV", href: null, cards: tvCards },
    { id: "head:mini", title: "TV Mini-Series", label: "TV", href: null, cards: miniCards },
    { id: "head:weird", title: "Weird and Wonderful", label: "Oddities", href: null, cards: weirdCards },
  ];
  return rows.filter((r) => r.cards.length > 0);
}

// ---------------------------------------------------------------------------------------------
// Hero
// ---------------------------------------------------------------------------------------------

export interface HomeFeature {
  href: string;
  workHref: string | null;
  title: string;
  year: string | null;
  format: string | null;
  kind: string;
  runtimeMins: number | null;
  rating: string | null;
  genres: string[];
  directors: string[];
  overview: string | null;
  tagline: string | null;
  poster: CatalogImage | null;
  backdrop: CatalogImage | null;
}

export interface ArchiveStats {
  total: number;
  boxSets: number;
  dvd: number;
  bluray: number;
  uhd: number;
  tv: number;
}

/** A random title that has real artwork (only ~200 of 3,000 rows do until the TMDb backfill
 * lands), so the hero never opens on a placeholder. */
export async function loadHomeFeature(seed: number): Promise<HomeFeature | null> {
  const supabase = getCatalogClient();
  if (!supabase) return null;
  const { data, error } = await supabase
    .from("titles")
    .select("unique_id")
    .eq("scanned", true)
    .eq("is_collection", false)
    // A scanned film with art (it's shown as a Film/TV entry, so it needs an IMDb id).
    .not("imdb_page", "is", null)
    .or("case_image_path.not.is.null,movie_poster_path.not.is.null")
    .order("unique_id")
    .limit(500);
  reportQueryError("loadHomeFeature", error);
  const ids = ((data ?? []) as Array<{ unique_id: string }>).map((r) => r.unique_id);
  if (ids.length === 0) return null;

  const disc = await getDisc(ids[Math.floor(rngFor(seed, "hero")() * ids.length)]);
  if (!disc) return null;
  const { row, metadata } = disc;
  return {
    // Film/TV entry first, like the rest of the home page (DVD pages hang off that page).
    href: disc.imdbId ? workHref(disc.imdbId) : discHref(row.unique_id),
    workHref: disc.imdbId ? workHref(disc.imdbId) : null,
    title: metadata?.title ?? displayTitle(row),
    year: yearOf(row.release_date) ?? yearOf(metadata?.release_date),
    format: shortFormatLabel(row.format),
    kind: row.movie_or_tv,
    runtimeMins: row.running_time_mins ?? metadata?.runtime_mins ?? null,
    rating: row.rating,
    genres: (row.genre.length > 0 ? row.genre : (metadata?.genres ?? [])).slice(0, 4),
    directors: row.director.slice(0, 2),
    overview: metadata?.overview ?? null,
    tagline: metadata?.tagline ?? null,
    poster: tmdbImage(metadata?.poster_path, "w500") ?? disc.poster,
    backdrop: tmdbImage(metadata?.backdrop_path, "w1280"),
  };
}

export async function loadArchiveStats(): Promise<ArchiveStats | null> {
  const supabase = getCatalogClient();
  if (!supabase) return null;
  const count = async (context: string, filter: (q: CardQuery) => CardQuery, headers = false) => {
    let q = supabase.from("titles").select("unique_id", { count: "exact", head: true }).eq("scanned", true) as unknown as CardQuery;
    q = headers ? q.eq("is_collection", true) : q.eq("is_collection", false);
    const { count: n, error } = await filter(q);
    reportQueryError(`stats ${context}`, error);
    return n ?? 0;
  };
  const [total, boxSets, dvd, bluray, uhd, tv] = await Promise.all([
    count("total", (q) => q),
    count("box sets", (q) => q, true),
    count("dvd", (q) => q.ilike("format", "DVD%")),
    count("blu-ray", (q) => q.ilike("format", "Blu-Ray%")),
    count("4k", (q) => q.ilike("format", "4K%")),
    count("tv", (q) => q.in("movie_or_tv", ["TV Series", "TV Mini-Series"])),
  ]);
  if (total === 0) return null;
  return { total, boxSets, dvd, bluray, uhd, tv };
}
