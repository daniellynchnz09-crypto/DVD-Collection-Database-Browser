/**
 * Audit script, run by hand periodically: lists every title that has a confirmed Rotten
 * Tomatoes critics score (per OMDB's own `Ratings` array) but no `rotten_tomatoes_page` saved
 * - added 2026-09-18 after the user found "The Day the Earth Stood Still" (1951) missing its
 * RT link despite the score genuinely existing.
 *
 * ROOT CAUSE (see rottenTomatoes.ts's own header comment): `lookupRottenTomatoesPage` has no
 * real RT search to fall back on - Rotten Tomatoes' own robots.txt explicitly disallows
 * `/search`, so this project (which has consistently respected every site's robots.txt
 * throughout this feature) can't scrape RT's search results the way it can a plain `/m/<slug>`
 * movie page. Instead it GUESSES a slug from the title text alone
 * (`the_day_the_earth_stood_still`) and only accepts the guess if the resulting page's own
 * JSON-LD both names the same film and reports the same score. For "The Day the Earth Stood
 * Still" specifically, RT's real slug is `1005371-day_the_earth_stood_still` (a numeric-ID
 * prefix, confirmed live against two older Sheet-imported rows for the same film that already
 * carry the correct link, presumably typed in by hand before this automation existed) - the
 * guessed slug returns a flat 404, so the lookup correctly returned null rather than a wrong
 * link, exactly as designed ("wrong link is worse than no link" - see rottenTomatoes.ts). This
 * is a genuine, unfixable-by-better-guessing class of failure (irregular/numeric-ID RT slugs,
 * articles dropped from the slug, etc.), not a one-off bug - it will keep happening for other
 * titles with an equally irregular real slug.
 *
 * Since there's no automated fix available within this project's own scraping-ethics
 * constraints, this script exists to make the resulting gap VISIBLE instead of silent -
 * exactly the same "surface an automation gap for manual review" pattern already established
 * for the private-only pricing feature's AUTO-ESTIMATED NOTE (see that feature's own planning
 * doc). Run this occasionally, manually search Rotten Tomatoes for each title
 * it lists, and paste the real URL into that title's `rotten_tomatoes_page` cell in the Sheet
 * (which flows back into Supabase via the existing webhook, no separate write path needed).
 *
 * Read-only - never writes anything itself. Usage: npx tsx src/find-missing-rotten-tomatoes.ts
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { omdbGetById, extractImdbIdFromPage } from "@danflix/shared";

interface TitleRow {
  unique_id: string;
  title: string;
  release_name: string | null;
  imdb_page: string | null;
}

async function main() {
  const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

  const rows: TitleRow[] = [];
  const PAGE_SIZE = 1000;
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from("titles")
      .select("unique_id, title, release_name, imdb_page")
      .is("rotten_tomatoes_page", null)
      .not("imdb_page", "is", null)
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as TitleRow[]));
    if ((data ?? []).length < PAGE_SIZE) break;
  }

  console.log(`Checking ${rows.length} title(s) with no saved Rotten Tomatoes link...\n`);

  let found = 0;
  for (const row of rows) {
    const imdbId = extractImdbIdFromPage(row.imdb_page);
    if (!imdbId) continue;

    const detail = await omdbGetById(imdbId);
    const rtRating = detail?.Ratings?.find((r) => r.Source === "Rotten Tomatoes");
    if (!rtRating) continue;

    found++;
    const displayName = row.release_name ? `${row.title} (${row.release_name})` : row.title;
    console.log(`- ${displayName} - ${rtRating.Value} on Rotten Tomatoes, no link saved (${row.unique_id})`);
  }

  console.log(
    found === 0
      ? "\nNothing missing - every title with a real Rotten Tomatoes score already has a link saved."
      : `\n${found} title(s) have a real score but no saved link (guessed-slug lookup failed for each - see this file's own header comment for why). Search Rotten Tomatoes by hand for each and paste the real URL into that title's cell in the Sheet.`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
