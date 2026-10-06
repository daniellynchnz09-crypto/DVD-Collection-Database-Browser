"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import {
  activeFilterCount,
  EMPTY_FILTERS,
  FACETS,
  facetValueLabel,
  filtersToParams,
  RANGES,
  REALISM_LEVELS,
  realismIndex,
  RESULT_TYPES,
  SORTS,
  type FacetCounts,
  MATCH_ALL_FACETS,
  type FacetKey,
  type FacetOption,
  type MatchAllFacet,
  type Flag,
  type RangeKey,
  type ResultType,
  type SearchFacetOptions,
  type SearchFilters,
  type SortKey,
  type TriState,
} from "@/lib/catalog/searchFilters";
import { TasteProfiles, type ClientTasteProfile } from "./TasteProfiles";

/**
 * Advanced Search's filter + sort panel (WEB APP DESIGN.md: filters that find entries or
 * block them, several at once, ranges as sliders, and a sort-by). Edits a draft and applies it
 * as URL params on /search, so the server does the filtering and a filtered view can be
 * bookmarked. Facet chips cycle off -> include -> block -> off.
 */
export function FilterPanel({
  query,
  filters,
  options,
  extraRanges = [],
  extraSorts = [],
  profiles = [],
  defaultOpen,
}: {
  query: string;
  filters: SearchFilters;
  options: SearchFacetOptions;
  /** Ranges only some builds offer (the private build's own and community scores). */
  extraRanges?: RangeKey[];
  extraSorts?: SortKey[];
  /** Saved taste profiles (the taste_profiles table). */
  profiles?: ClientTasteProfile[];
  defaultOpen: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(defaultOpen);
  const [draft, setDraft] = useState<SearchFilters>(filters);
  const dirty = JSON.stringify(draft) !== JSON.stringify(filters);

  const ranges = RANGES.filter((r) => !OPTIONAL_KEYS.includes(r.key) || extraRanges.includes(r.key));
  const sorts = SORTS.filter((s) => (!OPTIONAL_KEYS.includes(s.value) || (extraSorts as string[]).includes(s.value)) && (s.value !== "relevance" || query));

  function go(next: SearchFilters) {
    const params = filtersToParams(next);
    if (query) params.set("q", query);
    const qs = params.toString();
    router.push(qs ? `/search?${qs}` : "/search");
  }

  const setFacet = (key: FacetKey, value: string, state: TriState | null) =>
    setDraft((d) => {
      const map = { ...(d.facets[key] ?? {}) };
      if (state) map[value] = state;
      else delete map[value];
      return { ...d, facets: { ...d.facets, [key]: map } };
    });

  const setRange = (key: RangeKey, value: [number | null, number | null] | null) =>
    setDraft((d) => {
      const next = { ...d.ranges };
      if (value && (value[0] !== null || value[1] !== null)) next[key] = value;
      else delete next[key];
      return { ...d, ranges: next };
    });

  // Live option counts for the draft (everything but types/sort, which don't change what a
  // facet value matches). Fetched debounced; with nothing picked the full counts apply.
  const countParams = filtersToParams({ ...draft, types: [], sort: null, dir: null }).toString();
  const [fetched, setFetched] = useState<{ params: string; counts: FacetCounts } | null>(null);
  useEffect(() => {
    if (!countParams || !open) return;
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      fetch(`/api/search/facets?${countParams}`, { signal: ctrl.signal })
        .then((res) => (res.ok ? (res.json() as Promise<{ counts: FacetCounts }>) : null))
        .then((json) => {
          if (json?.counts) setFetched({ params: countParams, counts: json.counts });
        })
        .catch(() => {
          // Aborted or offline - the panel keeps the last counts it had.
        });
    }, 200);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [countParams, open]);
  // While a new count is on its way the previous one stays up, so lists don't flicker.
  const liveCounts = countParams ? (fetched?.counts ?? null) : null;
  const facetOptions = (key: FacetKey): FacetOption[] => {
    const all = options.facets[key] ?? [];
    const live = liveCounts?.[key];
    return live ? all.map((o) => ({ ...o, count: live[o.value.toLowerCase()] ?? 0 })) : all;
  };

  const count = activeFilterCount(filters);

  return (
    <section id="filters" className="panel clip-corner mb-8">
      <header className="chrome-bar flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="group flex items-center gap-2 outline-none"
        >
          <svg aria-hidden viewBox="0 0 10 10" className={`h-2.5 w-2.5 fill-accent transition-transform ${open ? "rotate-90" : ""}`}>
            <polygon points="0,0 10,5 0,10" />
          </svg>
          <span className="font-display text-xs font-semibold tracking-[0.2em] text-chrome-hi uppercase group-hover:text-accent-hi">
            Filters &amp; sort
          </span>
          {count ? <span className="gloss clip-tab bg-accent-deep px-1.5 font-display text-[10px] font-bold text-accent-hi">{count}</span> : null}
        </button>
        <SortControls
          sorts={sorts}
          sort={filters.sort ?? (query ? "relevance" : "title")}
          dir={filters.dir}
          onChange={(sort, dir) => go({ ...filters, sort, dir })}
        />
      </header>

      <ActiveChips filters={filters} options={options} profiles={profiles} onChange={go} />

      {open ? (
        <div className="p-4">
          {/* Collapsible sections (the user, 2026-10-07: too many filters for one long list).
              A section starts open when something in it is set. */}
          <div className="space-y-1.5">
            <Accordion title="Show" active={draft.types.length} defaultOpen>
              <div className="flex flex-wrap gap-1.5">
                {RESULT_TYPES.map((t) => {
                  const on = draft.types.includes(t.value);
                  return (
                    <Chip
                      key={t.value}
                      state={on ? "include" : null}
                      onClick={() =>
                        setDraft((d) => ({ ...d, types: on ? d.types.filter((x) => x !== t.value) : [...d.types, t.value as ResultType] }))
                      }
                    >
                      {t.label}
                    </Chip>
                  );
                })}
              </div>
              <p className="label-tech mt-1.5 text-mist-dim">None picked = everything. Actors &amp; crew only appear for a typed search.</p>
            </Accordion>

            <Accordion title="Taste profiles" active={draft.profiles.length}>
              <TasteProfiles
                profiles={profiles}
                selected={draft.profiles}
                draft={draft}
                onToggle={(id) =>
                  setDraft((d) => ({ ...d, profiles: d.profiles.includes(id) ? d.profiles.filter((x) => x !== id) : [...d.profiles, id] }))
                }
                onLoad={(pf) =>
                  setDraft((d) => ({ ...d, facets: pf.facets, ranges: pf.ranges, steelbook: pf.steelbook, boxSet: pf.boxSet, inBoxSet: pf.inBoxSet, matchAll: pf.matchAll }))
                }
              />
            </Accordion>

            {RANGE_SECTIONS.map((section) => {
              const inSection = ranges.filter((r) => (section.keys as readonly string[]).includes(r.key));
              return (
                <Accordion key={section.title} title={section.title} active={inSection.filter((r) => draft.ranges[r.key]).length}>
                  <div className="grid gap-6 lg:grid-cols-2">
                    {inSection.map((r) => (
                      <Group key={r.key} title={r.label}>
                        <DualRange
                          min={r.key === "year" ? options.yearBounds[0] : r.min}
                          max={r.key === "year" ? options.yearBounds[1] : r.max}
                          step={r.step}
                          unit={r.unit}
                          value={draft.ranges[r.key] ?? [null, null]}
                          onChange={(v) => setRange(r.key, v)}
                        />
                        {r.key === "year" ? <DecadeChips bounds={options.yearBounds} onPick={(v) => setRange("year", v)} /> : null}
                      </Group>
                    ))}
                  </div>
                </Accordion>
              );
            })}

            <Accordion title="Steelbooks & box sets" active={[draft.steelbook, draft.boxSet, draft.inBoxSet].filter(Boolean).length}>
              <div className="grid gap-6 sm:grid-cols-3">
                <Group title="Steelbook">
                  <FlagSwitch value={draft.steelbook} onChange={(v) => setDraft((d) => ({ ...d, steelbook: v }))} />
                </Group>
                <Group title="Is a box set">
                  <FlagSwitch value={draft.boxSet} onChange={(v) => setDraft((d) => ({ ...d, boxSet: v }))} />
                </Group>
                <Group title="Is in a box set">
                  <FlagSwitch value={draft.inBoxSet} onChange={(v) => setDraft((d) => ({ ...d, inBoxSet: v }))} />
                </Group>
              </div>
            </Accordion>

            {FACETS.map((f) => {
              if (!options.facets[f.key]?.length) return null;
              const list = facetOptions(f.key);
              const selection = draft.facets[f.key] ?? {};
              if (f.key === "doc") {
                // Story values sit on a fact-to-fiction slider; performance/recording values
                // (Stand Up, Live Concert...) stay as chips under it.
                const others = list.filter((o) => realismIndex(o.value) < 0);
                return (
                  <Accordion
                    key={f.key}
                    title={f.label}
                    // The slider's span counts once, however many notches it covers.
                    active={
                      Object.keys(selection).filter((v) => realismIndex(v) < 0).length +
                      (Object.entries(selection).some(([v, s]) => s === "include" && realismIndex(v) >= 0) ? 1 : 0)
                    }
                  >
                    <RealismSlider
                      selection={selection}
                      counts={REALISM_LEVELS.map((l) => list.find((o) => o.value.toLowerCase() === l.value.toLowerCase())?.count ?? 0)}
                      onChange={(next) => setDraft((d) => ({ ...d, facets: { ...d.facets, doc: next } }))}
                    />
                    {others.length ? (
                      <div className="mt-4">
                        <p className="label-tech mb-2 text-accent">Performances &amp; recordings</p>
                        <FacetGroup facet={f.key} title="type" options={others} selection={selection} onSet={setFacet} />
                      </div>
                    ) : null}
                  </Accordion>
                );
              }
              const available = list.filter((o) => o.count > 0 || selection[o.value]).length;
              return (
                <Accordion
                  key={f.key}
                  title={f.label}
                  active={Object.keys(selection).length}
                  extra={available === list.length ? `${list.length} options` : `${available} of ${list.length} options`}
                >
                  {isMatchAllFacet(f.key) ? (
                    <MatchSwitch
                      all={draft.matchAll.includes(f.key)}
                      picked={Object.values(selection).filter((s) => s === "include").length}
                      noun={f.key === "genre" ? "genres" : "franchises"}
                      onChange={(all) => {
                        const key = f.key as MatchAllFacet;
                        setDraft((d) => ({ ...d, matchAll: all ? [...d.matchAll.filter((k) => k !== key), key] : d.matchAll.filter((k) => k !== key) }));
                      }}
                    />
                  ) : null}
                  <FacetGroup facet={f.key} title={f.label} options={list} selection={selection} onSet={setFacet} />
                </Accordion>
              );
            })}
          </div>

          <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-rule pt-4">
            <span className="case-shadow inline-flex">
              <button
                type="button"
                onClick={() => go(draft)}
                disabled={!dirty}
                className="gloss clip-chevron-right h-10 bg-accent pr-7 pl-4 font-display text-xs font-bold tracking-[0.2em] text-void uppercase transition-colors hover:bg-accent-hi disabled:bg-steel disabled:text-mist"
              >
                Apply filters
              </button>
            </span>
            <button
              type="button"
              onClick={() => {
                setDraft({ ...EMPTY_FILTERS, sort: filters.sort, dir: filters.dir });
                go({ ...EMPTY_FILTERS, sort: filters.sort, dir: filters.dir });
              }}
              className="label-tech text-accent hover:text-accent-hi"
            >
              Clear all
            </button>
            <span className="label-tech text-mist-dim">Click a chip once to require it, twice to block it.</span>
          </div>
        </div>
      ) : null}
    </section>
  );
}

