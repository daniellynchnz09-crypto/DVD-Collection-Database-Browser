import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { CatalogImage, TitleCardRow, TitleMetadata } from "./types";

/**
 * Image URL resolution for pages.
 *
 * Card/poster priority (best first): case_image_path (the user's own scanned product photo,
 * `case-images` bucket - changed 2026-10-06 at the user's request: a scanned disc shows its own
 * case, not a generic poster) > TMDb poster from title_metadata > movie_poster_path
 * (`poster-images` bucket) > case_image_url (a raw external URL from the original Sheet). Case
 * photo priority: case_image_path > case_image_url. The Movie/TV Page builds its own poster
 * (TMDb first) in queries.ts getWork, since that page is the film rather than a disc.
 *
 * Both Storage buckets are PRIVATE (0026/0036 - no anon policies), so their objects need
 * signed URLs, which only the service-role key can mint. That key is used here for
 * `storage.createSignedUrls` ONLY - never for row reads (those go through the anon client in
 * client.ts). Signed URLs are cached in memory and reused until close to expiry, so the same
 * image keeps the same URL across requests and browser caches stay warm.
 *
 * Storage images are served straight from Supabase, not through Next's image optimizer
 * (2026-10-09, rate-limit report): a signed URL changes whenever it is re-signed and differs
 * between server copies, so on Vercel every one counted as a new optimizer conversion against
 * the free plan's monthly allowance. Stored photos are capped at 1200px now
 * (imageCrop.ts's shrinkForStorage), small enough to send as they are.
 */

export const TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p";
export type TmdbPosterSize = "w92" | "w154" | "w185" | "w342" | "w500" | "w780" | "original";
export type TmdbBackdropSize = "w300" | "w780" | "w1280" | "original";
export type TmdbProfileSize = "w45" | "w185" | "h632" | "original";

export function tmdbImageUrl(
  path: string | null | undefined,
  size: TmdbPosterSize | TmdbBackdropSize | TmdbProfileSize = "w342",
): string | null {
  if (!path) return null;
  return `${TMDB_IMAGE_BASE}/${size}${path.startsWith("/") ? path : `/${path}`}`;
}

export function tmdbImage(path: string | null | undefined, size: TmdbPosterSize | TmdbBackdropSize | TmdbProfileSize = "w342"): CatalogImage | null {
  const src = tmdbImageUrl(path, size);
  return src ? { src, source: "tmdb", unoptimized: true } : null;
}

export const CASE_IMAGE_BUCKET = "case-images";
export const POSTER_IMAGE_BUCKET = "poster-images";
type Bucket = typeof CASE_IMAGE_BUCKET | typeof POSTER_IMAGE_BUCKET;

const SIGNED_URL_TTL_SECONDS = 60 * 60 * 24; // 24h
const REUSE_MARGIN_MS = 1000 * 60 * 60 * 12; // re-sign once under 12h remain
const signedUrlCache = new Map<string, { url: string; expiresAt: number }>();

let storageClient: SupabaseClient | null | undefined;
function getStorageSigningClient(): SupabaseClient | null {
  if (storageClient !== undefined) return storageClient;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  storageClient = url && serviceKey ? createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } }) : null;
  if (!storageClient) console.error("[catalog] SUPABASE_SERVICE_ROLE_KEY missing - Storage images will be skipped.");
  return storageClient;
}

/** Batch-signs Storage paths (one request per bucket), returning path -> signed URL. Paths
 * that fail to sign are simply absent, so callers fall through to the next image source. */
export async function signStoragePaths(bucket: Bucket, paths: Array<string | null | undefined>): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const now = Date.now();
  const toSign: string[] = [];
  for (const path of new Set(paths.filter((p): p is string => !!p))) {
    const cached = signedUrlCache.get(`${bucket}/${path}`);
    if (cached && cached.expiresAt - now > REUSE_MARGIN_MS) result.set(path, cached.url);
    else toSign.push(path);
  }
  if (toSign.length === 0) return result;

  const supabase = getStorageSigningClient();
  if (!supabase) return result;
  try {
    const { data, error } = await supabase.storage.from(bucket).createSignedUrls(toSign, SIGNED_URL_TTL_SECONDS);
    if (error) {
      console.error(`[catalog] signing ${bucket} failed: ${error.message}`);
      return result;
    }
    const expiresAt = now + SIGNED_URL_TTL_SECONDS * 1000;
    for (const item of data ?? []) {
      if (item.error || !item.path || !item.signedUrl) continue;
      signedUrlCache.set(`${bucket}/${item.path}`, { url: item.signedUrl, expiresAt });
      result.set(item.path, item.signedUrl);
    }
  } catch (err) {
    console.error(`[catalog] signing ${bucket} threw:`, err);
  }
  return result;
}

/** Only https external URLs are used - an http one would be blocked as mixed content. */
function externalCaseUrl(url: string | null): CatalogImage | null {
  if (!url || !/^https:\/\//i.test(url) || /no_image/i.test(url)) return null;
  return { src: url, source: "case_url", unoptimized: true };
}

export interface ResolvedImages {
  poster: CatalogImage | null;
  caseImage: CatalogImage | null;
}

type ImageRow = Pick<TitleCardRow, "unique_id" | "movie_poster_path" | "case_image_path" | "case_image_url">;

/**
 * Resolves poster + case image for many rows at once (two signing calls total, regardless of
 * row count). `metadataFor` supplies each row's title_metadata when it exists.
 */
export async function resolveImages<R extends ImageRow>(
  rows: R[],
  metadataFor: (row: R) => TitleMetadata | null | undefined = () => null,
  posterSize: TmdbPosterSize = "w342",
): Promise<Map<string, ResolvedImages>> {
  const [posterUrls, caseUrls] = await Promise.all([
    // A case photo or TMDb poster wins outright, so only sign movie_poster_path for rows with neither.
    signStoragePaths(
      POSTER_IMAGE_BUCKET,
      rows.filter((r) => !r.case_image_path && !metadataFor(r)?.poster_path).map((r) => r.movie_poster_path),
    ),
    signStoragePaths(CASE_IMAGE_BUCKET, rows.map((r) => r.case_image_path)),
  ]);

  const out = new Map<string, ResolvedImages>();
  for (const row of rows) {
    const caseSigned = row.case_image_path ? caseUrls.get(row.case_image_path) : undefined;
    const scannedCase: CatalogImage | null = caseSigned ? { src: caseSigned, source: "case_image", unoptimized: true } : null;
    const caseImage = scannedCase ?? externalCaseUrl(row.case_image_url);

    const posterSigned = row.movie_poster_path ? posterUrls.get(row.movie_poster_path) : undefined;
    const poster =
      scannedCase ??
      tmdbImage(metadataFor(row)?.poster_path, posterSize) ??
      (posterSigned ? { src: posterSigned, source: "movie_poster" as const, unoptimized: true } : null) ??
      caseImage;

    out.set(row.unique_id, { poster, caseImage });
  }
  return out;
}
