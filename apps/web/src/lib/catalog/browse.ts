import "server-only";
import { getCatalogClient, isMissingTableError, reportQueryError } from "./client";
import { personHref } from "./display";
import { tmdbImageUrl } from "./images";
import { listFranchiseTiles, listIndexedFilmIds, searchCatalog, type FranchiseTile, type SearchHit, type SearchKind } from "./search";
import { PEOPLE_ROLES, roleOfCredit, roleSingular, type PeopleRole } from "./roles";

export { PEOPLE_ROLES, type PeopleRole, type FranchiseTile };
import { EMPTY_FILTERS, type SearchFilters } from "./searchFilters";

/**
 * The Browse tabs under the search bar (2026-10-28, the user's request): category pages like a
 * site's nav menu, open to more tabs later. The grids reuse the search index's browse mode
 * (search.ts), so a tab lists exactly what the matching Advanced Search filters would.
 *
 * - On 4K UHD / In HD (renamed from "On HD", the user's call): every Film/TV page with a disc of that format, newest scan first. A film
 *   owned on both formats appears in both (the user's choice: each tab answers "do I have it on
 *   this format?"). "HD" is any Blu-ray that isn't 4K (search's "Blu-ray" format label, which
 *   covers Blu-Ray, Blu-Ray 3D and a Blu-ray custom burn).
 * - Collections: every box set's own page (not the titles inside), newest first.
 * - Franchises: every franchise as a large circle (the oldest film's poster crop, like the
 *   franchise page's own circle), most titles first.
 * - People: everyone credited on the site's films (TMDb cast + key crew), most titles first; a
 *   role tag sorts by how many titles they had in THAT role (the user, 2026-10-28: Patrick
 *   Wilson ranked #2 director on 7 titles overall, though he directed just 1).
 */

export interface BrowseTab {
  slug: string;
  label: string;
  href: string;
}

export const BROWSE_TABS: BrowseTab[] = [
  { slug: "4k", label: "On 4K UHD", href: "/browse/4k" },
  { slug: "hd", label: "In HD", href: "/browse/hd" },
  { slug: "franchises", label: "Franchises", href: "/browse/franchises" },
  { slug: "collections", label: "Collections", href: "/browse/collections" },
  { slug: "people", label: "People", href: "/browse/people" },
];

/** Plenty for every format / franchise in the collection (search.ts caps a group at 2,000). */
const BROWSE_MAX = 2000;

interface GridSpec {
  kind: SearchKind;
  filters: SearchFilters;
}

const GRID_SPECS = {
  "4k": { kind: "film", filters: { ...EMPTY_FILTERS, types: ["film"], facets: { fmt: { "4K UHD": "include" } }, sort: "added", dir: "desc" } },
  hd: { kind: "film", filters: { ...EMPTY_FILTERS, types: ["film"], facets: { fmt: { "Blu-ray": "include" } }, sort: "added", dir: "desc" } },
  collections: { kind: "collection", filters: { ...EMPTY_FILTERS, types: ["collection"], sort: "added", dir: "desc" } },
} satisfies Record<string, GridSpec>;

export type BrowseGridSlug = keyof typeof GRID_SPECS;

/** Every franchise, most titles first - see listFranchiseTiles in search.ts. */
export async function loadBrowseFranchises(): Promise<FranchiseTile[]> {
  return listFranchiseTiles();
}

/** The hits for one grid tab, in the tab's own order. */
export async function loadBrowseGrid(slug: BrowseGridSlug): Promise<SearchHit[]> {
  const spec: GridSpec = GRID_SPECS[slug];
  const results = await searchCatalog("", { perGroup: BROWSE_MAX, posterSize: "w342", filters: spec.filters });
  return results.groups.find((g) => g.kind === spec.kind)?.hits ?? [];
}

// ---------------------------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------------------------

export interface BrowsePerson {
  id: number;
  name: string;
  href: string;
  imageSrc: string | null;
  /** How many of the site's films/shows they're credited on. */
  titles: number;
  /** How many of those in each role, for sorting and labelling under a role tag. */
  roleTitles: Partial<Record<PeopleRole, number>>;
  roles: PeopleRole[];
  /** "Actor, Director" - their roles in display form. */
  roleLabel: string;
}

const PEOPLE_TTL_MS = 5 * 60 * 1000;
let peopleCache: { builtAt: number; people: BrowsePerson[] } | null = null;
let peopleBuild: Promise<BrowsePerson[]> | null = null;

