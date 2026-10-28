import Link from "next/link";
import { PosterImage } from "@/components/PosterImage";
import type { SearchHit } from "@/lib/catalog/search";

/** Franchise / director / person row: small image + name + subtitle, angular panel. */
export function EntityRow({ hit }: { hit: SearchHit }) {
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