/** How the range sliders are split into sections. */
const RANGE_SECTIONS = [
  { title: "Release year & runtime", keys: ["year", "run"] },
  { title: "Scores", keys: ["imdb", "rt", "rta", "mc", "lb", "my"] },
] as const;

/** Ranges/sorts shown only when the page offers them (extraRanges / extraSorts). */
const OPTIONAL_KEYS: readonly string[] = ["my", "lb"];

/**
 * One collapsible filter section: a bevelled header bar (arrow, title, how many filters inside
 * are set) over a recessed body. Starts open when asked to or when something inside is set.
 */
function Accordion({
  title,
  active,
  extra,
  defaultOpen = false,
  children,
}: {
  title: string;
  /** Filters set inside - shown as a badge, and opens the section on first render. */
  active: number;
  /** Small note on the right, e.g. how many values there are to pick from. */
  extra?: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen || active > 0);
  const id = useId();
  return (
    <div className={`clip-corner-sm border ${open ? "border-rule-strong" : "border-rule"}`}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={id}
        className="bevel group flex w-full items-center gap-2 bg-panel/70 px-3 py-2 text-left hover:bg-panel"
      >
        <svg aria-hidden viewBox="0 0 10 10" className={`h-2 w-2 shrink-0 fill-accent transition-transform ${open ? "rotate-90" : ""}`}>
          <polygon points="0,0 10,5 0,10" />
        </svg>
        <span className="font-display text-[11px] font-semibold tracking-[0.18em] text-chrome-hi uppercase group-hover:text-accent-hi">{title}</span>
        {active ? <span className="gloss clip-tab bg-accent-deep px-1.5 font-display text-[10px] font-bold text-accent-hi">{active}</span> : null}
        {extra ? <span className="label-tech ml-auto text-mist-dim">{extra}</span> : null}
      </button>
      {open ? (
        <div id={id} className="well border-t border-rule bg-void/40 px-3 py-3">
          {children}
        </div>
      ) : null}
    </div>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="min-w-0">
      <legend className="label-tech mb-2 text-accent">{title}</legend>
      {children}
    </fieldset>
  );
}

