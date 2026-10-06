import "server-only";
import { cache } from "react";
import { extractImdbIdFromPage } from "@danflix/shared";
import { escapeLike, getCatalogClient, isMissingTableError, PAGE_SIZE, reportQueryError } from "./client";
import { PERSON_COLUMNS, TITLE_CARD_COLUMNS } from "./columns";
import { discHref, shortFormatLabel, slugify, workHref } from "./display";
import { tmdbImage } from "./images";
import { listFranchises, toPosterCards } from "./queries";
import type { CatalogImage, FacetValue, Person, PosterCardData, TitleCardRow } from "./types";

/**
 * Queries for the Cast/Crew/Franchise pages (WEB APP DESIGN.md "Cast/Crew/Franchise Pages"):
 * - /franchise/[slug]  - every row whose `franchise` array holds the name (works today).
 * - /people/[slug]     - every row whose `director` array holds the name (works today; the
 *                        bridge for director links before 0043's people table is filled).
 * - /person/[id]       - every owned title a TMDb person is credited on via title_credits
 *                        (empty/"not available" until 0043 is applied and backfilled).
 * Each page gets two tabs: one card per film ("Films & TV") and one per physical row
 * ("Discs & Collections").
 */

/** Hard ceiling on rows one page will list - far above today's biggest franchise (56). */
const MAX_PAGE_ROWS = 2000;

export interface ConnectedTab {
  id: "works" | "discs";
  label: string;
  cards: PosterCardData[];
}

export interface ConnectionSummary {
  works: number;
  /** Physical rows that aren't box-set headers. */
  discs: number;
  boxSets: number;
  firstYear: string | null;
  lastYear: string | null;
  /** Format counts over standalone items + box sets (members are counted via their set). */
  formats: Array<{ label: string; count: number }>;
}

export interface Connections {
  tabs: ConnectedTab[];
  summary: ConnectionSummary;
  /** First film card (oldest release) with art - the franchise's stand-in emblem. */
  leadImage: CatalogImage | null;
}

// ---------------------------------------------------------------------------------------------
// Row fetching
// ---------------------------------------------------------------------------------------------

// Same quoting as queries.ts: supabase-js's .overlaps() doesn't quote elements, which breaks on
// names with commas/spaces/quotes.
function pgArrayLiteral(values: string[]): string {
  return `{${values.map((v) => `"${v.replace(/["\\]/g, (c) => `\\${c}`)}"`).join(",")}}`;
}

/** Every card-column row whose text[] `column` overlaps `names`, paged past PostgREST's
 * 1,000-row cap. */
async function listRowsByArray(column: "franchise" | "director", names: string[]): Promise<TitleCardRow[]> {
  const supabase = getCatalogClient();
  if (!supabase || names.length === 0) return [];
  const rows: TitleCardRow[] = [];
  for (let from = 0; from < MAX_PAGE_ROWS; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from("titles")
      .select(TITLE_CARD_COLUMNS)
      .eq("scanned", true)
      .filter(column, "ov", pgArrayLiteral(names))
      .order("unique_id")
      .range(from, from + PAGE_SIZE - 1);
    if (error) {
      reportQueryError(`listRowsByArray(${column})`, error);
      break;
    }
    rows.push(...((data ?? []) as unknown as TitleCardRow[]));
    if (!data || data.length < PAGE_SIZE) break;
  }
  return rows;
}

/** Box-set headers for any listed members whose set isn't already in the list, so a page
 * connected to a film inside a set also links the set itself. */
async function withCollectionHeaders(rows: TitleCardRow[]): Promise<TitleCardRow[]> {
  const supabase = getCatalogClient();
  const have = new Set(rows.filter((r) => r.is_collection && r.name_of_collection).map((r) => r.name_of_collection!.toLowerCase()));
  const missing = [
    ...new Set(rows.filter((r) => r.title_in_a_collection && r.name_of_collection && !have.has(r.name_of_collection.toLowerCase())).map((r) => r.name_of_collection!)),
  ];
  if (!supabase || missing.length === 0) return rows;
  const { data, error } = await supabase
    .from("titles")
    .select(TITLE_CARD_COLUMNS)
    .eq("scanned", true)
    .eq("is_collection", true)
    .in("name_of_collection", missing.slice(0, 100))
    .limit(200);
  reportQueryError("withCollectionHeaders", error);
  const ids = new Set(rows.map((r) => r.unique_id));
  return [...rows, ...((data ?? []) as unknown as TitleCardRow[]).filter((r) => !ids.has(r.unique_id))];
}

