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
