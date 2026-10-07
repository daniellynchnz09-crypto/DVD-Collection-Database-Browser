import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Fetches an image from a URL that came from a request body or query string (2026-10-07
 * security pass) - the case-image-preview route's `url` param and the confirm route's
 * `case_image_url`. Both used to go straight into a bare `fetch()`, so anyone holding the scan
 * secret could point the server at an internal address (localhost, the LAN, a cloud metadata
 * endpoint) and get the response back - case-image-preview returned any non-image body as-is,
 * with the upstream Content-Type, which also let it serve attacker HTML from the site's own
 * origin. The scan secret is in the scanner app's bundle and in those preview URLs, so it's not
 * a strong enough boundary on its own once the site is public.
 *
 * Guards, each cheap:
 *   - http(s) only, and the host (plus every redirect hop, followed by hand) must resolve to a
 *     public address - no loopback/private/link-local/CGNAT/multicast ranges;
 *   - a timeout, and a size cap read off the stream rather than after buffering it all;
 *   - the response must look like a raster image: image/* except SVG (which can carry script),
 *     or a generic octet-stream (some CDNs label every object that way), or no type at all.
 *
 * Not a complete SSRF defence: the address is checked before fetch() does its own lookup, so a
 * DNS-rebinding host could still switch addresses in between. That needs a custom socket
 * agent, which isn't worth a new dependency for a secret-gated route.
 */

const MAX_REDIRECTS = 4;
const FETCH_TIMEOUT_MS = 15_000;
/** Real listing photos are well under 5MB; this only stops a huge or endless body. */
const MAX_REMOTE_IMAGE_BYTES = 20 * 1024 * 1024;

export type RemoteImageResult =
  | { ok: true; bytes: Buffer; contentType: string }
  | { ok: false; status: number; reason: string };

function isBlockedIpv4(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isBlockedAddress(ip: string): boolean {
  if (isIP(ip) === 4) return isBlockedIpv4(ip);
  const v6 = ip.toLowerCase();
  const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedIpv4(mapped[1]);
  return (
    v6 === "::" ||
    v6 === "::1" ||
    v6.startsWith("fc") ||
    v6.startsWith("fd") ||
    /^fe[89ab]/.test(v6) ||
    v6.startsWith("ff") ||
    // ::ffff:7f00:1 style (hex-written IPv4-mapped) - rare, just refuse it.
    v6.startsWith("::ffff:")
  );
}

async function hostIsPublic(url: URL): Promise<boolean> {
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host || host === "localhost" || /\.(localhost|local|internal|lan|home)$/.test(host)) return false;
  try {
    const addresses = isIP(host) ? [host] : (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);
    return addresses.length > 0 && !addresses.some(isBlockedAddress);
  } catch {
    return false;
  }
}

/** Null when the type isn't one we'll pass on; otherwise the type to use. */
function acceptedContentType(header: string | null): string | null {
  const type = (header ?? "").split(";")[0].trim().toLowerCase();
  if (!type) return "image/jpeg";
  if (type === "application/octet-stream" || type === "binary/octet-stream") return type;
  if (type.startsWith("image/") && !type.includes("svg")) return type;
  return null;
}

async function readCapped(res: Response): Promise<Buffer | null> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_REMOTE_IMAGE_BYTES) return null;
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_REMOTE_IMAGE_BYTES) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export async function fetchRemoteImage(rawUrl: string): Promise<RemoteImageResult> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, status: 400, reason: "Not a valid URL." };
  }

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!(await hostIsPublic(url))) return { ok: false, status: 400, reason: "That image host isn't allowed." };
    const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      await res.body?.cancel().catch(() => {});
      url = new URL(location, url);
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return { ok: false, status: 502, reason: `Source image fetch failed (${res.status}).` };
    }
    const contentType = acceptedContentType(res.headers.get("content-type"));
    if (!contentType) {
      await res.body?.cancel().catch(() => {});
      return { ok: false, status: 415, reason: "The source isn't an image." };
    }
    const bytes = await readCapped(res);
    if (!bytes) return { ok: false, status: 413, reason: "The source image is too large." };
    return { ok: true, bytes, contentType };
  }
  return { ok: false, status: 502, reason: "Too many redirects." };
}
