"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { filtersToParams, type SearchFilters } from "@/lib/catalog/searchFilters";

export interface ClientTasteProfile {
  id: string;
  name: string;
  filters: SearchFilters;
}

const PASSCODE_KEY = "danflix-owner-passcode";

function readPasscode(): string {
  try {
    return sessionStorage.getItem(PASSCODE_KEY) ?? "";
  } catch {
    return "";
  }
}
function rememberPasscode(value: string) {
  try {
    if (value) sessionStorage.setItem(PASSCODE_KEY, value);
    else sessionStorage.removeItem(PASSCODE_KEY);
  } catch {
    // Private windows can refuse storage; the passcode is just asked for again.
  }
}

/** A profile's filters only - never result types, sorting or other profiles. */
function profileParams(f: SearchFilters): string {
  return filtersToParams({ ...f, types: [], sort: null, dir: null, profiles: [] }).toString();
}

/**
 * Taste profiles inside the filter panel (WEB APP DESIGN.md: saved filter presets, combined to
 * find titles that suit everyone - the taste_profiles table). Anyone can pick profiles; saving, updating
 * and deleting need the owner passcode, remembered for this browser tab only.
 */
export function TasteProfiles({
  profiles,
  selected,
  draft,
  onToggle,
  onLoad,
}: {
  profiles: ClientTasteProfile[];
  selected: string[];
  /** The panel's current (unapplied) filters - what "Save" stores. */
  draft: SearchFilters;
  onToggle: (id: string) => void;
  /** Puts a profile's filters into the panel, to tweak and save back. */
  onLoad: (filters: SearchFilters) => void;
}) {
  const router = useRouter();
  const [managing, setManaging] = useState(false);
  const [passcode, setPasscode] = useState(readPasscode);
  const [newName, setNewName] = useState("");
  const [renaming, setRenaming] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  async function send(method: "POST" | "PUT" | "DELETE", url: string, body?: object): Promise<boolean> {
    if (!passcode) {
      setMessage({ text: "Enter the owner passcode first.", error: true });
      return false;
    }
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(url, {
        method,
        headers: { "content-type": "application/json", "x-owner-passcode": passcode },
        body: body ? JSON.stringify(body) : undefined,
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        if (res.status === 401) rememberPasscode("");
        setMessage({ text: json.error ?? "That didn't work.", error: true });
        return false;
      }
      rememberPasscode(passcode);
      router.refresh();
      return true;
    } catch {
      setMessage({ text: "Couldn't reach the server.", error: true });
      return false;
    } finally {
      setBusy(false);
    }
  }

  const draftParams = profileParams(draft);

  return (
    <div>
      {profiles.length ? (
        <div className="flex flex-wrap gap-1.5">
          {profiles.map((p) => {
            const on = selected.includes(p.id);
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => onToggle(p.id)}
                aria-pressed={on}
                className={`clip-tab inline-flex items-center gap-1.5 border px-2.5 py-1 text-xs transition-colors ${
                  on ? "gloss border-accent bg-accent-deep text-accent-hi" : "border-rule bg-panel/60 text-chrome hover:border-accent-dim hover:text-accent-hi"
                }`}
              >
                <svg aria-hidden viewBox="0 0 10 10" className="h-2.5 w-2.5 fill-current opacity-80">
                  <circle cx="5" cy="3" r="2.2" />
                  <path d="M1 10c0-2.4 1.8-4 4-4s4 1.6 4 4z" />
                </svg>
                {p.name}
              </button>
            );
          })}
        </div>
      ) : (
        <p className="text-sm text-mist">No taste profiles yet.</p>
      )}
      <p className="label-tech mt-1.5 text-mist-dim">
        Pick two or more to see only titles that suit everyone picked.{" "}
        <button type="button" onClick={() => setManaging((m) => !m)} className="text-accent hover:text-accent-hi">
          {managing ? "Done managing" : "Manage profiles"}
        </button>
      </p>

      {managing ? (
        <div className="well clip-corner-sm mt-3 space-y-4 border border-rule bg-void/50 p-3">
          <label className="block">
            <span className="label-tech text-accent">Owner passcode</span>
            <input
              type="password"
              value={passcode}
              onChange={(e) => setPasscode(e.target.value)}
              autoComplete="current-password"
              className="well clip-corner-sm mt-1 block h-8 w-full max-w-xs border border-rule bg-void/80 px-2 text-sm text-chrome-hi focus:border-accent focus:outline-none"
            />
          </label>

          <div>
            <span className="label-tech text-accent">New profile from the filters above</span>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value.slice(0, 60))}
                placeholder="Name, e.g. Dan"
                className="well clip-corner-sm h-8 w-48 border border-rule bg-void/80 px-2 text-sm text-chrome-hi placeholder:text-mist-dim focus:border-accent focus:outline-none"
              />
              <button
                type="button"
                disabled={busy || !newName.trim() || !draftParams}
                onClick={async () => {
                  if (await send("POST", "/api/taste-profiles", { name: newName, filters: draftParams })) {
                    setNewName("");
                    setMessage({ text: "Profile saved.", error: false });
                  }
                }}
                className="gloss clip-corner-sm h-8 bg-accent-deep px-3 font-display text-[11px] font-semibold tracking-[0.16em] text-accent-hi uppercase hover:bg-accent-dim disabled:opacity-40"
              >
                Save profile
              </button>
            </div>
            {!draftParams ? <p className="label-tech mt-1 text-mist-dim">Set some filters above first - they become the profile.</p> : null}
          </div>

          {profiles.length ? (
            <ul className="space-y-2">
              {profiles.map((p) => {
                const name = renaming[p.id] ?? p.name;
                return (
                  <li key={p.id} className="flex flex-wrap items-center gap-2 border-t border-rule pt-2">
                    <input
                      value={name}
                      onChange={(e) => setRenaming((r) => ({ ...r, [p.id]: e.target.value.slice(0, 60) }))}
                      aria-label={`Name of ${p.name}`}
                      className="well clip-corner-sm h-8 w-40 border border-rule bg-void/80 px-2 text-sm text-chrome-hi focus:border-accent focus:outline-none"
                    />
                    <ManageButton onClick={() => onLoad(p.filters)} disabled={busy}>
                      Load filters
                    </ManageButton>
                    <ManageButton
                      disabled={busy || !draftParams}
                      onClick={async () => {
                        if (await send("PUT", `/api/taste-profiles/${p.id}`, { name, filters: draftParams })) setMessage({ text: `${name} updated.`, error: false });
                      }}
                    >
                      Save filters above
                    </ManageButton>
                    <ManageButton
                      disabled={busy || name.trim() === p.name}
                      onClick={async () => {
                        if (await send("PUT", `/api/taste-profiles/${p.id}`, { name, filters: profileParams(p.filters) })) setMessage({ text: "Renamed.", error: false });
                      }}
                    >
                      Rename
                    </ManageButton>
                    <ManageButton
                      danger
                      disabled={busy}
                      onClick={async () => {
                        if (!window.confirm(`Delete the taste profile "${p.name}"?`)) return;
                        if (await send("DELETE", `/api/taste-profiles/${p.id}`)) setMessage({ text: `${p.name} deleted.`, error: false });
                      }}
                    >
                      Delete
                    </ManageButton>
                  </li>
                );
              })}
            </ul>
          ) : null}

          {message ? <p className={`text-sm ${message.error ? "text-signal" : "text-accent-hi"}`}>{message.text}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

function ManageButton({ children, onClick, disabled, danger }: { children: string; onClick: () => void; disabled?: boolean; danger?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`clip-tab border px-2 py-1 font-display text-[10px] tracking-[0.14em] uppercase disabled:opacity-40 ${
        danger ? "border-signal/60 text-signal hover:bg-signal/10" : "border-rule bg-panel/60 text-chrome hover:border-accent-dim hover:text-accent-hi"
      }`}
    >
      {children}
    </button>
  );
}
