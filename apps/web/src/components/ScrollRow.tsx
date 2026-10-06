"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

/**
 * A titled, horizontally scrolling row of cards. It ENDS: no looping/wrapping (the owner
 * explicitly dislikes Netflix repeating a franchise row forever) - the arrow buttons disable
 * at each end. Touch/trackpad scrolling works natively; arrows page by ~85% of the width.
 */
export function ScrollRow({
  title,
  label,
  href,
  hrefLabel = "View all",
  children,
}: {
  title: ReactNode;
  /** Tiny uppercase tag before the title (e.g. "Franchise"). */
  label?: ReactNode;
  /** Optional "View all" link to the full list page. */
  href?: string;
  hrefLabel?: string;
  children: ReactNode;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const [canLeft, setCanLeft] = useState(false);
  const [canRight, setCanRight] = useState(false);

  const update = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    setCanLeft(el.scrollLeft > 4);
    setCanRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 4);
  }, []);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    el.addEventListener("scroll", update, { passive: true });
    return () => {
      ro.disconnect();
      el.removeEventListener("scroll", update);
    };
  }, [update]);

  const page = (dir: -1 | 1) => {
    const el = scroller.current;
    if (el) el.scrollBy({ left: dir * el.clientWidth * 0.85, behavior: "smooth" });
  };

  return (
    <section className="relative">
      <div className="mb-2 flex items-end gap-3 px-4 sm:px-6">
        {label ? <span className="label-tech text-accent">{label}</span> : null}
        <h2 className="font-display text-base font-semibold tracking-wider text-chrome-hi uppercase sm:text-lg">{title}</h2>
        <span aria-hidden className="mb-1.5 h-px flex-1 bg-linear-to-r from-rule-strong to-transparent" />
        {href ? (
          <Link href={href} className="label-tech text-accent hover:text-accent-hi">
            {hrefLabel} &#9656;
          </Link>
        ) : null}
      </div>

      <div className="group/row relative">
        <div ref={scroller} className="scrollbar-none flex snap-x gap-3 overflow-x-auto scroll-px-4 px-4 pt-1 pb-2 sm:gap-4 sm:scroll-px-6 sm:px-6 [&>*]:snap-start">
          {children}
        </div>
        <RowArrow dir={-1} enabled={canLeft} onClick={() => page(-1)} />
        <RowArrow dir={1} enabled={canRight} onClick={() => page(1)} />
      </div>
    </section>
  );
}

function RowArrow({ dir, enabled, onClick }: { dir: -1 | 1; enabled: boolean; onClick: () => void }) {
  const left = dir === -1;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!enabled}
      aria-label={left ? "Scroll left" : "Scroll right"}
      className={`absolute top-1 bottom-12 z-10 hidden w-10 items-center justify-center bg-void/75 text-accent backdrop-blur-sm transition sm:flex ${
        // Flat side flush with the page edge, angled side facing the cards (2026-10-06 - the
        // point used to sit against the edge, leaving gaps at the corners).
        left ? "clip-chevron-right left-0" : "clip-chevron-left right-0"
      } ${enabled ? "opacity-0 group-hover/row:opacity-100 hover:bg-accent-deep hover:text-accent-hi focus-visible:opacity-100" : "pointer-events-none opacity-0"}`}
    >
      <svg aria-hidden viewBox="0 0 10 16" className="h-4 w-2.5 fill-current">
        <polygon points={left ? "10,0 10,16 0,8" : "0,0 10,8 0,16"} />
      </svg>
    </button>
  );
}
