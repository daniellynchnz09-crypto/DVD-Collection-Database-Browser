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
  // "sub-franchise" was merged into "franchise" (0020_merge_franchise_columns.sql,
  // franchise is now a comma-separated multi-value list like genre) - no alias for it here
  // any more, same as imdb_id's removal above. A Sheet still carrying an old "Sub-franchise"
  // column is simply no longer read from or written to.
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
  // Added ahead of the full-collection backfill rescan (0011_backfill_rescan_fields.sql) -
  // see Claude/TECH STACK AND ARCHITECTURE.md's "Backfill Rescan" section. `imdb_id` itself
  // was dropped in 0019_drop_imdb_id.sql - redundant with `imdb_page`, which already embeds
  // it (see extractImdbIdFromPage below) - so there's no alias for it here any more. A
  // Sheet still carrying an old "IMDb ID" column from before this change is simply no
  // longer read from or written to; delete that column by hand if you want it gone too.
  "tmdb page": "tmdb_page",
  "release variant note": "release_variant_note",
  "disc condition": "disc_condition",
  "case notes": "case_notes",
  "watched": "watched",
  "depicted era label": "depicted_era_label",
  "last watched date": "last_watched_date",
  // Added for the one-time watch-history import (0013_add_watched_title.sql, renamed from
  // "watched title"/`watched_title` in 0018_rename_watched_title_to_watched_disc.sql) - see
  // Claude/TECH STACK AND ARCHITECTURE.md's "Backfill Rescan" section for the `watched`
  // (this film, any format) vs `watched_disc` (this specific disc) distinction.
  "watched disc": "watched_disc",
  // Added 0021_add_rental_and_language_fields.sql - see database-design.md.
  "personal rating": "personal_rating",
  "is currently rented out": "is_currently_rented_out",
  "currently rented out": "is_currently_rented_out",
  "rented by who": "rented_by_who",
  "rented by": "rented_by_who",
  "date rented": "date_rented",
  "original language": "original_language",
};

