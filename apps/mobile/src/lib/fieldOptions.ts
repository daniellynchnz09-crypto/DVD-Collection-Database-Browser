import { supabase } from "./supabase";

export interface FieldOptions {
  format: string[];
  diskRegion: string[];
  genreLocation: string[];
  rating: string[];
  studio: string[];
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

const COLUMNS = "format, disk_region, genre_location, rating, studio";
const PAGE_SIZE = 1000;

/**
 * Every distinct Format/Disk Region/Genre Location/Rating/Studio value already in the
 * collection, for ConfirmScreen's autocomplete fields (AutocompleteInput) - there's no
 * fixed enum for any of these in the schema, so typing a genuinely new value just becomes
 * selectable for every future scan once it's been saved once. Cached for the app's
 * lifetime; call with forceRefresh after saving a new value if you need the very next
 * screen to already suggest it.
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
    const rows: Record<string, string | null>[] = [];
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
      format: distinctSorted(rows.map((r) => r.format)),
      diskRegion: distinctSorted(rows.map((r) => r.disk_region)),
      genreLocation: distinctSorted(rows.map((r) => r.genre_location)),
      rating: distinctSorted(rows.map((r) => r.rating)),
      studio: distinctSorted(rows.map((r) => r.studio)),
    };
    cached = options;
    inflight = null;
    return options;
  })();

  return inflight;
}
