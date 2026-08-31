import { createJimp } from "@jimp/core";
import { methods as hashMethods, compareHashes } from "@jimp/plugin-hash";
import jpeg from "@jimp/js-jpeg";
import png from "@jimp/js-png";

// Built from individual @jimp/* packages instead of the top-level `jimp` package on
// purpose: `jimp`'s own index pulls in every plugin including @jimp/plugin-print, which
// does a Node-only `import("fs")` for custom font loading - a feature never used here.
// Even with that avoided, @jimp/js-png's own dependency (pngjs) still needs Node's
// util/stream modules for zlib inflate - real image decoders generally do. That's exactly
// why this file lives in packages/backend rather than packages/shared: shared is the one
// package the mobile app also depends on, and Metro (its bundler) can't resolve those
// Node-core modules at all, so anything reachable from shared's barrel export has to stay
// bundleable for React Native too. @jimp/plugin-hash's own pHash implementation imports
// resize/color functions directly rather than depending on the Jimp instance having those
// methods mixed in, so this minimal build needs nothing beyond the hash plugin and two
// decoders.
const Jimp = createJimp({ plugins: [hashMethods], formats: [jpeg, png] });

/**
 * Auto-matches a UPC listing's own product photo against each OMDB candidate's poster,
 * using perceptual hashing (Jimp's built-in pHash/compareHashes - Hamming distance over a
 * DCT-based hash, normalized 0..1 where 0 is identical). Per Claude/TECH STACK AND
 * ARCHITECTURE.md's caveat: a resale-listing photo of a physical case often looks quite
 * different from OMDB's stylized theatrical poster even for the objectively correct film
 * (different framing, cropping, an added disc-shaped overlay, background), so this is
 * deliberately conservative - only reports "confident" when the best match is both close in
 * absolute terms AND clearly better than the runner-up, otherwise leaves it for the user to
 * pick manually (the review screen's existing horizontal poster list already covers that).
 */

const CONFIDENT_MAX_DISTANCE = 0.2;
const CONFIDENT_MIN_GAP = 0.05;

export interface PosterMatchResult {
  bestImdbId: string | null;
  distances: Record<string, number>;
  confident: boolean;
}

export async function matchPosterToCandidates(
  upcImageUrl: string,
  candidates: { imdbID: string; Poster: string }[]
): Promise<PosterMatchResult> {
  const withPosters = candidates.filter((c) => c.Poster && c.Poster !== "N/A");
  if (withPosters.length === 0) {
    return { bestImdbId: null, distances: {}, confident: false };
  }

  let upcHash: string;
  try {
    const upcImage = await Jimp.read(upcImageUrl);
    upcHash = upcImage.pHash();
  } catch {
    // Couldn't fetch/decode the listing's own photo - nothing to compare against.
    return { bestImdbId: null, distances: {}, confident: false };
  }

  const results = await Promise.allSettled(
    withPosters.map(async (c) => {
      const posterImage = await Jimp.read(c.Poster);
      return { imdbID: c.imdbID, hash: posterImage.pHash() };
    })
  );

  const distances: Record<string, number> = {};
  for (const result of results) {
    if (result.status === "fulfilled") {
      distances[result.value.imdbID] = compareHashes(upcHash, result.value.hash);
    }
    // A single poster failing to fetch/decode shouldn't sink the whole comparison.
  }

  const ranked = Object.entries(distances).sort((a, b) => a[1] - b[1]);
  if (ranked.length === 0) {
    return { bestImdbId: null, distances, confident: false };
  }

  const [bestId, bestDistance] = ranked[0];
  const runnerUpDistance = ranked[1]?.[1] ?? 1;
  const confident =
    bestDistance <= CONFIDENT_MAX_DISTANCE && runnerUpDistance - bestDistance >= CONFIDENT_MIN_GAP;

  return { bestImdbId: bestId, distances, confident };
}
