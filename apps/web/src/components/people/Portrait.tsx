"use client";

import Image from "next/image";
import { useState } from "react";
import type { CatalogImage } from "@/lib/catalog/types";

/**
 * The circular image on Cast/Crew/Franchise pages (WEB APP DESIGN.md asks for a circle here,
 * the one deliberate exception to the angular style). Falls back to initials when there's no
 * image or it fails to load.
 */
export function Portrait({ image, name, preload = false }: { image: CatalogImage | null; name: string; preload?: boolean }) {
  const [failed, setFailed] = useState(false);
  const initials = name
    .split(/\s+/)
    .filter((w) => /^[\p{L}\p{N}]/u.test(w))
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");

  return (
    <div className="relative h-28 w-28 shrink-0 sm:h-40 sm:w-40">
      {/* Outer accent ring + tick marks keep the circle on-brand with the techno chrome look */}
      <div aria-hidden className="absolute -inset-1.5 rounded-full border border-rule-strong" />
      <div aria-hidden className="absolute -inset-1.5 rounded-full border-2 border-transparent border-t-accent border-r-accent/40" />
      <div className="relative h-full w-full overflow-hidden rounded-full bg-linear-to-br from-panel-hi via-deep to-void ring-1 ring-accent-dim">
        {image && !failed ? (
          <Image
            src={image.src}
            alt={name}
            fill
            sizes="(max-width: 640px) 112px, 160px"
            preload={preload}
            unoptimized={image.unoptimized}
            onError={() => setFailed(true)}
            className="object-cover object-top"
          />
        ) : (
          <span aria-hidden className="absolute inset-0 flex items-center justify-center font-display text-3xl font-semibold tracking-widest text-accent sm:text-5xl">
            {initials || "?"}
          </span>
        )}
      </div>
    </div>
  );
}
