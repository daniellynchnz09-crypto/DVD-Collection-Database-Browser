/** Generates a short, purely-local correlator used to namespace a scan session's staged
 * cover-photo Storage paths (see cover-photo/route.ts) before any pending_scans row exists.
 * Never a DB key, never treated as sensitive - it just needs enough entropy that two sessions
 * started back-to-back never collide under cover-scan-staging/sessions/. */
export function createScanSessionId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
