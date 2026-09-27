import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Storage helper for `titles.movie_poster_path` (0036_add_movie_poster_path.sql) - a general-
 * purpose, Storage-hosted cache of each title's official OMDB/TMDb poster, deliberately kept
 * in its own `poster-images` bucket rather than the private-only pricing feature's
 * `retail-product-images` (see that migration's own comment for why: this needs to work in
 * both the public and private repo builds). Same shape as `caseImageStorage.ts` deliberately -
 * fetch-and-upload, signed URLs minted on demand, private bucket, service-role key only - just
 * pointed at a different bucket, and deliberately NOT autocropped: a movie poster from OMDB/
 * TMDb is already a clean promotional image, never a photo with a baked-in white border the
 * way a real product listing photo can be (see caseImageStorage.ts's own comment for that).
 */

const BUCKET = "poster-images";

/** Fetches a remote poster image and uploads it to the private bucket at the given path.
 * Returns the path on success, or null on any failure - same "a cache miss is fine, a bad
 * write isn't" convention as every other image-caching helper in this codebase. */
export async function uploadPosterImage(supabase: SupabaseClient, path: string, imageUrl: string): Promise<string | null> {
  try {
    const res = await fetch(imageUrl);
    if (!res.ok) return null;
    const contentType = res.headers.get("content-type") ?? "image/jpeg";
    const bytes = Buffer.from(await res.arrayBuffer());

    const { error } = await supabase.storage.from(BUCKET).upload(path, bytes, { contentType, upsert: true });
    return error ? null : path;
  } catch {
    return null;
  }
}

/** Mints a short-lived signed URL for a path already in the bucket - generated server-side,
 * on demand, never stored long-term. */
export async function getSignedPosterImageUrl(supabase: SupabaseClient, path: string, expiresInSeconds = 3600): Promise<string | null> {
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, expiresInSeconds);
  return error ? null : (data?.signedUrl ?? null);
}
