import type { SupabaseClient } from "@supabase/supabase-js";
import { upcLookup } from "./upc";
import {
  cleanProductTitleForSearch,
  filterCandidatesByMaxYear,
  looksLikeCollection,
  omdbSearch,
} from "./omdb";
import { inferDepictedEraStart } from "./titleParsing";
import { extractProductYear } from "./formatHints";

/**
 * Works through `pending_scans` at a safe rate (UPCitemdb's free tier is 100 req/day -
 * see Claude/TECH STACK AND ARCHITECTURE.md's "BARCODE SCANNING PIPELINE"). Shared
 * between apps/web/src/app/api/scan/resolve/route.ts (callable on demand / by a future
 * Vercel Cron job) and scripts/src/resolve-pending-scans.ts (runnable by hand) so the
 * two never drift.
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

    const status = omdbCandidates.length > 0 ? "resolved" : "needs_manual";
    await supabase
      .from("pending_scans")
      .update({
        status,
        resolved_candidates: { upcProduct, omdbCandidates, isCollection, depictedEraStart, productYear },
      })
      .eq("id", scan.id);

    if (status === "resolved") resolved++;
    else needsManual++;
  }

  return { processed: pending?.length ?? 0, resolved, needsManual };
}
