/**
 * Best-effort hints pulled from a UPC product's title/description text, used to narrow
 * down which of several existing collection entries a scanned disc actually is (Claude/
 * TECH STACK AND ARCHITECTURE.md's backfill-matching design: "if the barcode says Blu-ray,
 * narrow by Blu-ray; if it says 2-disc, narrow by 2-disc; only ask the user when more than
 * one candidate remains"). Both are deliberately conservative - return null rather than
 * guess when the text doesn't clearly say.
 */

// Canonical spellings match packages/shared/src/titleParsing.ts's FORMAT_ALIASES, so a
// scan-time guess and a manually-typed Sheet value never disagree on how to spell the
// same format.
const FORMAT_PATTERNS: { pattern: RegExp; format: string }[] = [
  { pattern: /\b4k|ultra ?hd|uhd\b/i, format: "4K UHD Blu-Ray" },
  { pattern: /\bblu-?ray\b/i, format: "Blu-Ray" },
  { pattern: /\bvhs\b/i, format: "VHS" },
  { pattern: /\bdvd\b/i, format: "DVD" },
];

export function extractFormatHint(text: string): string | null {
  for (const { pattern, format } of FORMAT_PATTERNS) {
    if (pattern.test(text)) return format;
  }
  return null;
}

const WORD_DISC_COUNTS: Record<string, number> = {
  single: 1,
  double: 2,
  triple: 3,
  quadruple: 4,
};

export function extractDiscCountHint(text: string): number | null {
  const digitMatch = text.match(/\b(\d+)[- ]?disc/i);
  if (digitMatch) return parseInt(digitMatch[1], 10);
  const wordMatch = text.match(/\b(single|double|triple|quadruple)[- ]?disc/i);
  if (wordMatch) return WORD_DISC_COUNTS[wordMatch[1].toLowerCase()];
  return null;
}

/**
 * The year a reseller listing annotates (e.g. "Paper Planes Dvd (2015)") is the disc's own
 * home-video release year, not necessarily the film's theatrical year - home video always
 * follows theatrical release, never precedes it. So this is a useful upper bound: any OMDB
 * candidate whose Year is *after* this can be eliminated outright, since a disc can't exist
 * for a film that hadn't been released yet (see filterCandidatesByMaxYear in omdb.ts).
 */
export function extractProductYear(text: string): number | null {
  const match = text.match(/\b(19[0-9]{2}|20[0-9]{2})\b/);
  if (!match) return null;
  const year = parseInt(match[1], 10);
  return year <= new Date().getFullYear() + 1 ? year : null;
}

// Official region-coding schemes, verified against current region-code references
// (September 2026) rather than assumed - DVD uses numeric regions 1-6 (7 is reserved/
// unused and 8 is airline/cruise-only, both excluded here as never realistic for a
// physical collection) plus region-free; Blu-ray uses three letter regions (A/B/C) plus
// region-free; Ultra HD Blu-ray carries no region coding at all, so "All" is the only
// real option, though the rare documented exception means the field stays free-text-
// capable regardless of this suggested list.
const DVD_REGIONS = ["1", "2", "3", "4", "5", "6", "All"];
const BLURAY_REGIONS = ["A", "B", "C", "All"];
const UHD_REGIONS = ["All"];

// Distinct from "All" - "All" means the packaging affirmatively states the disc is
// region-free (or the format's own scheme has no regions at all, like UHD); "Not Listed"
// means the packaging simply doesn't print any region information anywhere, so the region
// is genuinely unknown rather than assumed to be region-free. Appended to every recognized
// format's option list (per the user's own request after finding a disc with no region
// info printed at all) - mutually exclusive with every other option, "All" included, the
// same way "All" itself already is (see MultiSelectChips's exclusiveOptions).
export const NOT_LISTED_REGION = "Not Listed";

/** Which disc-region options make sense for a given format string, or null when the
 * format isn't a recognized disc type (VHS, CD, ...) and no narrower list applies. Checks
 * 4K/UHD before Blu-ray for the same reason extractFormatHint does - a "4K UHD Blu-ray"
 * combo format is UHD's region-free scheme, not Blu-ray's A/B/C one. */
