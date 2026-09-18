import AsyncStorage from "@react-native-async-storage/async-storage";
import { confirmScan, findExistingTitle, type ConfirmEntry, type FindExistingResult } from "./scanApi";

/**
 * On-device queue for a Confirm submission made while offline (added 2026-09-18, per the
 * user's own explicit spec, given across several messages): when there's no internet, Confirm
 * can't reach the server at all (OMDB/TMDb lookups, the similar-entry check, and the actual
 * write all need it), so instead of failing outright, the fully-filled-in entry is saved here
 * and automatically resubmitted once the connection comes back - "when internet is back up and
 * running the program will submit it to the database and do the normal checks and estimated
 * value stuff." A real duplicate found during that automatic resync is flagged for the user to
 * resolve later rather than shown as a live interactive dialog during an unattended sync -
 * "if it is a duplicate it is flagged and the user will have to open the entry again to see
 * the dialog."
 *
 * `overwriteUniqueId` CAN be known at queue time even while offline, for one specific case:
 * rescanning a barcode that's already definitively linked to an existing entry
 * (`existingMatch` in ConfirmScreen - a certainty established from the barcode itself, not
 * from the online-only similar-entry search) skips straight to Overwrite without ever needing
 * `findExistingTitle`. Every other path has no way to have already gone through that check
 * (it needs the network), so it queues as a plain new-entry submission instead; if the
 * resync's own find-existing check then finds a real match, the item moves to `needs_review`
 * and the eventual Overwrite/New Entry/Reject decision (made once the user reopens it later)
 * is what supplies an overwriteUniqueId, if at all.
 */

const STORAGE_KEY = "offlineSubmissionQueue";

export interface QueuedSubmission {
  id: string;
  pendingScanId: string;
  entries: ConfirmEntry[];
  // Set only for the barcode-certain "already know this exact disc" fast path - see this
  // file's own header comment. When present, resync skips find-existing entirely and
  // resubmits directly, same as the online fast path already does.
  overwriteUniqueId?: string;
  // Everything findExistingTitle needs, captured at queue time from ConfirmScreen's own
  // already-resolved state - same values a live online submission would have sent. Unused
  // when overwriteUniqueId is set above.
  titleForMatch: string;
  upcText: string;
  imdbId?: string;
  formatOverride?: string;
  discCountOverride?: number;
  // Shown in the queue/review list - not sent anywhere, just for the user's own orientation.
  displayTitle: string;
  queuedAt: string;
  status: "queued" | "needs_review" | "error";
  reviewResult?: Extract<FindExistingResult, { status: "auto" | "ambiguous" }>;
  lastError?: string;
}

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

async function readQueue(): Promise<QueuedSubmission[]> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as QueuedSubmission[]) : [];
  } catch {
    // A corrupted/unreadable queue is treated as empty rather than crashing the app - the
    // same "wrong/unreadable data is worse than no data" convention used everywhere server-
    // side in this project, applied here to on-device storage instead.
    return [];
  }
}

async function writeQueue(queue: QueuedSubmission[]): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(queue));
}

export async function getQueuedSubmissions(): Promise<QueuedSubmission[]> {
  return readQueue();
}

export async function queueSubmissionOffline(
  input: Omit<QueuedSubmission, "id" | "queuedAt" | "status" | "reviewResult" | "lastError">
): Promise<QueuedSubmission> {
  const queue = await readQueue();
  const item: QueuedSubmission = { ...input, id: generateId(), queuedAt: new Date().toISOString(), status: "queued" };
  queue.push(item);
  await writeQueue(queue);
  return item;
}

async function updateQueuedSubmission(id: string, patch: Partial<QueuedSubmission>): Promise<void> {
  const queue = await readQueue();
  const next = queue.map((item) => (item.id === id ? { ...item, ...patch } : item));
  await writeQueue(next);
}

/** Removes a queued item outright - either it synced successfully, or the user resolved its
 * duplicate-review decision (Overwrite/Is a new entry/Reject) and it's been handled. */
export async function removeQueuedSubmission(id: string): Promise<void> {
  const queue = await readQueue();
  await writeQueue(queue.filter((item) => item.id !== id));
}

/**
 * Attempts to submit every `queued` item for real now that the connection is back - runs the
 * exact same find-existing check a live online Confirm would have run, then either submits
 * immediately (no match found) or flags the item as `needs_review` (a real match exists,
 * left for the user to resolve by hand later) instead of guessing which choice they'd have
 * made. Already-`needs_review` items are left untouched - they're waiting on a human decision,
 * not something this function should retry. Best-effort per item: one item's failure doesn't
 * stop the rest of the queue from being attempted.
 */
export async function trySyncOfflineQueue(): Promise<{ submitted: number; flagged: number; failed: number }> {
  const queue = await readQueue();
  let submitted = 0;
  let flagged = 0;
  let failed = 0;

  for (const item of queue) {
    // "error" is retried too, not just "queued" - a failure right at the reconnect moment is
    // more likely a flaky/still-settling connection than a permanent problem, so it gets
    // another attempt on the next sync rather than being stuck forever without the user
    // having to do anything. Only "needs_review" is deliberately left alone - that one is
    // waiting on a human decision, not something to retry automatically.
    if (item.status !== "queued" && item.status !== "error") continue;

    try {
      if (item.overwriteUniqueId) {
        // overwriteUniqueId moved from a request-level field to a per-entry one
        // (2026-09-20, for the Collection scanning flow) - this queue only ever stores it
        // for the single-entry barcode-certain fast path (see this file's own header
        // comment), so it's attached to that one entry here.
        const entries =
          item.entries.length > 0
            ? [{ ...item.entries[0], overwriteUniqueId: item.overwriteUniqueId }, ...item.entries.slice(1)]
            : item.entries;
        await confirmScan(item.pendingScanId, entries);
        await removeQueuedSubmission(item.id);
        submitted++;
        continue;
      }

      const result = await findExistingTitle(
        item.titleForMatch,
        item.upcText,
        item.imdbId,
        item.formatOverride,
        item.discCountOverride
      );

      if (result.status === "none") {
        await confirmScan(item.pendingScanId, item.entries);
        await removeQueuedSubmission(item.id);
        submitted++;
      } else {
        await updateQueuedSubmission(item.id, { status: "needs_review", reviewResult: result });
        flagged++;
      }
    } catch (err) {
      await updateQueuedSubmission(item.id, { status: "error", lastError: (err as Error).message });
      failed++;
    }
  }

  return { submitted, flagged, failed };
}
