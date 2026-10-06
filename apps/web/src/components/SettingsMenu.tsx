"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

/** Settings entries - WEB APP DESIGN.md: only "Direct Database Access" for now. */
const ITEMS = [{ href: "/admin", label: "Direct Database Access" }] as const;

export function SettingsMenu() {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Settings"
        onClick={() => setOpen((v) => !v)}
        className={`clip-corner-sm flex h-10 w-10 items-center justify-center border transition-colors ${
          open ? "border-accent bg-accent-deep text-accent-hi" : "border-rule bg-void/60 text-accent hover:border-accent hover:text-accent-hi"
        }`}
      >
        {/* Angular 8-tooth cog with a diamond hole */}
        <svg aria-hidden viewBox="0 0 20 20" className="h-5 w-5 fill-current">
          <path fillRule="evenodd" d="M16.45,7.27 L19.13,7.37 L19.13,12.63 L16.45,12.73 L16.49,12.63 L18.31,14.60 L14.60,18.31 L12.63,16.49 L12.73,16.45 L12.63,19.13 L7.37,19.13 L7.27,16.45 L7.37,16.49 L5.40,18.31 L1.69,14.60 L3.51,12.63 L3.55,12.73 L0.87,12.63 L0.87,7.37 L3.55,7.27 L3.51,7.37 L1.69,5.40 L5.40,1.69 L7.37,3.51 L7.27,3.55 L7.37,0.87 L12.63,0.87 L12.73,3.55 L12.63,3.51 L14.60,1.69 L18.31,5.40 L16.49,7.37 Z M10 6.5 L13.5 10 L10 13.5 L6.5 10 Z" />
        </svg>
      </button>

      {open ? (
        <div role="menu" className="panel clip-corner absolute right-0 z-50 mt-2 w-64 backdrop-blur-md">
          <div className="chrome-bar label-tech px-3 py-1.5 text-chrome-hi">Settings</div>
          <ul className="p-1.5">
            {ITEMS.map((item) => (
              <li key={item.href}>
                <Link
                  role="menuitem"
                  href={item.href}
                  onClick={() => setOpen(false)}
                  className="clip-corner-sm flex items-center gap-2 px-3 py-2 text-sm text-chrome hover:bg-accent-deep hover:text-accent-hi focus-visible:bg-accent-deep"
                >
                  <svg aria-hidden viewBox="0 0 8 10" className="h-2.5 w-2 fill-accent">
                    <polygon points="0,0 8,5 0,10" />
                  </svg>
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
