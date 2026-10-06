"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useEffect } from "react";

/**
 * Counts in-app navigations so BackButton knows whether router.back() stays inside the site.
 * A visitor who opened a shared link directly has depth 0, so "back" goes home instead of
 * leaving the site. Browser back/forward (popstate) decrements - forward is miscounted as a
 * back, which only ever makes the fallback more conservative.
 */
let depth = 0;
let lastUrl: string | null = null;
let popped = false;

export function getInAppDepth(): number {
  return depth;
}

/** Call right before router.back() so the counter matches the history we're about to pop. */
export function noteBackNavigation(): void {
  depth = Math.max(0, depth - 1);
  popped = true;
}

export function NavigationTracker() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const url = `${pathname}?${searchParams.toString()}`;

  useEffect(() => {
    const onPop = () => {
      if (!popped) depth = Math.max(0, depth - 1);
      popped = true;
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    if (lastUrl !== null && lastUrl !== url && !popped) depth += 1;
    popped = false;
    lastUrl = url;
  }, [url]);

  return null;
}
