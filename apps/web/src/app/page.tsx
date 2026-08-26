import type { Title } from "@danflix/shared";

// Placeholder home page confirming the monorepo/shared-package wiring works.
// The real Home/Browse page (rows, search bar, settings) is Phase 2 -
// see Claude/TECH STACK AND ARCHITECTURE.md's Phased Build Order.
const EXAMPLE_TITLE: Pick<Title, "title" | "format"> = {
  title: "Nothing logged yet",
  format: "n/a",
};

export default function Home() {
  return (
    <div className="flex min-h-screen flex-col bg-gradient-to-b from-black to-zinc-900 text-zinc-100">
      <header className="flex items-center justify-between border-b border-zinc-800 px-6 py-4">
        <span className="text-xl font-bold tracking-wide text-sky-400">DANFLIX 5.0</span>
        <span className="text-sm text-zinc-500">search (phase 2)</span>
        <span className="text-sm text-zinc-500">settings (phase 4)</span>
      </header>
      <main className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
        <p className="text-zinc-400">Phase 0 scaffold - browse/search UI lands in Phase 2.</p>
        <p className="text-sm text-zinc-600">Example type from @danflix/shared: {EXAMPLE_TITLE.title}</p>
      </main>
    </div>
  );
}
