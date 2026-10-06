import type { Metadata } from "next";
import Link from "next/link";
import { Section } from "@/components/Panel";
import { PosterCard } from "@/components/PosterCard";
import { PosterImage } from "@/components/PosterImage";
import { FilterPanel } from "@/components/search/FilterPanel";
import { cleanSearchQuery, getSearchFacetOptions, searchCatalog, SEARCH_MIN_LENGTH, type SearchGroup, type SearchHit } from "@/lib/catalog/search";
import { activeFilterCount, filtersToParams, parseFiltersFromRecord, type RangeKey, type SortKey } from "@/lib/catalog/searchFilters";

/** Per-group cap on the full results page (the dropdown shows 4); `?all=1` lifts it. */
const PAGE_PER_GROUP = 60;
const PAGE_PER_GROUP_ALL = 500;

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export async function generateMetadata({ searchParams }: Props): Promise<Metadata> {
  const q = cleanSearchQuery((await searchParams).q);
  return { title: q ? `Search: ${q}` : "Search" };
}

export default async function SearchPage({ searchParams }: Props) {
  const params = await searchParams;
  const query = cleanSearchQuery(params.q);
  const filters = parseFiltersFromRecord(params);
  const showAll = params.all === "1";
  const tooShort = query.length < SEARCH_MIN_LENGTH;
  const filtered = activeFilterCount(filters) > 0 || !!filters.sort;
  // With filters or a sort, an empty search browses the whole collection.
  const [results, options] = await Promise.all([
    tooShort && !filtered ? null : searchCatalog(tooShort ? "" : query, { perGroup: showAll ? PAGE_PER_GROUP_ALL : PAGE_PER_GROUP, posterSize: "w342", filters }),
    getSearchFacetOptions(),
  ]);
  const browsing = tooShort && filtered;

  // Filters only some builds offer.
  const extraRanges: RangeKey[] = [];
  const extraSorts: SortKey[] = [];

  const showAllHref = (() => {
    const p = filtersToParams(filters);
    if (query) p.set("q", query);
    p.set("all", "1");
    return `/search?${p.toString()}`;
  })();

  return (
    <div className="mx-auto max-w-screen-2xl px-4 py-6 sm:px-6">
      <div className="mb-6 border-b border-rule pb-3">
        <p className="label-tech text-accent">Search // Collection</p>
        <h1 className="mt-1 font-display text-xl font-semibold tracking-wide break-words text-chrome-hi sm:text-2xl">
          {query && !tooShort ? <>Results for &ldquo;{query}&rdquo;</> : browsing ? "Browse the collection" : "Search the collection"}
        </h1>
        {results ? (
          <p className="label-tech mt-1">
            {results.total} match{results.total === 1 ? "" : "es"}
            {results.groups.length ? ` // ${results.groups.map((g) => `${g.total} ${g.label}`).join(" // ")}` : ""}
          </p>
        ) : null}
      </div>

      {options ? (
        <FilterPanel
          // Remount on navigation so the draft starts from the applied filters.
          key={filtersToParams(filters).toString() + query}
          query={tooShort ? "" : query}
          filters={filters}
          options={options}
          extraRanges={extraRanges}
          extraSorts={extraSorts}
          defaultOpen={!results || params.filters === "1"}
        />
      ) : null}

      {!results ? (
        <EmptyState
          title={query ? "Keep typing" : "Nothing searched yet"}
          body={`Enter at least ${SEARCH_MIN_LENGTH} characters in the search bar to find films, physical releases, collections, franchises and people - or pick some filters above to browse the whole collection.`}
        />
      ) : results.groups.length === 0 ? (
        <EmptyState
          title="No matches"
          body={
            browsing
              ? "Nothing in the collection passes all of these filters. Remove one of the filter chips above to widen it."
              : `Nothing in the collection matches "${query}"${filtered ? " with these filters" : ""}. Check the spelling, try part of the title - e.g. "wars" instead of the full name - or remove a filter.`
          }
        />
      ) : (
        <div className="space-y-10">
          {results.groups.map((group, i) => (
            <ResultGroup key={group.kind} group={group} index={i} query={query} browsing={browsing} showAllHref={showAll ? null : showAllHref} />
          ))}
        </div>
      )}
    </div>
  );
}

