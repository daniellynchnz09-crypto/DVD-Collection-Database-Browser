import Link from "next/link";
import type { ReactNode } from "react";
import { SearchBox } from "./SearchBox";
import { SettingsMenu } from "./SettingsMenu";

/**
 * Global site header (WEB APP DESIGN.md): logo top-left, search in the middle, settings on the
 * right. On phones the search drops to its own full-width second line.
 *
 * `search` lets the layout swap in an enhanced search (the Search agent's live-dropdown
 * wrapper around SearchBox) without restructuring the header; defaults to the plain shell.
 */
export function Header({ search }: { search?: ReactNode }) {
  const searchSlot = search ?? <SearchBox />;
  return (
    <header className="sticky top-0 z-40 border-b border-rule-strong bg-abyss/85 backdrop-blur-md">
      {/* Thin accent rule along the very top, like the reference's chrome edge */}
      <div aria-hidden className="h-px bg-linear-to-r from-transparent via-accent/70 to-transparent" />
      <div className="mx-auto grid max-w-screen-2xl grid-cols-[auto_1fr_auto] items-center gap-x-4 gap-y-2 px-4 py-2.5 sm:px-6">
        <Link href="/" className="group flex items-center gap-2 outline-none" aria-label="DANFLIX 5.0 home">
          <span aria-hidden className="clip-chevron-right h-6 w-3 bg-accent transition-colors group-hover:bg-accent-hi" />
          <span className="font-display text-xl font-bold tracking-[0.12em] whitespace-nowrap text-accent drop-shadow-[0_0_8px_rgb(92_200_255/0.45)] group-hover:text-accent-hi sm:text-2xl">
            DANFLIX<span className="ml-1.5 text-accent-hi">5.0</span>
          </span>
        </Link>

        <div className="col-span-3 row-start-2 md:col-span-1 md:col-start-2 md:row-start-1 md:mx-auto md:w-full md:max-w-xl">
          {searchSlot}
        </div>

        <div className="col-start-3 row-start-1 flex justify-end">
          <SettingsMenu />
        </div>
      </div>
    </header>
  );
}