/** Include = glossy accent, block = struck-through warning, off = plain. */
function Chip({ state, onClick, children, title }: { state: TriState | null; onClick: () => void; children: ReactNode; title?: string }) {
  const tone =
    state === "include"
      ? "gloss border-accent bg-accent-deep text-accent-hi"
      : state === "exclude"
        ? "border-signal/60 bg-signal/10 text-signal line-through"
        : "border-rule bg-panel/60 text-chrome hover:border-accent-dim hover:text-accent-hi";
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={state === "include" ? true : state === "exclude" ? "mixed" : false}
      className={`clip-tab inline-flex items-center gap-1 border px-2 py-1 text-xs transition-colors ${tone}`}
    >
      {state === "exclude" ? <span aria-hidden className="no-underline">✕</span> : null}
      {children}
    </button>
  );
}

/** Lists longer than this start with just their TOP_FEW biggest values; the rest are a find
 * or "Show all" away (the user, 2026-10-07: Studio has too many options to list). */
const LONG_LIST = 8;
const TOP_FEW = 5;

function FacetGroup({
  facet,
  title,
  options,
  selection,
  onSet,
}: {
  facet: FacetKey;
  title: string;
  options: Array<{ value: string; label: string; count: number }>;
  selection: Record<string, TriState>;
  onSet: (key: FacetKey, value: string, state: TriState | null) => void;
}) {
  const [all, setAll] = useState(false);
  const [find, setFind] = useState("");
  // Values matching nothing alongside the other filters are hidden; picked ones always stay.
  const available = useMemo(() => options.filter((o) => o.count > 0 || selection[o.value]), [options, selection]);
  const hidden = options.length - available.length;
  const long = available.length > LONG_LIST;
  const visible = useMemo(() => {
    const needle = find.trim().toLowerCase();
    if (needle) return available.filter((o) => o.label.toLowerCase().includes(needle));
    if (all || !long) return available;
    const top = [...available].sort((a, b) => b.count - a.count).slice(0, TOP_FEW);
    const picked = available.filter((o) => selection[o.value] && !top.includes(o));
    // Keep the list's own order (months stay Jan-Dec) among the ones shown.
    return available.filter((o) => top.includes(o) || picked.includes(o));
  }, [available, find, all, long, selection]);

  // No legend of its own - the section header above already names it.
  return (
    <div className="min-w-0">
      {long ? (
        <input
          type="search"
          value={find}
          onChange={(e) => setFind(e.target.value)}
          placeholder={`Find a ${title.toLowerCase()}...`}
          aria-label={`Find a ${title.toLowerCase()}`}
          className="well clip-corner-sm mb-2 h-8 w-full max-w-xs border border-rule bg-void/70 px-2 text-xs text-chrome-hi placeholder:text-mist-dim focus:border-accent focus:outline-none"
        />
      ) : null}
      <div className="flex flex-wrap gap-1.5">
        {visible.map((o) => {
          const state = selection[o.value] ?? null;
          return (
            <Chip
              key={o.value}
              state={state}
              title={state === "include" ? "Required - click to block" : state === "exclude" ? "Blocked - click to clear" : "Click to require"}
              onClick={() => onSet(facet, o.value, state === null ? "include" : state === "include" ? "exclude" : null)}
            >
              {o.label}
              <span className="text-[10px] text-mist-dim">{o.count}</span>
            </Chip>
          );
        })}
      </div>
      {find && !visible.length ? <p className="label-tech text-mist-dim">Nothing matching &ldquo;{find}&rdquo;.</p> : null}
      <div className="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1">
        {long && !find ? (
          <button type="button" onClick={() => setAll((a) => !a)} className="label-tech text-accent hover:text-accent-hi">
            {all ? `Top ${TOP_FEW} only` : `Show all ${available.length}`}
          </button>
        ) : null}
        {hidden ? (
          <span className="label-tech text-mist-dim">
            {hidden} hidden {"//"} no matches with your other filters
          </span>
        ) : null}
      </div>
    </div>
  );
}

