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
}

interface ConfirmResult {
  success: boolean;
  createdTitleIds: string[];
  shelfLocation: { before: string | null; after: string | null } | null;
}

/** `overwriteUniqueId` (single-entry submissions only) fully replaces every field of an
 * already-catalogued title instead of creating a new row - the "Overwrite" choice on the
 * pre-submit similar-entry check (see findExistingTitle below). */
export function confirmScan(pendingScanId: string, entries: ConfirmEntry[], overwriteUniqueId?: string) {
  return post<ConfirmResult>("/api/scan/confirm", { pendingScanId, entries, overwriteUniqueId });
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
  format: string;
  disc_count: number;
  disk_region: string | null;
  genre_location: string | null;
  franchise: string | null;
  rating: string | null;
  studio: string | null;
  animation_or_live_action: string;
  special_features: boolean;
  steelbook: boolean;
  barcode_id: string | null;
  case_image_url: string | null;
  imdb_id: string | null;
  release_date: string | null;
  /** case_image_url when set, else an OMDB poster fetched server-side via imdb_id, else null. */
  posterUrl: string | null;
}

export type FindExistingResult =
  | { status: "none" }
  | { status: "auto"; match: ExistingTitleCandidate }
  | { status: "ambiguous"; candidates: ExistingTitleCandidate[] };

/** Similar/matching-entry check, run right before confirmScan actually writes anything -
 * matches by title text OR (when imdbId is known - a real OMDB/TMDb candidate was picked)
 * a shared imdb_id, across every row (not just unbarcoded legacy ones), so both the
 * original backfill scenario and a genuine re-scan/duplicate-copy surface here. */
export function findExistingTitle(title: string, upcText: string, imdbId?: string) {
  return post<FindExistingResult>("/api/scan/find-existing", { title, upcText, imdbId });
}

export interface TmdbPreview {
  tmdbId: number | null;
  rating: string | null;
  studio: string | null;
  isAnimated: boolean | null;
  franchise: string | null;
}

/** Read-only "would TMDb find anything for this title" check - lets ConfirmScreen keep
 * the manual Rating/Studio fields hidden by default and only reveal one once TMDb has
 * genuinely come up empty for that specific field. Also carries `isAnimated` (TMDb's genre
 * list) and `franchise` (Wikidata's "part of the series" property). `isAnimated` is
 * three-valued: `true`/`false` are a confirmed answer from TMDb (used to show/hide the
 * Animation/Live Action field - TMDb has no "Live Action" genre of its own, only an
 * "Animation" tag that's either present or absent), `null` means TMDb has no match at all
 * for this title, which must not be treated as a confirmed "Live Action". */
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
