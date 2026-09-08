import { NextResponse } from "next/server";
import { requireScanSecret } from "@/lib/scanAuth";
import { lookupFranchiseFromWikidata, lookupTmdbFields } from "@danflix/backend";

/**
 * A read-only "would TMDb find anything for this title" check, called from ConfirmScreen
 * as soon as a candidate is picked - so the Rating/Studio manual fields (see
 * apps/mobile/src/screens/ConfirmScreen.tsx) can stay hidden by default and only appear
 * once TMDb has genuinely come up empty for that specific field, rather than asking the
 * user to fill in something TMDb is about to auto-fill anyway.
 *
 * Also returns `isAnimated` (TMDb's genre list) and `franchise` (Wikidata's "part of the
 * series" property) - unlike Rating/Studio these don't hide the manual field, they just
 * prefill it (still fully editable) since neither source is authoritative enough to trust
 * blindly: the user found Casper's Haunted Christmas mislabeled as Live Action with no
 * Franchise at all, tracing back to these two fields never having existed anywhere in the
 * scan form before - see Claude/TECH STACK AND ARCHITECTURE.md.
 *
 * Purely informational: /api/scan/confirm never re-derives these two itself - whatever the
 * user leaves in the (now-always-visible) manual fields at confirm time is what's stored,
 * matching how Genre Location already works, rather than the hidden-field/authoritative-
 * re-lookup pattern Rating/Studio use.
 */
export async function POST(request: Request) {
  const authError = requireScanSecret(request);
  if (authError) return authError;

  const body = await request.json().catch(() => null);
  const imdbId = typeof body?.imdbId === "string" ? body.imdbId : null;
  if (!imdbId) {
    return NextResponse.json({ error: "imdbId is required" }, { status: 400 });
  }

  const [{ rating, studio, isAnimated }, franchise] = await Promise.all([
    lookupTmdbFields(imdbId),
    lookupFranchiseFromWikidata(imdbId),
  ]);
  return NextResponse.json({ rating, studio, isAnimated, franchise });
}