export function getDiskRegionOptions(format: string): string[] | null {
  const normalized = format.toLowerCase();
  if (/4k|ultra ?hd|uhd/.test(normalized)) return [...UHD_REGIONS, NOT_LISTED_REGION];
  if (/blu-?ray/.test(normalized)) return [...BLURAY_REGIONS, NOT_LISTED_REGION];
  if (/dvd/.test(normalized)) return [...DVD_REGIONS, NOT_LISTED_REGION];
  return null;
}

/** True for a format whose own region-coding scheme has no regions at all (Ultra HD
 * Blu-ray) - used to auto-default Disk Region to "All" the moment the format looks like 4K,
 * distinct from getDiskRegionOptions's returned list length (which no longer reliably
 * signals this now that "Not Listed" is appended to every format's options). */
export function isRegionFreeFormat(format: string): boolean {
  return /4k|ultra ?hd|uhd/.test(format.toLowerCase());
}

const REGION_FREE_WORDS = /\bregion[- ]?free\b|\ball regions?\b/i;

/**
 * Best-effort disc-region code(s) mentioned directly in a UPC listing's own text (e.g.
 * "[regions 2,5]", "(Region A)", "Region Free") - added 2026-09-19 after a real listing
 * ("Resident Evil: Extinction [regions 2,5] - Dvd...") showed this is often sitting right
 * there in the raw UPC text, just never extracted into the Disk Region field, which the user
 * had to fill in by hand every time even when the listing already said it. Returns a
 * comma-joined string matching what ConfirmScreen's own MultiSelectChips submits (see
 * disk_region there), or "All" for a region-free listing, or null when nothing usable is
 * found - never a guess dressed up as a confirmed answer, same as every other hint in this
 * file.
 *
 * Deliberately narrow rather than a single greedy capture, to avoid a real false-positive
 * risk: an early draft captured every alnum token in a comma/space-separated run after
 * "region(s)", which would wrongly pull a nearby year digit into the match (e.g. "region 4,
 * 2015 edition" capturing "4" and "2" as if both were region codes). Instead, only looks for
 * genuinely standalone single-character codes (`\b[1-6]\b` for DVD, `\b[A-C]\b` for Blu-ray -
 * word-bounded on both sides, so "2" inside "2015" can never match) within a short window
 * right after the word "region"/"regions", and only for the codes that are actually valid
 * for the given `format` (DVD's 1-6, Blu-ray's A/B/C) - restricted to whichever scheme
 * `getDiskRegionOptions` already says applies, so a stray unrelated character near the word
 * "region" never becomes a wrong guess. Always still editable, same as every other auto-
 * filled hint on this screen; returns null outright for UHD, which carries no per-title
 * region coding of its own to extract (isRegionFreeFormat already handles that case).
 */
