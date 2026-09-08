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

export interface ExistingTitleCandidate {
  unique_id: string;
  title: string;
  format: string;
  disc_count: number;
}

export type FindExistingResult =
  | { status: "none" }
  | { status: "auto"; match: ExistingTitleCandidate }
  | { status: "ambiguous"; candidates: ExistingTitleCandidate[] };

/** Backfill matching: is this scanned disc actually a title already in the collection? */
export function findExistingTitle(title: string, upcText: string) {
  return post<FindExistingResult>("/api/scan/find-existing", { title, upcText });
}

export interface TmdbPreview {
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

interface LinkExistingResult {
  success: boolean;
  linkedTitle: string;
}

/** Attaches the barcode (+ image + a conservative metadata refresh) to an existing entry
 * instead of creating a duplicate row. */
export function linkExistingTitle(params: {
  pendingScanId: string;
  existingUniqueId: string;
  barcode: string;
  imdbId?: string;
  caseImageUrl?: string;
}) {
  return post<LinkExistingResult>("/api/scan/link-existing", params);
}
