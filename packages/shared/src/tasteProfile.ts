import type { Title, TitleFilters } from "./types";

function intersectRange(
  a?: [number, number],
  b?: [number, number]
): [number, number] | undefined {
  if (!a) return b;
  if (!b) return a;
  const lo = Math.max(a[0], b[0]);
  const hi = Math.min(a[1], b[1]);
  return lo <= hi ? [lo, hi] : undefined;
}

function intersectSet<T>(a?: T[], b?: T[]): T[] | undefined {
  if (!a) return b;
  if (!b) return a;
  const bSet = new Set(b);
  const result = a.filter((x) => bSet.has(x));
  return result.length > 0 ? result : undefined;
}

/**
 * Combines two taste profiles' filters into the "middle ground" both people would enjoy,
 * per Claude/AIM.md Aim Four. Range filters intersect to their overlap; set filters
 * intersect to their common members. A range/set that becomes empty after intersecting
 * is dropped rather than excluding every title.
 */
export function combineTasteProfiles(a: TitleFilters, b: TitleFilters): TitleFilters {
  return {
    movieOrTv: intersectSet(a.movieOrTv, b.movieOrTv),
    releaseYearRange: intersectRange(a.releaseYearRange, b.releaseYearRange),
    runtimeRange: intersectRange(a.runtimeRange, b.runtimeRange),
    genre: intersectSet(a.genre, b.genre),
    franchise: intersectSet(a.franchise, b.franchise),
    rating: intersectSet(a.rating, b.rating),
    format: intersectSet(a.format, b.format),
    animationOrLiveAction: intersectSet(a.animationOrLiveAction, b.animationOrLiveAction),
    documentary: intersectSet(a.documentary, b.documentary),
    isCollection: a.isCollection === b.isCollection ? a.isCollection : undefined,
    titleInACollection:
      a.titleInACollection === b.titleInACollection ? a.titleInACollection : undefined,
    studio: intersectSet(a.studio, b.studio),
    diskRegion: intersectSet(a.diskRegion, b.diskRegion),
    rottenTomatoesScoreRange: intersectRange(
      a.rottenTomatoesScoreRange,
      b.rottenTomatoesScoreRange
    ),
  };
}

/** Applies a TitleFilters (from a single taste profile or a combined one) to a title list. */
export function applyFilters(titles: Title[], filters: TitleFilters): Title[] {
  return titles.filter((t) => {
    if (filters.movieOrTv && !filters.movieOrTv.includes(t.movie_or_tv)) return false;
    if (filters.format && !filters.format.includes(t.format)) return false;
    if (filters.isCollection !== undefined && t.is_collection !== filters.isCollection)
      return false;
    if (
      filters.titleInACollection !== undefined &&
      t.title_in_a_collection !== filters.titleInACollection
    )
      return false;
    if (filters.genre && !t.genre.some((g) => filters.genre!.includes(g))) return false;
    if (filters.franchise && (!t.franchise || !filters.franchise.includes(t.franchise)))
      return false;
    if (filters.rating && (!t.rating || !filters.rating.includes(t.rating))) return false;
    if (filters.studio && (!t.studio || !filters.studio.includes(t.studio))) return false;
    if (filters.diskRegion && (!t.disk_region || !filters.diskRegion.includes(t.disk_region)))
      return false;
    if (filters.releaseYearRange && t.release_date) {
      const year = new Date(t.release_date).getFullYear();
      const [lo, hi] = filters.releaseYearRange;
      if (year < lo || year > hi) return false;
    }
    if (filters.runtimeRange && t.running_time_mins != null) {
      const [lo, hi] = filters.runtimeRange;
      if (t.running_time_mins < lo || t.running_time_mins > hi) return false;
    }
    return true;
  });
}
