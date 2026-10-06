import Image from "next/image";
import type { ReactNode } from "react";
import { PageHeader } from "@/components/PageHeader";
import type { CatalogImage } from "@/lib/catalog/types";

/**
 * Frame shared by the Movie/TV, DVD and Collection pages: the per-page header (title + back
 * button) over a blurred, darkened, zoomed-in copy of the poster (WEB APP DESIGN.md "TITLE
 * PAGES" design note), then the page body and an optional TMDb attribution line.
 */
export function TitlePageShell({
  title,
  eyebrow,
  actions,
  backdrop,
  tmdbAttribution = false,
  children,
}: {
  title: string;
  eyebrow?: ReactNode;
  actions?: ReactNode;
  backdrop: CatalogImage | null;
  /** TMDb's terms require the notice wherever its data/images are shown. */
  tmdbAttribution?: boolean;
  children: ReactNode;
}) {
  return (
    // isolate: gives the -z-10 backdrop its own stacking context so it sits behind this
    // page's content but still above the body's grid background.
    <div className="relative isolate overflow-clip">
      <TitleBackdrop image={backdrop} />
      <PageHeader title={title} eyebrow={eyebrow} actions={actions} />
      <div className="flex flex-col gap-10 pt-6 pb-12 sm:gap-12 sm:pt-8">{children}</div>
      {tmdbAttribution ? <TmdbAttribution /> : null}
    </div>
  );
}

function TitleBackdrop({ image }: { image: CatalogImage | null }) {
  if (!image) return null;
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[100svh] max-h-[1100px] overflow-hidden [mask-image:linear-gradient(to_bottom,black_45%,transparent)]"
    >
      {/* Heavily blurred, so a small source is plenty - keeps the background cheap. */}
      <Image
        src={image.src}
        alt=""
        fill
        sizes="480px"
        loading="eager"
        unoptimized={image.unoptimized}
        className="scale-125 object-cover blur-2xl brightness-[0.4] saturate-[1.2]"
      />
      <div className="absolute inset-0 bg-linear-to-b from-void/30 via-abyss/55 to-abyss" />
      {/* Scanline overlay so the blur still reads as the site's "techno" texture */}
      <div className="absolute inset-0 bg-[repeating-linear-gradient(0deg,rgb(255_255_255/0.025)_0_1px,transparent_1px_3px)]" />
    </div>
  );
}

export function TmdbAttribution() {
  return (
    <p className="mx-auto max-w-screen-2xl px-4 pb-6 text-[11px] leading-snug text-mist-dim sm:px-6">
      This product uses the TMDB API but is not endorsed or certified by TMDB.
    </p>
  );
}

/** Centred content column used by every block that isn't a full-bleed ScrollRow. */
export function Container({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`mx-auto w-full max-w-screen-2xl px-4 sm:px-6 ${className}`}>{children}</div>;
}

/** ScrollRow brings its own side padding, so it only needs the width cap. */
export function RowContainer({ children }: { children: ReactNode }) {
  return <div className="mx-auto w-full max-w-screen-2xl">{children}</div>;
}