// ---------------------------------------------------------------------------------------------
// Rows -> tabs
// ---------------------------------------------------------------------------------------------

/** Oldest release first, undated last, then title - matches the franchise rows elsewhere. */
function compareRows(a: TitleCardRow, b: TitleCardRow): number {
  const da = a.release_date ?? "9999";
  const db = b.release_date ?? "9999";
  return da.localeCompare(db) || a.title.localeCompare(b.title) || a.unique_id.localeCompare(b.unique_id);
}

function formatBadge(rows: TitleCardRow[]): string | null {
  const labels = [...new Set(rows.map((r) => shortFormatLabel(r.format)).filter((l): l is string => !!l))];
  if (labels.length <= 2) return labels.join(" + ") || null;
  return `${labels.length} formats`;
}

/**
 * Builds the two tabs from physical rows. Films are grouped by IMDb id (one Movie/TV page per
 * film, however many copies are owned); rows without an IMDb id have no Movie/TV page, so their
 * film card links straight to the DVD page instead. Box-set headers only become film cards
 * when they carry an IMDb id themselves (e.g. a complete-series set).
 */
async function buildConnections(
  inputRows: TitleCardRow[],
  workCaption?: (imdbId: string) => string | null,
): Promise<Connections> {
  const rows = [...inputRows].sort(compareRows);
  // Disc cards (case photo first) for the DVD tab; film-mode cards (TMDb poster first) for the
  // Movie/TV tab - the user, 2026-10-06: film thumbnails were showing a copy's case photo.
  const [cards, filmModeCards] = await Promise.all([toPosterCards(rows), toPosterCards(rows, "w342", { asWork: true })]);
  const cardById = new Map(cards.map((c) => [c.key, c]));
  const filmCardById = new Map(rows.map((r, i) => [r.unique_id, filmModeCards[i]]));

  const groups = new Map<string, { imdbId: string | null; rows: TitleCardRow[] }>();
  for (const row of rows) {
    const imdbId = extractImdbIdFromPage(row.imdb_page);
    if (!imdbId && row.is_collection) continue;
    // No IMDb id: copies of the same title/year still collapse into one card.
    const key = imdbId ?? `t:${slugify(row.title)}:${row.release_date?.slice(0, 4) ?? ""}`;
    const group = groups.get(key) ?? { imdbId, rows: [] };
    group.rows.push(row);
    groups.set(key, group);
  }

  const workCards: PosterCardData[] = [];
  for (const [key, group] of groups) {
    // A standalone copy's art beats a box-set header's; first one that has art wins.
    const ordered = [...group.rows.filter((r) => !r.is_collection), ...group.rows.filter((r) => r.is_collection)];
    const rep = ordered.find((r) => cardById.get(r.unique_id)?.image) ?? ordered[0];
    const repCard = cardById.get(rep.unique_id)!;
    const copies = group.rows.length;
    workCards.push({
      key: `w:${key}`,
      href: group.imdbId ? workHref(group.imdbId) : discHref(rep.unique_id),
      title: rep.title,
      year: repCard.year,
      format: formatBadge(group.rows),
      image: filmCardById.get(rep.unique_id)?.image ?? repCard.image,
      aspect: filmCardById.get(rep.unique_id)?.aspect ?? repCard.aspect,
      caption: (group.imdbId && workCaption?.(group.imdbId)) || (copies > 1 ? `${copies} copies` : null),
    });
  }

  const discCards: PosterCardData[] = rows.map((row) => ({
    ...cardById.get(row.unique_id)!,
    caption: row.is_collection ? "Box set" : row.title_in_a_collection ? "In a box set" : null,
  }));

  const years = cards.map((c) => c.year).filter((y): y is string => !!y).sort();
  const formatCounts = new Map<string, number>();
  for (const row of rows) {
    if (row.title_in_a_collection) continue;
    const label = shortFormatLabel(row.format);
    if (label) formatCounts.set(label, (formatCounts.get(label) ?? 0) + 1);
  }

  return {
    tabs: [
      { id: "works", label: "Films & TV", cards: workCards },
      { id: "discs", label: "Discs & Collections", cards: discCards },
    ],
    summary: {
      works: workCards.length,
      discs: rows.filter((r) => !r.is_collection).length,
      boxSets: rows.filter((r) => r.is_collection).length,
      firstYear: years[0] ?? null,
      lastYear: years.at(-1) ?? null,
      formats: [...formatCounts.entries()].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count),
    },
    leadImage: workCards.find((c) => c.image)?.image ?? null,
  };
}

