import { HomeHero } from "@/components/home/HomeHero";
import { HomeRow } from "@/components/home/HomeRow";
import { InfiniteRows } from "@/components/home/InfiniteRows";
import {
  HOME_INITIAL_PLAN_ROWS,
  loadArchiveStats,
  loadHomeFeature,
  loadHomeHeadRows,
  loadHomePlanRows,
  randomHomeSeed,
} from "@/lib/catalog/home";

// Re-rendered at most every 5 minutes: new scans show up without every visit hitting
// Supabase, and each re-render draws a new seed, so the featured title and row shuffle rotate.
export const revalidate = 300;

/**
 * Home / Browse (WEB APP DESIGN.md): Netflix-style rows that each END, on a page that keeps
 * loading new rows as you scroll. The server renders the hero, the fixed head rows and the
 * first few plan rows; <InfiniteRows> continues the same seeded plan via /home-rows.
 */
export default async function Home() {
  const seed = randomHomeSeed();
  const [feature, stats, headRows, planStart] = await Promise.all([
    loadHomeFeature(seed),
    loadArchiveStats(),
    loadHomeHeadRows(seed),
    loadHomePlanRows(seed, 0, HOME_INITIAL_PLAN_ROWS),
  ]);
  const rows = [...headRows, ...planStart.rows];

  return (
    <div className="flex flex-col">
      <HomeHero feature={feature} stats={stats} />

      <div className="flex flex-col gap-8 py-6 sm:gap-10 sm:py-8">
        {rows.length === 0 ? (
          <p className="px-4 text-mist sm:px-6">The collection couldn&apos;t be loaded right now.</p>
        ) : (
          <>
            {rows.map((row, i) => (
              <HomeRow key={row.id} row={row} preloadCount={i === 0 ? 4 : 0} />
            ))}
            <InfiniteRows seed={seed} startCursor={planStart.nextCursor} shownIds={rows.map((r) => r.id)} />
          </>
        )}
      </div>
    </div>
  );
}
