import nspell from "nspell";

/**
 * Generic English-word typo correction for the manual title-search route (apps/web/src/
 * app/api/scan/title-search/route.ts). Verified live (see Claude/TECH STACK AND
 * ARCHITECTURE.md) that neither OMDB's nor TMDb's own search is meaningfully fuzzy for a
 * realistic typo ("Jurrasic Park", "Lord of the Rngs" both returned zero results from
 * both) - this fixes typos of *ordinary English words* within a title before a second
 * search pass ("Jurrasic" -> "Jurassic", "Rngs" -> "Rings").
 *
 * Deliberately limited to real English dictionary words: a proper noun or invented name
 * that isn't in the dictionary at all (e.g. "Shawshank") gets "corrected" to nspell's
 * nearest real-word guess, which is very likely wrong - but that's an acceptable risk here
 * specifically because the caller always runs the literal, uncorrected search in parallel
 * and merges both result sets (per the user's own explicit design: "it will also show
 * results from what the user actually input as well as a spellchecked version") - a bad
 * correction just adds irrelevant extra candidates rather than replacing the correct ones.
 */
let spellcheckerPromise: Promise<ReturnType<typeof nspell>> | null = null;

function getSpellchecker(): Promise<ReturnType<typeof nspell>> {
  if (!spellcheckerPromise) {
    // Loaded lazily via a dynamic import, not a static one - dictionary-en is ESM-only
    // (top-level await inside its own module), which broke every script in scripts/ that
    // transitively imports anything from @danflix/backend's barrel export: tsx transforms
    // scripts to CommonJS by default, and esbuild can't transform an ESM top-level-await
    // module into CJS. A dynamic import() is left alone by that transform and Node natively
    // supports loading an ESM module this way even from CJS code, so this fixes it without
    // needing every consumer (scripts/, apps/web) to change its own module settings.
    spellcheckerPromise = import("dictionary-en").then(({ default: dictionary }) =>
      // dictionary-en's own types declare aff/dic as plain Uint8Array (it works fine with
      // nspell at runtime - Node's fs.readFile already returns real Buffers under the
      // hood), but @types/nspell wants an actual Buffer - a cheap, one-time conversion.
      nspell({ aff: Buffer.from(dictionary.aff), dic: Buffer.from(dictionary.dic) })
    );
  }
  return spellcheckerPromise;
}

function matchCase(corrected: string, original: string): string {
  if (original === original.toUpperCase()) return corrected.toUpperCase();
  if (original[0] === original[0]?.toUpperCase()) {
    return corrected[0].toUpperCase() + corrected.slice(1);
  }
  return corrected;
}

/** Returns a spelling-corrected version of `text`, or null when nothing needed changing
 * (avoids the caller running a pointless duplicate search). Only ever swaps individual
 * alphabetic words the dictionary both flags as misspelled and has a suggestion for -
 * numbers, punctuation, and words already deemed correctly spelled pass through untouched. */
export async function correctSpelling(text: string): Promise<string | null> {
  const spell = await getSpellchecker();
  let changed = false;

  const corrected = text.replace(/[A-Za-z]+(?:'[A-Za-z]+)?/g, (word) => {
    // Very short "words" are usually initials/articles where a dictionary suggestion is
    // more likely noise than a genuine correction (e.g. "Ex Machina"'s "Ex").
    if (word.length <= 2 || spell.correct(word)) return word;
    const [suggestion] = spell.suggest(word);
    if (!suggestion) return word;
    changed = true;
    return matchCase(suggestion, word);
  });

  return changed ? corrected : null;
}
