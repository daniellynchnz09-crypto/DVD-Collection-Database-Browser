import Link from "next/link";
import { Panel } from "@/components/Panel";

/** Shared body for the title routes' not-found.tsx files (bad or unknown ids). */
export function TitleNotFound({ what }: { what: string }) {
  return (
    <div className="mx-auto flex max-w-screen-md flex-col gap-4 px-4 py-16 sm:px-6">
      <Panel title="Signal lost" aside="404">
        <p className="text-chrome">That {what} isn&apos;t in the collection.</p>
        <p className="mt-1 text-sm text-mist">The link may be mistyped, or the item may have been removed.</p>
        <div className="mt-4 flex gap-3">
          <Link href="/" className="clip-chevron-right bg-accent-deep px-4 py-2 pr-6 font-display text-xs font-semibold tracking-[0.18em] text-accent-hi uppercase hover:bg-accent-dim">
            Browse the collection
          </Link>
        </div>
      </Panel>
    </div>
  );
}
