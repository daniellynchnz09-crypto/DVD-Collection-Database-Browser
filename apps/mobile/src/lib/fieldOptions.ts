import { supabase } from "./supabase";

export interface FieldOptions {
  format: string[];
  diskRegion: string[];
  genreLocation: string[];
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

/**
 * Every distinct Format/Disk Region/Genre Location value already in the collection, for
 * ConfirmScreen's autocomplete fields (AutocompleteInput) - there's no fixed enum for any
 * of these in the schema, so typing a genuinely new value just becomes selectable for
 * every future scan once it's been saved once. Cached for the app's lifetime since this
 * is a large (~3000-row) but small (3 text columns) read; call with forceRefresh after
 * saving a new value if you need the very next screen to already suggest it.
 */
export async function loadFieldOptions(forceRefresh = false): Promise<FieldOptions> {
  if (cached && !forceRefresh) return cached;
  if (inflight) return inflight;

  inflight = (async () => {
    const { data } = await supabase.from("titles").select("format, disk_region, genre_location");
    const rows = data ?? [];
    const options: FieldOptions = {
      format: distinctSorted(rows.map((r) => r.format)),
      diskRegion: distinctSorted(rows.map((r) => r.disk_region)),
      genreLocation: distinctSorted(rows.map((r) => r.genre_location)),
    };
    cached = options;
    inflight = null;
    return options;
  })();

  return inflight;
}
