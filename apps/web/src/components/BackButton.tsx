"use client";

import { useRouter } from "next/navigation";
import { getInAppDepth, noteBackNavigation } from "./NavigationTracker";

/**
 * Goes back one page (WEB APP DESIGN.md: title pages link to each other, so "back" must
 * retrace the trail rather than jump home) - or to `fallbackHref` when there's no in-app
 * history, e.g. a link opened in a fresh tab.
 */
export function BackButton({ fallbackHref = "/", label = "Back" }: { fallbackHref?: string; label?: string }) {
  const router = useRouter();

  function goBack() {
    if (getInAppDepth() > 0) {
      noteBackNavigation();
      router.back();
    } else {
      router.push(fallbackHref);
    }
  }

  return (
    <button
      type="button"
      onClick={goBack}
      aria-label={label}
      className="clip-chevron-left group flex h-9 shrink-0 items-center gap-2 bg-accent-deep pr-4 pl-5 text-accent-hi transition-colors hover:bg-accent-dim hover:text-chrome-hi"
    >
      <svg aria-hidden viewBox="0 0 10 10" className="h-2.5 w-2.5 fill-current">
        <polygon points="10,0 10,10 0,5" />
      </svg>
      <span className="label-tech text-current">{label}</span>
    </button>
  );
}
