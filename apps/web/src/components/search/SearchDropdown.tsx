"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useState } from "react";
import type { SearchGroup, SearchHit, SearchKind } from "@/lib/catalog/search";

/** /api/search's compact response (image trimmed to what the dropdown renders). */
export type DropdownHit = Omit<SearchHit, "image"> & { image: { src: string; unoptimized: boolean } | null };
export type DropdownGroup = Omit<SearchGroup, "hits"> & { hits: DropdownHit[] };
export interface DropdownResults {
  query: string;
  groups: DropdownGroup[];
  total: number;
}

/** Which results to draw for the typed query: the matching response, or the previous one
 * (dimmed) while the next request is in flight, so the list doesn't flash empty per keystroke. */
export function pickShownResults(results: DropdownResults | null, query: string, minLength: number) {
  if (query.length < minLength || !results) return { results: null, stale: false };
  return { results, stale: results.query.toLowerCase() !== query.toLowerCase() };
}

/** Option hrefs in display order - every hit, then "See all results". Keyboard navigation
 * indexes into this same list. */
export function dropdownOptionHrefs(results: DropdownResults | null, query: string, minLength: number): string[] {
  if (query.length < minLength) return [];
  const hrefs = (results?.groups ?? []).flatMap((g) => g.hits.map((h) => h.href));
  hrefs.push(`/search?q=${encodeURIComponent(query)}`);
  return hrefs;
}

const KIND_ICON: Record<SearchKind, string> = {
  film: "M0,0 H10 V14 H0 Z M2,2 V12 H8 V2 Z",
  item: "M5,0 A5,5 0 1,1 4.99,0 Z M5,3.5 A1.5,1.5 0 1,0 5.01,3.5 Z",
  collection: "M0,2 H8 V14 H0 Z M2,0 H10 V12 H9 V1 H2 Z",
  franchise: "M5,0 L10,5 L5,10 L0,5 Z",
  director: "M0,3 H7 V11 H0 Z M7,5 L10,3 V11 L7,9 Z",
  person: "M5,0 A2.6,2.6 0 1,1 4.99,0 Z M0,12 L2,7 H8 L10,12 Z",
};

function Thumb({ hit }: { hit: DropdownHit }) {
  const [failed, setFailed] = useState(false);
  const round = hit.kind === "person" || hit.kind === "director";
  return (
    <span
      className={`relative flex shrink-0 items-center justify-center overflow-hidden bg-panel ring-1 ring-rule ring-inset ${
        round ? "h-10 w-10 clip-corner-sm" : "h-12 w-8 clip-corner-sm"
      }`}
    >
      {hit.image && !failed ? (
        <Image
          src={hit.image.src}
          alt=""
          fill
          sizes="40px"
          unoptimized={hit.image.unoptimized}
          onError={() => setFailed(true)}
          className="object-cover"
        />
      ) : (
        <svg aria-hidden viewBox="0 0 10 14" className="h-4 w-3 fill-accent-dim" fillRule="evenodd">
          <path d={KIND_ICON[hit.kind]} />
        </svg>
      )}
    </span>
  );
}

