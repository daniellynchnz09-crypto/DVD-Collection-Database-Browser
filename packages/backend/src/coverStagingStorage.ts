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

/** Uploads a freshly-captured cover photo's raw bytes (already cropped client-side to the
 * guide rectangle - see ScannerScreen.tsx's CoverCaptureGuide - so no server-side cropping
 * happens here) to the staging bucket. Returns the path on success, null on any failure - same
 * "a cache miss is fine, a bad write isn't" convention as every other image-caching helper in
 * this codebase. Takes bytes directly (not a URL) since the caller already has them in hand
 * from the upload request body - there's nothing to fetch. */
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
 * target is just whichever `uniqueId` the caller already knows, new or existing. Runs the same
 * autocrop border-trim as every other case-images upload for consistency, even though a
 * client-cropped cover photo usually has no uniform border left to trim - harmless no-op in
 * that case. Returns the path on success, null on any failure. */
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
