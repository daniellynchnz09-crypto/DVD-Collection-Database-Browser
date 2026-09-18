import { NextResponse } from "next/server";
import { requireScanSecret } from "@/lib/scanAuth";
import { lookupFranchiseFromWikidata, lookupTmdbFields } from "@danflix/backend";

/**
 * A read-only "would TMDb find anything for this title" check, called from ConfirmScreen
 * as soon as a candidate is picked - so the Rating/Studio/Original Language manual fields
 * (see apps/mobile/src/screens/ConfirmScreen.tsx) can stay hidden by default and only appear
 * once TMDb has genuinely come up empty for that specific field, rather than asking the
 * user to fill in something TMDb is about to auto-fill anyway. `originalLanguage` is
 * TMDb's own `original_language` field mapped to a human-readable name (see
 * packages/backend/src/iso639.ts) - genuinely free alongside rating/studio, same
 * `/movie/{id}` detail call.
 *
 * Also returns `isAnimated` (TMDb's genre list) and `franchise` (Wikidata's "part of the
 * series" property) - unlike Rating/Studio these don't hide the manual field, they just
 * prefill it (still fully editable) since neither source is authoritative enough to trust
 * blindly: the user found Casper's Haunted Christmas mislabeled as Live Action with no
 * Franchise at all, tracing back to these two fields never having existed anywhere in the
 * scan form before - see Claude/TECH STACK AND ARCHITECTURE.md.
 *
 * Also returns `genres` - TMDb's raw genre names, added 2026-09-19 alongside the confirm
 * route's own OMDb+TMDb genre merge (see mergeOmdbAndTmdbGenres in scan/confirm/route.ts) so
 * ConfirmScreen can use the same signal client-side: specifically, a movie-typed candidate
 * TMDb tags "TV Movie" (its own genre id 10770, a leftover of TMDb's taxonomy rather than a
 * real content genre) is a real, reliable sharpening of the movie_or_tv *guess* - verified
 * live that this tag only ever appears on TMDb's *movie* genre list, tied to the exact same
 * candidate the user already selected, never a different title (see barcode-review-screen-
 * fields.md's TV Scanning section for the live verification against the 1996 Doctor Who TV
 * movie specifically).
 *
 * Purely informational: /api/scan/confirm never re-derives these two itself - whatever the
 * user leaves in the (now-always-visible) manual fields at confirm time is what's stored,
 * matching how Genre Location already works, rather than the hidden-field/authoritative-
 * re-lookup pattern Rating/Studio use.
 *
 * Also returns `tmdbId` (`null` when TMDb has no match for this IMDb id at all) - the
 * confirm route now requires every candidate-backed entry to end up with a real TMDb id
 * (Claude/TECH STACK AND ARCHITECTURE.md's "Backfill Rescan" section, so every other
 * metadata-driven feature can be backfilled later without re-touching the physical disc),
 * and ConfirmScreen uses this to show a manual TMDb link/id override field before that
 * happens, rather than the user only finding out once the confirm request already failed.
 */
export async function POST(request: Request) {
  const authError = requireScanSecret(request);
  if (authError) return authError;

  const body = await request.json().catch(() => null);
  const imdbId = typeof body?.imdbId === "string" ? body.imdbId : null;
  if (!imdbId) {
    return NextResponse.json({ error: "imdbId is required" }, { status: 400 });
  }

  const [{ tmdbId, rating, studio, isAnimated, originalLanguage, genres }, franchise] = await Promise.all([
    lookupTmdbFields(imdbId),
    lookupFranchiseFromWikidata(imdbId),
  ]);
  return NextResponse.json({ tmdbId, rating, studio, isAnimated, originalLanguage, genres, franchise });
}
