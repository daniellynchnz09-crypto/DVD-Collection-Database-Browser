"use client";

import { useState, type ReactNode } from "react";
import type { CatalogImage } from "@/lib/catalog/types";
import { PosterImage } from "./PosterImage";

const isCasePhoto = (image: CatalogImage | null) => image?.source === "case_image" || image?.source === "case_url";

/**
 * A clipped image frame whose shape follows the image (2026-10-06, the user: product-image
 * frames should match the case, and case sizes vary - Blu-rays are shorter). Starts at
 * `aspect` (the format's standard case, or 2/3 for a poster - see frameAspect in display.ts)
 * so the layout is right before the photo arrives, then settles on a case photo's own measured
 * shape, clamped so a badly cropped photo can't produce an absurd sliver.
 */
export function ImageFrame({
  image,
  title,
  aspect,
  sizes,
  preload = false,
  className = "",
  children,
}: {
  image: CatalogImage | null;
  title: string;
  aspect: number;
  sizes?: string;
  preload?: boolean;
  className?: string;
  /** Overlays drawn inside the frame (badges, hover sheen). */
  children?: ReactNode;
}) {
  const [measured, setMeasured] = useState<number | null>(null);
  const casePhoto = isCasePhoto(image);

  return (
    <div className={`relative overflow-hidden ${className}`} style={{ aspectRatio: casePhoto && measured ? measured : aspect }}>
      <PosterImage
        image={image}
        title={title}
        sizes={sizes}
        preload={preload}
        fit={casePhoto ? "contain" : "cover"}
        onNaturalSize={
          casePhoto
            ? (w, h) => {
                if (w > 0 && h > 0) setMeasured(Math.min(1.6, Math.max(0.45, w / h)));
              }
            : undefined
        }
      />
      {children}
    </div>
  );
}
