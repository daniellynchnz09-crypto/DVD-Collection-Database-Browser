import { normalizeTitleForMatch } from "./titleParsing";

export interface OmdbSearchCandidate {
  Title: string;
  Year: string;
  imdbID: string;
  Type: string;
  Poster: string;
  // Only ever populated for candidates that shared a near-identical title+year with at
  // least one other candidate in the same list (see findDuplicateTitleYearIds below) - a
  // plain OMDB search result never includes it. Purely a display aid on the review screen
  // (e.g. two same-year "Captain Marvel" entries with identical posters) - runtime isn't
  // used to auto-narrow anything, since it's the disc's own case, not this listing's text,
  // that would say which cut is actually in hand.
  Runtime?: string;
}

export interface OmdbDetail {
  Title: string;
  Year: string;
  Rated: string;
  Released: string;
  Runtime: string;
  Genre: string;
  Director: string;
  // For a "series"-Type entry, OMDB's own Director field is usually blank or just the pilot
  // episode's director - Writer is the closer real-world equivalent of a show's creator/
  // head-writer, used instead of Director for a whole-season/show-level TV confirmation (see
  // Claude/TECH STACK AND ARCHITECTURE/barcode-review-screen-fields.md's TV Scanning
  // section's "Director vs. Creator/Head-Writer" note). Not used at all for a "movie" or
  // "episode" Type entry, where Director keeps its ordinary meaning.
  Writer: string;
  // Only present on an "episode"-Type detail response - the parent show's own imdbID, used
  // to resolve an episode match back to its series (see the same TV Scanning section's
  // "IMDb page for TV"/"Release date for TV" notes: both must reflect the whole show, not
  // one specific episode/serial).
  seriesID?: string;
  // Top-billed cast only (OMDB returns roughly 3-4 names) - see scoreCandidateByCastHint
  // below, which is all this is currently used for.
  Actors: string;
  Plot: string;
  Poster: string;
  imdbRating: string;
  imdbID: string;
  Type: string;
  // Multi-source aggregate scores OMDB already bundles in - includes a "Rotten Tomatoes"
  // entry (e.g. Value "85%") whenever the title actually has a critics score, without
  // needing to touch Rotten Tomatoes' own site just to find that out.
  Ratings?: { Source: string; Value: string }[];
}

function getApiKey(): string {
  const key = process.env.OMDB_API_KEY;
  if (!key) throw new Error("OMDB_API_KEY not configured.");
  return key;
}

/** Searches OMDB by title text, returning candidate matches for the user to pick from. */
export async function omdbSearch(query: string): Promise<OmdbSearchCandidate[]> {
  const url = `https://www.omdbapi.com/?s=${encodeURIComponent(query)}&apikey=${getApiKey()}`;
  const res = await fetch(url);
  const data = (await res.json()) as { Response: string; Search?: OmdbSearchCandidate[] };
  if (data.Response === "False") return [];
  return data.Search ?? [];
}

/** Fetches full OMDB detail for a chosen imdbID. */
export async function omdbGetById(imdbId: string): Promise<OmdbDetail | null> {
  const url = `https://www.omdbapi.com/?i=${encodeURIComponent(imdbId)}&apikey=${getApiKey()}`;
  const res = await fetch(url);
  const data = (await res.json()) as { Response: string } & OmdbDetail;
  if (data.Response === "False") return null;
  return data;
}

// OMDB's Released format is "05 May 2017"; the Sheet/DB want yyyy-mm-dd.
const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

export function parseOmdbReleaseDate(released: string | undefined): string | null {
  if (!released || released === "N/A") return null;
  const [day, monthName, year] = released.split(" ");
  const month = MONTHS[monthName?.slice(0, 3).toLowerCase()];
  if (!day || !month || !year) return null;
  return `${year}-${month}-${day.padStart(2, "0")}`;
}

