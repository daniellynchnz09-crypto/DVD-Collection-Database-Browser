import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { parseProfileParams } from "@/lib/catalog/tasteProfiles";
import { filtersToParams, hasTitleFilters } from "@/lib/catalog/searchFilters";

/** Shared body checks for creating and editing a taste profile. */
export async function readProfileBody(request: Request): Promise<{ name: string; filters: string } | NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }
  const { name, filters } = (body ?? {}) as { name?: unknown; filters?: unknown };
  const cleanName = typeof name === "string" ? name.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim() : "";
  if (!cleanName || cleanName.length > 60) {
    return NextResponse.json({ error: "Give the profile a name of 1-60 characters." }, { status: 400 });
  }
  if (typeof filters !== "string" || filters.length > 4000) {
    return NextResponse.json({ error: "Filters are missing or too long." }, { status: 400 });
  }
  // Re-parse and re-write, so only filters the search understands are ever stored.
  const parsed = parseProfileParams(filters);
  if (!hasTitleFilters(parsed)) {
    return NextResponse.json({ error: "Pick at least one filter for the profile first." }, { status: 400 });
  }
  return { name: cleanName, filters: filtersToParams(parsed).toString() };
}

/** Profile names are unique, ignoring case (checked here - 0001's table has no constraint). */
export async function nameTaken(supabase: SupabaseClient, name: string, exceptId?: string): Promise<boolean> {
  const { data } = await supabase.from("taste_profiles").select("id, name");
  return (data ?? []).some((r: { id: string; name: string }) => r.id !== exceptId && r.name.toLowerCase() === name.toLowerCase());
}

export function writeError(error: { code?: string; message: string }): NextResponse {
  if (error.code === "23505") return NextResponse.json({ error: "There's already a profile with that name." }, { status: 409 });
  if (error.code === "PGRST205" || error.code === "42P01") {
    return NextResponse.json({ error: "The taste_profiles table is missing from the database (migration 0001)." }, { status: 503 });
  }
  console.error("[taste-profiles]", error.code, error.message);
  return NextResponse.json({ error: "Couldn't save the profile." }, { status: 500 });
}
