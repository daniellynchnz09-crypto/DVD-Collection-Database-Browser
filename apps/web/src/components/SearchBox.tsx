"use client";

import { useRouter } from "next/navigation";
import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

export const SEARCH_MAX_LENGTH = 120;

export interface SearchDropdownContext {
  /** The current (untrimmed) input value. */
  query: string;
  /** Close the dropdown (e.g. after a result is clicked). */
  close: () => void;
  /** id to put on the dropdown's listbox element, for aria-controls. */
  listboxId: string;
}

export interface SearchBoxProps {
  /** Pre-fill, e.g. the current ?q= on the /search page. */
  initialQuery?: string;
  placeholder?: string;
  /** Called on every keystroke - hook for the live-results fetcher. */
  onQueryChange?: (query: string) => void;
  /** Renders the live dropdown under the input while focused and non-empty. Return null for
   * nothing. The Search agent plugs its results panel in here. */
  renderDropdown?: (ctx: SearchDropdownContext) => ReactNode;
  /** Keyboard hook for dropdown navigation (ArrowUp/Down/Enter). Call
   * event.preventDefault() to stop the default submit. */
  onInputKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void;
  className?: string;
}

/**
 * Header search shell: submitting navigates to /search?q=... A later agent adds the live
 * dropdown through `renderDropdown`/`onQueryChange` without restructuring this component.
 */
export function SearchBox({
  initialQuery = "",
  placeholder = "Search titles, collections, people, franchises",
  onQueryChange,
  renderDropdown,
  onInputKeyDown,
  className = "",
}: SearchBoxProps) {
  const router = useRouter();
  const [query, setQuery] = useState(initialQuery);
  const [open, setOpen] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);
  const listboxId = useId();

  const close = () => setOpen(false);

  function submit() {
    const q = query.trim().slice(0, SEARCH_MAX_LENGTH);
    if (!q) return;
    close();
    router.push(`/search?q=${encodeURIComponent(q)}`);
  }

  const dropdown = open && query.trim() && renderDropdown ? renderDropdown({ query, close, listboxId }) : null;

  return (
    <div
      ref={wrapper}
      className={`relative ${className}`}
      onBlur={(e) => {
        // Keep it open while focus moves into the dropdown itself.
        if (!wrapper.current?.contains(e.relatedTarget as Node | null)) close();
      }}
    >
      <form
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="clip-corner-sm flex h-10 items-center border border-rule bg-void/70 focus-within:border-accent focus-within:bg-void"
      >
        <svg aria-hidden viewBox="0 0 16 16" className="ml-3 h-4 w-4 shrink-0 fill-none stroke-accent" strokeWidth="1.5">
          {/* Angular magnifier: square lens + diagonal handle */}
          <rect x="1.5" y="1.5" width="9" height="9" transform="rotate(45 6 6)" />
          <line x1="10" y1="10" x2="15" y2="15" />
        </svg>
        <input
          type="search"
          name="q"
          value={query}
          maxLength={SEARCH_MAX_LENGTH}
          autoComplete="off"
          spellCheck={false}
          placeholder={placeholder}
          aria-label="Search the collection"
          // Only a combobox once a live dropdown is plugged in.
          {...(renderDropdown
            ? { role: "combobox", "aria-autocomplete": "list" as const, "aria-expanded": !!dropdown, "aria-controls": dropdown ? listboxId : undefined }
            : {})}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
            onQueryChange?.(e.target.value);
          }}
          onKeyDown={(e) => {
            onInputKeyDown?.(e);
            if (e.defaultPrevented) return;
            if (e.key === "Escape") close();
          }}
          className="h-full min-w-0 flex-1 bg-transparent px-3 text-sm text-chrome-hi placeholder:text-mist-dim focus:outline-none [&::-webkit-search-cancel-button]:hidden"
        />
        <button
          type="submit"
          className="clip-chevron-right h-full shrink-0 bg-accent-deep px-4 pr-5 font-display text-[11px] font-semibold tracking-[0.18em] text-accent-hi uppercase hover:bg-accent-dim"
        >
          Search
        </button>
      </form>
      {dropdown ? <div className="absolute inset-x-0 top-full z-50 mt-1">{dropdown}</div> : null}
    </div>
  );
}
