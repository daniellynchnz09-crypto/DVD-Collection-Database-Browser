import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // @danflix/shared and @danflix/backend both ship TS source (no build step), so Next
  // needs to transpile both - @danflix/backend was missing here (found live 2026-09-14:
  // a real fix to scanResolver.ts, which lives in @danflix/backend, silently never took
  // effect in the running dev server because of this exact gap), which is a much easier
  // mistake to make than it sounds - a route can import @danflix/backend and even
  // typecheck/compile fine while still serving a stale cached copy at runtime, since the
  // untranspiled package just isn't in Turbopack's watched dependency graph at all.
  transpilePackages: ["@danflix/shared", "@danflix/backend"],
};

export default nextConfig;
