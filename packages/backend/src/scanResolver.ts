import type { SupabaseClient } from "@supabase/supabase-js";
import {
  cleanProductTitleForSearch,
  extractProductYear,
  filterCandidatesByMaxYear,
  inferDepictedEraStart,
  looksLikeCollection,
  omdbSearch,
  upcLookup,
} from "@danflix/shared";
import { matchPosterToCandidates } from "./posterMatch";

/**
 * Works through `pending_scans` at a safe rate (UPCitemdb's free tier is 100 req/day -
 * see Claude/TECH STACK AND ARCHITECTURE.md's "BARCODE SCANNING PIPELINE"). Shared
 * between apps/web/src/app/api/scan/resolve/route.ts (callable on demand / by a future
 * Vercel Cron job) and scripts/src/resolve-pending-scans.ts (runnable by hand) so the
 * two never drift.
 *
 * Lives in packages/backend rather than packages/shared because matchPosterToCandidates
 * pulls in Jimp for image decoding - fine for Node (this API route / this script), but
 * Metro (the mobile app's bundler) can't resolve the Node-core polyfills real image
 * decoders need (util/stream for PNG's zlib inflate). packages/shared is the one package
 * the mobile app also depends on, so anything Node-only that isn't safe for Metro to even
 * *see* belongs here instead, not there - see posterMatch.ts's own comment for the exact
 * failure this avoids.
 */
export async function resolvePendingScansBatch(
  supabase: SupabaseClient,
  limit: number
): Promise<{ processed: number; resolved: number; needsManual: number }> {
  const { data: pending, error: fetchError } = await supabase
    .from("pending_scans")
    .select("id, barcode")
    .eq("status", "pending")
    .order("scanned_at", { ascending: true })
    .limit(limit);

  if (fetchError) throw new Error(fetchError.message);

  let resolved = 0;
  let needsManual = 0;

  for (const scan of pending ?? []) {
    // Re-scan case: this exact disc was already logged (STEP BY STEP PROCESS AND
    // AUTOMATION.md's reason for having a barcode identifier at all).
    const { data: existing } = await supabase
      .from("titles")
      .select("*")
      .eq("barcode_id", scan.barcode)
      .maybeSingle();

    if (existing) {
      await supabase
        .from("pending_scans")
        .update({ status: "resolved", resolved_candidates: { existingMatch: existing } })
        .eq("id", scan.id);
      resolved++;
      continue;
    }

    const upcProduct = await upcLookup(scan.barcode);
    if (!upcProduct) {
      await supabase
        .from("pending_scans")
        .update({ status: "needs_manual", resolved_candidates: { upcLookupFailed: true } })
        .eq("id", scan.id);
      needsManual++;
      continue;
    }

    const searchQuery = cleanProductTitleForSearch(upcProduct.title);
    const rawCandidates = searchQuery ? await omdbSearch(searchQuery) : [];
    // A listing's year is the disc's own home-video release year, not necessarily the
    // film's - but home video always follows theatrical release, so it's a valid upper
    // bound: no film released after this year could already have a disc for it.
    const productYear = extractProductYear(`${upcProduct.title} ${upcProduct.description ?? ""}`);
    const omdbCandidates = filterCandidatesByMaxYear(rawCandidates, productYear);
    const isCollection = looksLikeCollection(upcProduct.title);
    const depictedEraStart = inferDepictedEraStart(upcProduct.title, upcProduct.description);

    // Box-set covers don't correspond to any single film's poster, and the checklist flow
    // already handles picking multiple titles - auto-matching only makes sense for a
    // single-title scan with its own listing photo to compare against.
    const posterMatch =
      !isCollection && upcProduct.imageUrl && omdbCandidates.length > 0
        ? await matchPosterToCandidates(upcProduct.imageUrl, omdbCandidates)
        : null;

    const status = omdbCandidates.length > 0 ? "resolved" : "needs_manual";
    await supabase
      .from("pending_scans")
      .update({
        status,
        resolved_candidates: {
          upcProduct,
          omdbCandidates,
          isCollection,
          depictedEraStart,
          productYear,
          posterMatch,
        },
      })
      .eq("id", scan.id);

    if (status === "resolved") resolved++;
    else needsManual++;
  }

  return { processed: pending?.length ?? 0, resolved, needsManual };
}
