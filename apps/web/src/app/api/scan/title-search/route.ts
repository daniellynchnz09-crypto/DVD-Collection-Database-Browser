import { NextResponse } from "next/server";
import { requireScanSecret } from "@/lib/scanAuth";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { omdbSearch, type OmdbSearchCandidate } from "@danflix/shared";
import {
  correctSpelling,
  fuzzySearchTitleIndex,
  resolveTmdbCandidatesByIds,
  searchTmdbMovies,
} from "@danflix/backend";

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

/**
 * Runs the same OMDB search the resolver itself uses (Claude/TECH STACK AND
 * ARCHITECTURE.md's "BARCODE SCANNING PIPELINE"), but on demand from ConfirmScreen - for
 * the case where the barcode lookup came back with nothing usable at all (no UPCitemdb
 * listing, so the resolver had no title text to search with). Rather than dumping the user
 * straight into a blank form, ConfirmScreen offers a single "what's the title?" field that
 * calls this to get the same best-match candidate list the automatic pipeline would have
 * produced from a real listing.
 *
 * Three layered passes handle a misspelled title (verified live that neither OMDB's nor
 * TMDb's own search is meaningfully fuzzy for a realistic typo - "Jurrasic Park" and "Lord
 * of the Rngs" both returned zero results from both providers):
 *   1. OMDB + TMDb search using the exact typed text (unchanged from before).
 *   2. The same two searches again using a spelling-corrected version of the text
 *      (packages/backend/src/spellcheck.ts - a generic English dictionary corrector, so it
 *      fixes "Jurrasic" -> "Jurassic" but can't fix an invented/proper name like
 *      "Shawshank" that isn't a real English word at all). Only run when correction
 *      actually changed something.
 *   3. Only if the above two passes together found nothing at all: a fuzzy match against a
 *      local, periodically-refreshed index of every real TMDb movie title
 *      (fuzzySearchTitleIndex - see supabase/migrations/0006_tmdb_title_index.sql) via
 *      Postgres trigram similarity, which catches typos of invented/proper names since it
 *      matches against actual title strings rather than English dictionary words.
 * Every pass's results are merged by imdbID (first pass's OMDB results kept first), so the
 * final list always includes "results from what the user actually typed" alongside
 * anything the corrected/fuzzy passes additionally found - per the user's own explicit
 * design, a spelling correction never replaces or hides the literal search.
 */
export async function POST(request: Request) {
  const authError = requireScanSecret(request);
  if (authError) return authError;

  const body = await request.json().catch(() => null);
  const title = typeof body?.title === "string" ? body.title.trim() : "";
  if (!title) {
    return NextResponse.json({ error: "title is required" }, { status: 400 });
  }

  const correctedTitle = await correctSpelling(title).catch(() => null);
  const queries = correctedTitle ? [title, correctedTitle] : [title];

  const passResults = await Promise.all(
    queries.flatMap((q) => [omdbSearch(q), searchTmdbMovies(q).catch(() => [])])
  );
  let merged = mergeByImdbId(passResults);

  if (merged.length === 0) {
    const supabase = getSupabaseServerClient();
    const fuzzyMatches = await fuzzySearchTitleIndex(supabase, title).catch(() => []);
    const fuzzyCandidates = await resolveTmdbCandidatesByIds(fuzzyMatches.map((m) => m.tmdbId));
    merged = mergeByImdbId([fuzzyCandidates]);
  }

  return NextResponse.json({ candidates: merged });
}
