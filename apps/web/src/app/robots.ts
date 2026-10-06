import type { MetadataRoute } from "next";

// The site is shared by link only - no crawler should index any of it (paired with the
// noindex/nofollow robots meta in layout.tsx, which covers crawlers that ignore robots.txt).
export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", disallow: "/" },
  };
}
