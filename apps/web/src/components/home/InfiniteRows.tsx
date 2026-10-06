"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { HomeRowData } from "@/lib/catalog/home";
import { HomeRow } from "./HomeRow";

interface Batch {
  rows: HomeRowData[];
  nextCursor: number | null;
}

/**
 * The endless vertical part of the home page: when the sentinel nears the viewport, fetch the
 * next few rows of the server's seeded plan from /home-rows. The same seed as the server render
 * means no row repeats on one page load; the plan eventually runs out and an end marker shows.
 */
export function InfiniteRows({
  seed,
  startCursor,
  shownIds,
}: {
  seed: number;
  /** Plan position after the rows the server already rendered; null = plan already done. */
  startCursor: number | null;
  /** Ids already on the page (defensive dedupe). */
  shownIds: string[];
}) {
  const [rows, setRows] = useState<HomeRowData[]>([]);
  const [cursor, setCursor] = useState<number | null>(startCursor);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const sentinel = useRef<HTMLDivElement>(null);
  const seen = useRef(new Set(shownIds));
  const inFlight = useRef(false);

  const loadMore = useCallback(async () => {
    if (cursor === null || inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    setFailed(false);
    try {
      const res = await fetch(`/home-rows?seed=${seed}&cursor=${cursor}`);
      if (!res.ok) throw new Error(String(res.status));
      const batch = (await res.json()) as Batch;
      const fresh = batch.rows.filter((r) => !seen.current.has(r.id));
      for (const r of fresh) seen.current.add(r.id);
      setRows((prev) => [...prev, ...fresh]);
      setCursor(batch.nextCursor);
    } catch {
      setFailed(true);
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, [cursor, seed]);

  // A fresh observer per cursor: its first callback reports the current state, so if a batch
  // came back short and the sentinel is still on screen, the next batch loads straight away.
  useEffect(() => {
    const el = sentinel.current;
    if (!el || cursor === null || failed) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) void loadMore();
      },
      { rootMargin: "900px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [cursor, failed, loadMore]);

  return (
    <>
      {rows.map((row) => (
        <HomeRow key={row.id} row={row} />
      ))}

      <div ref={sentinel} className="px-4 sm:px-6" aria-live="polite">
        {cursor !== null && !failed ? <LoadingRow active={loading} /> : null}
        {failed ? (
          <div className="flex items-center gap-3">
            <span className="label-tech text-signal">Signal lost // rows failed to load</span>
            <button
              type="button"
              onClick={() => void loadMore()}
              className="clip-chevron-right bg-accent-deep py-1.5 pr-5 pl-3 font-display text-[11px] font-semibold tracking-[0.18em] text-accent-hi uppercase hover:bg-accent-dim"
            >
              Retry
            </button>
          </div>
        ) : null}
        {cursor === null ? <EndOfArchive /> : null}
      </div>
    </>
  );
}

/** Ghost poster row shown while the next batch streams in. */
function LoadingRow({ active }: { active: boolean }) {
  return (
    <div className={`transition-opacity ${active ? "opacity-100" : "opacity-40"}`}>
      <div className="mb-2 flex items-center gap-3">
        <span className="label-tech text-accent">Loading</span>
        <span className="h-3 w-40 animate-pulse bg-panel-hi" />
        <span aria-hidden className="h-px flex-1 bg-linear-to-r from-rule-strong to-transparent" />
      </div>
      <div className="flex gap-3 overflow-hidden sm:gap-4">
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className="clip-corner aspect-[2/3] w-32 shrink-0 animate-pulse bg-panel ring-1 ring-rule ring-inset sm:w-40" style={{ animationDelay: `${i * 80}ms` }} />
        ))}
      </div>
    </div>
  );
}

function EndOfArchive() {
  return (
    <div className="flex flex-col items-center gap-3 py-10 text-center">
      <div aria-hidden className="flex items-center gap-1 text-accent-dim">
        {[0, 1, 2].map((i) => (
          <svg key={i} viewBox="0 0 10 8" className="h-2 w-2.5 fill-current" style={{ opacity: 1 - i * 0.3 }}>
            <polygon points="0,0 10,0 5,8" />
          </svg>
        ))}
      </div>
      <p className="font-display text-sm tracking-[0.2em] text-chrome uppercase">End of the archive</p>
      <p className="label-tech">Every shelf has been browsed // reload for a new shuffle</p>
      <button
        type="button"
        onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
        className="clip-corner-sm mt-1 border border-rule bg-void/60 px-4 py-2 font-display text-[11px] font-semibold tracking-[0.18em] text-accent uppercase hover:border-accent hover:text-accent-hi"
      >
        Back to top
      </button>
    </div>
  );
}
