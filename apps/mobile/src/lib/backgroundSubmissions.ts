import { useEffect, useState } from "react";

/**
 * Background Confirm submissions (added 2026-10-03, per the user's own request for faster
 * navigation): "instead of greying out the buttons, it will instead make the scanned message
 * pop up that ... will say scanning ... This way the user can quickly move to another scan
 * without having to wait." ConfirmScreen hands the real `confirmScan` write to
 * `startBackgroundSubmission` and navigates straight to SuccessScreen, which shows
 * "Scanning..." and flips to succeeded/failed if the user is still there when it settles. If
 * they've already moved on, App.tsx's SubmissionBanner shows a tick/cross banner with the
 * entry's title instead.
 *
 * Lives at module level (not in any screen's state) so the request keeps running and its
 * outcome is still observable after ConfirmScreen unmounts. A failed submission leaves the
 * pending scan untouched server-side (the confirm route only marks it "confirmed" once the
 * write succeeds) and its on-device draft is kept (only cleared on success), so it simply
 * reappears in Pending Scans with everything the user typed still filled in - plus the
 * failure reason, via getSubmissionError, shown on ConfirmScreen when they reopen it.
 */
export type SubmissionStatus = "saving" | "succeeded" | "failed";

export interface ShelfLocation {
  before: string | null;
  after: string | null;
}

export interface BackgroundSubmission {
  id: string;
  pendingScanId: string;
  title: string;
  status: SubmissionStatus;
  shelfLocation: ShelfLocation | null;
  error: string | null;
  // Set once a finished submission's outcome has been seen (on SuccessScreen, or its banner
  // shown), so the banner never announces the same result twice.
  acknowledged: boolean;
}

const submissions = new Map<string, BackgroundSubmission>();
const listeners = new Set<() => void>();
let nextId = 1;

function emit() {
  for (const listener of listeners) listener();
}

function update(id: string, patch: Partial<BackgroundSubmission>) {
  const current = submissions.get(id);
  if (!current) return;
  submissions.set(id, { ...current, ...patch });
  emit();
}

export function subscribeToSubmissions(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getSubmission(id: string): BackgroundSubmission | undefined {
  return submissions.get(id);
}

/** Pending scan ids PendingScansScreen/SuccessScreen should leave out: any whose latest save
 * is still in flight (so it can't be opened and submitted twice) or already succeeded (the
 * server has it, even if an already-loaded list hasn't refetched yet). A failed save's scan
 * is NOT in here - it's genuinely back in the list. */
export function getHiddenPendingScanIds(): Set<string> {
  const latestByScan = new Map<string, BackgroundSubmission>();
  for (const s of submissions.values()) latestByScan.set(s.pendingScanId, s);
  const ids = new Set<string>();
  for (const [scanId, s] of latestByScan) if (s.status !== "failed") ids.add(scanId);
  return ids;
}

/** The most recent failure for this pending scan, if its latest submission failed. */
export function getSubmissionError(pendingScanId: string): string | null {
  let latest: BackgroundSubmission | undefined;
  for (const s of submissions.values()) if (s.pendingScanId === pendingScanId) latest = s;
  return latest?.status === "failed" ? latest.error : null;
}

export function acknowledgeSubmission(id: string): void {
  const current = submissions.get(id);
  if (current && current.status !== "saving" && !current.acknowledged) update(id, { acknowledged: true });
}

/** Next finished-but-unseen submission, for the banner. */
export function getNextUnacknowledgedSubmission(): BackgroundSubmission | undefined {
  for (const s of submissions.values()) if (s.status !== "saving" && !s.acknowledged) return s;
  return undefined;
}

/** Starts `run` without awaiting it and returns the submission id to track it by. `run`
 * owns everything that must happen on success (clearing the draft, refreshing option lists);
 * a throw marks the submission failed with the error's message. */
export function startBackgroundSubmission(
  pendingScanId: string,
  title: string,
  run: () => Promise<{ shelfLocation: ShelfLocation | null }>
): string {
  const id = String(nextId++);
  submissions.set(id, {
    id,
    pendingScanId,
    title,
    status: "saving",
    shelfLocation: null,
    error: null,
    acknowledged: false,
  });
  emit();
  run().then(
    (result) => update(id, { status: "succeeded", shelfLocation: result.shelfLocation }),
    (err) => update(id, { status: "failed", error: (err as Error)?.message ?? "Unknown error" })
  );
  return id;
}

/** Re-renders the calling component whenever any submission changes. */
export function useSubmissionsVersion(): number {
  const [version, setVersion] = useState(0);
  useEffect(() => subscribeToSubmissions(() => setVersion((v) => v + 1)), []);
  return version;
}
