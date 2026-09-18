const API_URL = process.env.EXPO_PUBLIC_SCAN_API_URL!;
const API_SECRET = process.env.EXPO_PUBLIC_SCAN_API_SECRET!;

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-scan-secret": API_SECRET },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error ?? `Request to ${path} failed (${res.status})`);
  return data as T;
}

export function queueScan(barcode: string) {
  return post<{ pendingScanId: string }>("/api/scan/queue", { barcode });
}

export interface ManualPendingScan {
  id: string;
  barcode: null;
  status: "needs_manual";
  resolved_candidates: Record<string, never>;
  scanned_at: string;
}

/** Creates a pending scan with no barcode at all, for the "+" button in PendingScansScreen -
 * some of the collection's custom-burned DVDs (the user's own creations) have no barcode to
 * scan in the first place. Lands straight on the manual title-search step in ConfirmScreen,
 * same as a barcode that scanned but returned nothing. */
export function createManualPendingScan() {
  return post<{ scan: ManualPendingScan }>("/api/scan/manual-entry", {});
}

export interface ConfirmEntry {
  imdbId?: string;
  barcodeId?: string;
  manualFields?: Record<string, unknown>;
  /** Per-entry (added 2026-09-20, for the Collection scanning flow): fully replaces every
   * field of an already-catalogued title instead of creating a new row for THIS entry only -
   * the "Overwrite" choice on the pre-submit similar-entry check (see findExistingTitle
   * below). A collection submission can mix fresh-insert entries (a genuinely new member)
   * and overwrite entries (a member that matched an already-catalogued row) in one request -
   * see the confirm route's own comment on why this moved from a request-level field to a
   * per-entry one. */
  overwriteUniqueId?: string;
}

interface ConfirmResult {
  success: boolean;
  createdTitleIds: string[];
  shelfLocation: { before: string | null; after: string | null } | null;
}

export function confirmScan(pendingScanId: string, entries: ConfirmEntry[]) {
  return post<ConfirmResult>("/api/scan/confirm", { pendingScanId, entries });
}

/** For the re-scan case: the resolver already found an existingMatch, nothing new to write. */
export function dismissScan(pendingScanId: string) {
  return post<ConfirmResult>("/api/scan/confirm", { pendingScanId, dismiss: true });
}

/** Deletes a stray/junk pending scan outright - e.g. a barcode glimpsed on a neighbouring
 * disc while lining up a shot, never meant to be catalogued. */
export function discardScan(pendingScanId: string) {
  return post<ConfirmResult>("/api/scan/confirm", { pendingScanId, discard: true });
}

/** Enough detail for a real side-by-side comparison against the fresh scan, not just a
 * title/format/disc-count summary - see apps/web/src/app/api/scan/find-existing/route.ts. */
export interface ExistingTitleCandidate {
  unique_id: string;
  title: string;
  release_name: string | null;
  format: string;
  disc_count: number;
  disk_region: string | null;
  genre_location: string | null;
  franchise: string[];
  rating: string | null;
  studio: string | null;
  animation_or_live_action: string;
  special_features: boolean;
  steelbook: boolean;
  barcode_id: string | null;
  case_image_url: string | null;
  imdb_page: string | null;
  release_date: string | null;
  /** case_image_url when set, else an OMDB poster fetched server-side via the id parsed out
   * of imdb_page, else null. */
  posterUrl: string | null;
  movie_or_tv: string;
  season_no: string | null;
  part_of_season_no: string | null;
  episode_count: number | null;
  is_collection: boolean;
  title_in_a_collection: boolean;
  name_of_collection: string | null;
  /** Only present on an `is_collection` candidate from the collection-header fuzzy match
   * (added 2026-09-20) - that candidate's own already-catalogued members, so a single
   * "overwrite the whole collection" decision can resolve into a per-title match client-side
   * without a second round-trip. See find-existing/route.ts's own comment for the full design. */
  existingMemberTitles?: { title: string; unique_id: string }[];
}

export type FindExistingResult =
  | { status: "none" }
  | { status: "auto"; match: ExistingTitleCandidate }
  | { status: "ambiguous"; candidates: ExistingTitleCandidate[] };

