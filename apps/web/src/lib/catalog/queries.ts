import "server-only";
import { cache } from "react";
import { extractImdbIdFromPage } from "@danflix/shared";
import type { SupabaseClient } from "@supabase/supabase-js";
import { escapeLike, getCatalogClient, PAGE_SIZE, reportQueryError } from "./client";
import { TITLE_CARD_COLUMNS, TITLE_DETAIL_COLUMNS } from "./columns";
import { collectionHref, discHref, displayTitle, frameAspect, shortFormatLabel, slugify, workHref, yearOf } from "./display";
import { resolveImages, tmdbImage, type TmdbPosterSize } from "./images";
import { getTitleMetadataMap, isImdbId } from "./metadata";
import type {
  Collection,
  Disc,
  FacetValue,
  ListOptions,
  PosterCardData,
  TitleCardRow,
  TitleDetailRow,
  Work,
} from "./types";

/**
 * Query layer for `titles`. Every read selects an explicit column list (columns.ts), and every
 * function returns an empty list / null on failure instead of throwing, so one bad query
 * degrades a row or section rather than the whole page.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUniqueId = (value: string) => UUID_RE.test(value);

const DEFAULT_ROW_LIMIT = 30;
const MAX_LIMIT = 200;

// supabase-js's .overlaps() doesn't quote array elements, which breaks on names containing
// commas/spaces/quotes - so the Postgres array literal is built here instead.
function pgArrayLiteral(values: string[]): string {
  return `{${values.map((v) => `"${v.replace(/["\\]/g, (c) => `\\${c}`)}"`).join(",")}}`;
}

/** Card-column select on titles with ListOptions' collection filters applied. */
function cardListQuery(supabase: SupabaseClient, opts: ListOptions) {
  let q = supabase.from("titles").select(TITLE_CARD_COLUMNS).eq("scanned", true);
  if (opts.excludeCollectionHeaders) q = q.eq("is_collection", false);
  if (opts.excludeCollectionMembers) q = q.eq("title_in_a_collection", false);
  return q;
}

/** [from, to] for .range(), clamped so a caller can't ask for the whole table at once. */
function rangeOf(opts: ListOptions, defaultLimit = DEFAULT_ROW_LIMIT): [number, number] {
  const limit = Math.min(Math.max(opts.limit ?? defaultLimit, 1), MAX_LIMIT);
  const offset = Math.max(opts.offset ?? 0, 0);
  return [offset, offset + limit - 1];
}

// ---------------------------------------------------------------------------------------------
// Row lists (browse rows, franchise/genre/collection lists)
// ---------------------------------------------------------------------------------------------

/**
 * Most recently added first. `date_added` is only populated for rows confirmed through the
 * scanner (~33 of 3,090 as of 2026-10-06); older Sheet-synced rows have null and their
 * `last_updated` is a bulk-sync timestamp, so ordering is date_added desc (nulls last), then
 * last_updated desc as a stable-ish tiebreak.
 */
export async function listRecentlyAdded(opts: ListOptions = {}): Promise<TitleCardRow[]> {
  const supabase = getCatalogClient();
  if (!supabase) return [];
  const query = cardListQuery(supabase, opts)
    .order("date_added", { ascending: false, nullsFirst: false })
    .order("last_updated", { ascending: false })
    .order("unique_id");
  const { data, error } = await query.range(...rangeOf(opts));
  reportQueryError("listRecentlyAdded", error);
  return (data ?? []) as unknown as TitleCardRow[];
}

/** Distinct values of a text[] column across the whole collection, with counts. Cached in
 * memory for a few minutes - it pages through every row, so it shouldn't run per request. */
const FACET_TTL_MS = 5 * 60_000;
const facetCache = new Map<string, { at: number; values: FacetValue[] }>();