const isMatchAllFacet = (key: FacetKey): key is MatchAllFacet => (MATCH_ALL_FACETS as readonly string[]).includes(key);

/** Any / All for a multi-value facet, with a plain-words line saying what it will find. */
function MatchSwitch({ all, picked, noun, onChange }: { all: boolean; picked: number; noun: string; onChange: (all: boolean) => void }) {
  return (
    <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1">
      <div role="radiogroup" aria-label="Match" className="well clip-corner-sm inline-flex border border-rule bg-void/60 p-0.5">
        {[
          { v: false, label: "Match any" },
          { v: true, label: "Match all" },
        ].map((o) => (
          <button
            key={o.label}
            type="button"
            role="radio"
            aria-checked={all === o.v}
            onClick={() => onChange(o.v)}
            className={`px-3 py-1 font-display text-[11px] tracking-[0.14em] uppercase ${all === o.v ? "gloss bg-accent-deep text-accent-hi" : "text-mist hover:text-chrome-hi"}`}
          >
            {o.label}
          </button>
        ))}
      </div>
      <span className="label-tech text-mist-dim">
        {picked < 2 ? `Pick 2+ ${noun} to choose` : all ? `Titles with every picked ${noun.replace(/s$/, "")}` : `Titles with any picked ${noun.replace(/s$/, "")}`}
      </span>
    </div>
  );
}

