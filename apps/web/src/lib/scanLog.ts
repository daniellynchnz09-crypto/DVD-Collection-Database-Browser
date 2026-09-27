import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

/**
 * A lightweight, append-only local log of every scan attempt - added 2026-09-24, per the
 * user's own request after repeatedly asking me (Claude) to dig up how a specific past scan
 * was interpreted, which until now meant writing a one-off script each time to query
 * `pending_scans` directly (see the real Universal Monsters/Bride of the Monster sessions).
 * Framed by the user as "a lightweight log file... to see where incorrect entries go wrong",
 * not a resilient backup - it's meant to survive a minor Supabase-side data problem or make a
 * bad entry easy to trace back to its source, not to replace real backups.
 *
 * Deliberately a plain local file, not another Supabase table - `pending_scans` already keeps
 * this same data (it's never deleted except on an explicit discard), but the point here is a
 * SECOND, independent copy that doesn't disappear if something goes wrong with Supabase itself,
 * and one I can read/grep directly without a script or DB credentials.
 *
 * One JSON-lines file per calendar day (`scan-log/YYYY-MM-DD.jsonl`, UTC date - so a scan late
 * at night NZ time can land in what looks like "tomorrow"'s file, or vice versa; simpler and
 * more consistent than reasoning about the server's local timezone config) under this app's own
 * directory - human-readable, trivially appendable, and naturally splits into browsable chunks
 * instead of one ever-growing file. Gitignored (`apps/web/scan-log/` in the root .gitignore) -
 * this is runtime data, not source, and would only bloat the repo.
 *
 * Assumes a persistent server filesystem, true for the local `next dev`/`next start` process
 * this project currently runs as. If this app ever deploys to a serverless platform (Vercel is
 * still the plan per Claude.md, not yet done as of this writing), a serverless function's
 * filesystem is ephemeral/read-only outside `/tmp`, and writes here would silently vanish
 * between invocations - this module would need rethinking (e.g. writing to a mounted volume,
 * or accepting that this specific safety net only exists in local/self-hosted deployments).
 *
 * Fire-and-forget by design, same "never block the real thing" convention every other helper
 * in this codebase follows - a logging failure (disk full, permissions, whatever) must never
 * stop a real scan from being confirmed/discarded/dismissed. Callers don't await this.
 */
export type ScanLogOutcome = "confirmed" | "discarded" | "dismissed" | "superseded";

export interface ScanLogEntry {
  outcome: ScanLogOutcome;
  pendingScanId: string;
  barcode: string | null;
  /** The scanner's own resolved data at the time of this outcome - upcProduct, omdbCandidates,
   * listingTextExtraction, posterMatch, etc. - exactly what `pending_scans.resolved_candidates`
   * held. Null when the row couldn't be read (already gone, or never existed). */
  resolvedCandidates: unknown;
  /** Only meaningful for `outcome: "confirmed"` - what was actually submitted/written. */
  submittedEntries?: { manualFields?: Record<string, unknown>; overwriteUniqueId?: string }[];
  createdTitleIds?: string[];
}

const LOG_DIR = path.join(process.cwd(), "scan-log");

export function logScanEvent(entry: ScanLogEntry): void {
  const line = JSON.stringify({ loggedAt: new Date().toISOString(), ...entry }) + "\n";
  const fileName = `${new Date().toISOString().slice(0, 10)}.jsonl`;
  mkdir(LOG_DIR, { recursive: true })
    .then(() => appendFile(path.join(LOG_DIR, fileName), line, "utf8"))
    .catch((err) => {
      console.error("[scan-log] Failed to write log entry (non-fatal):", err);
    });
}