function ResultGroup({
  group,
  index,
  query,
  browsing,
  showAllHref,
}: {
  group: SearchGroup;
  index: number;
  query: string;
  browsing: boolean;
  showAllHref: string | null;
}) {
  const aside = group.total > group.hits.length ? `Showing ${group.hits.length} of ${group.total}` : `${group.total}`;
  const posterKinds = group.kind === "film" || group.kind === "item" || group.kind === "collection";
  return (
    <Section title={group.label} label={String(index + 1).padStart(2, "0")} aside={aside}>
      {posterKinds ? (
        <div className="flex flex-wrap gap-x-3 gap-y-5 sm:gap-x-4">
          {group.hits.map((hit) => (
            <PosterCard
              key={hit.key}
              size="sm"
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
      ) : (
        <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {group.hits.map((hit) => (
            <li key={hit.key}>
              <EntityRow hit={hit} />
            </li>
          ))}
        </ul>
      )}
      {group.total > group.hits.length ? (
        <p className="label-tech mt-3 text-mist-dim">
          {group.total - group.hits.length} more -{" "}
          {showAllHref ? (
            <Link href={showAllHref} className="text-accent hover:text-accent-hi">
              show them all
            </Link>
          ) : null}
          {showAllHref ? " or " : ""}
          {browsing ? "add a filter" : <>refine &ldquo;{query}&rdquo;</>} to narrow these down.
        </p>
      ) : null}
    </Section>
  );
}

/** Second caption line under a poster: what kind of entry it is beyond year/format. */
function captionFor(hit: SearchHit): string | null {
  if (hit.kind === "film") return hit.subtitle;
  if (hit.kind === "collection") return "Box set";
  // Items: "4K UHD Blu-Ray // In: <set>" -> just the set, since the badge already shows format.
  const inSet = hit.subtitle?.split(" // In: ")[1];
  return inSet ? `In: ${inSet}` : null;
}

/** Franchise / director / person row: small image + name + subtitle, angular panel. */
function EntityRow({ hit }: { hit: SearchHit }) {
  return (
    <Link
      href={hit.href}
      className="panel clip-corner-sm flow-ring group flex items-center gap-3 p-2 outline-none hover:border-accent-dim focus-visible:shadow-glow"
    >
      <span className="clip-corner-sm relative h-16 w-11 shrink-0 overflow-hidden bg-panel ring-1 ring-rule ring-inset">
        {hit.image ? (
          <PosterImage image={hit.image} title={hit.title} sizes="44px" />
        ) : (
          <span aria-hidden className="absolute inset-0 flex items-center justify-center font-display text-lg font-bold text-accent-dim">
            {initials(hit.title)}
          </span>
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium text-chrome group-hover:text-accent-hi">{hit.title}</span>
        <span className="label-tech block truncate">
          {hit.subtitle}
          {hit.related ? " // related" : ""}
        </span>
      </span>
      <svg aria-hidden viewBox="0 0 8 10" className="mr-1 h-2.5 w-2 shrink-0 fill-accent">
        <polygon points="0,0 8,5 0,10" />
      </svg>
    </Link>
  );
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="panel clip-corner mx-auto max-w-xl px-6 py-10 text-center">
      <div aria-hidden className="mb-4 flex items-center justify-center gap-1 text-accent-dim">
        {[0, 1, 2].map((i) => (
          <svg key={i} viewBox="0 0 8 10" className="h-3 w-2.5 fill-current" style={{ opacity: 1 - i * 0.3 }}>
            <polygon points="0,0 8,5 0,10" />
          </svg>
        ))}
      </div>
      <h2 className="font-display text-lg font-semibold tracking-wider text-chrome-hi uppercase">{title}</h2>
      <p className="mt-2 text-sm text-mist">{body}</p>
    </div>
  );
}
