import type { SupabaseClient } from "@supabase/supabase-js";
import { autocropImageBuffer } from "./imageCrop";

/**
 * Storage helper for cover-photo scanning's temporary holding area
 * (0038_add_cover_scan_staging.sql) - a private `cover-scan-staging` bucket that holds
 * freshly-captured front/back cover photos from the moment they're captured in
 * ScannerScreen's "Scan Cover" flow (before any `pending_scans` row even exists - see
 * `pending_scans.staged_cover_photos`) until that scan reaches a terminal state. Deliberately
 * a separate bucket from `case-images`/`poster-images` - those two only ever hold images this
 * app has decided are worth keeping permanently; this one holds images that might still be
 * deleted outright (a rejected back cover, a discarded/dismissed scan), so it needs its own
 * lifecycle rather than borrowing either permanent bucket's.
 */

const STAGING_BUCKET = "cover-scan-staging";
const CASE_IMAGES_BUCKET = "case-images";

/** The only shapes a staged path or session id may take - exactly what cover-photo/route.ts
 * writes (`sessions/{sessionId}/{uuid}.jpg`, the session id from the app's scanSession.ts).
 * Shared (2026-10-07 security pass) by every route that takes one from a request, so none of
 * them can be handed `..` or another prefix inside the bucket. */
export const STAGED_SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const STAGED_COVER_PATH_PATTERN = /^sessions\/[A-Za-z0-9_-]{1,64}\/[0-9a-f-]{36}\.jpg$/i;

/** Uploads a freshly-captured cover photo's raw, uncropped bytes to the staging bucket -
 * cropping now happens server-side, during resolution (scanResolver.ts's
 * analyzeStagedCoverPhotos, via coverVision.ts's detectCoverBoundingBox +
 * imageCrop.ts's cropImageBufferToBox), not client-side at capture time (see
 * replaceStagedCoverPhoto below for how the cropped result gets back into this same staged
 * path). Returns the path on success, null on any failure - same "a cache miss is fine, a bad
 * write isn't" convention as every other image-caching helper in this codebase. Takes bytes
 * directly (not a URL) since the caller already has them in hand from the upload request body -
 * there's nothing to fetch. */
export async function uploadStagedCoverPhoto(
  supabase: SupabaseClient,
  path: string,
  bytes: Buffer,
  contentType: string
): Promise<string | null> {
  try {
    const { error } = await supabase.storage.from(STAGING_BUCKET).upload(path, bytes, { contentType, upsert: false });
    return error ? null : path;
  } catch {
    return null;
  }
}

/** Overwrites an already-staged photo in place with its cropped result (added 2026-09-29,
 * content-aware cropping) - `upsert: true`, unlike uploadStagedCoverPhoto's own `false`, since
 * this deliberately replaces what's already there rather than requiring a fresh path. Doing
 * this in-place (rather than writing the crop to a new path) means every later reader of this
 * same `stagedPath` - most importantly promoteStagedCoverToCaseImage below, which runs much
 * later at confirm time, entirely separate from the resolver's own in-memory analysis - gets
 * the cropped version for free with no changes needed on its end. Best-effort: a failure here
 * just leaves the original uncropped upload in place rather than losing the photo. */
export async function replaceStagedCoverPhoto(
  supabase: SupabaseClient,
  path: string,
  bytes: Buffer,
  contentType: string
): Promise<boolean> {
  try {
    const { error } = await supabase.storage.from(STAGING_BUCKET).upload(path, bytes, { contentType, upsert: true });
    return !error;
  } catch {
    return false;
  }
}

/** Downloads a staged photo's bytes directly from the private bucket (never via a public URL -
 * there isn't one) for the resolver's cover-vision step to read. Returns null on any failure,
 * including a path that's already been cleaned up out from under a still-running resolve. */
export async function downloadStagedCoverPhoto(
  supabase: SupabaseClient,
  path: string
): Promise<{ bytes: Buffer; contentType: string } | null> {
  try {
    const { data, error } = await supabase.storage.from(STAGING_BUCKET).download(path);
    if (error || !data) return null;
    const contentType = data.type || "image/jpeg";
    const bytes = Buffer.from(await data.arrayBuffer());
    return { bytes, contentType };
  } catch {
    return null;
  }
}

/** Best-effort cleanup, called on every terminal path a scan session can reach (confirmed,
 * dismissed, discarded, or superseded by a newer scan for the same barcode) - never throws,
 * since a leaked staging file is recoverable (worst case, a small private bucket slowly
 * accumulates a few stray JPEGs) but a cleanup failure must never block the real confirm/
 * discard/dismiss action it's attached to. */
export async function deleteStagedCoverPhotos(supabase: SupabaseClient, paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  try {
    await supabase.storage.from(STAGING_BUCKET).remove(paths);
  } catch {
    // Swallowed deliberately - see this function's own comment above.
  }
}

/** Promotes a staged cover photo into the permanent `case-images` bucket at the same
 * `titles/{uniqueId}/case.jpg` path/convention `uploadCaseImage` (caseImageStorage.ts) already
 * uses - a Storage-to-Storage copy (download from staging, autocrop, upload into case-images),
 * not a `fetch(url)`, since the staging bucket is private and has no fetchable URL. Used both
 * for a brand-new title (confirm route) and for updating an already-existing, already-
 * catalogued title's photo (the dismiss-path re-scan case, session-finish/route.ts) - the
 * target is just whichever `uniqueId` the caller already knows, new or existing. The staged
 * photo it downloads here is normally already the content-aware-cropped result (see
 * replaceStagedCoverPhoto above) - this also runs the same uniform-border autocrop every other
 * case-images upload gets, for consistency, though it's usually a harmless no-op on an image
 * that's already been cropped tightly to the case. Returns the path on success, null on any
 * failure. */
export async function promoteStagedCoverToCaseImage(
  supabase: SupabaseClient,
  stagedPath: string,
  uniqueId: string
): Promise<string | null> {
  const staged = await downloadStagedCoverPhoto(supabase, stagedPath);
  if (!staged) return null;
  try {
    const bytes = await autocropImageBuffer(staged.bytes, staged.contentType);
    const path = `titles/${uniqueId}/case.jpg`;
    const { error } = await supabase.storage.from(CASE_IMAGES_BUCKET).upload(path, bytes, {
      contentType: staged.contentType,
      upsert: true,
    });
    return error ? null : path;
  } catch {
    return null;
  }
}
