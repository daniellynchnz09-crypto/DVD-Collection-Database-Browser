import type { SupabaseClient } from "@supabase/supabase-js";
import { omdbSearch, splitCutVariantTitle, type OmdbSearchCandidate } from "@danflix/shared";
import { matchClassicWhoSerial } from "./classicWhoSerials";
import { correctSpelling } from "./spellcheck";
import { fuzzySearchTitleIndex, resolveTmdbCandidatesByIds, searchTmdbMovies } from "./tmdb";

function mergeByImdbId(lists: OmdbSearchCandidate[][]): OmdbSearchCandidate[] {
  const seen = new Set<string>();
  const merged: OmdbSearchCandidate[] = [];
  for (const list of lists) {
    for (const candidate of list) {
      if (seen.has(candidate.imdbID)) continue;
      seen.add(candidate.imdbID);
      merged.push(candidate);
    }
  }
  return merged;
}

export interface TitleTextSearchOptions {
  /** Skips the spelling-correction and fuzzy-index passes - only the literal typed text is
   * searched. See this function's own comment below for when that's the right call. */
  skipCorrections?: boolean;
}

/**
 * Runs the same OMDB/TMDb best-match search the automatic barcode resolver uses (see
 * scanResolver.ts and Claude/TECH STACK AND ARCHITECTURE/barcode-scanning-pipeline.md), but
 * against a title known only as plain text - either typed by hand on ConfirmScreen's manual
 * fallback (the barcode lookup came back with nothing usable at all), or read straight off a
 * cover photo by coverVision.ts. Extracted out of the /api/scan/title-search route (2026-09-28,
 * part of cover-photo scanning) specifically so a cover-derived title can call the exact same
 * logic rather than a re-implementation - that route is now a thin wrapper around this.
 *
 * Three layered passes handle a misspelled/OCR'd title (verified live that neither OMDB's nor
 * TMDb's own search is meaningfully fuzzy for a realistic typo - "Jurrasic Park" and "Lord of
 * the Rngs" both returned zero results from both providers):
 *   1. OMDB + TMDb search using the exact text as given.
 *   2. The same two searches again using a spelling-corrected version of the text
 *      (spellcheck.ts - a generic English dictionary corrector, so it fixes "Jurrasic" ->
 *      "Jurassic" but can't fix an invented/proper name like "Shawshank" that isn't a real
 *      English word at all). Only run when correction actually changed something.
 *   3. Only if the above two passes together found nothing at all: a fuzzy match against a
 *      local, periodically-refreshed index of every real TMDb movie title
 *      (fuzzySearchTitleIndex - see supabase/migrations/0006_tmdb_title_index.sql) via
 *      Postgres trigram similarity, which catches typos of invented/proper names since it
 *      matches against actual title strings rather than English dictionary words.
 * Every pass's results are merged by imdbID (first pass's OMDB results kept first), so the
 * final list always includes "results from the text as given" alongside anything the
 * corrected/fuzzy passes additionally found - a spelling correction never replaces or hides
 * the literal search.
 *
 * `skipCorrections: true` (set by ConfirmScreen's "custom/homemade disc" toggle) skips passes
 * 2 and 3 entirely - only the literal search runs. Added after the user pointed out that a
 * meaningful chunk of the collection is "DVD (Custom Burn)" discs of non-English or obscure
 * franchises with genuinely made-up-sounding names, plus some of the user's own creations that
 * were never going to be on OMDB/TMDb at all - for those, "correcting" the typed name toward
 * the nearest real English word or the nearest real TMDb title is more likely to produce a
 * wrong, confusing suggestion than to catch an actual typo.
 */
export async function searchTitleCandidates(
  supabase: SupabaseClient,
  typedTitle: string,
  options?: TitleTextSearchOptions
): Promise<OmdbSearchCandidate[]> {
  const skipCorrections = options?.skipCorrections === true;

  // Classic-era (1963-1989) Doctor Who serials are never findable through the generic
  // search below at all (see classicWhoSerials.ts's own header comment) - checked first,
  // against the raw typed text, and short-circuits the rest of this function when it hits.
  const classicWhoMatch = await matchClassicWhoSerial(supabase, typedTitle).catch(() => []);
  if (classicWhoMatch.length > 0) return classicWhoMatch;

  // Same "search the base film title, not a specific cut/edition's own text" reasoning as
  // scanResolver.ts's automatic path (see splitCutVariantTitle's own comment) - a typed/cover-
  // read "Blade Runner the Final Cut" would miss OMDB's real "Blade Runner" entry exactly the
  // same way a barcode-derived one would.
  const { baseTitle: title } = splitCutVariantTitle(typedTitle);

  const correctedTitle = skipCorrections ? null : await correctSpelling(title).catch(() => null);
  const queries = correctedTitle ? [title, correctedTitle] : [title];

  const passResults = await Promise.all(
    queries.flatMap((q) => [omdbSearch(q), searchTmdbMovies(q).catch(() => [])])
  );
  let merged = mergeByImdbId(passResults);

  if (merged.length === 0 && !skipCorrections) {
    const fuzzyMatches = await fuzzySearchTitleIndex(supabase, title).catch(() => []);
    const fuzzyCandidates = await resolveTmdbCandidatesByIds(fuzzyMatches.map((m) => m.tmdbId));
    merged = mergeByImdbId([fuzzyCandidates]);
  }

  return merged;
}
