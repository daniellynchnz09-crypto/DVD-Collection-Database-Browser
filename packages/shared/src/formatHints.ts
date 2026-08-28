/**
 * Best-effort hints pulled from a UPC product's title/description text, used to narrow
 * down which of several existing collection entries a scanned disc actually is (Claude/
 * TECH STACK AND ARCHITECTURE.md's backfill-matching design: "if the barcode says Blu-ray,
 * narrow by Blu-ray; if it says 2-disc, narrow by 2-disc; only ask the user when more than
 * one candidate remains"). Both are deliberately conservative - return null rather than
 * guess when the text doesn't clearly say.
 */

const FORMAT_PATTERNS: { pattern: RegExp; format: string }[] = [
  { pattern: /\b4k|ultra ?hd|uhd\b/i, format: "4K UHD" },
  { pattern: /\bblu-?ray\b/i, format: "Blu-ray" },
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