/** Everyone credited on the site's films, most titles first (ties A-Z). Built from
 * title_credits + people for the indexed films and kept for a few minutes, like the search
 * index - a few thousand rows, read in pages. */
export async function loadBrowsePeople(): Promise<BrowsePerson[]> {
  if (peopleCache && Date.now() - peopleCache.builtAt < PEOPLE_TTL_MS) return peopleCache.people;
  peopleBuild ??= buildPeople().finally(() => {
    peopleBuild = null;
  });
  const people = await peopleBuild;
  peopleCache = { builtAt: Date.now(), people };
  return people;
}

const ID_CHUNK = 150;

async function buildPeople(): Promise<BrowsePerson[]> {
  const supabase = getCatalogClient();
  const filmIds = await listIndexedFilmIds();
  if (!supabase || filmIds.length === 0) return [];

  const titlesByPerson = new Map<number, Set<string>>();
  const roleTitlesByPerson = new Map<number, Map<PeopleRole, Set<string>>>();
  const chunks = <T,>(list: T[]) => Array.from({ length: Math.ceil(list.length / ID_CHUNK) }, (_, i) => list.slice(i * ID_CHUNK, (i + 1) * ID_CHUNK));

  // Batches run side by side - one after another took ~10s for a few thousand credits.
  const creditPages = await Promise.all(
    chunks(filmIds).map(async (chunk) => {
      const rows: { imdb_id: string; tmdb_person_id: number; credit_type: string; job: string | null }[] = [];
      for (let from = 0; ; from += 1000) {
        const { data, error } = await supabase
          .from("title_credits")
          .select("imdb_id, tmdb_person_id, credit_type, job")
          .in("imdb_id", chunk)
          .range(from, from + 999);
        if (error) {
          if (!isMissingTableError(error)) reportQueryError("browse people credits", error);
          return null;
        }
        rows.push(...((data ?? []) as typeof rows));
        if (!data || data.length < 1000) return rows;
      }
    })
  );
  if (creditPages.some((page) => page === null)) return [];
  for (const c of creditPages.flat()) {
    if (!c) continue;
    const role = roleOfCredit(c.credit_type, c.job);
    if (!role) continue;
    const id = c.tmdb_person_id;
    (titlesByPerson.get(id) ?? titlesByPerson.set(id, new Set()).get(id)!).add(c.imdb_id);
    const byRole = roleTitlesByPerson.get(id) ?? roleTitlesByPerson.set(id, new Map()).get(id)!;
    (byRole.get(role) ?? byRole.set(role, new Set()).get(role)!).add(c.imdb_id);
  }

  const details = new Map<number, { name: string; profile_path: string | null }>();
  const peoplePages = await Promise.all(
    chunks([...titlesByPerson.keys()]).map(async (chunk) => {
      const { data, error } = await supabase.from("people").select("tmdb_person_id, name, profile_path").in("tmdb_person_id", chunk);
      if (error) {
        reportQueryError("browse people names", error);
        return null;
      }
      return data ?? [];
    })
  );
  if (peoplePages.some((page) => page === null)) return [];
  for (const p of peoplePages.flat()) {
    if (p) details.set(p.tmdb_person_id as number, { name: p.name as string, profile_path: p.profile_path as string | null });
  }
  const personIds = [...titlesByPerson.keys()];

  const order = PEOPLE_ROLES.map((r) => r.key);
  return personIds
    .filter((id) => details.get(id)?.name)
    .map((id) => {
      const d = details.get(id)!;
      const byRole = roleTitlesByPerson.get(id)!;
      const roles = [...byRole.keys()].sort((a, b) => order.indexOf(a) - order.indexOf(b));
      return {
        id,
        name: d.name,
        href: personHref(id),
        imageSrc: d.profile_path ? tmdbImageUrl(d.profile_path, "w185") : null,
        titles: titlesByPerson.get(id)!.size,
        roleTitles: Object.fromEntries([...byRole].map(([role, set]) => [role, set.size])),
        roles,
        roleLabel: roles.map(roleSingular).join(", "),
      };
    })
    .sort((a, b) => b.titles - a.titles || a.name.localeCompare(b.name));
}

/** Everyone in `role` (or everyone), ordered for that tag: by titles in that role, then total
 * titles, then A-Z. */
export function peopleForRole(people: BrowsePerson[], role: PeopleRole | null): BrowsePerson[] {
  if (!role) return people;
  return people
    .filter((p) => p.roleTitles[role])
    .sort((a, b) => b.roleTitles[role]! - a.roleTitles[role]! || b.titles - a.titles || a.name.localeCompare(b.name));
}
