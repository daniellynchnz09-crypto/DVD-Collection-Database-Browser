import { supabase } from "./supabase";

export interface FieldOptions {
  format: string[];
  diskRegion: string[];
  genreLocation: string[];
  rating: string[];
  studio: string[];
  animationOrLiveAction: string[];
  genre: string[];
  franchise: string[];
  rentedByWho: string[];
  originalLanguage: string[];
  // Every real, live movie_or_tv value already in the collection - the Confirm screen's
  // Movie/TV type field (SelectInput, added for TV scanning support 2026-09-18) is a closed
  // choice with no free-text entry (per the user's own instruction), unlike every other
  // field here, which stays a SearchableModalInput that also accepts a brand-new value. A
  // genuinely new category still just needs adding to the live data once (e.g. via Direct
  // Database Access) - it becomes selectable here the next time this cache refreshes, same
  // as everywhere else.
  movieOrTv: string[];
}

let cached: FieldOptions | null = null;
let inflight: Promise<FieldOptions> | null = null;

function distinctSorted(values: (string | null)[]): string[] {
  const set = new Set<string>();
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) set.add(trimmed);
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

/** Same as distinctSorted, but for the text[] columns (genre, franchise) - each row
 * contributes every tag it holds, not the array as a single joined value. */
function distinctSortedFlat(values: (string[] | null)[]): string[] {
  const set = new Set<string>();
  for (const list of values) {
    for (const value of list ?? []) {
      const trimmed = value?.trim();
      if (trimmed) set.add(trimmed);
    }
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

const COLUMNS =
  "format, disk_region, genre_location, rating, studio, animation_or_live_action, genre, franchise, rented_by_who, original_language, movie_or_tv";
const PAGE_SIZE = 1000;

/**
 * Every distinct Format/Disk Region/Genre Location/Rating/Studio value already in the
 * collection, for ConfirmScreen's searchable-modal fields (SearchableModalInput) - there's
 * no fixed enum for any of these in the schema, so typing a genuinely new value just becomes
 * selectable for every future scan once it's been saved once. Cached for the app's
 * lifetime; call with forceRefresh after saving a new value if you need the very next
 * screen to already suggest it.
 *
 * Genre and Franchise are both multi-value text[] columns, so their options are every
 * distinct individual tag across the collection (flattened via distinctSortedFlat), not
 * distinct whole-array values - ConfirmScreen's TagSearchableModalInput matches against
 * these per comma-separated segment rather than replacing the whole field, which is what
 * makes suggestions workable for a list field at all (see TagSearchableModalInput.tsx).
 *
 * Paginated in PAGE_SIZE chunks rather than one plain .select() - Postgrest caps a single
 * response at 1000 rows by default, and the collection has ~3000+, so an unpaginated read
 * here was silently missing whatever genre_location/disk_region/etc. values only appeared
 * past the first 1000 rows.
 */
export async function loadFieldOptions(forceRefresh = false): Promise<FieldOptions> {
  if (cached && !forceRefresh) return cached;
  if (inflight) return inflight;

  inflight = (async () => {
    const rows: Record<string, string | string[] | null>[] = [];
    for (let from = 0; ; from += PAGE_SIZE) {
      const { data } = await supabase
        .from("titles")
        .select(COLUMNS)
        .range(from, from + PAGE_SIZE - 1);
      const page = data ?? [];
      rows.push(...page);
      if (page.length < PAGE_SIZE) break;
    }

    const options: FieldOptions = {
      format: distinctSorted(rows.map((r) => r.format as string | null)),
      diskRegion: distinctSorted(rows.map((r) => r.disk_region as string | null)),
      genreLocation: distinctSorted(rows.map((r) => r.genre_location as string | null)),
      rating: distinctSorted(rows.map((r) => r.rating as string | null)),
      studio: distinctSorted(rows.map((r) => r.studio as string | null)),
      animationOrLiveAction: distinctSorted(
        rows.map((r) => r.animation_or_live_action as string | null)
      ),
      genre: distinctSortedFlat(rows.map((r) => r.genre as string[] | null)),
      franchise: distinctSortedFlat(rows.map((r) => r.franchise as string[] | null)),
      // Both scalar single-value columns (0021_add_rental_and_language_fields.sql) - plain
      // distinctSorted, not distinctSortedFlat, matching Format/Studio/Rating rather than
      // Genre/Franchise. TagSearchableModalInput is deliberately NOT used for either - neither
      // is a comma-separated multi-value list.
      rentedByWho: distinctSorted(rows.map((r) => r.rented_by_who as string | null)),
      originalLanguage: distinctSorted(rows.map((r) => r.original_language as string | null)),
      movieOrTv: distinctSorted(rows.map((r) => r.movie_or_tv as string | null)),
    };
    cached = options;
    inflight = null;
    return options;
  })();

  return inflight;
}
