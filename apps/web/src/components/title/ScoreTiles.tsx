import type { ReactNode } from "react";

/**
 * IMDb / Rotten Tomatoes / Metacritic scores beside the poster (WEB APP DESIGN.md). Scores
 * come from OMDb via title_metadata and show as graphics (icon, number, coloured meter); before
 * the backfill reaches a title only the outbound links show. `extraTiles` lets a page add its
 * own tiles to the same row.
 */
export function ScoreTiles({
  imdbRating,
  imdbVotes,
  rottenTomatoes,
  metacritic,
  imdbUrl,
  rottenTomatoesUrl,
  extraTiles,
}: {
  imdbRating: number | null;
  imdbVotes: number | null;
  rottenTomatoes: number | null;
  metacritic: number | null;
  imdbUrl: string | null;
  rottenTomatoesUrl: string | null;
  extraTiles?: ReactNode;
}) {
  const tiles: ReactNode[] = [];
  if (imdbRating !== null) {
    const r = Number(imdbRating);
    tiles.push(
      <Tile
        key="imdb"
        label="IMDb"
        href={imdbUrl}
        icon={<StarIcon />}
        color="#f5c518"
        fill={r / 10}
        footnote={imdbVotes ? `${compact(imdbVotes)} votes` : null}
      >
        {r.toFixed(1)}
        <span className="text-sm text-mist">/10</span>
      </Tile>,
    );
  }
  if (rottenTomatoes !== null) {
    const fresh = rottenTomatoes >= 60;
    tiles.push(
      <Tile
        key="rt"
        label="Rotten Tomatoes"
        href={rottenTomatoesUrl}
        icon={fresh ? <TomatoIcon /> : <SplatIcon />}
        color={fresh ? "#fa320a" : "#7cb342"}
        fill={rottenTomatoes / 100}
        footnote={fresh ? "Fresh // Tomatometer" : "Rotten // Tomatometer"}
      >
        {rottenTomatoes}
        <span className="text-sm text-mist">%</span>
      </Tile>,
    );
  }
  if (metacritic !== null) {
    // Metacritic's own bands: 61+ favourable, 40-60 mixed, under 40 unfavourable.
    const color = metacritic >= 61 ? "#66cc33" : metacritic >= 40 ? "#ffcc33" : "#ff3333";
    tiles.push(
      <Tile
        key="mc"
        label="Metacritic"
        icon={<span className="block h-3.5 w-3.5" style={{ backgroundColor: color }} />}
        color={color}
        fill={metacritic / 100}
        footnote={metacritic >= 61 ? "Favourable // Metascore" : metacritic >= 40 ? "Mixed // Metascore" : "Unfavourable // Metascore"}
      >
        {metacritic}
        <span className="text-sm text-mist">/100</span>
      </Tile>,
    );
  }

  const links = [
    imdbUrl && imdbRating === null ? { href: imdbUrl, label: "IMDb" } : null,
    rottenTomatoesUrl && rottenTomatoes === null ? { href: rottenTomatoesUrl, label: "Rotten Tomatoes" } : null,
  ].filter((l): l is { href: string; label: string } => !!l);

  if (extraTiles) tiles.push(<span key="extra" className="contents">{extraTiles}</span>);
  if (tiles.length === 0 && links.length === 0) return null;
  return (
    <div className="flex flex-col gap-3">
      {tiles.length > 0 ? <div className="flex flex-wrap gap-3">{tiles}</div> : null}
      {links.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="label-tech">{tiles.length === 0 ? "Ratings" : "Also on"}</span>
          {links.map((l) => (
            <ExternalChip key={l.label} href={l.href}>
              {l.label}
            </ExternalChip>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** One score: source icon + label, the big number, and a meter filled to the score in the
 * source's own colour (the user asked for the rating as a graphic, not just a link). */
function Tile({
  label,
  href,
  icon,
  color,
  fill,
  footnote,
  children,
}: {
  label: string;
  href?: string | null;
  icon: ReactNode;
  color: string;
  /** 0-1 */
  fill: number;
  footnote?: string | null;
  children: ReactNode;
}) {
  const body = (
    <>
      <span className="flex items-center gap-1.5">
        <span aria-hidden style={{ color }}>
          {icon}
        </span>
        <span className="label-tech text-accent">{label}</span>
      </span>
      <span className="font-display text-3xl leading-none font-bold text-chrome-hi">{children}</span>
      <span aria-hidden className="clip-tab relative h-1.5 w-full overflow-hidden bg-void/80">
        <span className="absolute inset-y-0 left-0" style={{ width: `${Math.round(Math.min(1, Math.max(0, fill)) * 100)}%`, backgroundColor: color }} />
      </span>
      {footnote ? <span className="label-tech text-[9px] text-mist-dim">{footnote}</span> : null}
    </>
  );
  const cls = "panel clip-corner flex min-w-[9rem] flex-col gap-2 px-4 py-3";
  return href ? (
    <a href={href} target="_blank" rel="noopener noreferrer" className={`${cls} transition-colors hover:[--panel-line:var(--color-accent)]`}>
      {body}
    </a>
  ) : (
    <div className={cls}>{body}</div>
  );
}

function StarIcon() {
  return (
    <svg viewBox="0 0 20 20" className="h-3.5 w-3.5 fill-current">
      <polygon points="10,1 12.6,7 19,7.4 14,11.6 15.6,18 10,14.5 4.4,18 6,11.6 1,7.4 7.4,7" />
    </svg>
  );
}

function TomatoIcon() {
  return (
    <svg viewBox="0 0 20 20" className="h-3.5 w-3.5 fill-current">
      <circle cx="10" cy="11.5" r="7.5" />
      <polygon points="10,1 11.5,4.5 15,3.5 12.5,6 7.5,6 5,3.5 8.5,4.5" fill="#4caf50" />
    </svg>
  );
}

function SplatIcon() {
  return (
    <svg viewBox="0 0 20 20" className="h-3.5 w-3.5 fill-current">
      <polygon points="10,1 12,6 17,3 14,8 19,10 14,12 17,17 12,14 10,19 8,14 3,17 6,12 1,10 6,8 3,3 8,6" />
    </svg>
  );
}

export function ExternalChip({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="clip-tab inline-flex items-center gap-1.5 border border-rule bg-void/60 px-2 py-1 font-display text-[11px] font-semibold tracking-[0.14em] text-accent uppercase hover:border-accent hover:text-accent-hi"
    >
      {children}
      <svg aria-hidden viewBox="0 0 10 10" className="h-2 w-2 fill-current">
        <polygon points="2,0 10,0 10,8 8,6 8,3.4 1.4,10 0,8.6 6.6,2 4,2" />
      </svg>
    </a>
  );
}

function compact(n: number): string {
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(n);
}
