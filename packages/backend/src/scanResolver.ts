import type { SupabaseClient } from "@supabase/supabase-js";
import {
  cleanProductTitleForSearch,
  extractFormatHint,
  extractImdbIdFromPage,
  extractListingMetaText,
  extractProductYear,
  filterCandidatesByMaxYear,
  findDuplicateTitleYearIds,
  inferDepictedEraStart,
  looksLikeCollection,
  omdbGetById,
  omdbSearch,
  scoreCandidateByCastHint,
  splitCutVariantTitle,
  upcLookup,
  type OmdbSearchCandidate,
} from "@danflix/shared";
import { matchPosterToCandidates } from "./posterMatch";
import { detectFormatFromImage } from "./formatVision";
import { extractListingTextFields, type ListingTextExtraction } from "./listingTextExtract";
import { recordUpcRateLimit } from "./upcQuota";
import { getSignedPosterImageUrl } from "./posterImageStorage";
import { downloadStagedCoverPhoto } from "./coverStagingStorage";
import { detectCoverFromImage, type StagedCoverAnalysis } from "./coverVision";
import { searchTitleCandidates } from "./titleTextSearch";

/**
 * One combined pass over an already year-filtered OMDB candidate list that (a) narrows it
 * down to one when the listing's own "|"-delimited metadata text (extractListingMetaText -
 * cast names, in practice) clearly points at a single candidate by cast overlap
 * (scoreCandidateByCastHint) - e.g. "Brie Larson" picking the real 2019 Captain Marvel out
 * from among any other same-titled OMDB entries - and (b) attaches each candidate's Runtime
 * when it shares an identical title+year with another candidate in the list
 * (findDuplicateTitleYearIds) - e.g. two same-year "Captain Marvel" entries with identical
 * posters that cast overlap can't tell apart at all, since a genuine alternate cut shares
 * its cast with the original. Runtime is purely a display aid for the user to check against
 * the disc's own case - never used to auto-narrow, since nothing in the listing text says
 * which cut is actually in hand.
 *
 * Both fetch the same OMDB detail record per candidate, so they're combined into one pass
 * (one `omdbGetById` per candidate that needs it for either reason, never two) rather than
 * two separate narrowing functions each re-fetching the same data. Runs silently, per the
 * user's own request: narrowing only ever narrows, never blocks, and only when there's a
 * genuine, unambiguous single best-scoring candidate (score > 0 and strictly ahead of every
 * runner-up) - a tie or an all-zero-score result leaves the list untouched for the user to
 * pick from as before. Caps how many detail fetches it's willing to make (10 total
 * candidates) so an unusually generic title search can't quietly burn through OMDB's quota
 * just to disambiguate.
 */
async function enrichAndNarrowCandidates(
  candidates: OmdbSearchCandidate[],
  listingTitle: string,
  // Cast names the LLM fallback pulled out of a listing with no "|" delimiter (e.g. names
  // glued straight onto the title with a bare hyphen) - extractListingMetaText can't find
  // these at all, since it only knows how to split on "|". Only ever set when the LLM
  // fallback actually ran (see resolvePendingScansBatch below), so the common case (regex
  // cleanup already found candidates) is unaffected.
  llmActors?: string[]
): Promise<OmdbSearchCandidate[]> {
  if (candidates.length <= 1 || candidates.length > 10) return candidates;

  const metaText = extractListingMetaText(listingTitle) ?? (llmActors && llmActors.length > 0 ? llmActors.join(" ") : null);
  const duplicateIds = findDuplicateTitleYearIds(candidates);
  const idsNeedingDetail = metaText
    ? new Set(candidates.map((c) => c.imdbID))
    : duplicateIds;
  if (idsNeedingDetail.size === 0) return candidates;

  const detailById = new Map<string, Awaited<ReturnType<typeof omdbGetById>>>();
  await Promise.all(
    [...idsNeedingDetail].map(async (id) => {
      detailById.set(id, await omdbGetById(id));
    })
  );

  const enriched = candidates.map((c) => {
    const detail = detailById.get(c.imdbID);
    return duplicateIds.has(c.imdbID) && detail?.Runtime ? { ...c, Runtime: detail.Runtime } : c;
  });

  if (!metaText) return enriched;

  const scored = enriched.map((candidate) => ({
    candidate,
    score: scoreCandidateByCastHint(detailById.get(candidate.imdbID)?.Actors ?? "", metaText),
  }));
  const [best, runnerUp] = [...scored].sort((a, b) => b.score - a.score);
  if (best.score > 0 && best.score > (runnerUp?.score ?? 0)) {
    return [best.candidate];
  }
  return enriched;
}

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
/** An `existing` (barcode-matched `titles` row) with `case_image_url` unset has no image
 * ConfirmScreen.tsx's synthesized candidate can show at all - found live 2026-09-25, a real
 * rescan of an already-cataloged title whose own case photo was never captured showed no
 * poster on the "best match" step, even though the title genuinely does have a real OMDB
 * poster (it was found via a manual title search when first catalogued, well before any
 * `existingMatch` fast path existed to skip that search on a later rescan).
 *
 * Three-tier fallback, cheapest/most-authoritative first: `case_image_url` (the user's own
 * physical case photo, when captured) - else `movie_poster_path` (0036_add_movie_poster_path.
 * sql, a signed URL minted from the already-cached poster - added 2026-09-25 per the user's
 * own follow-up question: "why doesn't the app just save time and use the poster from the
 * database... instead of searching the internet again", once it was clear every confirm now
 * caches one) - else a live OMDB lookup by the imdb_id recovered from imdb_page, purely as a
 * last resort for a title confirmed before movie_poster_path existed, or where that upload
 * happened to fail. This still mirrors find-existing/route.ts's own `posterUrl` fallback (so
 * the two "already have this" surfaces never disagree about whether a poster exists), just
 * with the cached-poster tier inserted ahead of the live lookup. Returns `existing` unchanged
 * when there's nothing to add - the extra `resolvedPosterUrl` key is additive, never
 * required. */