/** Similar/matching-entry check, run right before confirmScan actually writes anything -
 * matches by title text OR (when imdbId is known - a real OMDB/TMDb candidate was picked)
 * a shared imdb_id, across every row (not just unbarcoded legacy ones), so both the
 * original backfill scenario and a genuine re-scan/duplicate-copy surface here.
 *
 * `formatOverride`/`discCountOverride` (added 2026-09-18) - ConfirmScreen's own already-
 * resolved `format`/`discCount` state, passed through so the server's own narrowing step
 * doesn't have to re-derive a hint from the raw barcode listing text independently. Found
 * live: a real "Blade Runner: The Final Cut" listing's own title text literally said "...Dvd"
 * despite the actual disc being 4K UHD - ConfirmScreen had already correctly resolved the
 * real format (via the vision fallback, or the user's own manual correction on the form) by
 * the time this check runs, but the server was still narrowing candidates against the same
 * stale, wrong "DVD" text hint - which silently filtered the genuine 4K UHD duplicate OUT of
 * the results shown, hiding it from view (the box-set's own DVD-format member rows still
 * matched, so the screen didn't look broken - it just never showed the one candidate that
 * actually mattered). Passing the screen's own resolved values means the narrowing step now
 * agrees with what the user is actually looking at, not a second, disconnected guess.
 *
 * `scopeToCollections` (added 2026-09-20) - passed by the Collection scanning flow so this
 * check only ever compares a collection header/member against other collections/collection
 * members, never against a standalone title (see find-existing/route.ts's own comment on
 * why: a film owned both standalone and inside a box set is legitimate, not a duplicate).
 *
 * `collectionMemberTitles` (added 2026-09-20) - passed only when checking the collection
 * HEADER itself (not an individual member): the collection's own already-added member titles,
 * used server-side for a fuzzy name+format+member-title-overlap match instead of requiring
 * exact title-text equality (a real box set was found to fail exact matching once already -
 * see find-existing/route.ts's own comment on why). */
export function findExistingTitle(
  title: string,
  upcText: string,
  imdbId?: string,
  formatOverride?: string,
  discCountOverride?: number,
  scopeToCollections?: boolean,
  collectionMemberTitles?: string[]
) {
  return post<FindExistingResult>("/api/scan/find-existing", {
    title,
    upcText,
    imdbId,
    formatOverride,
    discCountOverride,
    scopeToCollections,
    collectionMemberTitles,
  });
}

export interface TmdbPreview {
  tmdbId: number | null;
  rating: string | null;
  studio: string | null;
  isAnimated: boolean | null;
  originalLanguage: string | null;
  franchise: string[];
  // TMDb's raw genre names - used to sharpen the movie_or_tv guess (a movie-typed candidate
  // tagged TMDb's own "TV Movie" genre almost certainly is one), same signal the confirm
  // route's own OMDb+TMDb genre merge uses. See ConfirmScreen.tsx's guessMovieOrTvFromType.
  genres: string[];
}

/** Read-only "would TMDb find anything for this title" check - lets ConfirmScreen keep
 * the manual Rating/Studio/Original Language fields hidden by default and only reveal one
 * once TMDb has genuinely come up empty for that specific field. Also carries `isAnimated`
 * (TMDb's genre list) and `franchise` (Wikidata's "part of the series" property).
 * `isAnimated` is three-valued: `true`/`false` are a confirmed answer from TMDb (used to
 * show/hide the Animation/Live Action field - TMDb has no "Live Action" genre of its own,
 * only an "Animation" tag that's either present or absent), `null` means TMDb has no match
 * at all for this title, which must not be treated as a confirmed "Live Action". */
export function previewTmdbFields(imdbId: string) {
  return post<TmdbPreview>("/api/scan/tmdb-preview", { imdbId });
}

export interface OmdbSearchCandidate {
  Title: string;
  Year: string;
  imdbID: string;
  Type: string;
  Poster: string;
}

/** Manual title-search fallback: when the barcode lookup came back with no usable UPC/product
 * data at all, ConfirmScreen asks the user to type the title and runs it through the same OMDB
 * search the automatic resolver uses, producing the same kind of candidate list.
 *
 * `skipCorrections` disables the spelling-correction passes (dictionary + fuzzy TMDb match) -
 * for a custom-burned disc of a non-English/obscure franchise, "correcting" an invented or
 * foreign name is more likely to produce a wrong candidate than a typo, so ConfirmScreen lets
 * the user flag this before searching instead of applying spellcheck by default. */
export function searchTitleOnOmdb(title: string, skipCorrections?: boolean) {
  return post<{ candidates: OmdbSearchCandidate[] }>("/api/scan/title-search", { title, skipCorrections });
}

/** UPCitemdb's own real-time trial-tier quota, mirrored from its response headers (unlike
 * the private-only Amazon-pricing quota tracker's AmazonProviderQuota, which self-counts
 * because the RapidAPI Amazon providers were confirmed NOT to expose a header like this).
 * Rendered as a progress bar on PendingScansScreen. `resetAt` is when UPCitemdb's own count
 * goes back up, null if unknown. */
export interface UpcQuotaStatus {
  used: number;
  limit: number;
  remaining: number;
  resetAt: string | null;
}

export function fetchUpcQuotaStatus() {
  return post<{ quota: UpcQuotaStatus }>("/api/scan/upc-quota", {});
}
