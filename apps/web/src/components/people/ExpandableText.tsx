"use client";

import { useState } from "react";

/** A biography/description that shows the first few lines and expands on demand - TMDb
 * biographies can run to many paragraphs and would push the connected titles off-screen. */
export function ExpandableText({ text, collapsedChars = 520 }: { text: string; collapsedChars?: number }) {
  const [open, setOpen] = useState(false);
  const long = text.length > collapsedChars;
  const paragraphs = (open || !long ? text : `${text.slice(0, collapsedChars).replace(/\s+\S*$/, "")}…`)
    .split(/\n\s*\n|\n/)
    .map((p) => p.trim())
    .filter(Boolean);

  return (
    <div className="space-y-3 text-[15px] leading-relaxed text-chrome">
      {paragraphs.map((p, i) => (
        <p key={i}>{p}</p>
      ))}
      {long ? (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="label-tech flex items-center gap-1.5 text-accent hover:text-accent-hi"
        >
          <svg aria-hidden viewBox="0 0 10 10" className={`h-2 w-2 fill-current transition-transform ${open ? "-rotate-90" : "rotate-90"}`}>
            <polygon points="0,0 10,5 0,10" />
          </svg>
          {open ? "Show less" : "Read more"}
        </button>
      ) : null}
    </div>
  );
}