async function withResolvedPoster<
  T extends { case_image_url: string | null; imdb_page: string | null; movie_poster_path?: string | null } | null
>(supabase: SupabaseClient, existing: T): Promise<(T & { resolvedPosterUrl?: string }) | undefined> {
  if (!existing) return undefined;
  if (existing.case_image_url) return existing;
  if (existing.movie_poster_path) {
    const signedUrl = await getSignedPosterImageUrl(supabase, existing.movie_poster_path);
    if (signedUrl) return { ...existing, resolvedPosterUrl: signedUrl };
  }
  const imdbId = extractImdbIdFromPage(existing.imdb_page);
  if (!imdbId) return existing;
  const detail = await omdbGetById(imdbId);
  if (detail?.Poster && detail.Poster !== "N/A") {
    return { ...existing, resolvedPosterUrl: detail.Poster };
  }
  return existing;
}

/** Downloads and reads every staged cover photo on a scan (cover-photo scanning, added
 * 2026-09-28 - see Claude/TECH STACK AND ARCHITECTURE/barcode-scanning-pipeline.md), front
 * and/or back, in whatever order they were captured. A photo that fails to download or that
 * the model can't read anything from is simply skipped - one bad read never blocks the rest
 * of this scan's resolution, same "a cache miss is fine, a bad write isn't" posture as every
 * other vision/lookup call in this pipeline. */
async function analyzeStagedCoverPhotos(
  supabase: SupabaseClient,
  stagedPaths: string[]
): Promise<StagedCoverAnalysis[]> {
  const analyses: StagedCoverAnalysis[] = [];
  for (const stagedPath of stagedPaths) {
    const staged = await downloadStagedCoverPhoto(supabase, stagedPath);
    if (!staged) continue;
    const analysis = await detectCoverFromImage(staged.bytes, staged.contentType);
    if (analysis) analyses.push({ stagedPath, analysis });
  }
  return analyses;
}

/** The title to drive a cover-derived candidate search with, when one exists: the
 * front-classified photo's title takes priority (it's the one actually meant to carry the
 * release's own title treatment), falling back to any other legible title an "unclear" or
 * back-classified photo happened to also carry (a back cover's spec block often repeats the
 * title too). Null when no staged photo yielded a legible title at all. */
function pickCoverDerivedTitle(analyses: StagedCoverAnalysis[]): string | null {
  return (
    analyses.find((a) => a.analysis.side === "front" && a.analysis.title)?.analysis.title ??
    analyses.find((a) => a.analysis.title)?.analysis.title ??
    null
  );
}

