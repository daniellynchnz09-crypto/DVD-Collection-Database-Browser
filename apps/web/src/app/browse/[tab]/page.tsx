import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PosterCard } from "@/components/PosterCard";
import { EntityRow } from "@/components/search/EntityRow";
import { PersonCircle } from "@/components/title/PersonCircle";
import { BROWSE_TABS, loadBrowseGrid, loadBrowsePeople, PEOPLE_ROLES, type BrowseGridSlug, type PeopleRole } from "@/lib/catalog/browse";
import type { SearchHit } from "@/lib/catalog/search";

/**
 * One Browse tab (lib/catalog/browse.ts): /browse/4k, /browse/hd, /browse/collections,
 * /browse/franchises, /browse/people. The grids are like the home page's posters, but in one
 * wrapping grid with no scrolling rows or row headings (the user's spec).
 */
export const revalidate = 300;

/** People shown per "Load more" step. */
const PEOPLE_STEP = 60;

const INTROS: Record<string, string> = {
  "4k": "Every film and show with a 4K UHD disc in the collection - newest scans first.",
  hd: "Every film and show with a Blu-ray disc (not 4K) in the collection - newest scans first.",
  collections: "Every box set and collection, newest scans first.",
  franchises: "Every franchise in the collection, A-Z.",
  people: "Everyone credited on a film or show in the collection - most titles first.",
};

export async function generateMetadata(props: PageProps<"/browse/[tab]">): Promise<Metadata> {
  const { tab } = await props.params;
  const found = BROWSE_TABS.find((t) => t.slug === tab);
  return { title: found ? found.label : "Browse" };
}

export default async function BrowsePage(props: PageProps<"/browse/[tab]">) {
  const { tab } = await props.params;
  const found = BROWSE_TABS.find((t) => t.slug === tab);
  if (!found) notFound();
  const searchParams = await props.searchParams;

  return (
    <div className="mx-auto max-w-screen-2xl px-4 py-6 sm:px-6">
      {tab === "people" ? (
        <PeopleTab label={found.label} params={searchParams} />
      ) : (
        <GridTab slug={tab as BrowseGridSlug} label={found.label} />
      )}
    </div>
  );
}

function TabHeading({ label, intro, count }: { label: string; intro: string; count: string }) {
  return (
    <div className="mb-6 border-b border-rule pb-3">
      <p className="label-tech text-accent">Browse // Collection</p>
      <h1 className="mt-1 font-display text-xl font-semibold tracking-wide text-chrome-hi uppercase sm:text-2xl">{label}</h1>
      <p className="mt-1 text-sm text-mist">{intro}</p>
      <p className="label-tech mt-1">{count}</p>
    </div>
  );
}

async function GridTab({ slug, label }: { slug: BrowseGridSlug; label: string }) {
  const hits = await loadBrowseGrid(slug);
  const noun = slug === "franchises" ? "franchise" : slug === "collections" ? "box set" : "title";
  return (
    <>
      <TabHeading label={label} intro={INTROS[slug]} count={`${hits.length} ${noun}${hits.length === 1 ? "" : "s"}`} />
      {hits.length === 0 ? (
        <p className="text-sm text-mist">Nothing here yet.</p>
      ) : slug === "franchises" ? (
        <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {hits.map((hit) => (
            <li key={hit.key} className="min-w-0">
              <EntityRow hit={hit} />
            </li>
          ))}
        </ul>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(8rem,1fr))] justify-items-center gap-x-3 gap-y-6 sm:grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] sm:gap-x-4">
          {hits.map((hit, i) => (
            <PosterCard
              key={hit.key}
              preload={i < 6}
              card={{
                key: hit.key,
                href: hit.href,
                title: hit.title,
                year: hit.year,
                format: hit.format,
                image: hit.image,
                caption: captionFor(hit),
              }}
            />
          ))}
        </div>
      )}
    </>
  );
}