function FlagSwitch({ value, onChange }: { value: Flag; onChange: (v: Flag) => void }) {
  const opts: Array<{ v: Flag; label: string }> = [
    { v: null, label: "Any" },
    { v: "only", label: "Only" },
    { v: "no", label: "Hide" },
  ];
  return (
    <div role="radiogroup" className="well clip-corner-sm inline-flex border border-rule bg-void/60 p-0.5">
      {opts.map((o) => (
        <button
          key={o.label}
          type="button"
          role="radio"
          aria-checked={value === o.v}
          onClick={() => onChange(o.v)}
          className={`px-3 py-1 font-display text-[11px] tracking-[0.14em] uppercase ${
            value === o.v ? "gloss bg-accent-deep text-accent-hi" : "text-mist hover:text-chrome-hi"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function formatValue(n: number, step: number, unit: string) {
  return `${step < 1 ? n.toFixed(1) : n}${unit}`;
}

/** Two thumbs on one track. A thumb resting at its end of the track means "no limit". */
function DualRange({
  min,
  max,
  step,
  unit,
  value,
  onChange,
}: {
  min: number;
  max: number;
  step: number;
  unit: string;
  value: [number | null, number | null];
  onChange: (v: [number | null, number | null]) => void;
}) {
  const lo = value[0] ?? min;
  const hi = value[1] ?? max;
  const pct = (n: number) => ((n - min) / (max - min || 1)) * 100;
  const set = (nextLo: number, nextHi: number) => onChange([nextLo <= min ? null : nextLo, nextHi >= max ? null : nextHi]);
  return (
    <div>
      <div className="flex items-baseline justify-between font-display text-sm text-chrome-hi tabular-nums">
        <span>{value[0] === null ? <span className="text-mist">Any</span> : formatValue(lo, step, unit)}</span>
        <span className="label-tech">to</span>
        <span>{value[1] === null ? <span className="text-mist">Any</span> : formatValue(hi, step, unit)}</span>
      </div>
      <div className="dual-range relative mt-2 h-6">
        <span aria-hidden className="well clip-tab absolute inset-x-0 top-1/2 h-2 -translate-y-1/2 bg-deep/80" />
        <span
          aria-hidden
          className="gloss absolute top-1/2 h-2 -translate-y-1/2 bg-accent"
          style={{ left: `${pct(lo)}%`, width: `${Math.max(0, pct(hi) - pct(lo))}%` }}
        />
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={lo}
          aria-label="Minimum"
          onChange={(e) => set(Math.min(Number(e.target.value), hi), hi)}
        />
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={hi}
          aria-label="Maximum"
          onChange={(e) => set(lo, Math.max(Number(e.target.value), lo))}
        />
      </div>
    </div>
  );
}

/**
 * Documentary / realism as a notched two-handled slider, documentary (left) to fiction (right)
 * (REALISM_LEVELS). The picked span is written as `doc` includes; the full span means "any".
 * Each notch shows its label and how many titles it currently matches.
 */
function RealismSlider({
  selection,
  counts,
  onChange,
}: {
  selection: Record<string, TriState>;
  counts: number[];
  onChange: (next: Record<string, TriState>) => void;
}) {
  const last = REALISM_LEVELS.length - 1;
  const picked = Object.entries(selection)
    .filter(([, state]) => state === "include")
    .map(([value]) => realismIndex(value))
    .filter((i) => i >= 0);
  const lo = picked.length ? Math.min(...picked) : 0;
  const hi = picked.length ? Math.max(...picked) : last;
  const any = lo === 0 && hi === last;
  const pct = (i: number) => (i / last) * 100;
  // A notch's centre, matching where the 14px-wide thumb sits on the track.
  const at = (i: number) => `calc(7px + (100% - 14px) * ${i / last})`;

  const set = (nextLo: number, nextHi: number) => {
    const next: Record<string, TriState> = {};
    for (const [value, state] of Object.entries(selection)) if (realismIndex(value) < 0) next[value] = state;
    if (!(nextLo === 0 && nextHi === last)) for (let i = nextLo; i <= nextHi; i++) next[REALISM_LEVELS[i].value] = "include";
    onChange(next);
  };

  return (
    <div>
      <div className="flex items-baseline justify-between font-display text-sm text-chrome-hi">
        <span>{any ? <span className="text-mist">Any realism</span> : lo === hi ? REALISM_LEVELS[lo].label : `${REALISM_LEVELS[lo].label} to ${REALISM_LEVELS[hi].label}`}</span>
        {!any ? (
          <button type="button" onClick={() => set(0, last)} className="label-tech text-accent hover:text-accent-hi">
            Reset
          </button>
        ) : null}
      </div>
      <div className="dual-range relative mt-2 h-6">
        <span aria-hidden className="well clip-tab absolute inset-x-0 top-1/2 h-2 -translate-y-1/2 bg-deep/80" />
        <span aria-hidden className="gloss absolute top-1/2 h-2 -translate-y-1/2 bg-accent" style={{ left: `${pct(lo)}%`, width: `${pct(hi) - pct(lo)}%` }} />
        {/* Notch ticks */}
        {REALISM_LEVELS.map((l, i) => (
          <span
            key={l.value}
            aria-hidden
            className={`absolute top-1/2 h-3.5 w-px -translate-y-1/2 ${i >= lo && i <= hi ? "bg-accent-hi" : "bg-rule-strong"}`}
            style={{ left: at(i) }}
          />
        ))}
        <input
          type="range"
          min={0}
          max={last}
          step={1}
          value={lo}
          aria-label="Most real"
          aria-valuetext={REALISM_LEVELS[lo].label}
          onChange={(e) => set(Math.min(Number(e.target.value), hi), hi)}
        />
        <input
          type="range"
          min={0}
          max={last}
          step={1}
          value={hi}
          aria-label="Least real"
          aria-valuetext={REALISM_LEVELS[hi].label}
          onChange={(e) => set(lo, Math.max(Number(e.target.value), lo))}
        />
      </div>
      {/* Notch labels - click one to jump both handles to just that level. On phones every
          other label drops to a second row so neighbours don't overlap. */}
      <div className="relative mt-1 h-[3.75rem] sm:h-9">
        {REALISM_LEVELS.map((l, i) => (
          <button
            key={l.value}
            type="button"
            onClick={() => set(i, i)}
            className={`absolute flex flex-col items-center leading-tight whitespace-nowrap ${i % 2 ? "top-6 sm:top-0" : "top-0"} ${
              i === 0 ? "" : i === last ? "-translate-x-full" : "-translate-x-1/2"
            } ${i === 0 ? "items-start" : i === last ? "items-end" : ""}`}
            style={{ left: i === 0 ? 0 : i === last ? "100%" : at(i) }}
            title={`Only ${l.label.toLowerCase()}`}
          >
            <span className={`font-display text-[10px] tracking-wider uppercase ${i >= lo && i <= hi && !any ? "text-accent-hi" : "text-mist"} hover:text-accent-hi`}>
              {l.label}
            </span>
            <span className={`text-[10px] ${counts[i] ? "text-mist-dim" : "text-mist-dim/50"}`}>{counts[i]}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function DecadeChips({ bounds, onPick }: { bounds: [number, number]; onPick: (v: [number, number]) => void }) {
  const decades: number[] = [];
  for (let d = Math.floor(bounds[0] / 10) * 10; d <= bounds[1]; d += 10) decades.push(d);
  return (
    <div className="mt-2 flex flex-wrap gap-1">
      {decades.map((d) => (
        <button
          key={d}
          type="button"
          onClick={() => onPick([d, d + 9])}
          className="clip-tab border border-rule bg-panel/60 px-1.5 py-0.5 font-display text-[10px] tracking-wider text-mist hover:border-accent-dim hover:text-accent-hi"
        >
          {d}s
        </button>
      ))}
    </div>
  );
}

function SortControls({
  sorts,
  sort,
  dir,
  onChange,
}: {
  sorts: ReadonlyArray<(typeof SORTS)[number]>;
  sort: SortKey;
  dir: "asc" | "desc" | null;
  onChange: (sort: SortKey, dir: "asc" | "desc" | null) => void;
}) {
  const def = SORTS.find((s) => s.value === sort)?.dir ?? "asc";
  const current = dir ?? def;
  return (
    <div className="ml-auto flex items-center gap-2">
      <label className="label-tech" htmlFor="search-sort">
        Sort
      </label>
      <select
        id="search-sort"
        value={sort}
        onChange={(e) => onChange(e.target.value as SortKey, null)}
        className="well clip-corner-sm h-8 border border-rule bg-void/80 px-2 text-xs text-chrome-hi focus:border-accent focus:outline-none"
      >
        {sorts.map((s) => (
          <option key={s.value} value={s.value}>
            {s.label}
          </option>
        ))}
      </select>
      {sort !== "relevance" ? (
        <button
          type="button"
          onClick={() => onChange(sort, current === "asc" ? "desc" : "asc")}
          aria-label={current === "asc" ? "Ascending - switch to descending" : "Descending - switch to ascending"}
          className="gloss clip-corner-sm flex h-8 w-8 items-center justify-center bg-accent-deep text-accent-hi hover:bg-accent-dim"
        >
          <svg aria-hidden viewBox="0 0 10 10" className={`h-2.5 w-2.5 fill-current ${current === "asc" ? "" : "rotate-180"}`}>
            <polygon points="5,0 10,10 0,10" />
          </svg>
        </button>
      ) : null}
    </div>
  );
}

/** The applied filters as removable chips, so they stay visible with the panel closed. */
function ActiveChips({
  filters,
  options,
  profiles,
  onChange,
}: {
  filters: SearchFilters;
  options: SearchFacetOptions;
  profiles: ClientTasteProfile[];
  onChange: (f: SearchFilters) => void;
}) {
  const chips: Array<{ key: string; label: string; exclude?: boolean; remove: () => SearchFilters }> = [];
  for (const id of filters.profiles) {
    chips.push({
      key: `profile:${id}`,
      label: `Suits ${profiles.find((p) => p.id === id)?.name ?? "a deleted profile"}`,
      remove: () => ({ ...filters, profiles: filters.profiles.filter((x) => x !== id) }),
    });
  }
  for (const t of filters.types) {
    chips.push({
      key: `type:${t}`,
      label: RESULT_TYPES.find((x) => x.value === t)?.label ?? t,
      remove: () => ({ ...filters, types: filters.types.filter((x) => x !== t) }),
    });
  }
  // The realism slider's span reads as one chip.
  const realism = Object.entries(filters.facets.doc ?? {})
    .filter(([v, state]) => state === "include" && realismIndex(v) >= 0)
    .map(([v]) => realismIndex(v));
  if (realism.length) {
    const lo = REALISM_LEVELS[Math.min(...realism)].label;
    const hi = REALISM_LEVELS[Math.max(...realism)].label;
    chips.push({
      key: "doc:realism",
      label: `Realism: ${lo === hi ? lo : `${lo} to ${hi}`}`,
      remove: () => {
        const map = Object.fromEntries(Object.entries(filters.facets.doc ?? {}).filter(([v, s]) => !(s === "include" && realismIndex(v) >= 0)));
        return { ...filters, facets: { ...filters.facets, doc: map } };
      },
    });
  }
  for (const f of FACETS) {
    for (const [value, state] of Object.entries(filters.facets[f.key] ?? {})) {
      if (f.key === "doc" && state === "include" && realismIndex(value) >= 0) continue;
      chips.push({
        key: `${f.key}:${value}`,
        label: facetValueLabel(f.key, options.facets[f.key]?.find((o) => o.value.toLowerCase() === value.toLowerCase())?.value ?? value),
        exclude: state === "exclude",
        remove: () => {
          const map = { ...(filters.facets[f.key] ?? {}) };
          delete map[value];
          return { ...filters, facets: { ...filters.facets, [f.key]: map } };
        },
      });
    }
  }
  for (const r of RANGES) {
    const v = filters.ranges[r.key];
    if (!v) continue;
    const text = `${v[0] === null ? "" : formatValue(v[0], r.step, r.unit)}${v[0] !== null && v[1] !== null ? "-" : ""}${v[1] === null ? "+" : (v[0] === null ? "up to " : "") + formatValue(v[1], r.step, r.unit)}`;
    chips.push({
      key: `range:${r.key}`,
      label: `${r.label}: ${text}`,
      remove: () => {
        const ranges = { ...filters.ranges };
        delete ranges[r.key];
        return { ...filters, ranges };
      },
    });
  }
  for (const k of filters.matchAll) {
    if (Object.values(filters.facets[k] ?? {}).filter((s) => s === "include").length < 2) continue;
    chips.push({
      key: `match:${k}`,
      label: `${k === "genre" ? "Genres" : "Franchises"}: match all`,
      remove: () => ({ ...filters, matchAll: filters.matchAll.filter((x) => x !== k) }),
    });
  }
  const flag = (name: string, value: Flag, clear: () => SearchFilters) => {
    if (value) chips.push({ key: name, label: `${name}: ${value === "only" ? "only" : "hidden"}`, remove: clear });
  };
  flag("Steelbook", filters.steelbook, () => ({ ...filters, steelbook: null }));
  flag("Box sets", filters.boxSet, () => ({ ...filters, boxSet: null }));
  flag("In a box set", filters.inBoxSet, () => ({ ...filters, inBoxSet: null }));
  if (!chips.length) return null;
  return (
    <div className="flex flex-wrap gap-1.5 border-b border-rule px-4 py-2.5">
      {chips.map((c) => (
        <button
          key={c.key}
          type="button"
          onClick={() => onChange(c.remove())}
          aria-label={`Remove filter ${c.label}`}
          className={`clip-tab inline-flex items-center gap-1.5 border px-2 py-0.5 text-xs ${
            c.exclude ? "border-signal/60 bg-signal/10 text-signal" : "gloss border-accent bg-accent-deep text-accent-hi"
          }`}
        >
          {c.exclude ? "Not " : ""}
          {c.label}
          <span aria-hidden className="text-[10px] opacity-70">✕</span>
        </button>
      ))}
    </div>
  );
}
