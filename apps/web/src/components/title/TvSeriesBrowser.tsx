"use client";

import Image from "next/image";
import Link from "next/link";
import { Fragment, useId, useState, type ReactNode } from "react";
import { storyKeyOf } from "@/lib/catalog/display";
import type { BrowserSeason } from "@/lib/catalog/titlePages";

/** TMDb still URL built client-side (images.ts is server-only); 300w suits the thumbnail. */
const stillUrl = (path: string) => `https://image.tmdb.org/t/p/w300${path.startsWith("/") ? path : `/${path}`}`;

/**
 * The "burnt in Series browser" (WEB APP DESIGN.md): season tabs for only the seasons the
 * collection holds, each showing its episode list (live from TMDb when the show is matched)
 * and which owned disc(s) carry that season.
 *
 * `storyExtras` (2026-10-06) adds an accordion per story/serial: keyed `${season}|${storyKeyOf(
 * serial title)}`, its `badge` shows on each of that story's episodes, and clicking any of them
 * opens `panel` under the story's last episode (the user's request, for their own per-serial
 * scores and reviews of Doctor Who). Pages that pass nothing get the plain list.
 */
export type StoryExtras = Record<string, { badge: ReactNode; panel: ReactNode }>;

export function TvSeriesBrowser({
  seasons,
  tmdbLinked,
  storyExtras,
}: {
  seasons: BrowserSeason[];
  tmdbLinked: boolean;
  storyExtras?: StoryExtras;
}) {
  const [active, setActive] = useState(0);
  const [openStory, setOpenStory] = useState<string | null>(null);
  const baseId = useId();
  if (seasons.length === 0) return null;
  const season = seasons[Math.min(active, seasons.length - 1)];

  return (
    <div className="panel clip-corner">
      <div className="chrome-bar scrollbar-none flex overflow-x-auto" role="tablist" aria-label="Seasons">
        {seasons.map((s, i) => {
          const selected = i === active;
          return (
            <button
              key={`${i}:${s.label}`}
              type="button"
              role="tab"
              id={`${baseId}-tab-${i}`}
              aria-selected={selected}
              aria-controls={`${baseId}-panel`}
              onClick={() => setActive(i)}
              className={`clip-tab shrink-0 border-r border-rule px-4 py-2 font-display text-xs font-semibold tracking-[0.16em] whitespace-nowrap uppercase transition-colors ${
                selected ? "gloss bg-accent-deep text-accent-hi" : "text-mist hover:bg-panel-hi hover:text-chrome-hi"
              }`}
            >
              {s.label}
            </button>
          );
        })}
      </div>

      <div id={`${baseId}-panel`} role="tabpanel" aria-labelledby={`${baseId}-tab-${active}`} className="grid gap-6 p-4 lg:grid-cols-[1fr_17rem] lg:p-5">
        <div className="min-w-0">
          {season.overview ? <p className="mb-4 max-w-3xl text-sm leading-relaxed text-mist">{season.overview}</p> : null}
          {season.seasonEpisodeTotal && season.episodes ? (
            <p className="label-tech mb-3 text-accent">
              {`${season.episodes.length} of ${season.seasonEpisodeTotal} episodes // on my discs`}
            </p>
          ) : null}
          {season.episodes && season.episodes.length > 0 ? (
            <ol className="flex flex-col divide-y divide-rule">
              {season.episodes.map((ep, i, eps) => {
                const key = `${season.number}|${storyKeyOf(ep.name)}`;
                const extra = storyExtras?.[key];
                const lastOfStory = !eps[i + 1] || `${season.number}|${storyKeyOf(eps[i + 1].name)}` !== key;
                const open = openStory === key;
                const body = (
                  <>
                    <div className="clip-corner-sm relative hidden aspect-video w-36 shrink-0 overflow-hidden bg-void sm:block">
                      {ep.stillPath ? (
                        <Image src={stillUrl(ep.stillPath)} alt="" fill sizes="144px" unoptimized className="object-cover" />
                      ) : (
                        <span className="label-tech absolute inset-0 flex items-center justify-center text-[9px] text-mist-dim">No still</span>
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                        <span className="font-display text-xs font-semibold tracking-[0.16em] text-accent">E{String(ep.episodeNumber).padStart(2, "0")}</span>
                        <span className="font-medium text-chrome-hi">{ep.name}</span>
                        <span className="label-tech text-[10px] text-mist-dim">
                          {[ep.airDate, ep.runtime ? `${ep.runtime}m` : null].filter(Boolean).join(" // ")}
                        </span>
                      </div>
                      {ep.overview ? <p className="mt-1 line-clamp-3 text-sm leading-snug text-mist">{ep.overview}</p> : null}
                    </div>
                  </>
                );
                return (
                  <Fragment key={ep.episodeNumber}>
                    <li className="py-3 first:pt-0">
                      {extra ? (
                        <button
                          type="button"
                          onClick={() => setOpenStory(open ? null : key)}
                          aria-expanded={open}
                          className="flex w-full gap-3 text-left transition-colors hover:bg-panel-hi/40 sm:gap-4"
                        >
                          {body}
                          <span className="flex shrink-0 items-center gap-1.5 self-center">
                            {extra.badge}
                            <svg aria-hidden viewBox="0 0 10 6" className={`h-1.5 w-2.5 fill-accent transition-transform ${open ? "rotate-180" : ""}`}>
                              <polygon points="0,0 10,0 5,6" />
                            </svg>
                          </span>
                        </button>
                      ) : (
                        <div className="flex gap-3 sm:gap-4">{body}</div>
                      )}
                    </li>
                    {extra && open && lastOfStory ? <li className="pb-3">{extra.panel}</li> : null}
                  </Fragment>
                );
              })}
            </ol>
          ) : (
            <EpisodeFallback season={season} tmdbLinked={tmdbLinked} />
          )}
        </div>

        <aside className="flex flex-col gap-2">
          <span className="label-tech">On disc</span>
          {season.holders.map((h) => (
            <Link
              key={h.uniqueId}
              href={h.href}
              className="clip-corner-sm flow-ring group flex flex-col border border-rule bg-void/50 px-3 py-2 transition-colors hover:border-accent-dim"
            >
              <span className="text-sm font-medium text-chrome group-hover:text-accent-hi">{h.title}</span>
              <span className="label-tech text-[10px]">
                {[h.format, h.partOfSeason ? `Part ${h.partOfSeason}` : null, h.episodeCount ? `${h.episodeCount} episodes` : null]
                  .filter(Boolean)
                  .join(" // ")}
              </span>
            </Link>
          ))}
        </aside>
      </div>
    </div>
  );
}

function EpisodeFallback({ season, tmdbLinked }: { season: BrowserSeason; tmdbLinked: boolean }) {
  const episodes = season.holders.reduce((n, h) => n + (h.episodeCount ?? 0), 0);
  return (
    <div className="flex flex-col gap-2">
      {episodes > 0 ? (
        <p className="font-display text-2xl font-semibold text-chrome-hi">
          {episodes}
          <span className="label-tech ml-2">episodes held</span>
        </p>
      ) : null}
      <p className="text-sm text-mist">
        {season.number === null
          ? "A mixed release - see the disc page for what it holds."
          : tmdbLinked
            ? "The episode list couldn't be loaded right now."
            : "The episode list will appear once this series is matched on TMDB."}
      </p>
    </div>
  );
}