export function parseOmdbRuntimeMins(runtime: string | undefined): number | null {
  if (!runtime) return null;
  const match = runtime.match(/(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Words that show up in box-set product titles but aren't part of a searchable movie/
 * franchise name - stripped before querying OMDB. Also used to flag "this looks like a
 * collection" so the confirm flow can offer the sub-title checklist.
 */
const COLLECTION_HINT_WORDS =
  /\b(collection|box ?set|boxset|complete series|trilogy|duology|anthology|bundle|\d+[- ]?(film|movie|disc)s?)\b/i;

export function looksLikeCollection(productTitle: string): boolean {
  return COLLECTION_HINT_WORDS.test(productTitle);
}

// A search for a big, well-known film's title often also turns up making-of documentaries,
// convention/special-screening footage, and behind-the-scenes featurettes that legitimately
// share (part of) that title in OMDB - real IMDb entries, just never something that could be
// the physical disc actually being scanned. Never used to drop a candidate outright (OMDB's
// own Type field doesn't reliably distinguish these from a real movie either, and a false
// positive here would be a real film wrongly hidden) - only to move it into a collapsed
// "Extras" section on the review screen so it's a tap away rather than cluttering the main
// candidate list, per the user's own explicit ask.
const EXTRA_CONTENT_HINT_WORDS =
  /\b(making[- ]of|featurette|behind[- ]the[- ]scenes|special screening|world premiere|red carpet|press conference|press junket|q\s?&\s?a|fan event|gag reel|bloopers|deleted scenes|table read|round ?table|panel discussion)\b/i;

export function looksLikeExtraContent(title: string): boolean {
  return EXTRA_CONTENT_HINT_WORDS.test(title);
}

// UPCitemdb's titles are crowdsourced/scraped from resale listings, not just packaging -
// found via a real scan whose product title was "Paper Planes Dvd (2015) (region 4, Non Uk
// Standard), , Used; Acceptable Dvd": condition/listing words like "Used; Acceptable"
// weren't being stripped, so the OMDB search query came out as "Paper Planes , , Used;
// Acceptable" and matched nothing even though "Paper Planes" alone finds it easily.
const MARKETPLACE_NOISE_WORDS =
  /\b(brand new|like new|very good|good condition|acceptable|used|pre-?owned|second-?hand|free shipping|fast dispatch|fast shipping|ex-?rental|near mint|mint condition)\b/gi;

// "<qualifier> Edition" is packaging/marketing fluff, not a content distinction - unlike
// CUT_SUFFIX_WORDS in titleParsing.ts ("Final Cut", "Director's Cut"), which the user
// deliberately keeps in a title because it names an actually different edit of the film.
// A "Special Edition"/"Collector's Edition"/etc. re-release is still the same cut, just
// different bonus-features packaging, so it never belongs in the `title` field.
const PACKAGING_EDITION_WORDS =
  /\b(special|deluxe|collector'?s?|anniversary|limited|premium|gift set)\s+edition\b/gi;

/** Strips packaging/format noise from a UPC product title to get a usable OMDB search term
 * (and a reasonable starting guess for the `title` field when there's no OMDB pick yet).
 *
 * Some listings (found live via a real "Captain Marvel" scan whose title was "Captain
 * Marvel | Brie Larson, Samuel L J Blu-Ray Expertly Referubished Product") put the actual
 * movie title before a "|" and everything else - cast names, format, resale-condition
 * fluff - after it. None of that trailing text is stripped by the noise-word regexes below
 * (they only know specific known words, not arbitrary names), so it was reaching OMDB's
 * search query verbatim and returning zero results even though "Captain Marvel" alone
 * finds it instantly. Cutting at the first "|" before anything else runs fixes this - see
 * extractListingMetaText/scoreCandidateByCastHint below for what the discarded half is
 * still used for.
 *
 * A second real search-breaking listing shape found live 2026-09-19: "Resident Evil:
 * Extinction [regions 2,5] - Dvd - - Free Shipping." returned zero OMDB results even though
 * "Resident Evil: Extinction" alone finds it instantly. Two compounding gaps - the old
 * region-stripping pattern only matched a single alnum token after the literal singular word
 * "region " (never "regions", never a comma-separated list like "2,5"), so the bracketed
 * annotation survived untouched; and square-bracketed listing metadata (`[...]`) was never
 * stripped at all, only round-bracketed `(...)` was. Fixed by broadening the region pattern
 * to a comma/slash/ampersand/hyphen-separated list after "region(s)", stripping `[...]`
 * alongside `(...)`, and cleaning up the stray standalone "-"/trailing punctuation left
 * behind once the words between them are gone (a listing often uses " - " as its own field
 * separator, e.g. "Title - Format - Condition"). */
export function cleanProductTitleForSearch(productTitle: string): string {
  return productTitle
    .split("|")[0]
    .replace(PACKAGING_EDITION_WORDS, "")
    .replace(
      /\b(blu-?ray|dvd|4k|uhd|ultra ?hd|steelbook|regions? [a-z0-9](?:[\s,/&-]+[a-z0-9])*|edition|disc|widescreen)\b/gi,
      ""
    )
    .replace(COLLECTION_HINT_WORDS, "")
    .replace(MARKETPLACE_NOISE_WORDS, "")
    .replace(/[([].*?[)\]]/g, "")
    .replace(/[,;]+/g, " ")
    .replace(/\s+-\s+/g, " ")
    .replace(/^[-.\s]+|[-.\s]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The part of a "|"-delimited UPC listing title after the movie title itself (cast names,
 * format, resale-condition text - see cleanProductTitleForSearch above) - null when the
 * listing has no such delimiter, since there's then no reliable way to separate "the title"
 * from everything else in it. Used only to score candidates by cast overlap below, never to
 * fill any stored field, so no noise-stripping is needed here - see
 * scoreCandidateByCastHint's own comment for why. */
export function extractListingMetaText(productTitle: string): string | null {
  const parts = productTitle.split("|");
  if (parts.length < 2) return null;
  const meta = parts.slice(1).join("|").trim();
  return meta.length > 0 ? meta : null;
}

const CAST_HINT_STOPWORDS = new Set(["and", "the", "with", "starring", "featuring"]);

function castHintWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !CAST_HINT_STOPWORDS.has(w))
  );
}

/**
 * Scores how well a listing's leftover metadata text (extractListingMetaText) overlaps with
 * an OMDB candidate's `Actors` field, for disambiguating multiple same-titled candidates by
 * who's credited (e.g. "Brie Larson" picking out the 2019 Captain Marvel over an older,
 * unrelated same-titled entry). Deliberately a word-overlap score rather than trying to
 * first classify which part of the metadata text is "a name" - a listing's cast mention is
 * often abbreviated/mangled (this project's own real example shortened "Samuel L. Jackson"
 * to "Samuel L J", which won't substring-match at all), and the leftover text is just as
 * often mixed with genuine noise ("Expertly Referubished Product") with no delimiter of its
 * own separating the two. Word overlap tolerates both: real cast names contribute matching
 * words, and noise words simply fail to appear in any real actor's name and contribute
 * nothing - never a wrong exclusion, only ever a (possibly zero) positive signal, so a
 * messy/unmatched metadata text degrades to "no disambiguation help" rather than an error.
 */
export function scoreCandidateByCastHint(actorsField: string, metaText: string): number {
  if (!actorsField || actorsField === "N/A") return 0;
  const metaWords = castHintWords(metaText);
  if (metaWords.size === 0) return 0;
  const actorWords = castHintWords(actorsField);
  let score = 0;
  for (const word of metaWords) {
    if (actorWords.has(word)) score++;
  }
  return score;
}

/**
 * Eliminates OMDB candidates whose Year is chronologically impossible given the disc's own
 * release year (see extractProductYear in formatHints.ts) - a DVD/Blu-ray can't exist for a
 * film that hadn't been released yet. Never eliminates everything (falls back to the
 * unfiltered list) since the product year is itself just a best-effort text extraction, not
 * a guarantee.
 */
/**
 * Finds candidates that share the same title text (normalizeTitleForMatch - case/whitespace-
 * insensitive, same comparison the backfill/similar-entry matching already uses elsewhere)
 * AND the same Year - real OMDB search results the user can't tell apart by title/year/
 * poster alone (found live: two identically-postered "Captain Marvel" (2019) entries).
 * These are exactly the case a listing's own year/cast signals can never resolve (both
 * share the same cast too, if it's genuinely an alternate cut of the same film), so the
 * caller fetches each one's Runtime to show as a physical, human-checkable distinguisher
 * instead - see scanResolver.ts's enrichAndNarrowCandidates.
 */
export function findDuplicateTitleYearIds(candidates: OmdbSearchCandidate[]): Set<string> {
  const counts = new Map<string, number>();
  for (const c of candidates) {
    const key = `${normalizeTitleForMatch(c.Title)}|${c.Year}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const duplicateIds = new Set<string>();
  for (const c of candidates) {
    const key = `${normalizeTitleForMatch(c.Title)}|${c.Year}`;
    if ((counts.get(key) ?? 0) > 1) duplicateIds.add(c.imdbID);
  }
  return duplicateIds;
}

export function filterCandidatesByMaxYear(
  candidates: OmdbSearchCandidate[],
  maxYear: number | null
): OmdbSearchCandidate[] {
  if (maxYear == null) return candidates;
  const filtered = candidates.filter((c) => {
    const year = parseInt(c.Year, 10);
    return Number.isNaN(year) ? true : year <= maxYear;
  });
  return filtered.length > 0 ? filtered : candidates;
}
