import type { NextRequest } from "next/server";
import { getFacetCounts } from "@/lib/catalog/search";
import { parseFilters } from "@/lib/catalog/searchFilters";
import { listTasteProfiles } from "@/lib/catalog/tasteProfiles";

/**
 * GET /api/search/facets?<filter params> - how many titles each filter value still matches
 * given the rest of the filter panel's draft, so the panel can hide values that would match
 * nothing (e.g. DVD regions once Blu-ray is picked). Read-only and served from the in-memory
 * search index; the panel debounces, and short public caching absorbs repeats.
 */

const MAX_QUERY_LENGTH = 4000;
const CACHE_HEADERS = { "Cache-Control": "public, max-age=30, s-maxage=60, stale-while-revalidate=300" };

export async function GET(request: NextRequest) {
  if (request.nextUrl.search.length > MAX_QUERY_LENGTH) {
    return Response.json({ error: "Too many filters." }, { status: 400 });
  }
  const params = request.nextUrl.searchParams;
  const filters = parseFilters((key) => params.getAll(key));
  try {
    const profileFilters = filters.profiles.length
      ? (await listTasteProfiles()).filter((p) => filters.profiles.includes(p.id)).map((p) => p.filters)
      : [];
    const counts = await getFacetCounts(filters, profileFilters);
    if (!counts) return Response.json({ error: "Search index unavailable." }, { status: 503, headers: { "Cache-Control": "no-store" } });
    return Response.json({ counts }, { headers: CACHE_HEADERS });
  } catch (err) {
    console.error("[api/search/facets] failed:", err);
    return Response.json({ error: "Couldn't count the filters." }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
