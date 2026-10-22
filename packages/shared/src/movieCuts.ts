/**
 * Cuts of one film inside a collection (2026-10-22, the user's request). OMDb/TMDb list a film
 * once, never per cut, so the scanner matches the film itself and the user names the cut. A
 * cut's own release date and runtime are the only facts that really differ, and TMDb's
 * per-country release-date notes often name the cut ("119-minute Dario Argento Cut", "Rogue
 * Cut", "Sydney (Final Cut)"), as do its alternative titles ("Extended 196 Minute Recut
 * (2001)"). These helpers read the cut's details out of that text.
 */

export interface TmdbReleaseNote {
  /** YYYY-MM-DD */
  date: string;
  note: string;
}

export interface TmdbAltTitle {
  title: string;
  type: string;
}

export interface CutInfo {
  releaseDate: string | null;
  runtimeMins: number | null;
}

/** Quick picks offered for every film, before TMDb's own suggestions. */
export const COMMON_CUT_NAMES = ["Theatrical Cut", "Extended Cut", "Director's Cut", "Unrated Cut"];

const FILLER_WORDS = new Set(["the", "a", "an", "cut", "version", "edition", "of", "s"]);

function textTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/'s\b/g, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** The words that identify a cut: "The Argento Cut" -> ["argento"], "Director's Cut" -> ["director"]. */
export function cutKeyTokens(cutName: string): string[] {
  return textTokens(cutName).filter((t) => !FILLER_WORDS.has(t));
}

/** The theatrical cut is the film's own release, so the film's own date and runtime apply. */
export function isTheatricalCut(cutName: string): boolean {
  return /\b(theatrical|original)\b/i.test(cutName);
}

function textNamesCut(text: string, keyTokens: string[]): boolean {
  if (keyTokens.length === 0) return false;
  const tokens = new Set(textTokens(text));
  return keyTokens.every((t) => tokens.has(t));
}

/** "119-minute ..." / "196 Minute Recut" / "139 mins" -> minutes, only within a plausible film length. */
export function runtimeFromText(text: string): number | null {
  const match = text.match(/\b(\d{2,3})[\s-]*min(?:ute)?s?\b/i);
  if (!match) return null;
  const mins = parseInt(match[1], 10);
  return mins >= 20 && mins <= 400 ? mins : null;
}

/** The cut's earliest dated release that names it, and a runtime from any note or alternative
 * title that names it. Null for a theatrical cut (the film's own values apply) or a blank name. */
export function findCutInfo(cutName: string, notes: TmdbReleaseNote[], altTitles: TmdbAltTitle[]): CutInfo | null {
  if (!cutName.trim() || isTheatricalCut(cutName)) return null;
  const key = cutKeyTokens(cutName);
  const matchingNotes = notes.filter((n) => textNamesCut(n.note, key)).sort((a, b) => a.date.localeCompare(b.date));
  const matchingAlts = altTitles.filter((a) => textNamesCut(`${a.title} ${a.type}`, key));
  const runtimeMins =
    matchingNotes.map((n) => runtimeFromText(n.note)).find((m) => m != null) ??
    matchingAlts.map((a) => runtimeFromText(`${a.type} ${a.title}`)).find((m) => m != null) ??
    null;
  return { releaseDate: matchingNotes[0]?.date ?? null, runtimeMins };
}

const CUT_NAME_IN_NOTE = /((?:[A-Z][\w'’+.-]*\s+){0,3}(?:Cut|Recut|Redux|Version))\b/g;

/** Cut names TMDb's notes mention for this film, most-mentioned first ("Dario Argento Cut",
 * "Cannes Cut", "Rogue Cut", "Redux"). Leading "The" is dropped. */
export function suggestCutNames(notes: TmdbReleaseNote[], limit = 6): string[] {
  const counts = new Map<string, { name: string; count: number }>();
  for (const { note } of notes) {
    for (const match of note.matchAll(CUT_NAME_IN_NOTE)) {
      const name = match[1].replace(/^the\s+/i, "").trim();
      const key = cutKeyTokens(name).join(" ");
      if (!key) continue;
      const existing = counts.get(key);
      if (existing) existing.count += 1;
      else counts.set(key, { name, count: 1 });
    }
  }
  // "Apocalypse Now Final Cut" is just "Final Cut" with the film's name in front.
  const keys = [...counts.keys()];
  const isLongerFormOfAnother = (key: string) => keys.some((other) => other !== key && key.endsWith(` ${other}`));
  return [...counts.entries()]
    .filter(([key]) => !isLongerFormOfAnother(key))
    .map(([, value]) => value)
    .sort((a, b) => b.count - a.count)
    .slice(0, limit)
    .map((c) => c.name);
}

/** How a cut appears in the title column - the same "<film>: <cut>" shape the confirm route's
 * `cut_suffix` writes for a single-title scan. */
export function titleWithCut(baseTitle: string, cutName: string | null | undefined): string {
  const cut = cutName?.trim();
  return cut ? `${baseTitle}: ${cut}` : baseTitle;
}
