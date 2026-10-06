import Image from "next/image";
import Link from "next/link";
import type { ArchiveStats, HomeFeature } from "@/lib/catalog/home";
import { Badge } from "../Panel";
import { PosterImage } from "../PosterImage";

/**
 * Top-of-home feature band in the techno-chrome style: a randomly featured title over a
 * blurred, zoomed copy of its art (the same treatment title pages use), plus an "archive
 * status" readout of the collection's size by format.
 */
export function HomeHero({ feature, stats }: { feature: HomeFeature | null; stats: ArchiveStats | null }) {
  const bg = feature?.backdrop ?? feature?.poster ?? null;
  const meta = feature
    ? [feature.year, feature.kind, feature.runtimeMins ? `${feature.runtimeMins} min` : null, feature.rating].filter(Boolean)
    : [];

  return (
    <section className="relative overflow-hidden border-b border-rule-strong">
      {bg ? (
        <div aria-hidden className="absolute inset-0">
          <Image
            src={bg.src}
            alt=""
            fill
            sizes="480px"
            unoptimized={bg.unoptimized}
            className={`object-cover ${feature?.backdrop ? "opacity-45 blur-sm" : "scale-125 opacity-40 blur-2xl"}`}
          />
        </div>
      ) : null}
      {/* Darken towards the text side and the bottom so copy stays readable over any art */}
      <div aria-hidden className="absolute inset-0 bg-linear-to-r from-void via-abyss/85 to-abyss/30" />
      <div aria-hidden className="absolute inset-0 bg-linear-to-t from-void via-transparent to-void/40" />
      {/* Diagonal hatch on the right edge, a nod to the 2Advanced panels */}
      <div
        aria-hidden
        className="absolute inset-y-0 right-0 hidden w-1/3 opacity-30 md:block"
        style={{ background: "repeating-linear-gradient(135deg, rgb(92 200 255 / 0.10) 0 1px, transparent 1px 14px)" }}
      />

      <div className="relative mx-auto max-w-screen-2xl px-4 pt-6 pb-5 sm:px-6 sm:pt-10 sm:pb-7">
        <div aria-hidden className="mb-4 h-px bg-linear-to-r from-accent/60 via-rule-strong to-transparent" />

        {feature ? (
          <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-4 sm:gap-8">
            <div className="min-w-0">
              <p className="mb-2 flex items-center gap-1.5 text-accent">
                {[0, 1, 2].map((i) => (
                  <svg key={i} aria-hidden viewBox="0 0 8 10" className="h-2.5 w-2 fill-current" style={{ opacity: 1 - i * 0.3 }}>
                    <polygon points="0,0 8,5 0,10" />
                  </svg>
                ))}
                <span className="label-tech ml-1 text-accent">Featured from the archive</span>
              </p>
              <h1 className="font-display text-2xl leading-[1.05] font-bold tracking-wide text-chrome-hi uppercase drop-shadow-[0_2px_12px_rgb(3_6_11/0.9)] sm:text-4xl lg:text-5xl">
                {feature.title}
              </h1>

              {meta.length > 0 ? (
                <p className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1">
                  {meta.map((m, i) => (
                    <span key={i} className="label-tech flex items-center gap-2 text-chrome">
                      {i > 0 ? <span aria-hidden className="h-1.5 w-1.5 rotate-45 bg-accent-dim" /> : null}
                      {m}
                    </span>
                  ))}
                </p>
              ) : null}

              <div className="mt-3 flex flex-wrap gap-1.5">
                {feature.format ? <Badge>{feature.format}</Badge> : null}
                {feature.genres.map((g) => (
                  <Badge key={g} tone="muted">
                    {g}
                  </Badge>
                ))}
              </div>

              {feature.tagline ? <p className="mt-4 font-display text-sm tracking-wide text-accent-hi italic">{feature.tagline}</p> : null}
              {feature.overview ? (
                <p className="mt-2 line-clamp-3 max-w-2xl text-sm leading-relaxed text-chrome sm:text-base">{feature.overview}</p>
              ) : feature.directors.length > 0 ? (
                <p className="mt-4 text-sm text-mist">
                  Directed by <span className="text-chrome">{feature.directors.join(" & ")}</span>
                </p>
              ) : null}

              <div className="mt-5 flex flex-wrap items-center gap-2">
                <Link
                  href={feature.href}
                  className="clip-chevron-right flex h-10 items-center bg-accent pr-7 pl-4 font-display text-xs font-bold tracking-[0.2em] text-void uppercase transition-colors hover:bg-accent-hi"
                >
                  View title
                </Link>
              </div>
            </div>

            <Link href={feature.href} className="group relative block w-24 shrink-0 outline-none sm:w-44 lg:w-56" aria-label={feature.title}>
              <div className="clip-corner relative aspect-[2/3] overflow-hidden bg-panel shadow-glow ring-1 ring-accent-dim ring-inset">
                <PosterImage image={feature.poster} title={feature.title} sizes="(max-width: 640px) 96px, 224px" preload />
                <div aria-hidden className="pointer-events-none absolute inset-0 border border-transparent transition-colors group-hover:border-accent" />
              </div>
              {/* Corner brackets framing the poster like a targeting reticle */}
              <span aria-hidden className="absolute -top-1.5 -left-1.5 h-3 w-3 border-t border-l border-accent" />
              <span aria-hidden className="absolute -right-1.5 -bottom-1.5 h-3 w-3 border-r border-b border-accent" />
            </Link>
          </div>
        ) : (
          <div>
            <h1 className="font-display text-3xl font-bold tracking-[0.12em] text-accent uppercase sm:text-5xl">
              DANFLIX<span className="ml-2 text-accent-hi">5.0</span>
            </h1>
            <p className="label-tech mt-2">Physical media archive</p>
          </div>
        )}

        {stats ? <StatsStrip stats={stats} /> : null}
      </div>
    </section>
  );
}

