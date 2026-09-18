/**
 * Rotten Tomatoes has no public API, unlike IMDb - whose own robots.txt explicitly states
 * "Use of any device, tool, or process designed to data mine or scrape the content using
 * automated means is prohibited without prior written permission from IMDb" (confirmed by
 * fetching it directly), which is exactly why this project uses OMDB instead of IMDb
 * itself. Rotten Tomatoes' robots.txt is far more permissive (only a handful of specific
 * paths - /pictures, /search, ... - are disallowed; plain /m/<slug> movie pages are not),
 * so a low-volume, one-fetch-per-confirmed-title lookup here doesn't hit the same wall.
 *
 * OMDB's own `Ratings` array already tells the caller whether a title has a critics score
 * at all (a "Rotten Tomatoes" source entry) without touching RT's site - see
 * packages/shared/src/omdb.ts's OmdbDetail. This only fetches Rotten Tomatoes itself to
 * find and verify the actual page URL, and only once that score has already confirmed one
 * exists.
 *
 * Deliberately conservative: constructs one guessed slug from the title, fetches it, and
 * only returns a URL when the page's own structured data (a standard schema.org JSON-LD
 * block, present on every real movie page) both names the same film and reports a
 * Tomatometer score matching what OMDB already gave. Anything else - the guessed slug
 * doesn't exist, it's a different film, no JSON-LD, the score doesn't match - returns null
 * rather than a guessed link, since a wrong Rotten Tomatoes link is worse than no link.
 */

function guessSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

interface RottenTomatoesJsonLd {
  name?: string;
  aggregateRating?: { name?: string; ratingValue?: string };
}

export async function lookupRottenTomatoesPage(
  title: string,
  criticsScorePercent: number
): Promise<string | null> {
  const slug = guessSlug(title);
  if (!slug) return null;

  const url = `https://www.rottentomatoes.com/m/${slug}`;
  let html: string;
  let finalUrl: string;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; DanflixCollectionBot/1.0)" },
    });
    if (!res.ok) return null;
    // RT redirects a same-titled-film's bare slug to a disambiguated "<slug>_<year>" one
    // (found live: the guessed "thor_ragnarok" 302s to "thor_ragnarok_2017") - fetch already
    // follows that, so store the actual page it landed on rather than the guessed slug that
    // just bounces through an extra redirect every time the link is opened.
    finalUrl = res.url;
    html = await res.text();
  } catch {
    return null;
  }

  const match = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  if (!match) return null;

  let data: RottenTomatoesJsonLd;
  try {
    data = JSON.parse(match[1]);
  } catch {
    return null;
  }

  // RT's own schema.org `name` field is "<Title> (<Year>)", not the bare title - found live
  // on Thor: Ragnarok's real page ("Thor: Ragnarok (2017)"), which meant this exact-match
  // check was silently rejecting a genuinely correct guess (right slug, right film, right
  // score) for seemingly no reason. Strip a trailing " (YYYY)" before comparing; a title
  // that never gets one (as apparently happened to work by chance for the original Paper
  // Planes verification) is unaffected, since the strip is then just a no-op.
  const dataName = data.name?.replace(/\s*\(\d{4}\)\s*$/, "").trim().toLowerCase();
  if (dataName !== title.trim().toLowerCase()) return null;

  const isTomatometer = data.aggregateRating?.name === "Tomatometer";
  const pageScore = isTomatometer ? Number(data.aggregateRating?.ratingValue) : NaN;
  if (Number.isNaN(pageScore) || pageScore !== criticsScorePercent) return null;

  return finalUrl;
}
