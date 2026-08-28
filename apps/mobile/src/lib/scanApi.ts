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
