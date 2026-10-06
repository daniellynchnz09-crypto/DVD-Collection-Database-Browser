"use client";

import Image from "next/image";
import { useState } from "react";
import type { CatalogImage } from "@/lib/catalog/types";

/**
 * A poster/cover image that fills its (position: relative) parent, swapping to an angular
 * text placeholder when there's no image or it fails to load - Sheet-era case_image_url hosts
 * in particular can be dead.
 */
export function PosterImage({
  image,
  title,
  sizes = "(max-width: 640px) 40vw, 180px",
  preload = false,
  fit = "cover",
  onNaturalSize,
}: {
  image: CatalogImage | null;
  title: string;
  sizes?: string;
  /** Use for the one above-the-fold hero image on a page (replaces the deprecated `priority`). */
  preload?: boolean;
  fit?: "cover" | "contain";
  /** Reports the loaded image's intrinsic size (ImageFrame uses it to fit case photos). */
  onNaturalSize?: (width: number, height: number) => void;
}) {
  const [failed, setFailed] = useState(false);

  if (!image || failed) return <PosterPlaceholder title={title} />;

  return (
    <Image
      src={image.src}
      alt={title}
      fill
      sizes={sizes}
      preload={preload}
      unoptimized={image.unoptimized}
      onError={() => setFailed(true)}
      onLoad={onNaturalSize ? (e) => onNaturalSize(e.currentTarget.naturalWidth, e.currentTarget.naturalHeight) : undefined}
      className={fit === "cover" ? "object-cover" : "object-contain"}
    />
  );
}

export function PosterPlaceholder({ title }: { title: string }) {
  return (
    <div className="absolute inset-0 flex flex-col justify-between overflow-hidden bg-linear-to-br from-panel-hi via-deep to-void p-3">
      {/* Decorative chevron stack + rule lines, so missing art still reads as on-brand */}
      <div aria-hidden className="flex items-center gap-1 text-accent-dim">
        {[0, 1, 2].map((i) => (
          <svg key={i} viewBox="0 0 8 10" className="h-2.5 w-2 fill-current" style={{ opacity: 1 - i * 0.3 }}>
            <polygon points="0,0 8,5 0,10" />
          </svg>
        ))}
        <span className="ml-1 h-px flex-1 bg-rule-strong" />
      </div>
      <p className="line-clamp-5 font-display text-sm leading-snug font-semibold tracking-wide text-chrome uppercase">{title}</p>
      <div aria-hidden className="flex items-center gap-2">
        <span className="h-px flex-1 bg-rule" />
        <span className="label-tech text-[9px]">No Image</span>
      </div>
    </div>
  );
}
