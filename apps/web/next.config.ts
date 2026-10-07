import type { NextConfig } from "next";

// Supabase project host for Storage signed URLs - read from env so the private and public
// builds (different projects) each allow only their own host.
const supabaseHost = (() => {
  try {
    return new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").hostname;
  } catch {
    return null;
  }
})();

const nextConfig: NextConfig = {
  // @danflix/shared and @danflix/backend both ship TS source (no build step), so Next
  // needs to transpile both - @danflix/backend was missing here (found live 2026-09-14:
  // a real fix to scanResolver.ts, which lives in @danflix/backend, silently never took
  // effect in the running dev server because of this exact gap), which is a much easier
  // mistake to make than it sounds - a route can import @danflix/backend and even
  // typecheck/compile fine while still serving a stale cached copy at runtime, since the
  // untranspiled package just isn't in Turbopack's watched dependency graph at all.
  transpilePackages: ["@danflix/shared", "@danflix/backend"],

  // Dev only: Next 16 blocks its dev scripts for any origin but localhost, so the site opened
  // on the phone over the LAN (the same address the scanner app uses) rendered but never
  // hydrated - links worked, the Back button and search didn't (found 2026-10-06).
  allowedDevOrigins: ["192.168.1.70"],

  // Baseline response headers for every page and route (2026-10-07 security pass, ahead of the
  // public Vercel deploy): no MIME sniffing, no framing by other sites (the taste-profile edit
  // buttons could otherwise be clickjacked once the passcode is in sessionStorage), and no full
  // URLs leaked to other sites in the Referer header.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ];
  },

  images: {
    // Only our own private-bucket signed URLs go through the optimizer (lib/catalog/images.ts);
    // TMDb posters are already pre-sized and rendered `unoptimized`. Kept tight so the
    // optimizer can't be used as an open image proxy.
    remotePatterns: [
      ...(supabaseHost
        ? [{ protocol: "https" as const, hostname: supabaseHost, pathname: "/storage/v1/object/sign/**" }]
        : []),
      { protocol: "https", hostname: "image.tmdb.org", pathname: "/t/p/**" },
    ],
  },
};

export default nextConfig;
