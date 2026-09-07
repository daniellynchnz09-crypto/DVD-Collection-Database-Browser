import { NextResponse } from "next/server";
import { requireScanSecret } from "@/lib/scanAuth";
import { omdbSearch } from "@danflix/shared";

/**
 * Runs the same OMDB search the resolver itself uses (Claude/TECH STACK AND
 * ARCHITECTURE.md's "BARCODE SCANNING PIPELINE"), but on demand from ConfirmScreen - for
 * the case where the barcode lookup came back with nothing usable at all (no UPCitemdb
 * listing, so the resolver had no title text to search with). Rather than dumping the user
 * straight into a blank form, ConfirmScreen offers a single "what's the title?" field that
 * calls this to get the same best-match candidate list the automatic pipeline would have
 * produced from a real listing.
 */
export async function POST(request: Request) {
  const authError = requireScanSecret(request);
  if (authError) return authError;

  const body = await request.json().catch(() => null);
  const title = typeof body?.title === "string" ? body.title.trim() : "";
  if (!title) {
    return NextResponse.json({ error: "title is required" }, { status: 400 });
  }

  const candidates = await omdbSearch(title);
  return NextResponse.json({ candidates });
}