/**
 * The archive stats: the total as a big number, then the breakdown as bar charts (2026-10-06,
 * the user asked for a graph instead of a row of numbers, keeping the total as a number).
 */
function StatsStrip({ stats }: { stats: ArchiveStats }) {
  const other = Math.max(0, stats.total - stats.dvd - stats.bluray - stats.uhd);
  const formats = [
    { label: "DVD", value: stats.dvd },
    { label: "Blu-ray", value: stats.bluray },
    { label: "4K UHD", value: stats.uhd },
    { label: "Other", value: other },
  ].filter((b) => b.label !== "Other" || b.value > 0);
  const types = [
    { label: "Movies", value: Math.max(0, stats.total - stats.tv - stats.boxSetMovies) },
    { label: "TV", value: stats.tv },
    { label: "Box sets", value: stats.boxSets },
  ];
  return (
    <div className="mt-6 grid gap-4 border border-rule bg-void/50 p-4 backdrop-blur-sm sm:mt-8 sm:grid-cols-[auto_1fr_1fr] sm:gap-8 sm:p-5">
      <div className="flex flex-col justify-center sm:border-r sm:border-rule sm:pr-8">
        <span className="label-tech text-[10px]">Titles in the archive</span>
        <span className="font-display text-5xl leading-none font-bold text-accent-hi tabular-nums sm:text-6xl">
          {stats.total.toLocaleString("en-NZ")}
        </span>
      </div>
      <BarChart title="By format" bars={formats} total={stats.total} />
      <BarChart title="By type" bars={types} total={stats.total} />
    </div>
  );
}

/** Each bar is a share of the whole archive (the user's request: DVD reads 68 of 116, not 68 of 68). */
function BarChart({ title, bars, total }: { title: string; bars: Array<{ label: string; value: number }>; total: number }) {
  const max = Math.max(1, total);
  return (
    <figure className="flex min-w-0 flex-col gap-2">
      <figcaption className="label-tech text-[10px] text-accent">{title}</figcaption>
      {bars.map((b) => (
        <div key={b.label} className="grid grid-cols-[4.5rem_1fr_2.5rem] items-center gap-2">
          <span className="label-tech truncate text-[10px]">{b.label}</span>
          <span aria-hidden className="clip-tab relative h-3 bg-deep/80">
            <span
              className="absolute inset-y-0 left-0 bg-linear-to-r from-accent-dim to-accent"
              style={{ width: `${b.value > 0 ? Math.min(100, Math.max(3, (b.value / max) * 100)) : 0}%` }}
            />
          </span>
          <span className="text-right font-display text-sm font-semibold text-chrome-hi tabular-nums">{b.value.toLocaleString("en-NZ")}</span>
        </div>
      ))}
    </figure>
  );
}
