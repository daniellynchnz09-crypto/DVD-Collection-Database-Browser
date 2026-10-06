import Link from "next/link";

export interface RelatedLink {
  href: string;
  /** Page type, e.g. "Movie / TV", "Franchise", "Collection". */
  kind: string;
  label: string;
  detail?: string | null;
}

/** The "list that has links to its respective Film/TV entry, Franchise entry or collection"
 * on DVD and Collection pages - angular rows, one per related page. */
export function RelatedLinks({ links }: { links: RelatedLink[] }) {
  if (links.length === 0) return null;
  return (
    <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
      {links.map((l) => (
        <li key={`${l.kind}:${l.href}`}>
          <Link
            href={l.href}
            className="panel clip-corner group flex items-center gap-3 px-4 py-3 transition-colors hover:[--panel-line:var(--color-accent)]"
          >
            <svg aria-hidden viewBox="0 0 8 10" className="h-3 w-2.5 shrink-0 fill-accent transition-transform group-hover:translate-x-0.5">
              <polygon points="0,0 8,5 0,10" />
            </svg>
            <span className="min-w-0 flex-1">
              <span className="label-tech block text-accent">{l.kind}</span>
              <span className="block truncate font-medium text-chrome-hi group-hover:text-accent-hi">{l.label}</span>
              {l.detail ? <span className="block truncate text-xs text-mist">{l.detail}</span> : null}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
