import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // @danflix/shared ships TS source (no build step), so Next needs to transpile it.
  transpilePackages: ["@danflix/shared"],
};

export default nextConfig;
