import type { NextRequest } from "next/server";
import { cleanSearchQuery, searchCatalog, SEARCH_MAX_QUERY_LENGTH, SEARCH_MIN_LENGTH } from "@/lib/catalog/search";

/**
 * GET /api/search?q=... - compact grouped results for the header's live dropdown.
 * Read-only and backed by the in-memory search index, so a request costs no DB round-trip
 * (bar the small `people` lookup). The client debounces; short public caching lets the
 * browser/CDN absorb repeat keystrokes and spam of the same URL.
 */

const PER_GROUP = 4;
const CACHE_HEADERS = { "Cache-Control": "public, max-age=30, s-maxage=60, stale-while-revalidate=300" };

export async function GET(request: NextRequest) {
  const raw = request.nextUrl.searchParams.get("q") ?? "";
  // The UI input caps at the same length, so anything longer is not from the site - reject it.
  if (raw.length > SEARCH_MAX_QUERY_LENGTH) {
    return Response.json({ error: `Query too long (max ${SEARCH_MAX_QUERY_LENGTH} characters).` }, { status: 400 });
  }
  const q = cleanSearchQuery(raw);
  if (q.length < SEARCH_MIN_LENGTH) {
    return Response.json({ query: q, groups: [], total: 0 }, { headers: CACHE_HEADERS });
  }

  try {
    const results = await searchCatalog(q, { perGroup: PER_GROUP, posterSize: "w92" });
    // Trim to what the dropdown renders (image.source is page-only detail).
    const compact = {
      ...results,
      groups: results.groups.map((g) => ({
        ...g,
        hits: g.hits.map((h) => ({ ...h, image: h.image ? { src: h.image.src, unoptimized: h.image.unoptimized } : null })),
      })),
    };
    return Response.json(compact, { headers: CACHE_HEADERS });
  } catch (err) {
    console.error("[api/search] failed:", err);
    return Response.json({ error: "Search failed." }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