/** Plain-English description derived from the collection itself (franchises and pre-metadata
 * directors have no stored blurb). */
export function describeConnections(summary: ConnectionSummary, subject: string): string {
  const parts: string[] = [];
  const span =
    summary.firstYear && summary.lastYear
      ? summary.firstYear === summary.lastYear
        ? ` from ${summary.firstYear}`
        : ` spanning ${summary.firstYear}\u2013${summary.lastYear}`
      : "";
  parts.push(`${summary.works} ${summary.works === 1 ? "film or series" : "films and series"} ${subject}${span}.`);
  const physical = [`${summary.discs} physical ${summary.discs === 1 ? "release" : "releases"}`];
  if (summary.boxSets > 0) physical.push(`${summary.boxSets} ${summary.boxSets === 1 ? "box set" : "box sets"}`);
  parts.push(`The shelf holds ${physical.join(" and ")}.`);
  return parts.join(" ");
}

// ---------------------------------------------------------------------------------------------
// Franchise pages
// ---------------------------------------------------------------------------------------------

export interface FranchisePage extends Connections {
  name: string;
  slug: string;
}

/** Every stored spelling of a franchise matching the slug/name (case-insensitive), so
 * "Star Wars" and "star wars" rows land on one page. */
async function franchiseVariants(nameOrSlug: string): Promise<FacetValue[]> {
  const needle = nameOrSlug.trim().toLowerCase();
  const slug = slugify(nameOrSlug);
  if (!needle || !slug) return [];
  return (await listFranchises()).filter((f) => f.slug === slug || f.name.toLowerCase() === needle);
}

/** URL params may arrive percent-encoded; a malformed escape is just "not found", not a 500. */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return "";
  }
}

export const getFranchisePage = cache(async (slug: string): Promise<FranchisePage | null> => {
  const variants = await franchiseVariants(safeDecode(slug));
  if (variants.length === 0) return null;
  const rows = await withCollectionHeaders(await listRowsByArray("franchise", variants.map((v) => v.name)));
  if (rows.length === 0) return null;
  // The most-used spelling is the display name (listFranchises sorts by count).
  return { name: variants[0].name, slug: variants[0].slug, ...(await buildConnections(rows)) };
});

// ---------------------------------------------------------------------------------------------
// Director pages by name (/people/[slug]) - from titles.director, no metadata needed
// ---------------------------------------------------------------------------------------------

const DIRECTOR_TTL_MS = 5 * 60_000;
let directorCache: { at: number; values: FacetValue[] } | null = null;

/** Distinct director names with row counts, paged over the whole table and cached in memory
 * for a few minutes (same approach as listFranchises). */