// Columns the sync script/webhook will add to the Sheet itself if missing, per
// STEP BY STEP PROCESS AND AUTOMATION.md "UPDATING THE GOOGLE SHEET" step 1.
export const AUTO_CREATE_COLUMNS: { field: string; headerText: string }[] = [
  { field: "unique_id", headerText: "Unique Identifier" },
  { field: "barcode_id", headerText: "Barcode Identifier" },
  { field: "genre_location", headerText: "Genre Location" },
  { field: "steelbook", headerText: "Steelbook" },
  { field: "release_name", headerText: "Release Name" },
  { field: "tmdb_page", headerText: "TMDb Page" },
  { field: "release_variant_note", headerText: "Release Variant Note" },
  { field: "disc_condition", headerText: "Disc Condition" },
  { field: "case_notes", headerText: "Case Notes" },
  { field: "watched", headerText: "Watched" },
  { field: "depicted_era_label", headerText: "Depicted Era Label" },
  { field: "last_watched_date", headerText: "Last Watched Date" },
  { field: "watched_disc", headerText: "Watched Disc" },
  // Added 0021_add_rental_and_language_fields.sql - see database-design.md.
  { field: "personal_rating", headerText: "Personal Rating" },
  { field: "is_currently_rented_out", headerText: "Is Currently Rented Out" },
  { field: "rented_by_who", headerText: "Rented By Who" },
  { field: "date_rented", headerText: "Date Rented" },
  { field: "original_language", headerText: "Original Language" },
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

/** Same word list as CUT_SUFFIX_WORDS above, but anchored to the END of the string (plus an
 * optional leading "the", separator punctuation, and trailing period) - added 2026-09-17 for
 * splitCutVariantTitle below. CUT_SUFFIX_WORDS itself stays unanchored/unchanged since
 * normalizeTitleForMatch's callers (duplicate-title matching) only care whether the phrase
 * appears anywhere, not where. A title's own cut/edition name is always trailing text in
 * practice ("Blade Runner the Final Cut", "Kingdom of Heaven: Director's Cut") - anchoring to
 * the end means this can never accidentally cut into the middle of an unrelated base title
 * that happens to contain one of these words for some other reason. */
const CUT_SUFFIX_AT_END =
  /[\s:\-–—]+((?:the\s+)?(?:final cut|director'?s cut|extended cut|extended edition|theatrical cut|theatrical edition|ultimate cut|unrated cut|redux))\.?\s*$/i;

export interface CutVariantSplit {
  /** The film's own base title, with the cut/edition suffix removed - what an OMDB/TMDb
   * search should actually use, since neither indexes a separate entry per re-release cut. */
  baseTitle: string;
  /** Verbatim cleaned title (base + cut suffix, original casing) when a suffix was found -
   * kept for callers that just want the whole thing back together. `null` when no cut/edition
   * suffix was present - the ordinary, by-far-most-common case, where `baseTitle` just equals
   * the input unchanged and nothing needs to move anywhere. */
  releaseTitle: string | null;
  /** Just the matched cut/edition phrase itself, verbatim-cased exactly as it appeared in the
   * source text (e.g. "the Final Cut", "Director's Cut", "Redux") - added 2026-09-18 per the
   * user's explicit instruction: a specific CUT of a film belongs appended to the end of the
   * catalogued `title` itself (e.g. "Blade Runner: The Final Cut"), never moved into
   * `release_name` the way a packaging/marketing special edition ("Special Edition,"
   * "Collector's Edition," ...) is - those are a different, unrelated category
   * (PACKAGING_EDITION_WORDS in omdb.ts) and this function/word list has nothing to do with
   * them. `null` alongside `releaseTitle: null` when no cut suffix was found. */
  cutSuffix: string | null;
}

/**
 * Splits a title like "Blade Runner the Final Cut" into a base film title ("Blade Runner") -
 * the only thing OMDB/TMDb actually index, since a re-release cut is a different disc/edit of
 * the same film record, never a separate entry - plus the verbatim cut suffix text on its own
 * (`cutSuffix`), which the confirm flow appends back onto the real OMDB/TMDb title once a
 * match is found (e.g. "Blade Runner" + "the Final Cut" -> stored as "Blade Runner: the Final
 * Cut"). Added 2026-09-17 after a real barcode scan of "Blade Runner: The Final Cut" searched
 * OMDB for that exact string and found nothing useful (OMDB only has "Blade Runner" (1982);
 * "The Final Cut" (2007) is a re-release/re-edit of that same film, not its own entry), which
 * in turn meant the confirm screen's whole candidate list - poster included - came from
 * whatever unrelated title OMDB's fuzzy `s=` search happened to surface for that literal
 * query, not a real Blade Runner match at all.
 *
 * A no-op (returns the input unchanged, `releaseTitle`/`cutSuffix: null`) for the vast
 * majority of titles, which don't name a specific cut/edition at all - this only ever fires
 * when CUT_SUFFIX_AT_END's word list actually matches at the very end of the string.
 */
export function splitCutVariantTitle(title: string): CutVariantSplit {
  const match = title.match(CUT_SUFFIX_AT_END);
  if (!match) return { baseTitle: title, releaseTitle: null, cutSuffix: null };

  const baseTitle = title.slice(0, match.index).trim();
  // A suffix match with nothing left in front of it (the barcode title genuinely IS just
  // "Final Cut", with no film name at all) isn't a real split - searching OMDB for an empty
  // string would just waste the call, so treat this the same as no match at all.
  if (!baseTitle) return { baseTitle: title, releaseTitle: null, cutSuffix: null };

  return { baseTitle, releaseTitle: title.trim(), cutSuffix: match[1].trim() };
}

/** Recovers the bare `tt<digits>` IMDb id from a stored `imdb_page` URL - the only place
 * this app persists it (see 0019_drop_imdb_id.sql: the id was dropped as its own column
 * since it's just this, parsed out again, and keeping both invited them to drift apart).
 * Every `imdb_page` this app writes follows the fixed
 * `https://www.imdb.com/title/<id>/` shape, so a plain regex match is reliable. */
export function extractImdbIdFromPage(imdbPage: string | null | undefined): string | null {
  if (!imdbPage) return null;
  const match = imdbPage.match(/\/title\/(tt\d+)/);
  return match ? match[1] : null;
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
// (TV Show for TV Series). `movie_or_tv` is free text in the DB (not a fixed enum - see
// 0001_init.sql), so this only cleans up known variants; anything unrecognized passes
// through as-is rather than being rejected, since RESOURCES.md's own spec treats this field
// as open-ended ("... etc.").
//
// "tv serial"/"serial tv" used to fold into "TV Series" here - a real bug, found 2026-09-18:
// the user HAD already typed "TV Serial" in the Sheet for a few classic theatrical serials
// (Dick Tracy, Zorro Rides Again), and every sync was silently collapsing that distinction
// away without them knowing. "Serial" is now its own real category - a classic chapter-play
// (Republic/Columbia/Universal-style, 1930s-40s), distinct from an ordinary TV Series: always
// season_no "1", an episode_count counted the same way TV Series counts it (episodes/chapters
// on this specific disc), and - unlike TV Series - always keeps a real running_time_mins,
// since online databases (OMDb included) present a serial in "movie" shape with no episode
// breakdown of its own, and a serial's story definitively concludes rather than running open-
// ended the way an ordinary show can. See barcode-review-screen-fields.md's TV Scanning
// section for the full rule and the still-open "a serial nested inside a show" complexity
// (Doctor Who-shaped, deliberately deferred by the user).
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
  "tv series movie": "TV Series",
  "tv mini series": "TV Mini-Series",
  "tv mini-series": "TV Mini-Series",
  "tv minie series": "TV Mini-Series",
  "tv movie": "TV Movie",
  "tv-movie": "TV Movie",
  "tv special": "TV Special",
  "tv event": "TV Special",
  "tv episode": "TV Episode",
  "serial": "Serial",
  "serials": "Serial",
  "tv serial": "Serial",
  "serial tv": "Serial",
  "tv-serial": "Serial",
};

export function normalizeMovieOrTv(value: string | undefined): string | null {
  const cleaned = cleanCell(value);
  if (cleaned == null) return null;
  return MOVIE_OR_TV_ALIASES[normalizeHeader(cleaned)] ?? cleaned;
}

// season_no is text (0001_init.sql), not an enum, and mostly holds plain numbers or real
// comma-lists ("2,4") - RESOURCES.md's own spec. Beyond those, the live collection had grown
// four more genuine, recurring conventions the original spec never named, resolved with the
// user 2026-09-18 while designing TV scanning support:
//   - "Assorted" - episodes from multiple seasons at random on one disc (e.g. a cartoon
//     compilation). The Sheet had both "various" and "assorted" already in live use for this
//     exact meaning - the user picked "Assorted" as the one going forward; "various" is a
//     value to migrate away from, not a synonym to keep accepting indefinitely.
//   - "All" - this disc/box-set contains every season the show has (a complete-series
//     collection), as opposed to a genuinely random cross-season mix. Kept as its own literal
//     value rather than spelled out as an explicit season list, since that would require
//     looking up how many seasons the show actually has just to say "all of them."
//   - "Specials" - unnumbered special episodes not tied to any numbered season at all (e.g.
//     Super Sentai's clip-show specials) - distinct from "Assorted" (a random mix of regular,
//     numbered-season episodes).
// See Claude/TECH STACK AND ARCHITECTURE/barcode-review-screen-fields.md's TV Scanning section
// for the full design discussion, including the "All"/"Assorted"/"Specials" real-data audit
// this was based on.
export const SEASON_NO_ALIASES: Record<string, string> = {
  "various": "Assorted",
  "assorted": "Assorted",
  "all": "All",
  "specials": "Specials",
};

// Matches a season list written with "and"/hyphen instead of commas (e.g. "1 and 2", "6-7") -
// deliberately narrow (digits and connector words/punctuation only) so it never touches "All",
// "Assorted", "Specials", or free text like "Unknown". "Multiple"/"multiple" is intentionally
// NOT auto-converted here - unlike a mis-punctuated list, it doesn't say which seasons at all,
// so fixing it requires reading the title for context (done as a one-time manual backfill,
// not a blind rule - see backfill-season-no-normalization.ts).
const SEASON_LIST_PATTERN = /^\d+(\s*(,|and|-)\s*\d+)+$/i;

export function normalizeSeasonNo(value: string | undefined): string | null {
  const cleaned = cleanCell(value);
  if (cleaned == null) return null;
  const aliased = SEASON_NO_ALIASES[normalizeHeader(cleaned)];
  if (aliased) return aliased;
  if (SEASON_LIST_PATTERN.test(cleaned)) {
    return (cleaned.match(/\d+/g) ?? []).join(",");
  }
  return cleaned;
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

/** Trims and collapses internal whitespace ("Gladiator  Special Edition " ->
 * "Gladiator Special Edition"), without any case-folding - title/release_name are proper
 * nouns/verbatim packaging text where casing is meaningful, so unlike normalizeFormat or
 * apps/web's canonicalizeValue, this never merges into an existing value. */
export function cleanFreeText(value: string | undefined): string | null {
  const cleaned = cleanCell(value);
  if (cleaned == null) return null;
  return cleaned.replace(/\s+/g, " ");
}

// NZ/Oceania classifications (the user's authoritative source - read off the physical
// case, see Claude/TECH STACK AND ARCHITECTURE.md) are a small fixed set, but the real
// Sheet had accumulated casing drift ("pg", "m") and a couple of stray typos ("R`16",
// "Rr16") - same underlying risk Format had. `rating` stays free text in the DB (OMDB's
// own US-style Rated value, e.g. "PG-13"/"Not Rated", also flows through this column and
// isn't meant to be forced into this table), so an unrecognized value still passes
// through as-is.
const RATING_ALIASES: Record<string, string> = {
  g: "G",
  pg: "PG",
  m: "M",
  r12: "R12",
  r13: "R13",
  r15: "R15",
  r16: "R16",
  rr16: "R16",
  r18: "R18",
};

function normalizeRatingKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function normalizeRating(value: string | undefined): string | null {
  const cleaned = cleanCell(value);
  if (cleaned == null) return null;
  return RATING_ALIASES[normalizeRatingKey(cleaned)] ?? cleaned;
}

// Real Sheet data has 13+ distinct typo'd casings of "Live Action" alone ("Live Aciton",
// "LIve Action", "Live Acrion", "Lice Action", ...) plus a couple of casing variants on
// "2D Animation"/"Puppet"/"Stop Motion Animation" - the same underlying risk Format/Rating
// already had. Deliberately does NOT touch the genuine hybrid descriptions ("Live Action/
// Animation Hybrid", "2D Animation and 3D Animation", ...) - those are real combination
// values, not typos, and stay free text (like Rating, this column isn't a small closed
// enum - an unrecognized value still passes through as-is).
const ANIMATION_ALIASES: Record<string, string> = {
  liveaction: "Live Action",
  // Genuine letter-level typos beyond casing (verified against the real Sheet, not
  // assumed) - a generic case/whitespace-insensitive key can't catch these, since the
  // misspelled key itself doesn't match "liveaction" even after normalizing case.
  liveaciton: "Live Action",
  liiveaction: "Live Action",
  liveactoin: "Live Action",
  liceaction: "Live Action",
  liveacion: "Live Action",
  liveacrion: "Live Action",
  livieaction: "Live Action",
  "2danimation": "2D Animation",
  "3danimation": "3D Animation",
  puppet: "Puppet",
  puppets: "Puppet",
  stopmotion: "Stop-Motion",
  stopmotionanimation: "Stop-Motion",
};

function normalizeAnimationKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function normalizeAnimationOrLiveAction(value: string | undefined): string | null {
  const cleaned = cleanCell(value);
  if (cleaned == null) return null;
  return ANIMATION_ALIASES[normalizeAnimationKey(cleaned)] ?? cleaned;
}

// Disc condition/playback-damage severity - a closed set the user defined explicitly
// (Claude/TECH STACK AND ARCHITECTURE.md's "Backfill Rescan" section), distinct from
// case_notes (free text, for the rarer "blank/mismatched case" scenario). "Visual
// Unchecked" covers a disc that looks scratched but has never actually been played, so its
// real playback impact isn't known yet - deliberately different from "None" (checked, or
// obviously fine) and from "Visual" (checked, plays fine despite visible scratches).
export const DISC_CONDITION_VALUES = [
  "None",
  "Visual",
  "Visual Unchecked",
  "Minor Issues",
  "Unplayable Scenes",
  "Significant",
  "Unwatchable",
] as const;

const DISC_CONDITION_ALIASES: Record<string, string> = {
  none: "None",
  noscratches: "None",
  visual: "Visual",
  visualscratches: "Visual",
  visualunchecked: "Visual Unchecked",
  minorissues: "Minor Issues",
  unplayablescenes: "Unplayable Scenes",
  significant: "Significant",
  unwatchable: "Unwatchable",
};

function normalizeDiscConditionKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Unlike the other normalizers here, this always returns a real value rather than null -
 * a blank cell genuinely means "no known condition issue", i.e. the column's own default. */
export function normalizeDiscCondition(value: string | undefined): string {
  const cleaned = cleanCell(value);
  if (cleaned == null) return "None";
  return DISC_CONDITION_ALIASES[normalizeDiscConditionKey(cleaned)] ?? cleaned;
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
    season_no: normalizeSeasonNo(row[columnIndexes["season_no"]]),
    part_of_season_no: cleanCell(row[columnIndexes["part_of_season_no"]]),
    episode_count: toInt(row[columnIndexes["episode_count"]]),
    release_date: toDate(row[columnIndexes["release_date"]]),
    running_time_mins: toInt(row[columnIndexes["running_time_mins"]]),
    genre: toList(row[columnIndexes["genre"]]),
    director: toList(row[columnIndexes["director"]]),
    franchise: toList(row[columnIndexes["franchise"]]),
    rating: normalizeRating(row[columnIndexes["rating"]]),
    format: normalizeFormat(row[columnIndexes["format"]]) ?? "DVD",
    disc_count: toInt(row[columnIndexes["disc_count"]]) ?? 1,
    special_features: toBoolean(row[columnIndexes["special_features"]]),
    special_features_disc_count: toInt(row[columnIndexes["special_features_disc_count"]]),
    special_features_disc_format: cleanCell(row[columnIndexes["special_features_disc_format"]]),
    animation_or_live_action:
      normalizeAnimationOrLiveAction(row[columnIndexes["animation_or_live_action"]]) ?? "Live Action",
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
    tmdb_page: cleanCell(row[columnIndexes["tmdb_page"]]),
    release_variant_note: cleanCell(row[columnIndexes["release_variant_note"]]),
    disc_condition: normalizeDiscCondition(row[columnIndexes["disc_condition"]]),
    case_notes: cleanCell(row[columnIndexes["case_notes"]]),
    watched: toBoolean(row[columnIndexes["watched"]]),
    depicted_era_label: cleanCell(row[columnIndexes["depicted_era_label"]]),
    last_watched_date: toDate(row[columnIndexes["last_watched_date"]]),
    watched_disc: toBoolean(row[columnIndexes["watched_disc"]]),
    personal_rating: toInt(row[columnIndexes["personal_rating"]]),
    is_currently_rented_out: toBoolean(row[columnIndexes["is_currently_rented_out"]]),
    rented_by_who: cleanCell(row[columnIndexes["rented_by_who"]]),
    date_rented: toDate(row[columnIndexes["date_rented"]]),
    original_language: cleanCell(row[columnIndexes["original_language"]]),
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

// Confirmed against the real Sheet's existing convention (e.g. "154mins", no space) -
// running_time_mins is a plain integer in Postgres, but the Sheet expects the unit typed
// directly after the number. toInt() already reads this back fine either way, since
// parseInt stops at the first non-digit character.
function formatRunningTimeForSheet(value: unknown): string {
  if (value == null || value === "") return "n/a";
  return `${value}mins`;
}

// The real Sheet's boolean convention isn't actually uniform: columns whose header
// literally says "(y/n)" (Collection, Title in a Collection) genuinely use abbreviated
// "y"/"n" as their dominant existing spelling, but "Special Features" (no such qualifier
// in its header) has always predominantly used full "Yes"/"No" (confirmed against the
// real data: 1587 "no"/1429 "yes" vs. a single stray "y") - formatValueForSheet's blanket
// boolean -> "y"/"n" was silently wrong for this one column the whole time, only noticed
// once a scan-confirmed row (Paper Planes) got written with "y" instead of matching every
// other row's "Yes". toBoolean() already accepted both spellings on the read side (its
// YES_VALUES set includes "yes"/"Yes"), so only the write side needed fixing. Steelbook
// (this project's own new column, no legacy data, header also unqualified) follows the
// same "Yes"/"No" convention for consistency with Special Features' naming style.
function formatYesNoForSheet(value: unknown): string {
  if (value == null || value === "") return "n/a";
  return value ? "Yes" : "No";
}

// Fields needing a different sheet representation than their raw DB value (booleans/
// arrays not listed here already stringify sensibly via formatValueForSheet).
const SHEET_FIELD_FORMATTERS: Partial<Record<string, (v: unknown) => string>> = {
  release_date: formatDateForSheet,
  last_watched_date: formatDateForSheet,
  running_time_mins: formatRunningTimeForSheet,
  special_features: formatYesNoForSheet,
  steelbook: formatYesNoForSheet,
  // A fresh column with no legacy data - follows Special Features/Steelbook's "Yes"/"No"
  // convention rather than "y"/"n" for consistency (see the comment above formatYesNoForSheet).
  watched: formatYesNoForSheet,
  watched_disc: formatYesNoForSheet,
  // Also a fresh column with no legacy data - same "Yes"/"No" convention.
  is_currently_rented_out: formatYesNoForSheet,
  date_rented: formatDateForSheet,
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
 * Fields with no Sheet column (case_image_url, case_image_path, poster_image_path,
 * last_updated, depicted_era_start, ...) are simply not written - they're DB-only.
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
