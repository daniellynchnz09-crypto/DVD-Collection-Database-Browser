"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { searchHref } from "@/lib/catalog/display";
import { SearchBox } from "../SearchBox";
import { dropdownOptionHrefs, pickShownResults, SearchDropdown, type DropdownResults } from "./SearchDropdown";

const DEBOUNCE_MS = 180;
const MIN_LENGTH = 2;

/** Responses shared across remounts (navigation remounts the box), capped so it can't grow
 * without bound in a long session. */
const responseCache = new Map<string, DropdownResults>();
const CACHE_MAX = 100;

/**
 * The header search: the foundation SearchBox plus a live, grouped results dropdown fed by
 * /api/search. Wrapped in Suspense because it reads useSearchParams (to pre-fill the box on
 * /search?q=), with the plain SearchBox as the fallback.
 */
export function HeaderSearch() {
  return (
    <Suspense fallback={<SearchBox />}>
      <KeyedLiveSearch />
    </Suspense>
  );
}

function KeyedLiveSearch() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // On /search the box shows the current query; elsewhere it starts empty. Keying by it resets
  // the box on navigation instead of leaving a stale query (and open dropdown) behind.
  const pageQuery = pathname === "/search" ? (searchParams.get("q") ?? "") : "";
  return <LiveSearch key={`${pathname}?${pageQuery}`} initialQuery={pageQuery} />;
}

function LiveSearch({ initialQuery }: { initialQuery: string }) {
  const router = useRouter();
  const [typed, setTyped] = useState(initialQuery);
  const [results, setResults] = useState<DropdownResults | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [active, setActive] = useState(-1);
  const latest = useRef(initialQuery);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inflight = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      inflight.current?.abort();
    },
    [],
  );

  const fetchResults = useCallback(async (q: string) => {
    const key = q.toLowerCase();
    const cached = responseCache.get(key);
    if (cached) {
      setResults(cached);
      setFailed(false);
      setLoading(false);
      return;
    }
    inflight.current?.abort();
    const controller = new AbortController();
    inflight.current = controller;
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`, { signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as DropdownResults;
      responseCache.set(key, data);
      if (responseCache.size > CACHE_MAX) responseCache.delete(responseCache.keys().next().value!);
      // Ignore a response that lands after the user typed something else.
      if (latest.current.trim().toLowerCase() !== key) return;
      setResults(data);
      setFailed(false);
      setLoading(false);
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      setFailed(true);
      setLoading(false);
    }
  }, []);

  const onQueryChange = useCallback(
    (raw: string) => {
      latest.current = raw;
      setTyped(raw);
      setActive(-1);
      if (timer.current) clearTimeout(timer.current);
      const q = raw.trim();
      if (q.length < MIN_LENGTH) {
        inflight.current?.abort();
        setLoading(false);
        return;
      }
      setLoading(true);
      // Debounced so a burst of keystrokes costs one request.
      timer.current = setTimeout(() => void fetchResults(q), DEBOUNCE_MS);
    },
    [fetchResults],
  );

  const shown = pickShownResults(results, typed.trim(), MIN_LENGTH);

  const onInputKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const hrefs = dropdownOptionHrefs(shown.results, typed.trim(), MIN_LENGTH);
    const count = hrefs.length;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (count === 0) return;
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      // Cycles through -1 (no option highlighted) so the user can get back to plain typing.
      setActive((i) => {
        const next = Math.min(i, count - 1) + step;
        if (next >= count) return -1;
        if (next < -1) return count - 1;
        return next;
      });
    } else if (e.key === "Enter" && active >= 0 && active < count) {
      e.preventDefault();
      setActive(-1);
      // Blurring closes the SearchBox dropdown (it closes when focus leaves its wrapper).
      e.currentTarget.blur();
      router.push(hrefs[active]);
    } else if (e.key === "Escape") {
      setActive(-1);
    }
  };

  return (
    <SearchBox
      initialQuery={initialQuery}
      onQueryChange={onQueryChange}
      onInputKeyDown={onInputKeyDown}
      renderDropdown={({ query, close, listboxId }) => (
        <SearchDropdown
          query={query.trim()}
          minLength={MIN_LENGTH}
          results={shown.results}
          stale={shown.stale}
          loading={loading}
          failed={failed}
          active={active}
          onActiveChange={setActive}
          onPick={() => {
            setActive(-1);
            close();
          }}
          listboxId={listboxId}
          seeAllHref={searchHref(query.trim())}
        />
      )}
    />
  );
}
