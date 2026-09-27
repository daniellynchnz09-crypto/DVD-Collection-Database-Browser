import type { SupabaseClient } from "@supabase/supabase-js";
import { autocropImageBuffer } from "./imageCrop";

/**
 * Storage helper for `titles.case_image_path` (0026_add_case_image_path.sql) - the physical
 * product/case photo shown on the future web app's DVD Pages, kept in its own `case-images`
 * bucket rather than the private-only pricing feature's `retail-product-images` (see that
 * migration's own comment for why: this needs to work in both the public and private repo
 * builds, and `retail-product-images` and its own storage helper live entirely inside that
 * private-collection-only directory). Same shape as that module deliberately - fetch-and-
 * upload, signed URLs minted on demand, private bucket, service-role key only - just pointed
 * at a different bucket that both builds can reach.
 */

const BUCKET = "case-images";

/** Fetches a remote image, auto-crops a uniform-color border off it (see imageCrop.ts - added
 * 2026-09-22 after a real UPCitemdb/reseller listing photo turned out to have a wide white
 * border baked into the image itself), and uploads the result to the private bucket at the
 * given path. Returns the path on success, or null on any failure - same "a cache miss is
 * fine, a bad write isn't" convention as every other image-caching helper in this codebase.
 * Cropping happens here (once, at the point the image becomes a permanent stored asset) not
 * at scan-resolve time - the live review-screen preview still fetches the UPC listing's raw
 * image directly, so it can still show its own white border until the scan is actually
 * confirmed; only the asset that persists into the collection (and everywhere it's shown
 * from then on) is cropped. */
export async function uploadCaseImage(supabase: SupabaseClient, path: string, imageUrl: string): Promise<string | null> {
  try {
    const res = await fetch(imageUrl);
    if (!res.ok) return null;
    const contentType = res.headers.get("content-type") ?? "image/jpeg";
    const rawBytes = Buffer.from(await res.arrayBuffer());
    const bytes = await autocropImageBuffer(rawBytes, contentType);

    const { error } = await supabase.storage.from(BUCKET).upload(path, bytes, { contentType, upsert: true });
    return error ? null : path;
  } catch {
    return null;
  }
}

/** Mints a short-lived signed URL for a path already in the bucket - generated server-side,
 * on demand, never stored long-term. */
export async function getSignedCaseImageUrl(supabase: SupabaseClient, path: string, expiresInSeconds = 3600): Promise<string | null> {
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, expiresInSeconds);
  return error ? null : (data?.signedUrl ?? null);
}
