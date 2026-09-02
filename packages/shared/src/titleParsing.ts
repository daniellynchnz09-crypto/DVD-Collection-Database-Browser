/**
 * Field-cleaning and Sheet-row-parsing helpers shared between scripts/src/sync-sheet.ts
 * and the Phase 1 backend routes (apps/web/src/app/api/scan/*, sheet-webhook) - both need
 * to turn a raw Google Sheet row into a `titles`-shaped object identically, so this is the
 * one place that logic lives. See Claude/TECH STACK AND ARCHITECTURE.md.
 */

// Normalized header text (lowercase, punctuation/"(...)" suffixes stripped, whitespace
// collapsed) -> our DB column name. Includes both the "correct" spelling from
// Claude/RESOURCES.md and the typos/variants actually found in the live Sheet.
export const HEADER_ALIASES: Record<string, string> = {
  "unique identifier": "unique_id",
  "title": "title",
  "movie or tv": "movie_or_tv",
  "season no": "season_no",
  "part of a season no": "part_of_season_no",
  "part of season no": "part_of_season_no",
  "episode count": "episode_count",
  "release date": "release_date",
  "running time": "running_time_mins",
  "genre": "genre",
  "director": "director",
  "franchise": "franchise",
  "sub-franchise": "sub_franchise",
  "rating": "rating",
  "format": "format",
  "disc count": "disc_count",
  "disk count": "disc_count",
  "special features": "special_features",
  "special features disc count": "special_features_disc_count",
  "special features disk count": "special_features_disc_count",
  "special features disc format": "special_features_disc_format",
  "special features disk format": "special_features_disc_format",
  "animation or live action": "animation_or_live_action",
  "animation or liveaction": "animation_or_live_action",
  "documentary": "documentary",
  "collection": "is_collection",
  "name of collection": "name_of_collection",
  "title in a collection": "title_in_a_collection",
  "number of titles in a collection": "number_of_titles_in_collection",
  "no titles in collection": "number_of_titles_in_collection",
  "rotten tomatoes page": "rotten_tomatoes_page",
  "rotten tommatoes page": "rotten_tomatoes_page",
  "imdb page": "imdb_page",
  "studio": "studio",
  "disk region": "disk_region",
  "disc region": "disk_region",
  "barcode identifier": "barcode_id",
  "genre location": "genre_location",
  "steelbook": "steelbook",
  "release name": "release_name",
};

// Columns the sync script/webhook will add to the Sheet itself if missing, per
// STEP BY STEP PROCESS AND AUTOMATION.md "UPDATING THE GOOGLE SHEET" step 1.
export const AUTO_CREATE_COLUMNS: { field: string; headerText: string }[] = [
  { field: "unique_id", headerText: "Unique Identifier" },
  { field: "barcode_id", headerText: "Barcode Identifier" },
  { field: "genre_location", headerText: "Genre Location" },
  { field: "steelbook", headerText: "Steelbook" },
  { field: "release_name", headerText: "Release Name" },
];

