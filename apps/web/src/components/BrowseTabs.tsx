"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { BrowseTab } from "@/lib/catalog/browse";

/**
 * The Browse tab strip under the search bar (2026-10-28): a brushed-metal nav bar of segmented
 * uppercase tabs, in the spirit of the 2Advanced reference's own nav (concept design
 * aesthetic-01). The tabs share the bar's full width evenly; the current one is lit with the
 * accent gloss. On a narrow screen the strip scrolls sideways instead of squashing the labels.
 */
export function BrowseTabs({ tabs }: { tabs: BrowseTab[] }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Browse" className="chrome-bar border-t border-rule">
      <ul className="scrollbar-none mx-auto flex max-w-screen-2xl overflow-x-auto">
        {tabs.map((tab) => {
          const active = pathname === tab.href || pathname.startsWith(`${tab.href}/`);
          return (
            <li key={tab.slug} className="flex-1 shrink-0 border-r border-rule first:border-l">
              <Link
                href={tab.href}
                aria-current={active ? "page" : undefined}
                className={`block px-5 py-2.5 text-center font-display text-sm font-semibold tracking-[0.18em] whitespace-nowrap uppercase transition-colors outline-none focus-visible:text-accent-hi sm:text-[15px] ${
                  active ? "gloss bg-accent-deep text-accent-hi" : "text-mist hover:bg-panel-hi/50 hover:text-chrome-hi"
                }`}
              >
                {tab.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