// Real country/market -> official region code, by scheme - added 2026-09-22 after the LLM
// listing-text fallback (listingTextExtract.ts) returned "UK" as a disc's region, which isn't
// a real region-code value at all (DVD/Blu-ray region schemes are numbers/letters, never
// country names), so it silently didn't match anything in getDiskRegionOptions' list. A
// country name doesn't map to one universal code either - DVD and Blu-ray group countries
// into their regions differently (e.g. Australia is DVD Region 4 but Blu-ray Region B), so
// this is two separate tables, same as DVD_REGIONS/BLURAY_REGIONS above. Verified against the
// real, decades-old DVD Forum / Blu-ray Disc Association regional breakdowns (September
// 2026) rather than assumed, same standard this file already documents itself against -
// deliberately kept as plain, editable, human-auditable data here rather than asking the LLM
// itself to know/encode this, for the same "keep factual domain knowledge as plain app code,
// not opaque model reasoning" reason formatVision.ts's own comment gives for
// deriveDiscConfigFromExtraDiscs. Covers common real-world markets, not every country on
// Earth - add more as a future listing surfaces one this doesn't recognize (same "ongoing,
// iterative" note as the rest of this file's UPC listing text parsing work).
const DVD_REGION_BY_COUNTRY: Record<string, string> = {
  // Region 1: US/Canada/Bermuda
  "us": "1", "usa": "1", "united states": "1", "america": "1",
  "canada": "1", "bermuda": "1",
  // Region 2: Japan, Europe (incl. UK), South Africa, Middle East, Greenland
  "uk": "2", "united kingdom": "2", "great britain": "2", "britain": "2",
  "england": "2", "scotland": "2", "wales": "2", "northern ireland": "2",
  "japan": "2", "europe": "2", "france": "2", "germany": "2", "italy": "2", "spain": "2",
  "south africa": "2", "middle east": "2", "egypt": "2", "greenland": "2",
  // Region 3: South Korea, Taiwan, Hong Kong, Macau, Southeast Asia
  "south korea": "3", "korea": "3", "taiwan": "3", "hong kong": "3", "macau": "3",
  "thailand": "3", "philippines": "3", "indonesia": "3", "vietnam": "3", "singapore": "3", "malaysia": "3",
  // Region 4: Australia, NZ, Central/South America, Caribbean
  "australia": "4", "new zealand": "4", "mexico": "4", "central america": "4",
  "south america": "4", "caribbean": "4", "brazil": "4", "argentina": "4",
  // Region 5: Russia/former Soviet Union, Indian subcontinent, Africa, North Korea, Mongolia
  "russia": "5", "eastern europe": "5", "india": "5", "pakistan": "5", "africa": "5",
  "north korea": "5", "mongolia": "5",
  // Region 6: China
  "china": "6",
};

const BLURAY_REGION_BY_COUNTRY: Record<string, string> = {
  // Region A: The Americas, East/Southeast Asia
  "us": "A", "usa": "A", "united states": "A", "america": "A",
  "canada": "A", "japan": "A", "south korea": "A", "korea": "A", "taiwan": "A", "hong kong": "A",
  "central america": "A", "south america": "A", "brazil": "A", "philippines": "A",
  "thailand": "A", "indonesia": "A", "singapore": "A",
  // Region B: Europe (incl. UK), Africa, Middle East, Oceania
  "uk": "B", "united kingdom": "B", "great britain": "B", "britain": "B",
  "england": "B", "scotland": "B", "wales": "B", "northern ireland": "B",
  "europe": "B", "france": "B", "germany": "B", "italy": "B", "spain": "B",
  "africa": "B", "south africa": "B", "middle east": "B", "egypt": "B",
  "australia": "B", "new zealand": "B", "oceania": "B",
  // Region C: China, Russia, India, Central/South Asia, Mongolia
  "china": "C", "russia": "C", "india": "C", "pakistan": "C", "mongolia": "C",
};

function normalizeCountryKey(value: string): string {
  return value.toLowerCase().trim().replace(/[.]/g, "").replace(/\s+/g, " ");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Maps a country/market name mentioned in a listing (e.g. "UK", "China", "US import") to
 * the real numeric/letter region code that market actually uses for the given disc format -
 * see DVD_REGION_BY_COUNTRY/BLURAY_REGION_BY_COUNTRY above. Matches a known country/market
 * name as a whole word/phrase anywhere in the text (not just an exact full-string match) -
 * e.g. "us import" still finds "us" - checking longer entries first ("united states" before
 * "us") so a longer name is never shadowed by a shorter one that happens to also be a
 * substring of it. Returns null for UHD (no region scheme of its own) and for any text this
 * table doesn't recognize as a known country/market name - never a guess, same convention as
 * every other hint in this file. */
export function mapRegionCountryToCode(regionText: string, format: string): string | null {
  const normalized = format.toLowerCase();
  if (isRegionFreeFormat(normalized)) return null;
  const isBluRay = /blu-?ray/.test(normalized);
  const table = isBluRay ? BLURAY_REGION_BY_COUNTRY : DVD_REGION_BY_COUNTRY;

  const text = normalizeCountryKey(regionText);
  const directHit = table[text];
  if (directHit) return directHit;

  const keysByLengthDesc = Object.keys(table).sort((a, b) => b.length - a.length);
  for (const key of keysByLengthDesc) {
    if (new RegExp(`\\b${escapeRegExp(key)}\\b`).test(text)) return table[key];
  }
  return null;
}

/** True when `regionText` names EVERY code in the given scheme (Blu-ray's A/B/C, DVD's 1-6) -
 * a disc genuinely coded for every region is region-free in substance even when the text
 * enumerates the codes individually rather than using free-region wording (e.g. a real
 * Blu-ray back cover's combined region badge - three joined hexagons each showing one of
 * "A"/"B"/"C" together - describes itself this way; found live 2026-09-29 against a real
 * "Madame Web" disc whose vision-read text only reported the single most legible letter,
 * "B", out of that three-hexagon cluster, wrongly implying region-B-only). Checked ahead of
 * the single-literal-code match below so a genuine enumeration of every code doesn't get
 * truncated down to just the first one found. */
function listsEveryRegionCode(regionText: string, isBluRay: boolean): boolean {
  const codes = isBluRay ? ["A", "B", "C"] : ["1", "2", "3", "4", "5", "6"];
  const pattern = isBluRay ? /\b[A-Ca-c]\b/g : /\b[1-6]\b/g;
  const found = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(regionText))) found.add(match[0].toUpperCase());
  return codes.every((code) => found.has(code));
}

