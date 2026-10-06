/**
 * Pure display/URL helpers - no server-only import, so client components may import this file
 * directly (`@/lib/catalog/display`). Route shapes follow web-app-build-plan.md's data model.
 */

export const discHref = (uniqueId: string) => `/disc/${uniqueId}`;
export const collectionHref = (uniqueId: string) => `/collection/${uniqueId}`;
export const workHref = (imdbId: string) => `/title/${imdbId}`;
export const personHref = (tmdbPersonId: number) => `/person/${tmdbPersonId}`;
export const franchiseHref = (name: string) => `/franchise/${slugify(name)}`;
/** Director-by-name page built from titles.director (works without TMDb person ids). */
export const directorHref = (name: string) => `/people/${slugify(name)}`;
export const searchHref = (q: string) => `/search?q=${encodeURIComponent(q)}`;

/** Lowercase, ASCII-folded, hyphenated - "Pokémon: The Movies" -> "pokemon-the-movies". */
export function slugify(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** A physical row's own name: release_name already carries the base title plus edition
 * wording (e.g. "Gladiator Special Edition"), so it wins over the bare title when set. */
export function displayTitle(row: { title: string; release_name: string | null }): string {
  return row.release_name?.trim() || row.title;
}

export function yearOf(date: string | null | undefined): string | null {
  const match = date?.match(/^(\d{4})/);
  return match ? match[1] : null;
}

/** Compact badge text for the `format` column's free-text values. */
export function shortFormatLabel(format: string | null | undefined): string | null {
  if (!format) return null;
  const f = format.toLowerCase();
  if (f.includes("4k")) return "4K UHD";
  if (f.includes("blu")) return "Blu-ray";
  if (f.includes("custom burn")) return "DVD-R";
  if (f.includes("vhs")) return "VHS";
  if (f.includes("cd")) return "VCD";
  if (f.includes("dvd")) return "DVD";
  return format;
}

/** Poster frame shape (width / height). */
export const POSTER_ASPECT = 2 / 3;

/**
 * The starting frame shape for a case photo, from its format's standard case (width/height,
 * 2026-10-06 - the user: frames should match the case, and Blu-ray cases are shorter). The
 * image frame then settles on the photo's own measured shape once it loads, so box sets,
 * slipcovers and steelbooks that differ from the standard still fit without bars.
 */
export function caseAspect(format: string | null | undefined): number {
  const f = (format ?? "").toLowerCase();
  if (f.includes("4k") || f.includes("blu")) return 135 / 171.5; // Blu-ray / 4K UHD keep case
  if (f.includes("vhs")) return 130 / 210; // VHS clamshell
  if (f.includes("cd")) return 142 / 125; // CD/VCD jewel case - wider than tall
  return 135 / 190; // DVD keep case (also DVD-R and anything unrecognised)
}

/** Frame shape for an image: a case photo starts from its format's case, anything else is a poster. */
export function frameAspect(image: { source: string } | null | undefined, format: string | null | undefined): number {
  return image && (image.source === "case_image" || image.source === "case_url") ? caseAspect(format) : POSTER_ASPECT;
}

/** "Disc 2" / "Discs 1, 2" from disc_number_in_set's free-text comma list. */
export function discNumberLabel(discNumberInSet: string | null | undefined): string | null {
  const parts = (discNumberInSet ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  return parts.length === 1 ? `Disc ${parts[0]}` : `Discs ${parts.join(", ")}`;
}
