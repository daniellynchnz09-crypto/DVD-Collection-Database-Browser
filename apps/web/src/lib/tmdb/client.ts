import "server-only";

/**
 * Minimal server-only TMDb reader for data the site fetches live rather than storing (per
 * web-app-build-plan.md: TV episode lists for the Series browser). Uses the v4 read access
 * token as a bearer header so the key never appears in a URL or reaches the browser.
 *
 * Every call fails soft (returns null) - a TMDb outage or slow response must only empty the
 * one section that needed it, never break the page.
 */

const TMDB_API_BASE = "https://api.themoviedb.org/3";
const TIMEOUT_MS = 6000;
/** Episode lists change rarely; a day keeps us far inside TMDb's 6-month caching limit while
 * making repeat visits free. */
const DEFAULT_REVALIDATE_SECONDS = 60 * 60 * 24;

export async function tmdbGet<T>(path: string, revalidate = DEFAULT_REVALIDATE_SECONDS): Promise<T | null> {
  const token = process.env.TMDB_READ_ACCESS_TOKEN;
  if (!token) {
    console.error("[tmdb] TMDB_READ_ACCESS_TOKEN not configured.");
    return null;
  }
  try {
    const res = await fetch(`${TMDB_API_BASE}${path}`, {
      headers: { Authorization: `Bearer ${token}`, accept: "application/json" },
      next: { revalidate },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      // 404 is an expected "no such season" answer, not worth logging.
      if (res.status !== 404) console.error(`[tmdb] ${path} -> HTTP ${res.status}`);
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    console.error(`[tmdb] ${path} failed:`, err instanceof Error ? err.message : err);
    return null;
  }
}
