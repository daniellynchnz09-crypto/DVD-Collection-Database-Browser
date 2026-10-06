import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

/**
 * Owner passcode for the few things on the public-by-link site that change data - taste
 * profiles first (2026-10-07; the user chose "anyone can use them, only I can edit them").
 * Not real accounts (those are Phase 4's owner auth): one secret, OWNER_PASSCODE in the
 * server's environment, sent by the browser in an `x-owner-passcode` header.
 *
 * Compared in constant time (both sides hashed first, so lengths match), and repeated wrong
 * guesses from one address are locked out for a while, so the passcode can't be brute-forced
 * through the site.
 */

const WINDOW_MS = 15 * 60_000;
const MAX_FAILURES = 8;
const failures = new Map<string, { count: number; since: number }>();

function clientKey(request: Request): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "local";
}

const digest = (s: string) => createHash("sha256").update(s, "utf8").digest();

/** Null when the passcode is right; otherwise the error response to return. */
export function requireOwnerPasscode(request: Request): NextResponse | null {
  const expected = process.env.OWNER_PASSCODE;
  if (!expected) {
    return NextResponse.json({ error: "Editing is turned off: OWNER_PASSCODE isn't set on the server." }, { status: 503 });
  }
  const key = clientKey(request);
  const now = Date.now();
  const record = failures.get(key);
  if (record && now - record.since > WINDOW_MS) failures.delete(key);
  const current = failures.get(key);
  if (current && current.count >= MAX_FAILURES) {
    return NextResponse.json({ error: "Too many wrong passcodes. Try again in 15 minutes." }, { status: 429 });
  }

  const provided = request.headers.get("x-owner-passcode") ?? "";
  if (provided && timingSafeEqual(digest(provided), digest(expected))) {
    failures.delete(key);
    return null;
  }
  failures.set(key, { count: (current?.count ?? 0) + 1, since: current?.since ?? now });
  if (failures.size > 5_000) failures.clear();
  return NextResponse.json({ error: "Wrong passcode." }, { status: 401 });
}