export async function resolvePendingScansBatch(
  supabase: SupabaseClient,
  limit: number
): Promise<{ processed: number; resolved: number; needsManual: number }> {
  const { data: pending, error: fetchError } = await supabase
    .from("pending_scans")
    .select("id, barcode, staged_cover_photos")
    .eq("status", "pending")
    .order("scanned_at", { ascending: true })
    .limit(limit);

  if (fetchError) throw new Error(fetchError.message);

  let resolved = 0;
  let needsManual = 0;

  for (const scan of pending ?? []) {
    const stagedCoverPaths: string[] = (scan.staged_cover_photos as string[] | null) ?? [];
    const coverAnalysis = await analyzeStagedCoverPhotos(supabase, stagedCoverPaths);
    const coverDerivedTitle = pickCoverDerivedTitle(coverAnalysis);

    // Cover-only session (no barcode at all - decision 6 in the plan this implements): none
    // of the UPC/existing-title lookup below applies, since there's no barcode to look either
    // up by. The cover-derived title (when the vision read found one) drives the exact same
    // best-match search a typed title would, via searchTitleCandidates - this is the direct
    // "cover photo replaces typing a title" path the feature exists for.
    if (!scan.barcode) {
      const omdbCandidates = coverDerivedTitle ? await searchTitleCandidates(supabase, coverDerivedTitle) : [];
      const status = omdbCandidates.length > 0 ? "resolved" : "needs_manual";
      await supabase
        .from("pending_scans")
        .update({
          status,
          resolved_candidates: { coverAnalysis, omdbCandidates, existingMatch: null },
        })
        .eq("id", scan.id);
      if (status === "resolved") resolved++;
      else needsManual++;
      continue;
    }

    // Re-scan case: this exact disc was already logged (STEP BY STEP PROCESS AND
    // AUTOMATION.md's reason for having a barcode identifier at all). Per the user's own
    // "Overwrite" design (Claude/TECH STACK AND ARCHITECTURE.md's "Backfill Rescan"
    // section - Overwrite replaces every field of the existing row with the new scan's
    // data, in place), this no longer short-circuits the whole resolution - the rest of
    // the pipeline still runs below so ConfirmScreen has real candidate/poster data to
    // pre-fill from, and `existingMatch` rides along on resolved_candidates so
    // ConfirmScreen can pre-fill every field from the current entry and route straight to
    // the same Overwrite/Is-a-new-entry/Reject choice the ordinary similar-entry check
    // uses, instead of a dead-end "Dismiss only" screen.
    // `barcode_id` has no uniqueness constraint (e.g. choosing "Is a new entry" for a
    // genuine second identical copy on this very screen would give two rows the same
    // barcode) - `.limit(1)` keeps that from ever making `.maybeSingle()` throw on more
    // than one match.
    const { data: existing } = await supabase
      .from("titles")
      .select("*")
      .eq("barcode_id", scan.barcode)
      .limit(1)
      .maybeSingle();

    const { product: upcProduct, rateLimit: upcRateLimit } = await upcLookup(scan.barcode);
    // Mirrors UPCitemdb's own real rate-limit headers from this call - see upcQuota.ts's own
    // comment on why this reads the provider's authoritative number rather than counting
    // calls itself. Never blocks/awaits-critically on failure - a quota-tracking write
    // failing must never stop the actual scan resolution below it.
    await recordUpcRateLimit(supabase, upcRateLimit).catch(() => {});
    if (!upcProduct) {
      // No barcode listing at all, but a cover photo was also captured this session (any
      // combination of barcode/front/back is valid - decision 6) - fall back to the same
      // cover-derived search a cover-only session would use, rather than dead-ending straight
      // into needs_manual when the resolver actually has a usable title in hand.
      const omdbCandidates = coverDerivedTitle ? await searchTitleCandidates(supabase, coverDerivedTitle) : [];
      const status = omdbCandidates.length > 0 ? "resolved" : "needs_manual";
      await supabase
        .from("pending_scans")
        .update({
          status,
          resolved_candidates: {
            upcLookupFailed: true,
            coverAnalysis,
            omdbCandidates,
            existingMatch: await withResolvedPoster(supabase, existing),
          },
        })
        .eq("id", scan.id);
      if (status === "resolved") resolved++;
      else needsManual++;
      continue;
    }

    // Search OMDB by the film's own base title, not the barcode's full cut/edition text
    // ("Blade Runner the Final Cut" -> "Blade Runner") - OMDB indexes one entry per film, not
    // one per re-release cut, so searching the full text can miss the real entry entirely and
    // fall through to whatever unrelated title OMDB's fuzzy `s=` search happens to surface
    // instead (candidate list, poster, everything downstream - see splitCutVariantTitle's own
    // comment in titleParsing.ts for the real case this was found from). The full cleaned
    // title (base + cut, when a cut was found) is what ConfirmScreen separately offers as the
    // release_name pre-fill - not threaded through here, since that's purely a UI concern.
    const isCollection = looksLikeCollection(upcProduct.title);
    // A listing's year is the disc's own home-video release year, not necessarily the
    // film's - but home video always follows theatrical release, so it's a valid upper
    // bound: no film released after this year could already have a disc for it. Computed
    // unconditionally (still useful context for a collection's own depicted-era/format
    // guessing below), but the OMDB search itself is skipped entirely for a collection - see
    // the isCollection branch immediately below.
    const productYear = extractProductYear(`${upcProduct.title} ${upcProduct.description ?? ""}`);
    // A collection scan never searches OMDB by the box set's own listing title (2026-09-20,
    // per the user's explicit decision to drop the "extract a franchise/director/actor name
    // and search OMDB for it" idea in favor of a manual per-title entry loop on the Confirm
    // screen instead - see Claude/TECH STACK AND ARCHITECTURE/barcode-scanning-pipeline.md).
    // Searching a box set's own title text ("Alfred Hitchcock Collection") almost never
    // matches a real OMDB film entry anyway, so this both saves a wasted OMDB call and avoids
    // populating a candidate list ConfirmScreen's collection flow no longer reads from.
    let omdbCandidates: OmdbSearchCandidate[] = [];
    // Only ever populated when the plain regex-cleaned search below finds nothing at all -
    // see listingTextExtract.ts's own doc comment for why an LLM call is deliberately the
    // fallback, not the first attempt.
    let listingTextExtraction: ListingTextExtraction | null = null;
    if (!isCollection) {
      const { baseTitle: searchQuery } = splitCutVariantTitle(cleanProductTitleForSearch(upcProduct.title));
      let rawCandidates = searchQuery ? await omdbSearch(searchQuery) : [];
      if (rawCandidates.length === 0) {
        listingTextExtraction = await extractListingTextFields(upcProduct.title, upcProduct.description);
        if (listingTextExtraction?.title) {
          rawCandidates = await omdbSearch(listingTextExtraction.title);
        }
      }
      const yearFilteredCandidates = filterCandidatesByMaxYear(rawCandidates, productYear);
      omdbCandidates = await enrichAndNarrowCandidates(yearFilteredCandidates, upcProduct.title, listingTextExtraction?.actors);
    }
    const depictedEraStart = inferDepictedEraStart(upcProduct.title, upcProduct.description);

    // Box-set covers don't correspond to any single film's poster, and the checklist flow
    // already handles picking multiple titles - auto-matching only makes sense for a
    // single-title scan with its own listing photo to compare against.
    const posterMatch =
      !isCollection && upcProduct.imageUrl && omdbCandidates.length > 0
        ? await matchPosterToCandidates(upcProduct.imageUrl, omdbCandidates)
        : null;

    // Vision-based format detection (added 2026-09-17) - deliberately the LAST resort, only
    // ever attempted when the barcode listing's own text doesn't already give a SPECIFIC
    // format, per the user's own explicit instruction: text is always more reliable than a
    // model guessing from a photo, so it's tried first and free (no API call) before this
    // ever runs. "DVD" is treated as not-specific rather than skipped outright (found
    // 2026-09-17 against a real "Blade Runner: The Final Cut" listing whose own title text
    // said "...Dvd" despite the actual disc being 4K UHD) - extractFormatHint only ever
    // returns "DVD" once its own 4K/Blu-ray/VHS patterns have all already failed to match, so
    // it's really this function's generic fallback rather than a confirmed signal the way
    // "Blu-Ray"/"4K UHD Blu-Ray"/"VHS" are; a real product photo is worth cross-checking
    // against it. Text still always wins outright for every other, more specific hint - see
    // formatVision.ts's own header comment for the full reasoning (model choice, prompt
    // design, why no training data was collected), and ConfirmScreen.tsx's own comment for
    // how the two are reconciled once both are available.
    const textFormatHint = extractFormatHint(`${upcProduct.title} ${upcProduct.description ?? ""}`);
    const visionFormatGuess =
      (!textFormatHint || textFormatHint === "DVD") && upcProduct.imageUrl
        ? await detectFormatFromImage(upcProduct.imageUrl)
        : null;

    // Merge strategy for a session that captured both a barcode AND a cover photo (decision 6):
    // the barcode/UPC path stays authoritative whenever it already found real candidates - the
    // cover analysis rides along in resolved_candidates.coverAnalysis purely as a secondary
    // cross-reference and format/disc-count pre-fill signal, the same way visionFormatGuess
    // already works today, without touching omdbCandidates. It only takes over as the actual
    // search when the barcode path itself found nothing, and never for a collection scan
    // (isCollection deliberately never searches OMDB by title text at all - see that branch
    // above).
    if (omdbCandidates.length === 0 && !isCollection && coverDerivedTitle) {
      omdbCandidates = await searchTitleCandidates(supabase, coverDerivedTitle);
    }

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
          visionFormatGuess,
          listingTextExtraction,
          coverAnalysis,
          existingMatch: await withResolvedPoster(supabase, existing),
        },
      })
      .eq("id", scan.id);

    if (status === "resolved") resolved++;
    else needsManual++;
  }

  return { processed: pending?.length ?? 0, resolved, needsManual };
}
