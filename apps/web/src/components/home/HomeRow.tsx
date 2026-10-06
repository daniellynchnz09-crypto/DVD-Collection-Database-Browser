import type { HomeRowData } from "@/lib/catalog/home";
import { PosterCard } from "../PosterCard";
import { ScrollRow } from "../ScrollRow";

/**
 * One browse row on the home page. No "use client" and no server-only imports, so the server
 * page and the client-side infinite loader render rows identically.
 */
export function HomeRow({ row, preloadCount = 0 }: { row: HomeRowData; preloadCount?: number }) {
  return (
    <ScrollRow
      label={row.label}
      title={<span title={row.fullTitle}>{row.title}</span>}
      href={row.href ?? undefined}
      hrefLabel={row.hrefLabel}
    >
      {row.cards.map((card, i) => (
        <PosterCard key={card.key} card={card} preload={i < preloadCount} />
      ))}
      <RowEnd count={row.cards.length} />
    </ScrollRow>
  );
}

/** A visible terminator so it's obvious the row ends rather than loops (the owner dislikes
 * Netflix rows that repeat forever). */
function RowEnd({ count }: { count: number }) {
  return (
    <div aria-hidden className="flex w-16 shrink-0 flex-col items-center justify-center gap-2 self-stretch pb-12 sm:w-20">
      <span className="h-full w-px bg-linear-to-b from-transparent via-rule-strong to-transparent" />
      <span className="label-tech text-[9px] whitespace-nowrap text-mist-dim">End // {count}</span>
      <span className="h-full w-px bg-linear-to-b from-transparent via-rule-strong to-transparent" />
    </div>
  );
}
