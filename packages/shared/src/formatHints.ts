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
