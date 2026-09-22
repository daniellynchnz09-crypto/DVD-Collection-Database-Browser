import type { CollectionMember } from "../components/TitleSearchPicker";
import type { OmdbSearchCandidate } from "./scanApi";

/**
 * Collection-name helpers (2026-09-20). Some box sets are titled something bland like "2 Movie
 * Collection" and then print the film names on the case as part of the title; for those the
 * automatic ": Title1, Title2" suffix would just repeat what's already there, a generic name needs
 * no separate release name, and the films can be matched straight from the name.
 */

/** Lowercase, drop a leading article and everything that isn't a letter/digit, collapse spaces. */
export function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/^(the|a|an)\s+/, "")
    .trim();
}

/** True when every title in the list already appears inside the typed collection name - in which
 * case the automatic ": Title1, Title2" suffix is skipped and the name is saved exactly as typed. */
export function nameListsAllTitles(baseName: string, memberTitles: string[]): boolean {
  if (memberTitles.length === 0) return false;
  // Spaces are ignored too (2026-09-20): a case reads "Spiderman into the Spiderverse" while the
  // matched film is "Spider-Man: Into the Spider-Verse" - same title, different spacing/hyphens.
  const squash = (x: string) => normalizeForMatch(x).replace(/\s+/g, "");
  const haystack = squash(baseName);
  return memberTitles.every((t) => {
    const needle = squash(t);
    return needle.length >= 4 && haystack.includes(needle);
  });
}

const NUMBER_WORD = "one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve";

/** A name that doesn't identify the release by itself ("2 Movie Collection", "Double Feature",
 * "Box Set") - saved with no Release Name, per the user's own rule for these. */
export function isGenericCollectionName(baseName: string): boolean {
  // Only the part before a colon is judged: "2 movie collection: Film A, Film B" is the generic
  // "2 movie collection" followed by the titles it lists (found live 2026-09-20 - the whole string
  // was judged instead, so this header kept a Release Name).
  const n = normalizeForMatch(baseName.split(":")[0]);
  if (!n) return false;
  // "<Franchise> Trilogy Collection" (2026-09-20): several different trilogies can share one
  // franchise (e.g. three Spider-Man trilogies), so the name can't identify the release by itself.
  // Tolerates the common "trillogy" misspelling.
  if (/\b(?:duo|tri|tetra|quadri|penta|hexa)l+ogy\b/.test(n)) return true;
  const filler = "(?:movie|film|disc|dvd|blu ray|pack|title|classic|great|best)s?";
  const kind = "(?:collection|set|box set|boxset|pack|bundle|double feature|triple feature|double bill|anthology)";
  return (
    new RegExp(`^(?:\\d+|${NUMBER_WORD})(?: ${filler})* ${kind}$`).test(n) ||
    new RegExp(`^(?:${kind}|(?:double|triple|twin|quad|quadruple) (?:feature|pack|bill))$`).test(n) ||
    new RegExp(`^(?:\\d+|${NUMBER_WORD}) ${filler}$`).test(n)
  );
}

/** Same generic test but for a name that has the film list attached after a colon or dash, e.g.
 * "2 Movie Collection: Buck Privates, In the Navy" - only the part before the list is judged. */
export function baseNameIsGeneric(fullName: string): boolean {
  return isGenericCollectionName(fullName.split(":")[0]);
}

/** Splits a collection name into likely film-title fragments. Primary delimiters are commas,
 * semicolons, colons, ampersands and "+"; a fragment that still contains " and " is returned whole
 * (film names contain "and" themselves) with its " and "-split pieces after it as fallbacks. */
export function extractTitleSegments(name: string): string[][] {
  const withoutGeneric = name.replace(/\b(?:\d+|(?:one|two|three|four|five|six|seven|eight|nine|ten))[\s-]*(?:movie|film|dvd|disc|blu-?ray)?s?\s+(?:collection|set|pack|box\s?set)\b\s*:?/gi, " ");
  const parts = withoutGeneric
    .split(/[,;:&+]/)
    .map((p) => p.trim())
    .filter((p) => normalizeForMatch(p).length >= 3);
  return parts.map((p) => {
    if (!/\sand\s/i.test(p)) return [p];
    return [p, ...p.split(/\s+and\s+/i).map((x) => x.trim()).filter((x) => normalizeForMatch(x).length >= 3)];
  });
}

function guessMovieOrTv(type: string | undefined): string {
  if (type === "series") return "TV Series";
  if (type === "episode") return "TV Episode";
  return "Movie";
}

/**
 * Looks the fragments in a collection name up on OMDB and returns the confident matches as
 * ready-to-list members. "Confident" is strict on purpose: the candidate's title must equal the
 * fragment after normalisation (a wrong auto-added film is worse than a missing one), and at least
 * two films must resolve or nothing is returned at all. Members come back without disc numbers -
 * which disc(s) each is on is something only the user can say, so they're prompted to tick them.
 */
export async function autoMatchTitlesFromName(
  name: string,
  defaultFormat: string,
  search: (query: string) => Promise<{ candidates: OmdbSearchCandidate[] }>,
  makeKey: () => string
): Promise<CollectionMember[]> {
  const groups = extractTitleSegments(name);
  if (groups.length === 0) return [];

  async function matchOne(fragment: string): Promise<OmdbSearchCandidate | null> {
    try {
      const { candidates } = await search(fragment);
      const want = normalizeForMatch(fragment);
      return candidates.find((c) => normalizeForMatch(c.Title) === want) ?? null;
    } catch {
      return null;
    }
  }

  const found: OmdbSearchCandidate[] = [];
  for (const group of groups) {
    // Whole fragment first; only if it fails, its " and "-split pieces (each must match).
    const whole = await matchOne(group[0]);
    if (whole) {
      found.push(whole);
      continue;
    }
    const pieces = group.slice(1);
    if (pieces.length > 0) {
      const matched: OmdbSearchCandidate[] = [];
      for (const piece of pieces) {
        const m = await matchOne(piece);
        if (m) matched.push(m);
      }
      found.push(...matched);
    }
  }

  const unique = found.filter((c, i) => found.findIndex((o) => o.imdbID === c.imdbID) === i);
  if (unique.length < 2) return [];
  return unique.map((c) => ({
    key: makeKey(),
    imdbId: c.imdbID,
    title: c.Title,
    poster: c.Poster && c.Poster !== "N/A" ? c.Poster : undefined,
    movieOrTv: guessMovieOrTv(c.Type),
    watched: false,
    watchedDisc: false,
    format: defaultFormat,
    discCount: "1",
    discNumbers: "",
    specialFeatures: false,
  }));
}
