import type { ReactNode } from "react";
import { BackButton } from "./BackButton";

/**
 * The per-page header that sits under the global site header on every title/person/franchise
 * page: back button + page title (WEB APP DESIGN.md "TITLE PAGES").
 */
export function PageHeader({
  title,
  eyebrow,
  actions,
  backFallbackHref = "/",
}: {
  title: ReactNode;
  /** Small uppercase label above the title, e.g. "DVD // Blu-ray" or "Franchise". */
  eyebrow?: ReactNode;
  /** Right-aligned extras (badges, owner actions). */
  actions?: ReactNode;
  backFallbackHref?: string;
}) {
  return (
    <div className="border-b border-rule bg-abyss/70 backdrop-blur-sm">
      <div className="mx-auto flex max-w-screen-2xl items-center gap-4 px-4 py-3 sm:px-6">
        <BackButton fallbackHref={backFallbackHref} />
        <div className="min-w-0 flex-1">
          {eyebrow ? <div className="label-tech truncate text-accent">{eyebrow}</div> : null}
          <h1 className="truncate font-display text-lg font-semibold tracking-wide text-chrome-hi sm:text-2xl">{title}</h1>
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </div>
    </div>
  );
}