async function listDirectors(): Promise<FacetValue[]> {
  if (directorCache && Date.now() - directorCache.at < DIRECTOR_TTL_MS) return directorCache.values;
  const supabase = getCatalogClient();
  if (!supabase) return [];
  const counts = new Map<string, number>();
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from("titles")
      .select("director")
      .eq("scanned", true)
      .order("unique_id")
      .range(from, from + PAGE_SIZE - 1);
    if (error) {
      reportQueryError("listDirectors", error);
      return directorCache?.values ?? [];
    }
    for (const row of (data ?? []) as unknown as Array<{ director: string[] | null }>) {
      for (const value of row.director ?? []) {
        const name = value.trim();
        if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
      }
    }
    if (!data || data.length < PAGE_SIZE) break;
  }
  const values = [...counts.entries()]
    .map(([name, count]) => ({ name, slug: slugify(name), count }))
    .filter((v) => v.slug)
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  directorCache = { at: Date.now(), values };
  return values;
}

export interface DirectorPage extends Connections {
  name: string;
  slug: string;
  /** The matching `people` row once 0043 is applied/backfilled (photo, biography, and a link
   * to the full /person/[id] page); null before then or when no name matches. */
  person: Person | null;
}

export const getDirectorPage = cache(async (slug: string): Promise<DirectorPage | null> => {
  const key = slugify(safeDecode(slug));
  if (!key) return null;
  const variants = (await listDirectors()).filter((d) => d.slug === key);
  if (variants.length === 0) return null;
  const name = variants[0].name;
  const [rows, person] = await Promise.all([
    listRowsByArray("director", variants.map((v) => v.name)).then(withCollectionHeaders),
    findPersonByName(name),
  ]);
  if (rows.length === 0) return null;
  return { name, slug: key, person, ...(await buildConnections(rows)) };
});

// ---------------------------------------------------------------------------------------------
// Person pages (/person/[tmdbPersonId]) - 0043's people + title_credits
// ---------------------------------------------------------------------------------------------

/** After a "table missing" error, skip 0043 queries for a minute; re-checked after that, so
 * applying the migration needs no restart (mirrors metadata.ts). */
let peopleTablesMissingUntil = 0;
const peopleTablesKnownMissing = () => Date.now() < peopleTablesMissingUntil;
function notePeopleError(context: string, error: Parameters<typeof reportQueryError>[1]): void {
  if (isMissingTableError(error)) peopleTablesMissingUntil = Date.now() + 60_000;
  else reportQueryError(context, error);
}

async function findPersonByName(name: string): Promise<Person | null> {
  const supabase = getCatalogClient();
  if (!supabase || peopleTablesKnownMissing()) return null;
  const { data, error } = await supabase
    .from("people")
    .select(PERSON_COLUMNS)
    .ilike("name", escapeLike(name))
    .order("tmdb_person_id")
    .limit(5);
  if (error) {
    notePeopleError("findPersonByName", error);
    return null;
  }
  const matches = (data ?? []) as unknown as Person[];
  // This lookup serves director pages, so prefer a director when two people share a name.
  return matches.find((p) => p.known_for_department === "Directing") ?? matches[0] ?? null;
}

interface PersonCreditRow {
  imdb_id: string;
  credit_type: "cast" | "crew";
  character: string | null;
  job: string | null;
  credit_order: number | null;
}

export const isTmdbPersonId = (value: string) => /^\d{1,9}$/.test(value);

/** Fills a missing biography/profile from TMDb (read-only, never written back from a page),
 * cached by Next's fetch cache for a week. Any failure just leaves the gaps. */
async function fetchTmdbPerson(tmdbPersonId: number): Promise<Partial<Person> | null> {
  const token = process.env.TMDB_READ_ACCESS_TOKEN;
  if (!token) return null;
  try {
    const res = await fetch(`https://api.themoviedb.org/3/person/${tmdbPersonId}?language=en-US`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      next: { revalidate: 60 * 60 * 24 * 7 },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);
    return {
      biography: str(json.biography),
      profile_path: str(json.profile_path),
      birthday: str(json.birthday),
      deathday: str(json.deathday),
      place_of_birth: str(json.place_of_birth),
      known_for_department: str(json.known_for_department),
    };
  } catch {
    return null;
  }
}

export interface PersonPage extends Connections {
  person: Person;
  profile: CatalogImage | null;
  /** Distinct roles across the owned titles, e.g. ["Actor", "Director"]. */
  roles: string[];
}

export type PersonPageResult = { status: "ok"; page: PersonPage } | { status: "not_found" } | { status: "unavailable" };

