"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { BrowseTab } from "@/lib/catalog/browse";

/**
 * The Browse tab strip under the search bar (2026-10-28): a brushed-metal nav bar of segmented
 * uppercase tabs, in the spirit of the 2Advanced reference's own nav (concept design
 * aesthetic-01). The current tab is lit with the accent gloss and a chevron. On a narrow screen
 * the strip scrolls sideways.
 */
export function BrowseTabs({ tabs }: { tabs: BrowseTab[] }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Browse" className="chrome-bar border-t border-rule">
      <ul className="scrollbar-none mx-auto flex max-w-screen-2xl overflow-x-auto px-4 sm:px-6 md:justify-center">
        {tabs.map((tab) => {
          const active = pathname === tab.href || pathname.startsWith(`${tab.href}/`);
          return (
            <li key={tab.slug} className="shrink-0 border-r border-rule first:border-l">
              <Link
                href={tab.href}
                aria-current={active ? "page" : undefined}
                className={`flex items-center gap-1.5 px-4 py-1.5 font-display text-[11px] font-semibold tracking-[0.18em] whitespace-nowrap uppercase transition-colors outline-none focus-visible:text-accent-hi sm:px-5 ${
                  active ? "gloss bg-accent-deep text-accent-hi" : "text-mist hover:bg-panel-hi/50 hover:text-chrome-hi"
                }`}
              >
                <svg aria-hidden viewBox="0 0 8 10" className={`h-2 w-1.5 fill-current ${active ? "text-accent" : "text-accent-dim"}`}>
                  <polygon points="0,0 8,5 0,10" />
                </svg>
                {tab.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
