"use client";

import { useEffect } from "react";

// While the tab is open and visible: once on arrival, then every 5 minutes.
const PING_EVERY_MS = 5 * 60 * 1000;

/**
 * Tells the server someone is using the site, so its background jobs (scan resolving, TMDb
 * refresh, Estimated Value pricing) run only while there's someone around - see
 * lib/backgroundJobs.ts. A hidden tab doesn't ping; coming back to it does.
 */
export function ActivityBeacon() {
  useEffect(() => {
    let lastPing = 0;
    const ping = () => {
      if (document.visibilityState !== "visible" || Date.now() - lastPing < PING_EVERY_MS) return;
      lastPing = Date.now();
      fetch("/api/activity", { method: "POST", keepalive: true }).catch(() => {});
    };
    ping();
    const timer = setInterval(ping, 30_000);
    document.addEventListener("visibilitychange", ping);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", ping);
    };
  }, []);
  return null;
}