export const getPersonPage = cache(async (tmdbPersonId: number): Promise<PersonPageResult> => {
  const supabase = getCatalogClient();
  if (!supabase) return { status: "unavailable" };
  if (!Number.isSafeInteger(tmdbPersonId) || tmdbPersonId <= 0) return { status: "not_found" };
  if (peopleTablesKnownMissing()) return { status: "unavailable" };

  const [personRes, creditsRes] = await Promise.all([
    supabase.from("people").select(PERSON_COLUMNS).eq("tmdb_person_id", tmdbPersonId).maybeSingle(),
    supabase
      .from("title_credits")
      .select("imdb_id,credit_type,character,job,credit_order")
      .eq("tmdb_person_id", tmdbPersonId)
      .order("credit_order", { ascending: true, nullsFirst: false })
      .limit(1000),
  ]);
  if (personRes.error || creditsRes.error) {
    // Missing tables (0043 not applied) or a transient failure: never a 404 for a real person.
    notePeopleError("getPersonPage people", personRes.error);
    notePeopleError("getPersonPage credits", creditsRes.error);
    return { status: "unavailable" };
  }
  const stored = personRes.data as unknown as Person | null;
  if (!stored) return { status: "not_found" };

  let person = stored;
  if (!person.biography || !person.profile_path) {
    const fresh = await fetchTmdbPerson(tmdbPersonId);
    if (fresh) {
      person = {
        ...person,
        biography: person.biography ?? fresh.biography ?? null,
        profile_path: person.profile_path ?? fresh.profile_path ?? null,
        birthday: person.birthday ?? fresh.birthday ?? null,
        deathday: person.deathday ?? fresh.deathday ?? null,
        place_of_birth: person.place_of_birth ?? fresh.place_of_birth ?? null,
        known_for_department: person.known_for_department ?? fresh.known_for_department ?? null,
      };
    }
  }

  const credits = (creditsRes.data ?? []) as unknown as PersonCreditRow[];
  const captions = new Map<string, string[]>();
  const roles = new Set<string>();
  for (const c of credits) {
    const list = captions.get(c.imdb_id) ?? [];
    const label = c.credit_type === "cast" ? (c.character ? `as ${c.character}` : "Cast") : c.job;
    if (label && !list.includes(label)) list.push(label);
    captions.set(c.imdb_id, list);
    roles.add(c.credit_type === "cast" ? "Actor" : (c.job ?? "Crew"));
  }

  const rows = await withCollectionHeaders(await listRowsByImdbIds([...captions.keys()]));
  const connections = await buildConnections(rows, (imdbId) => captions.get(imdbId)?.join(" / ") ?? null);
  return {
    status: "ok",
    page: { person, profile: tmdbImage(person.profile_path, "h632"), roles: [...roles], ...connections },
  };
});

/** Physical rows for a set of IMDb ids. titles has no imdb_id column (it lives inside the
 * imdb_page URL), so candidates are matched with ilike and confirmed by exact extraction. */
async function listRowsByImdbIds(imdbIds: string[]): Promise<TitleCardRow[]> {
  const supabase = getCatalogClient();
  const ids = [...new Set(imdbIds.filter((id) => /^tt\d+$/.test(id)))];
  if (!supabase || ids.length === 0) return [];
  const wanted = new Set(ids);
  const rows: TitleCardRow[] = [];
  for (let i = 0; i < ids.length; i += 40) {
    const filter = ids
      .slice(i, i + 40)
      .map((id) => `imdb_page.ilike.*/title/${id}*`)
      .join(",");
    const { data, error } = await supabase.from("titles").select(TITLE_CARD_COLUMNS).eq("scanned", true).or(filter).limit(MAX_PAGE_ROWS);
    if (error) {
      reportQueryError("listRowsByImdbIds", error);
      continue;
    }
    for (const row of (data ?? []) as unknown as TitleCardRow[]) {
      const id = extractImdbIdFromPage(row.imdb_page);
      if (id && wanted.has(id)) rows.push(row);
    }
  }
  return rows;
}