/** Second caption line under a poster - same wording as the search results page. */
function captionFor(hit: SearchHit): string | null {
  if (hit.kind === "film") return hit.subtitle;
  if (hit.kind === "collection") return "Box set";
  return null;
}

function single(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

async function PeopleTab({ label, params }: { label: string; params: Record<string, string | string[] | undefined> }) {
  const roleParam = single(params.role);
  const role = PEOPLE_ROLES.some((r) => r.key === roleParam) ? (roleParam as PeopleRole) : null;
  const nameFilter = single(params.q).trim().slice(0, 80);
  const show = Math.min(Math.max(parseInt(single(params.show), 10) || PEOPLE_STEP, PEOPLE_STEP), 5000);

  const everyone = await loadBrowsePeople();
  const needle = nameFilter.toLowerCase();
  const matching = everyone.filter((p) => (!role || p.roles.includes(role)) && (!needle || p.name.toLowerCase().includes(needle)));
  const shown = matching.slice(0, show);

  const hrefWith = (next: { role?: PeopleRole | null; show?: number }) => {
    const p = new URLSearchParams();
    const r = next.role === undefined ? role : next.role;
    if (r) p.set("role", r);
    if (nameFilter) p.set("q", nameFilter);
    if (next.show) p.set("show", String(next.show));
    const qs = p.toString();
    return `/browse/people${qs ? `?${qs}` : ""}`;
  };

  return (
    <>
      <TabHeading
        label={label}
        intro={INTROS.people}
        count={`${matching.length} ${matching.length === 1 ? "person" : "people"}${role || nameFilter ? " matching" : ""}`}
      />

      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <ul className="flex flex-wrap gap-2" aria-label="Filter by role">
          {[{ key: null, label: "Everyone" }, ...PEOPLE_ROLES].map((r) => {
            const active = role === r.key;
            return (
              <li key={r.label}>
                <Link
                  href={hrefWith({ role: r.key as PeopleRole | null })}
                  aria-current={active ? "true" : undefined}
                  className={`clip-tab block px-3 py-1 font-display text-[11px] font-semibold tracking-[0.14em] uppercase ring-1 ring-rule ring-inset transition-colors ${
                    active ? "gloss bg-accent-deep text-accent-hi" : "bg-panel text-mist hover:text-chrome-hi"
                  }`}
                >
                  {r.label}
                </Link>
              </li>
            );
          })}
        </ul>
        <form action="/browse/people" className="flex gap-2">
          {role ? <input type="hidden" name="role" value={role} /> : null}
          <input
            type="search"
            name="q"
            defaultValue={nameFilter}
            placeholder="Filter by name"
            aria-label="Filter people by name"
            className="well clip-corner-sm w-full border border-rule bg-transparent px-3 py-1.5 text-sm text-chrome placeholder:text-mist-dim focus:border-accent-dim sm:w-56"
          />
          <button type="submit" className="gloss clip-corner-sm bg-accent-deep px-3 font-display text-[11px] font-semibold tracking-[0.14em] text-accent-hi uppercase">
            Go
          </button>
        </form>
      </div>

      {shown.length === 0 ? (
        <p className="text-sm text-mist">No one matches.</p>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(6.5rem,1fr))] justify-items-center gap-x-2 gap-y-6 sm:grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))]">
          {shown.map((person) => (
            <PersonCircle
              key={person.id}
              name={person.name}
              role={`${person.roleLabel} // ${person.titles} title${person.titles === 1 ? "" : "s"}`}
              imageSrc={person.imageSrc}
              href={person.href}
            />
          ))}
        </div>
      )}

      {matching.length > shown.length ? (
        <div className="mt-8 flex justify-center">
          <Link
            href={hrefWith({ show: show + PEOPLE_STEP })}
            scroll={false}
            className="gloss clip-corner-sm bg-accent-deep px-5 py-2 font-display text-xs font-semibold tracking-[0.16em] text-accent-hi uppercase"
          >
            Load more ({matching.length - shown.length} left)
          </Link>
        </div>
      ) : null}
    </>
  );
}
