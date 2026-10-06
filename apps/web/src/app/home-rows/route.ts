import type { NextRequest } from "next/server";
import { HOME_BATCH_ROWS, loadHomePlanRows, normalizeSeed } from "@/lib/catalog/home";

/**
 * GET /home-rows?seed=&cursor= - the next batch of home-page browse rows (see
 * lib/catalog/home.ts). A read, so a GET route rather than a Server Action: it's cacheable and
 * survives deploys that rotate action ids under an already-open page.
 *
 * Inputs are strictly validated and the seed space is small, so every valid URL is one of a
 * bounded set of cacheable responses rather than an open-ended query surface.
 */
const MAX_CURSOR = 1000;

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const seed = normalizeSeed(params.get("seed"));
  const cursor = Number(params.get("cursor"));
  if (seed === null || !Number.isInteger(cursor) || cursor < 0 || cursor > MAX_CURSOR) {
    return Response.json({ error: "Bad request" }, { status: 400 });
  }

  const batch = await loadHomePlanRows(seed, cursor, HOME_BATCH_ROWS);
  return Response.json(batch, {
    headers: {
      // Shared caches may keep a batch a few minutes (matches the page's revalidate). Signed
      // image URLs inside last 24h, so this never serves a dead image link.
      "Cache-Control": "public, max-age=60, s-maxage=300, stale-while-revalidate=600",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}