/** Resolves arbitrary region text (a listing's own wording, or an LLM extraction's "region"
 * field - see listingTextExtract.ts) down to real region code(s)/"All" for the given format,
 * whether that text is already a literal code ("Region 2", "B"), region-free wording, every
 * code in the scheme enumerated individually ("A, B, C"), or a country/market name ("UK",
 * "China") - trying each in that order. A disc is very often coded for more than one region
 * at once (e.g. a combined "Region 2/4" release) - found live 2026-10-02: a real scan whose
 * region icon plainly showed both 2 and 4 only ever got "4" added, because the old version of
 * this function matched the literal-code pattern WITHOUT the `g` flag, so `.match()` returned
 * only the first (or in this case, apparently only) capture the regex engine reported before
 * stopping - every literal code actually present is now collected, not just one. Returns null
 * when nothing usable can be found at all, same "never a guess" convention as the rest of this
 * file - otherwise always an array (even a single code comes back as a one-element array), so
 * every caller treats "one region" and "several regions" the same way. */
export function resolveDiskRegionText(regionText: string, format: string): string[] | null {
  if (REGION_FREE_WORDS.test(regionText)) return ["All"];
  const normalized = format.toLowerCase();
  if (isRegionFreeFormat(normalized)) return null;

  const isBluRay = /blu-?ray/.test(normalized);
  if (listsEveryRegionCode(regionText, isBluRay)) return ["All"];

  const literalCodePattern = isBluRay ? /\b[A-Ca-c]\b/g : /\b[1-6]\b/g;
  const literalCodes = new Set<string>();
  let literalMatch: RegExpExecArray | null;
  while ((literalMatch = literalCodePattern.exec(regionText))) literalCodes.add(literalMatch[0].toUpperCase());
  if (literalCodes.size > 0) return [...literalCodes];

  const countryCode = mapRegionCountryToCode(regionText, format);
  return countryCode ? [countryCode] : null;
}

export function extractDiskRegionHint(text: string, format: string): string | null {
  if (REGION_FREE_WORDS.test(text)) return "All";

  const normalized = format.toLowerCase();
  if (isRegionFreeFormat(normalized)) return null;

  const regionMatch = text.match(/\bregions?\b\s*[:-]?\s*/i);
  if (!regionMatch) return null;
  const windowStart = (regionMatch.index ?? 0) + regionMatch[0].length;
  const window = text.slice(windowStart, windowStart + 20);

  const isBluRay = /blu-?ray/.test(normalized);
  const tokenPattern = isBluRay ? /\b[A-Ca-c]\b/g : /\b[1-6]\b/g;

  const codes: string[] = [];
  const seen = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = tokenPattern.exec(window))) {
    const code = match[0].toUpperCase();
    if (!seen.has(code)) {
      seen.add(code);
      codes.push(code);
    }
  }
  return codes.length > 0 ? codes.join(", ") : null;
}