async function listFacet(column: "franchise" | "genre"): Promise<FacetValue[]> {
  const cached = facetCache.get(column);
  if (cached && Date.now() - cached.at < FACET_TTL_MS) return cached.values;
  const supabase = getCatalogClient();
  if (!supabase) return [];

  const counts = new Map<string, number>();
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from("titles")
      .select(column)
      .eq("scanned", true)
      .order("unique_id")
      .range(from, from + PAGE_SIZE - 1);
    if (error) {
      reportQueryError(`listFacet(${column})`, error);
      return cached?.values ?? [];
    }
    for (const row of (data ?? []) as unknown as Array<Record<string, string[] | null>>) {
      for (const value of row[column] ?? []) {
        const name = value.trim();
        if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
      }
    }
    if (!data || data.length < PAGE_SIZE) break;
  }
  const values = [...counts.entries()]
    .map(([name, count]) => ({ name, slug: slugify(name), count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  facetCache.set(column, { at: Date.now(), values });
  return values;
}

/** Every franchise with its row count, most-populated first. */
export const listFranchises = () => listFacet("franchise");
/** Every genre with its row count, most-populated first. */
export const listGenres = () => listFacet("genre");

/** All stored spellings matching a name or slug case-insensitively ("star wars" also finds
 * "Star Wars"), so a franchise/genre lookup isn't defeated by inconsistent capitalisation. */
async function resolveFacetVariants(column: "franchise" | "genre", nameOrSlug: string): Promise<FacetValue[]> {
  const needle = nameOrSlug.trim().toLowerCase();
  const slug = slugify(nameOrSlug);
  if (!needle) return [];
  return (await listFacet(column)).filter((f) => f.name.toLowerCase() === needle || f.slug === slug);
}

/** Resolves a /franchise/[slug] segment (or a plain name) to its display name, or null. */
export async function findFranchise(nameOrSlug: string): Promise<FacetValue | null> {
  const variants = await resolveFacetVariants("franchise", nameOrSlug);
  if (variants.length === 0) return null;
  return { ...variants[0], count: variants.reduce((n, v) => n + v.count, 0) };
}

async function listByArrayFacet(column: "franchise" | "genre", nameOrSlug: string, opts: ListOptions): Promise<TitleCardRow[]> {
  const supabase = getCatalogClient();
  const variants = await resolveFacetVariants(column, nameOrSlug);
  if (!supabase || variants.length === 0) return [];
  const query = cardListQuery(supabase, opts)
    .filter(column, "ov", pgArrayLiteral(variants.map((v) => v.name)))
    .order("release_date", { ascending: true, nullsFirst: false })
    .order("title")
    .order("unique_id");
  const { data, error } = await query.range(...rangeOf(opts));
  reportQueryError(`listBy(${column})`, error);
  return (data ?? []) as unknown as TitleCardRow[];
}

/** Rows whose franchise array contains the name (case-insensitive), oldest release first. */
export const listTitlesByFranchise = (nameOrSlug: string, opts: ListOptions = {}) => listByArrayFacet("franchise", nameOrSlug, opts);
/** Rows whose genre array contains the name (case-insensitive), oldest release first. */
export const listTitlesByGenre = (nameOrSlug: string, opts: ListOptions = {}) => listByArrayFacet("genre", nameOrSlug, opts);

/** The titles inside a box set (not the set itself) - for "specific DVD Collection" rows.
 * Matches name_of_collection case-insensitively but otherwise exactly (wildcards escaped). */
export async function listCollectionMembers(nameOfCollection: string, opts: ListOptions = {}): Promise<TitleCardRow[]> {
  const supabase = getCatalogClient();
  if (!supabase || !nameOfCollection.trim()) return [];
  const query = cardListQuery(supabase, opts)
    .eq("title_in_a_collection", true)
    .ilike("name_of_collection", escapeLike(nameOfCollection))
    .order("release_date", { ascending: true, nullsFirst: false })
    .order("title")
    .order("unique_id");
  const { data, error } = await query.range(...rangeOf(opts, MAX_LIMIT));
  reportQueryError("listCollectionMembers", error);
  return (data ?? []) as unknown as TitleCardRow[];
}

// ---------------------------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------------------------

/** Where a physical row links: a box-set header goes to its Collection page, anything else to
 * its DVD page. */
export function rowHref(row: Pick<TitleCardRow, "unique_id" | "is_collection">): string {
  return row.is_collection ? collectionHref(row.unique_id) : discHref(row.unique_id);
}

/** Turns rows into PosterCardData with images resolved in one batch (metadata posters
 * included once title_metadata exists). `asWork` makes each card stand for the film rather than
 * the disc - the home page's rows (the user, 2026-10-06: the home page shows Film/TV entries
 * only, DVD pages are reached through search or a Film/TV page): it links to the Movie/TV Page,
 * shows the film's TMDb poster ahead of the case photo, drops the disc format badge, and is
 * keyed `w:<imdbId>` so copies of one film collapse to one card. A row with no IMDb id gets no
 * card at all in this mode (filter out the nulls). */
export async function toPosterCards(
  rows: TitleCardRow[],
  posterSize: TmdbPosterSize = "w342",
  { asWork = false }: { asWork?: boolean } = {},
): Promise<PosterCardData[]> {
  if (rows.length === 0) return [];
  const imdbIds = new Map(rows.map((r) => [r.unique_id, extractImdbIdFromPage(r.imdb_page)]));
  const metadata = await getTitleMetadataMap([...imdbIds.values()]);
  const images = await resolveImages(rows, (r) => metadata.get(imdbIds.get(r.unique_id) ?? ""), posterSize);
  return rows.map((row) => {
    const imdbId = imdbIds.get(row.unique_id) ?? null;
    const meta = imdbId ? metadata.get(imdbId) : undefined;
    const year = yearOf(row.release_date) ?? yearOf(meta?.release_date);
    if (asWork) {
      const image = tmdbImage(meta?.poster_path, posterSize) ?? images.get(row.unique_id)?.poster ?? null;
      return {
        key: imdbId ? `w:${imdbId}` : row.unique_id,
        href: imdbId ? workHref(imdbId) : "",
        title: meta?.title ?? displayTitle(row),
        year,
        format: null,
        image,
        aspect: frameAspect(image, row.format),
      };
    }
    const image = images.get(row.unique_id)?.poster ?? null;
    return {
      key: row.unique_id,
      href: rowHref(row),
      title: displayTitle(row),
      year,
      format: shortFormatLabel(row.format),
      image,
      aspect: frameAspect(image, row.format),
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Pages: DVD, Collection, Movie/TV (Work)
// ---------------------------------------------------------------------------------------------

async function toDiscs(rows: TitleDetailRow[], posterSize: TmdbPosterSize = "w500"): Promise<Disc[]> {
  if (rows.length === 0) return [];
  const imdbIds = new Map(rows.map((r) => [r.unique_id, extractImdbIdFromPage(r.imdb_page)]));
  const metadata = await getTitleMetadataMap([...imdbIds.values()]);
  const images = await resolveImages(rows, (r) => metadata.get(imdbIds.get(r.unique_id) ?? ""), posterSize);
  return rows.map((row) => {
    const imdbId = imdbIds.get(row.unique_id) ?? null;
    const resolved = images.get(row.unique_id);
    return {
      row,
      imdbId,
      metadata: imdbId ? (metadata.get(imdbId) ?? null) : null,
      poster: resolved?.poster ?? null,
      caseImage: resolved?.caseImage ?? null,
      collection: null,
    };
  });
}

/** The box-set header row for a collection name, if one exists. */
async function findCollectionHeader(nameOfCollection: string): Promise<{ uniqueId: string; title: string } | null> {
  const supabase = getCatalogClient();
  if (!supabase || !nameOfCollection.trim()) return null;
  const { data, error } = await supabase
    .from("titles")
    .select("unique_id,title,release_name")
    .eq("scanned", true)
    .eq("is_collection", true)
    .ilike("name_of_collection", escapeLike(nameOfCollection))
    .limit(1)
    .maybeSingle();
  reportQueryError("findCollectionHeader", error);
  if (!data) return null;
  const row = data as unknown as { unique_id: string; title: string; release_name: string | null };
  return { uniqueId: row.unique_id, title: displayTitle(row) };
}

/** One physical item for its DVD Page, or null (bad id / not found -> the page 404s).
 * Wrapped in React cache() so generateMetadata and the page share one fetch. */
export const getDisc = cache(async (uniqueId: string): Promise<Disc | null> => {
  const supabase = getCatalogClient();
  if (!supabase || !isUniqueId(uniqueId)) return null;
  const { data, error } = await supabase.from("titles").select(TITLE_DETAIL_COLUMNS).eq("scanned", true).eq("unique_id", uniqueId).maybeSingle();
  reportQueryError("getDisc", error);
  if (!data) return null;
  const [disc] = await toDiscs([data as unknown as TitleDetailRow]);
  if (disc.row.title_in_a_collection && disc.row.name_of_collection) {
    disc.collection = await findCollectionHeader(disc.row.name_of_collection);
  }
  return disc;
});

/** A box set (is_collection = true) and its member titles, or null if the id isn't a box set. */
export const getCollection = cache(async (uniqueId: string): Promise<Collection | null> => {
  const supabase = getCatalogClient();
  if (!supabase || !isUniqueId(uniqueId)) return null;
  const { data, error } = await supabase
    .from("titles")
    .select(TITLE_DETAIL_COLUMNS)
    .eq("scanned", true)
    .eq("unique_id", uniqueId)
    .eq("is_collection", true)
    .maybeSingle();
  reportQueryError("getCollection", error);
  if (!data) return null;
  const headerRow = data as unknown as TitleDetailRow;

  let memberRows: TitleDetailRow[] = [];
  if (headerRow.name_of_collection) {
    const res = await supabase
      .from("titles")
      .select(TITLE_DETAIL_COLUMNS)
      .eq("scanned", true)
      .eq("title_in_a_collection", true)
      .neq("unique_id", uniqueId)
      .ilike("name_of_collection", escapeLike(headerRow.name_of_collection))
      .order("release_date", { ascending: true, nullsFirst: false })
      .order("title")
      .limit(MAX_LIMIT);
    reportQueryError("getCollection members", res.error);
    memberRows = (res.data ?? []) as unknown as TitleDetailRow[];
  }

  const [header, ...members] = await toDiscs([headerRow, ...memberRows]);
  const link = { uniqueId: header.row.unique_id, title: displayTitle(header.row) };
  for (const m of members) m.collection = link;
  return { header, members };
});

/** A film/series (Movie/TV Page): every physical row sharing this IMDb id, plus metadata when
 * 0043 is populated. Null when no owned row carries the id. */
export const getWork = cache(async (imdbId: string): Promise<Work | null> => {
  const supabase = getCatalogClient();
  if (!supabase || !isImdbId(imdbId)) return null;
  // imdb_page holds a full URL; the ilike narrows candidates and the exact id check below
  // stops tt123 from also matching tt1234.
  const { data, error } = await supabase
    .from("titles")
    .select(TITLE_DETAIL_COLUMNS)
    .eq("scanned", true)
    .ilike("imdb_page", `%/title/${imdbId}%`)
    .order("is_collection")
    .order("format")
    .limit(MAX_LIMIT);
  reportQueryError("getWork", error);
  const rows = ((data ?? []) as unknown as TitleDetailRow[]).filter((r) => extractImdbIdFromPage(r.imdb_page) === imdbId);
  if (rows.length === 0) return null;

  const items = await toDiscs(rows);
  // Members of a box set link back to their set.
  const setNames = [...new Set(items.filter((d) => d.row.title_in_a_collection && d.row.name_of_collection).map((d) => d.row.name_of_collection!))];
  const headers = await Promise.all(setNames.map(async (name) => [name, await findCollectionHeader(name)] as const));
  const headerByName = new Map(headers);
  for (const d of items) if (d.row.name_of_collection) d.collection = headerByName.get(d.row.name_of_collection) ?? null;

  const metadata = items[0].metadata;
  // Prefer a standalone (non-box-set) row's own title over a set header's long name.
  const primary = items.find((d) => !d.row.is_collection) ?? items[0];
  return {
    imdbId,
    title: metadata?.title ?? primary.row.title,
    metadata,
    poster: tmdbImage(metadata?.poster_path, "w500") ?? items.find((d) => d.poster?.source === "movie_poster")?.poster ?? primary.poster,
    backdrop: tmdbImage(metadata?.backdrop_path, "w1280"),
    items,
  };
});
