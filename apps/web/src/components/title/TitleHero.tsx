import type { ReactNode } from "react";
import { ImageFrame } from "@/components/ImageFrame";
import { POSTER_ASPECT } from "@/lib/catalog/display";
import type { CatalogImage } from "@/lib/catalog/types";

/**
 * Poster on the left, information beside it (WEB APP DESIGN.md: title, runtime, year and
 * scores "sit parallel to the movie poster"). Stacks on phones with the poster first.
 */
export function TitleHero({
  image,
  imageAlt,
  aspect = POSTER_ASPECT,
  children,
}: {
  image: CatalogImage | null;
  imageAlt: string;
  /** Starting frame shape - frameAspect(image, format) for a disc; case photos then settle on
   * their own measured shape (ImageFrame). */
  aspect?: number;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-6 sm:grid-cols-[minmax(0,13rem)_1fr] md:grid-cols-[minmax(0,17rem)_1fr] md:gap-10">
      <div className="mx-auto w-48 sm:mx-0 sm:w-full">
        <ImageFrame
          image={image}
          title={imageAlt}
          aspect={aspect}
          sizes="(max-width: 640px) 192px, 272px"
          preload
          className="clip-corner bg-void/80 shadow-glow ring-1 ring-rule-strong ring-inset"
        />
        {/* Corner tick marks under the poster - part of the chrome frame language */}
        <div aria-hidden className="mt-2 flex items-center gap-2">
          <span className="h-px flex-1 bg-rule-strong" />
          <span className="h-1.5 w-1.5 rotate-45 bg-accent" />
        </div>
      </div>
      <div className="flex min-w-0 flex-col gap-5">{children}</div>
    </div>
  );
}

/** Big title block at the top of the hero's info column. */
export function HeroTitle({ kicker, title, subtitle }: { kicker?: ReactNode; title: string; subtitle?: ReactNode }) {
  return (
    <div>
      {kicker ? <div className="label-tech mb-1 text-accent">{kicker}</div> : null}
      <h2 className="font-display text-3xl leading-tight font-bold tracking-wide text-chrome-hi drop-shadow-[0_2px_12px_rgb(0_0_0/0.6)] sm:text-4xl lg:text-5xl">
        {title}
      </h2>
      {subtitle ? <div className="mt-2 text-base text-mist italic sm:text-lg">{subtitle}</div> : null}
    </div>
  );
}

/** "1958 // 2h 8m // PG" - drops empty parts. */
export function MetaLine({ parts }: { parts: Array<ReactNode | null | undefined | false> }) {
  const shown = parts.filter((p) => p !== null && p !== undefined && p !== false && p !== "");
  if (shown.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-display text-sm tracking-[0.12em] text-chrome uppercase">
      {shown.map((p, i) => (
        <span key={i} className="flex items-center gap-3">
          {i > 0 ? <span aria-hidden className="h-3 w-px rotate-12 bg-accent-dim" /> : null}
          {p}
        </span>
      ))}
    </div>
  );
}

export interface Fact {
  label: string;
  value: ReactNode;
}

/** Falsy entries (from `cond && {...}`) are skipped, so callers can inline conditions. */
type MaybeFact = Fact | null | undefined | false | "" | 0;

/** Two-column spec sheet; rows with an empty value are skipped so missing data never shows
 * as a blank or "null". */
export function FactList({ facts, className = "" }: { facts: Array<MaybeFact>; className?: string }) {
  const shown = facts.filter((f): f is Fact => typeof f === "object" && f !== null && f.value !== null && f.value !== undefined && f.value !== "");
  if (shown.length === 0) return null;
  return (
    <dl className={`grid grid-cols-[minmax(6.5rem,auto)_1fr] gap-x-5 gap-y-2 text-sm ${className}`}>
      {shown.map((f) => (
        <div key={f.label} className="contents">
          <dt className="label-tech pt-0.5">{f.label}</dt>
          <dd className="min-w-0 text-chrome">{f.value}</dd>
        </div>
      ))}
    </dl>
  );
}
