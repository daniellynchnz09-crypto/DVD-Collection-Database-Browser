import type { ReactNode } from "react";

/**
 * Layout primitives in the "techno chrome" style: an angular gradient Panel with an optional
 * brushed-metal title bar, and a Section with a labelled rule line. Pages compose these
 * instead of styling their own boxes.
 */

export function Panel({
  title,
  aside,
  children,
  className = "",
  bodyClassName = "p-4",
}: {
  /** Shown in the chrome title bar (uppercased). Omit for a plain panel. */
  title?: ReactNode;
  /** Right side of the title bar (count, link). */
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={`panel clip-corner ${className}`}>
      {title ? (
        <header className="chrome-bar flex items-center gap-2 px-4 py-1.5">
          <span aria-hidden className="h-2 w-2 rotate-45 bg-accent" />
          <h2 className="font-display text-xs font-semibold tracking-[0.2em] text-chrome-hi uppercase">{title}</h2>
          {aside ? <div className="ml-auto label-tech">{aside}</div> : null}
        </header>
      ) : null}
      <div className={bodyClassName}>{children}</div>
    </section>
  );
}

export function Section({
  title,
  label,
  aside,
  children,
  className = "",
}: {
  title: ReactNode;
  /** Tiny code-style label before the title, e.g. "01" or "SUB.DATA". */
  label?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={className}>
      <div className="mb-3 flex items-end gap-3">
        {label ? <span className="label-tech text-accent">{label}</span> : null}
        <h2 className="font-display text-base font-semibold tracking-wider text-chrome-hi uppercase sm:text-lg">{title}</h2>
        <span aria-hidden className="mb-1.5 h-px flex-1 bg-linear-to-r from-rule-strong to-transparent" />
        {aside ? <div className="label-tech">{aside}</div> : null}
      </div>
      {children}
    </section>
  );
}

/** Small angular badge (format, "Steelbook", "Rented out"...). */
export function Badge({ children, tone = "accent" }: { children: ReactNode; tone?: "accent" | "muted" | "signal" }) {
  const tones = {
    accent: "bg-accent-deep/90 text-accent-hi border-accent-dim",
    muted: "bg-panel/90 text-mist border-rule",
    signal: "bg-signal/15 text-signal border-signal/50",
  } as const;
  return (
    <span className={`clip-tab inline-flex items-center border px-1.5 py-px font-display text-[10px] font-semibold tracking-[0.14em] uppercase ${tones[tone]}`}>
      {children}
    </span>
  );
}
