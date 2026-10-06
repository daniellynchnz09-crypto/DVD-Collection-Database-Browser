import { NextResponse } from "next/server";
import { requireScanSecret } from "@/lib/scanAuth";
import { getSupabaseServerClient } from "@/lib/supabaseServer";

/**
 * Every distinct "rented to" name already in the collection, for the scanner app's Rented By
 * autocomplete (apps/mobile/src/lib/fieldOptions.ts). Added 2026-10-06 when the database's
 * public (anon) key lost read access to `rented_by_who` (migration 0044) - those are real third
 * parties' names, and the anon key is embedded in the app bundle and the public website, so it
 * must not be able to read them. Served here instead, behind the same scan secret as every
 * other /api/scan route, using the service-role client.
 */
const PAGE_SIZE = 1000;

export async function POST(request: Request) {
  const authError = requireScanSecret(request);
  if (authError) return authError;

  const supabase = getSupabaseServerClient();
  const names = new Set<string>();
  // Postgrest caps a response at 1000 rows, so page through every rented-out row.
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from("titles")
      .select("rented_by_who")
      .not("rented_by_who", "is", null)
      .range(from, from + PAGE_SIZE - 1);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    for (const row of data ?? []) {
      const name = (row.rented_by_who as string | null)?.trim();
      if (name) names.add(name);
    }
    if (!data || data.length < PAGE_SIZE) break;
  }

  return NextResponse.json({ names: [...names].sort((a, b) => a.localeCompare(b)) });
}
