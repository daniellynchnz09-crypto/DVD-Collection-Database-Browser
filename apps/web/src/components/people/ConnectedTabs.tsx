"use client";

import { useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { PosterCard } from "@/components/PosterCard";
import type { PosterCardData } from "@/lib/catalog/types";

/** Above this many items a tab gets its own quick filter (WEB APP DESIGN.md: "a mini search
 * bar for each tab ... if the number of items in the list is above 20"). */
const SEARCH_THRESHOLD = 20;

export interface ConnectedTabData {
  id: string;
  label: string;
  cards: PosterCardData[];
}

/**
 * Tabbed grid of everything a person/franchise is connected to: Movie/TV pages on one tab,
 * DVD/DVD Collection pages on the other. Filtering is client-side over the already-loaded
 * cards (title, year, caption, format) - no advanced search features by design.
 */
export function ConnectedTabs({ tabs, emptyText = "Nothing in the collection yet." }: { tabs: ConnectedTabData[]; emptyText?: string }) {
  const baseId = useId();
  const [active, setActive] = useState(() => tabs.find((t) => t.cards.length > 0)?.id ?? tabs[0]?.id);
  // Each tab keeps its own query, so switching tabs doesn't carry a filter across.
  const [queries, setQueries] = useState<Record<string, string>>({});
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const current = tabs.find((t) => t.id === active) ?? tabs[0];
  const query = current ? (queries[current.id] ?? "") : "";
  const showSearch = !!current && current.cards.length > SEARCH_THRESHOLD;

  const visible = useMemo(() => {
    if (!current) return [];
    const terms = normalize(query).split(" ").filter(Boolean);
    if (!showSearch || terms.length === 0) return current.cards;
    return current.cards.filter((c) => {
      const haystack = normalize([c.title, c.year, c.caption, c.format].filter(Boolean).join(" "));
      return terms.every((t) => haystack.includes(t));
    });
  }, [current, query, showSearch]);

  if (!current) return null;

  // Arrow keys move between tabs, per the WAI-ARIA tabs pattern.
  function onTabKey(e: KeyboardEvent<HTMLButtonElement>, index: number) {
    const delta = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!delta) return;
    e.preventDefault();
    const next = (index + delta + tabs.length) % tabs.length;
    setActive(tabs[next].id);
    tabRefs.current[next]?.focus();
  }

  return (
    <div>
      <div className="flex flex-wrap items-end gap-3 border-b border-rule-strong">
        <div role="tablist" aria-label="Connected pages" className="flex gap-1">
          {tabs.map((tab, i) => {
            const selected = tab.id === current.id;
            return (
              <button
                key={tab.id}
                ref={(el) => {
                  tabRefs.current[i] = el;
                }}
                type="button"
                role="tab"
                id={`${baseId}-tab-${tab.id}`}
                aria-selected={selected}
                aria-controls={`${baseId}-panel-${tab.id}`}
                tabIndex={selected ? 0 : -1}
                onClick={() => setActive(tab.id)}
                onKeyDown={(e) => onTabKey(e, i)}
                className={`clip-tab flex items-center gap-2 px-3 py-2 font-display text-xs font-semibold tracking-[0.16em] uppercase transition-colors sm:px-4 sm:text-sm ${
                  selected ? "gloss bg-accent-deep text-accent-hi" : "bg-panel/70 text-mist hover:bg-panel-hi hover:text-chrome"
                }`}
              >
                {tab.label}
                <span className={`font-sans text-[11px] tracking-normal ${selected ? "text-accent" : "text-mist-dim"}`}>{tab.cards.length}</span>
              </button>
            );
          })}
        </div>

        {showSearch ? (
          <label className="clip-corner-sm mb-1.5 ml-auto flex w-full items-center gap-2 border border-rule bg-void/70 px-3 py-1.5 focus-within:border-accent sm:w-64">
            <svg aria-hidden viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0 fill-none stroke-accent" strokeWidth="1.6">
              <circle cx="6.5" cy="6.5" r="4.5" />
              <path d="M10 10l4.5 4.5" />
            </svg>
            <span className="sr-only">Filter {current.label}</span>
            <input
              type="search"
              value={query}
              onChange={(e) => setQueries((q) => ({ ...q, [current.id]: e.target.value }))}
              placeholder={`Filter ${current.label.toLowerCase()}`}
              maxLength={80}
              className="w-full min-w-0 bg-transparent text-sm text-chrome-hi outline-none placeholder:text-mist-dim"
            />
          </label>
        ) : null}
      </div>

      <div role="tabpanel" id={`${baseId}-panel-${current.id}`} aria-labelledby={`${baseId}-tab-${current.id}`} className="pt-5">
        {visible.length > 0 ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(7rem,1fr))] gap-x-3 gap-y-5 sm:grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] sm:gap-x-4">
            {visible.map((card) => (
              <PosterCard key={card.key} card={card} size="sm" />
            ))}
          </div>
        ) : (
          <p className="label-tech py-6 text-mist">{current.cards.length === 0 ? emptyText : `No matches for “${query.trim()}”.`}</p>
        )}
        {showSearch && query.trim() && visible.length > 0 ? (
          <p className="label-tech mt-4 text-mist-dim">
            Showing {visible.length} of {current.cards.length}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function normalize(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
