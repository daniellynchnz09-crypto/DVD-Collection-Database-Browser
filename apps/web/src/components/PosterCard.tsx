import Link from "next/link";
import type { PosterCardData } from "@/lib/catalog/types";
import { POSTER_ASPECT } from "@/lib/catalog/display";
import { ImageFrame } from "./ImageFrame";

/**
 * One poster tile: image (or angular placeholder), format badge, title and year. Posters are
 * 2:3; a case photo's frame follows the case's own shape (ImageFrame).
 * Build `card` with toPosterCards() from @/lib/catalog so image priority and links stay
 * consistent across the site.
 */
export function PosterCard({
  card,
  size = "md",
  preload = false,
}: {
  card: PosterCardData;
  /** sm = dense grids/search, md = browse rows, lg = featured. */
  size?: "sm" | "md" | "lg";
  preload?: boolean;
}) {
  const widths = { sm: "w-28 sm:w-32", md: "w-32 sm:w-40", lg: "w-40 sm:w-52" } as const;
  const sizes = { sm: "128px", md: "(max-width: 640px) 128px, 160px", lg: "(max-width: 640px) 160px, 208px" } as const;

  return (
    <Link href={card.href} className={`group block shrink-0 ${widths[size]} outline-none`} title={card.title}>
      <ImageFrame
        image={card.image}
        title={card.title}
        aspect={card.aspect ?? POSTER_ASPECT}
        sizes={sizes[size]}
        preload={preload}
        className="clip-corner flow-ring bg-panel ring-1 ring-rule transition duration-200 ring-inset group-hover:-translate-y-0.5 group-focus-visible:shadow-glow"
      >
        {/* Hover sheen + accent frame */}
        <div aria-hidden className="pointer-events-none absolute inset-0 bg-linear-to-t from-void/70 via-transparent to-transparent opacity-80" />
        <div aria-hidden className="pointer-events-none absolute inset-0 border border-transparent transition-colors group-hover:border-accent/25 group-focus-visible:border-accent" />
        {card.format ? (
          <span className="clip-tab absolute bottom-0 left-0 bg-void/85 px-1.5 py-0.5 font-display text-[10px] font-semibold tracking-[0.14em] text-accent uppercase">
            {card.format}
          </span>
        ) : null}
      </ImageFrame>
      <div className="mt-2 px-0.5">
        <p className="line-clamp-2 text-sm leading-tight font-medium text-chrome group-hover:text-accent-hi">{card.title}</p>
        <p className="label-tech mt-0.5 truncate">
          {[card.year, card.caption].filter(Boolean).join(" // ") || " "}
        </p>
      </div>
    </Link>
  );
}