export function SearchDropdown({
  query,
  minLength,
  results,
  stale,
  loading,
  failed,
  active,
  onActiveChange,
  onPick,
  listboxId,
  seeAllHref,
}: {
  query: string;
  minLength: number;
  results: DropdownResults | null;
  stale: boolean;
  loading: boolean;
  failed: boolean;
  active: number;
  onActiveChange: (index: number) => void;
  onPick: () => void;
  listboxId: string;
  seeAllHref: string;
}) {
  const optionId = (i: number) => `${listboxId}-opt-${i}`;

  // SearchBox owns the input, so point its aria-activedescendant at the highlighted option
  // here, and keep that option scrolled into view.
  useEffect(() => {
    const input = document.querySelector<HTMLInputElement>(`[aria-controls="${CSS.escape(listboxId)}"]`);
    const id = active >= 0 ? `${listboxId}-opt-${active}` : null;
    if (input) {
      if (id) input.setAttribute("aria-activedescendant", id);
      else input.removeAttribute("aria-activedescendant");
    }
    if (id) document.getElementById(id)?.scrollIntoView({ block: "nearest" });
    return () => input?.removeAttribute("aria-activedescendant");
  }, [active, listboxId]);

  if (query.length < minLength) {
    return (
      <div className="clip-corner bg-void">
        <div className="panel clip-corner px-4 py-3">
          <p className="label-tech">Type at least {minLength} characters</p>
        </div>
      </div>
    );
  }

  const groups = results?.groups ?? [];
  // Flat option index where each group starts, so option ids match keyboard order.
  const offsets = groups.map((_, gi) => groups.slice(0, gi).reduce((n, g) => n + g.hits.length, 0));
  const nothing = !!results && !stale && groups.length === 0;
  const seeAllIndex = groups.reduce((n, g) => n + g.hits.length, 0);

  return (
    // Solid backing under the translucent panel so page content doesn't show through the list.
    <div className="clip-corner bg-void shadow-xl">
      <div className="panel clip-corner flex max-h-[min(70vh,36rem)] flex-col">
        <div className="chrome-bar flex items-center gap-2 px-3 py-1.5">
          <span aria-hidden className="h-2 w-2 rotate-45 bg-accent" />
          <span className="label-tech text-chrome-hi">Live Results</span>
          <span className="label-tech ml-auto" aria-live="polite">
            {failed ? "Search unavailable" : loading || stale ? "Searching..." : results ? `${results.total} match${results.total === 1 ? "" : "es"}` : ""}
          </span>
        </div>

        <ul id={listboxId} role="listbox" aria-label="Search results" className={`min-h-0 flex-1 overflow-y-auto pt-1 ${stale ? "opacity-60" : ""}`}>
          {nothing ? (
            <li role="presentation" className="px-4 py-3 text-sm text-mist">
              No matches for &ldquo;{query}&rdquo;.
            </li>
          ) : null}

          {groups.map((group, gi) => (
            <li key={group.kind} role="presentation">
              <div className="flex items-center gap-2 px-3 pt-2 pb-1">
                <span className="label-tech text-accent">{group.label}</span>
                <span aria-hidden className="h-px flex-1 bg-rule" />
                {group.total > group.hits.length ? <span className="label-tech text-mist-dim">{group.total}</span> : null}
              </div>
              <ul role="group" aria-label={group.label}>
                {group.hits.map((hit, hi) => {
                  const i = offsets[gi] + hi;
                  const isActive = i === active;
                  return (
                    <li key={`${hit.kind}:${hit.key}`} role="presentation">
                      <Link
                        id={optionId(i)}
                        role="option"
                        aria-selected={isActive}
                        tabIndex={-1}
                        href={hit.href}
                        // Keep focus in the input so the combobox stays the focus owner.
                        onMouseDown={(e) => e.preventDefault()}
                        onMouseEnter={() => onActiveChange(i)}
                        onClick={onPick}
                        className={`mx-1 flex items-center gap-3 border-l-2 px-2 py-1.5 outline-none ${
                          isActive ? "border-accent bg-accent-deep/70" : "border-transparent hover:bg-panel-hi/60"
                        }`}
                      >
                        <Thumb hit={hit} />
                        <span className="min-w-0 flex-1">
                          <span className={`block truncate text-sm font-medium ${isActive ? "text-accent-hi" : "text-chrome"}`}>{hit.title}</span>
                          <span className="label-tech block truncate">
                            {[hit.year, hit.subtitle].filter(Boolean).join(" // ")}
                            {hit.related ? <span className="text-accent-dim">{" // related"}</span> : null}
                          </span>
                        </span>
                        {hit.format ? (
                          <span className="clip-tab shrink-0 border border-accent-dim bg-accent-deep/90 px-1.5 py-px font-display text-[10px] font-semibold tracking-[0.14em] text-accent-hi uppercase">
                            {hit.format}
                          </span>
                        ) : null}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}

          {/* Inside the listbox (it is an option) but pinned to the bottom of the scroll area. */}
          <li role="presentation" className="sticky bottom-0 mt-1 bg-abyss">
            <Link
              id={optionId(seeAllIndex)}
              role="option"
              aria-selected={active === seeAllIndex}
              tabIndex={-1}
              href={seeAllHref}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => onActiveChange(seeAllIndex)}
              onClick={onPick}
              className={`flex items-center gap-2 border-t border-rule-strong px-4 py-2 outline-none ${
                active === seeAllIndex ? "bg-accent-deep text-accent-hi" : "text-accent hover:bg-accent-deep/60"
              }`}
            >
              <span className="font-display text-[11px] font-semibold tracking-[0.18em] uppercase">See all results</span>
              <svg aria-hidden viewBox="0 0 8 10" className="h-2.5 w-2 fill-current">
                <polygon points="0,0 8,5 0,10" />
              </svg>
            </Link>
          </li>
        </ul>
      </div>
    </div>
  );
}
