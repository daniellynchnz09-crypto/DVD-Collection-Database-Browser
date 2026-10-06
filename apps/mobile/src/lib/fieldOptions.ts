import { supabase } from "./supabase";
import { getAllConfirmDrafts } from "./confirmDrafts";
import { fetchRentedByOptions } from "./scanApi";

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
  // franchiseCooccurrence[a][b] = number of titles tagged with both franchise a and franchise b -
  // powers the Franchise slide's "often go with this selection" picks.
  franchiseCooccurrence: Record<string, Record<string, number>>;
  // ratingsByFranchise[franchise][rating] = number of titles tagged with that franchise that
  // carry that rating - added 2026-09-27 per the user's request for quick-tap rating buttons
  // on the Confirm screen ("give me buttons for the most common ratings for that franchise").
  // Most box sets/series in a given franchise tend to carry the same handful of
  // classifications (e.g. every mainline X-Men film is M or R13), so this lets the Rating
  // field surface the actual, real ratings this collection already uses for the same
  // franchise instead of the full alphabetical list of every rating ever seen.
  ratingsByFranchise: Record<string, Record<string, number>>;
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

function buildCooccurrence(lists: (string[] | null)[]): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const list of lists) {
    const tags = [...new Set((list ?? []).map((t) => t?.trim()).filter(Boolean))] as string[];
    for (const a of tags) {
      for (const b of tags) {
        if (a === b) continue;
        out[a] ??= {};
        out[a][b] = (out[a][b] ?? 0) + 1;
      }
    }
  }
  return out;
}

/** Counts how many titles tagged with each franchise carry each rating - one title with
 * multiple franchise tags contributes its rating to every one of them, same "count once per
 * distinct tag on this row" convention buildCooccurrence uses. Blank ratings are skipped
 * entirely (nothing useful to suggest from an unrated title). */
function buildRatingsByFranchise(
  franchiseLists: (string[] | null)[],
  ratings: (string | null)[]
): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (let i = 0; i < franchiseLists.length; i++) {
    const rating = ratings[i]?.trim();
    if (!rating) continue;
    const tags = [...new Set((franchiseLists[i] ?? []).map((t) => t?.trim()).filter(Boolean))] as string[];
    for (const tag of tags) {
      out[tag] ??= {};
      out[tag][rating] = (out[tag][rating] ?? 0) + 1;
    }
  }
  return out;
}

// rented_by_who is deliberately absent (2026-10-06): the public key can no longer read it
// (migration 0044 - real third parties' names), so those options come from the scan-secret-gated
// /api/scan/rented-by-options route instead (fetchRentedByOptions below).
const COLUMNS =
  "format, disk_region, genre_location, rating, studio, animation_or_live_action, genre, franchise, original_language, movie_or_tv";
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
  return withDraftValues(await loadSavedFieldOptions(forceRefresh));
}

function splitTagList(value: string | undefined): string[] {
  return (value ?? "").split(",").map((t) => t.trim()).filter(Boolean);
}

function mergeSorted(base: string[], extra: (string | undefined | null)[]): string[] {
  const set = new Set(base);
  let changed = false;
  for (const value of extra) {
    const trimmed = value?.trim();
    if (trimmed && !set.has(trimmed)) {
      set.add(trimmed);
      changed = true;
    }
  }
  return changed ? [...set].sort((a, b) => a.localeCompare(b)) : base;
}

/**
 * Folds every value typed into ANY still-unsubmitted pending scan's saved draft
 * (confirmDrafts.ts) into the option lists - added 2026-10-03 per the user's own request: a
 * brand-new Franchise/Genre/Genre Location/etc. created on one pending scan should be offered
 * on the next pending scan straight away, not only once the first one is finally submitted
 * and lands in `titles` (the only place loadSavedFieldOptions reads from). Recomputed on every
 * call rather than cached, since drafts change constantly and reading them is just an
 * in-memory Map walk - the `cached` DB snapshot itself is left untouched, so a draft that's
 * later discarded simply stops contributing its values instead of lingering in the cache.
 */
function withDraftValues(options: FieldOptions): FieldOptions {
  const drafts = getAllConfirmDrafts();
  if (drafts.length === 0) return options;
  const members = drafts.flatMap((d) => d.collectionMembers ?? []);
  return {
    ...options,
    format: mergeSorted(options.format, [
      ...drafts.flatMap((d) => [d.format, d.specialFeaturesDiscFormat]),
      ...members.flatMap((m) => [m.format, m.specialFeaturesDiscFormat]),
    ]),
    diskRegion: mergeSorted(options.diskRegion, drafts.flatMap((d) => d.diskRegions ?? [])),
    genreLocation: mergeSorted(options.genreLocation, drafts.map((d) => d.genreLocation)),
    rating: mergeSorted(options.rating, [...drafts.map((d) => d.rating), ...members.map((m) => m.rating)]),
    studio: mergeSorted(options.studio, drafts.map((d) => d.studio)),
    animationOrLiveAction: mergeSorted(options.animationOrLiveAction, drafts.map((d) => d.animationOrLiveAction)),
    genre: mergeSorted(options.genre, drafts.flatMap((d) => splitTagList(d.genre))),
    franchise: mergeSorted(options.franchise, [
      ...drafts.flatMap((d) => splitTagList(d.franchise)),
      ...members.flatMap((m) => splitTagList(m.franchise)),
    ]),
    rentedByWho: mergeSorted(options.rentedByWho, drafts.map((d) => d.rentedByWho)),
    originalLanguage: mergeSorted(options.originalLanguage, drafts.map((d) => d.originalLanguage)),
  };
}

async function loadSavedFieldOptions(forceRefresh: boolean): Promise<FieldOptions> {
  if (cached && !forceRefresh) return cached;
  if (inflight) return inflight;

  inflight = (async () => {
    const rows: Record<string, string | string[] | null>[] = [];
    // Started alongside the paged reads below; a failure (offline, old server) just means no
    // Rented By suggestions rather than breaking every other field's options.
    const rentedByPromise = fetchRentedByOptions()
      .then((r) => r.names)
      .catch(() => [] as string[]);
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
      rentedByWho: await rentedByPromise,
      originalLanguage: distinctSorted(rows.map((r) => r.original_language as string | null)),
      movieOrTv: distinctSorted(rows.map((r) => r.movie_or_tv as string | null)),
      franchiseCooccurrence: buildCooccurrence(rows.map((r) => r.franchise as string[] | null)),
      ratingsByFranchise: buildRatingsByFranchise(
        rows.map((r) => r.franchise as string[] | null),
        rows.map((r) => r.rating as string | null)
      ),
    };
    cached = options;
    inflight = null;
    return options;
  })();

  return inflight;
}