// Cuts/versions the user names inline within a box set (e.g. "Blade Runner Final Cut")
// rather than as a separate "edition" word - everything else gets the movie's name
// verbatim (Claude/TECH STACK AND ARCHITECTURE.md's backfill-matching design). Used both
// to strip the suffix for base-title matching and to flag "don't trust OMDB's runtime for
// this one" (a single OMDB entry only has one canonical runtime, not per-cut runtimes).
const CUT_SUFFIX_WORDS =
  /\b(final cut|director'?s cut|extended cut|extended edition|theatrical cut|theatrical edition|ultimate cut|unrated cut|redux)\b/i;

export function isCutVariantTitle(title: string): boolean {
  return CUT_SUFFIX_WORDS.test(title);
}

/** Lowercases, strips a cut suffix and punctuation, collapses whitespace - for comparing
 * two title strings as "the same base movie" regardless of minor formatting differences. */
export function normalizeTitleForMatch(title: string): string {
  return title
    .toLowerCase()
    .replace(CUT_SUFFIX_WORDS, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function normalizeHeader(header: string): string {
  return header
    .toLowerCase()
    .replace(/\(.*?\)/g, "")
    .replace(/[.,]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// The real sheet has ~40 distinct spellings of "Movie or TV" for what's really a handful
// of categories - typos (Moive, Documentart), casing drift (Tv Series), and synonyms
// (TV Show/TV Serial for TV Series). `movie_or_tv` is free text in the DB (not a fixed
// enum - see 0001_init.sql), so this only cleans up known variants; anything unrecognized
// passes through as-is rather than being rejected, since RESOURCES.md's own spec treats
// this field as open-ended ("... etc.").
export const MOVIE_OR_TV_ALIASES: Record<string, string> = {
  "movie": "Movie",
  "moive": "Movie",
  "moviw": "Movie",
  "short": "Short",
  "shorts": "Short",
  "short film": "Short",
  "video": "Video",
  "documentary": "Documentary",
  "documentart": "Documentary",
  "tv series": "TV Series",
  "tv sereis": "TV Series",
  "tv show": "TV Series",
  "tv serial": "TV Series",
  "tv series movie": "TV Series",
  "tv mini series": "TV Mini-Series",
  "tv mini-series": "TV Mini-Series",
  "tv minie series": "TV Mini-Series",
  "tv movie": "TV Movie",
  "tv-movie": "TV Movie",
  "tv special": "TV Special",
  "tv event": "TV Special",
  "tv episode": "TV Episode",
};

export function normalizeMovieOrTv(value: string | undefined): string | null {
  const cleaned = cleanCell(value);
  if (cleaned == null) return null;
  return MOVIE_OR_TV_ALIASES[normalizeHeader(cleaned)] ?? cleaned;
}

// The real sheet had ~19 distinct spellings for really 7 physical formats - casing drift
// (DVd, BLu-Ray, Blu Ray) and inconsistent spacing (double space, missing hyphen). Unlike
// normalizeHeader, this deliberately keeps "(...)" content - "DVD (Custom Burn)" and plain
// "DVD" are genuinely different physical media (a home-burned disc vs. an official
// pressing), not a spelling variant of each other, and 3D discs are their own real
// sub-format too - only casing/spacing noise gets collapsed. `format` is free text in the
// DB (not a fixed enum), so an unrecognized value still passes through as-is.
export const FORMAT_ALIASES: Record<string, string> = {
  "dvd": "DVD",
  "dvd (custom burn)": "DVD (Custom Burn)",
  "dvd 3d": "DVD 3D",
  "blu-ray": "Blu-Ray",
  "blu ray": "Blu-Ray",
  "blu-ray 3d": "Blu-Ray 3D",
  "4k uhd": "4K UHD Blu-Ray",
  "4k uhd blu-ray": "4K UHD Blu-Ray",
  "cd movie": "CD Movie",
  "cd": "CD Movie",
};

function normalizeFormatKey(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

export function normalizeFormat(value: string | undefined): string | null {
  const cleaned = cleanCell(value);
  if (cleaned == null) return null;
  return FORMAT_ALIASES[normalizeFormatKey(cleaned)] ?? cleaned;
}

/** Converts a 0-indexed column number to its Sheets column letter(s) (0 -> A, 26 -> AA, ...). */
export function columnLetter(index: number): string {
  let letter = "";
  let n = index + 1;
  while (n > 0) {
    const remainder = (n - 1) % 26;
    letter = String.fromCharCode(65 + remainder) + letter;
    n = Math.floor((n - 1) / 26);
  }
  return letter;
}

const NA_VALUES = new Set(["", "n/a", "N/A", "na"]);
const YES_VALUES = new Set(["y", "yes", "Y", "Yes"]);

export function cleanCell(value: string | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return NA_VALUES.has(trimmed) ? null : trimmed;
}

export function toBoolean(value: string | undefined): boolean {
  const cleaned = cleanCell(value);
  return cleaned != null && YES_VALUES.has(cleaned);
}

export function toInt(value: string | undefined): number | null {
  const cleaned = cleanCell(value);
  if (cleaned == null) return null;
  const n = parseInt(cleaned, 10);
  return Number.isNaN(n) ? null : n;
}

export function toDate(value: string | undefined): string | null {
  // Sheet dates are dd/mm/yyyy per Claude/RESOURCES.md; Postgres wants yyyy-mm-dd.
  const cleaned = cleanCell(value);
  if (cleaned == null) return null;
  const [day, month, year] = cleaned.split("/");
  if (!day || !month || !year) return null;
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

export function toList(value: string | undefined): string[] {
  const cleaned = cleanCell(value);
  if (cleaned == null) return [];
  return cleaned.split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * Builds column-name -> row-index map from a Sheet header row, using HEADER_ALIASES.
 * Shared by sync-sheet.ts (full-sheet sync) and the sheet-webhook route (single-row sync)
 * so both interpret the same header row identically.
 */
export function buildColumnIndexes(header: string[]): Record<string, number> {
  const columnIndexes: Record<string, number> = {};
  header.forEach((headerText, index) => {
    const column = HEADER_ALIASES[normalizeHeader(headerText)];
    if (column) columnIndexes[column] = index;
  });
  return columnIndexes;
}

/** Turns one raw Sheet row + its column-index map + a unique_id into a `titles` upsert object. */
export function parseSheetRowToTitle(
  row: string[],
  columnIndexes: Record<string, number>,
  uniqueId: string
): Record<string, unknown> {
  return {
    unique_id: uniqueId,
    title: cleanCell(row[columnIndexes["title"]]),
    movie_or_tv: normalizeMovieOrTv(row[columnIndexes["movie_or_tv"]]) ?? "Movie",
    season_no: cleanCell(row[columnIndexes["season_no"]]),
    part_of_season_no: cleanCell(row[columnIndexes["part_of_season_no"]]),
    episode_count: toInt(row[columnIndexes["episode_count"]]),
    release_date: toDate(row[columnIndexes["release_date"]]),
    running_time_mins: toInt(row[columnIndexes["running_time_mins"]]),
    genre: toList(row[columnIndexes["genre"]]),
    director: toList(row[columnIndexes["director"]]),
    franchise: cleanCell(row[columnIndexes["franchise"]]),
    sub_franchise: cleanCell(row[columnIndexes["sub_franchise"]]),
    rating: cleanCell(row[columnIndexes["rating"]]),
    format: normalizeFormat(row[columnIndexes["format"]]) ?? "DVD",
    disc_count: toInt(row[columnIndexes["disc_count"]]) ?? 1,
    special_features: toBoolean(row[columnIndexes["special_features"]]),
    special_features_disc_count: toInt(row[columnIndexes["special_features_disc_count"]]),
    special_features_disc_format: cleanCell(row[columnIndexes["special_features_disc_format"]]),
    animation_or_live_action:
      cleanCell(row[columnIndexes["animation_or_live_action"]]) ?? "Live Action",
    documentary: cleanCell(row[columnIndexes["documentary"]]) ?? "n",
    is_collection: toBoolean(row[columnIndexes["is_collection"]]),
    name_of_collection: cleanCell(row[columnIndexes["name_of_collection"]]),
    title_in_a_collection: toBoolean(row[columnIndexes["title_in_a_collection"]]),
    number_of_titles_in_collection: toInt(row[columnIndexes["number_of_titles_in_collection"]]),
    rotten_tomatoes_page: cleanCell(row[columnIndexes["rotten_tomatoes_page"]]),
    imdb_page: cleanCell(row[columnIndexes["imdb_page"]]),
    studio: cleanCell(row[columnIndexes["studio"]]),
    disk_region: cleanCell(row[columnIndexes["disk_region"]]),
    barcode_id: cleanCell(row[columnIndexes["barcode_id"]]),
    genre_location: cleanCell(row[columnIndexes["genre_location"]]),
    steelbook: toBoolean(row[columnIndexes["steelbook"]]),
    release_name: cleanCell(row[columnIndexes["release_name"]]),
  };
}

/**
 * Best-effort extraction of a "depicted era" (a year) from a documentary's title/synopsis,
 * for the History Documentary shelf-ordering (Claude/AIM.md Aim Five). Looks for an
 * explicit 4-digit year or the start of a decade/range ("1936-1939" -> 1936, "1970s" -> 1970).
 * Returns null when nothing confident is found - the manual-fill form covers the rest.
 */
export function inferDepictedEraStart(title: string, synopsis?: string | null): number | null {
  const text = `${title} ${synopsis ?? ""}`;
  const match = text.match(/\b(1[0-9]{3}|20[0-9]{2})s?\b/);
  if (!match) return null;
  const year = parseInt(match[1], 10);
  return year >= 1000 && year <= new Date().getFullYear() + 1 ? year : null;
}

function formatDateForSheet(value: unknown): string {
  if (typeof value !== "string" || !value) return "n/a";
  const [year, month, day] = value.split("-");
  if (!year || !month || !day) return "n/a";
  return `${parseInt(day, 10)}/${parseInt(month, 10)}/${year}`;
}

function formatValueForSheet(value: unknown): string {
  if (value == null || value === "") return "n/a";
  if (typeof value === "boolean") return value ? "y" : "n";
  if (Array.isArray(value)) return value.length > 0 ? value.join(", ") : "n/a";
  return String(value);
}

// Fields needing a different sheet representation than their raw DB value
// (booleans/arrays already stringify sensibly via formatValueForSheet - only
// dates need reformatting, dd/mm/yyyy in the Sheet vs yyyy-mm-dd in Postgres).
const SHEET_FIELD_FORMATTERS: Partial<Record<string, (v: unknown) => string>> = {
  release_date: formatDateForSheet,
};

/** Formats one field's value the same way buildSheetRowFromTitle would, for callers that
 * only need to patch a few cells in an existing row (see updateSheetFieldsByUniqueId). */
export function formatFieldForSheet(field: string, value: unknown): string {
  const formatter = SHEET_FIELD_FORMATTERS[field] ?? formatValueForSheet;
  return formatter(value);
}

/**
 * Inverse of parseSheetRowToTitle: turns a `titles`-shaped object back into a raw Sheet
 * row (string array, one cell per column, in header order) for appending a new row.
 * Fields with no Sheet column (case_image_url, last_updated, depicted_era_start, ...)
 * are simply not written - they're DB-only.
 */
export function buildSheetRowFromTitle(
  title: Record<string, unknown>,
  columnIndexes: Record<string, number>,
  columnCount: number
): string[] {
  const row = new Array(columnCount).fill("");
  for (const [field, index] of Object.entries(columnIndexes)) {
    if (index < 0 || index >= columnCount) continue;
    const formatter = SHEET_FIELD_FORMATTERS[field] ?? formatValueForSheet;
    row[index] = formatter(title[field]);
  }
  return row;
}
