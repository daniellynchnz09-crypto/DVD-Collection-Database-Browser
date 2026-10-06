import { NextResponse } from "next/server";
import { requireOwnerPasscode } from "@/lib/ownerAuth";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { nameTaken, readProfileBody, writeError } from "./shared";

/** Creates a taste profile (owner passcode required - see lib/ownerAuth.ts). */
export async function POST(request: Request) {
  const denied = requireOwnerPasscode(request);
  if (denied) return denied;
  const body = await readProfileBody(request);
  if (body instanceof NextResponse) return body;

  const supabase = getSupabaseServerClient();
  if (await nameTaken(supabase, body.name)) return NextResponse.json({ error: "There's already a profile with that name." }, { status: 409 });
  const { data, error } = await supabase.from("taste_profiles").insert(body).select("id").single();
  if (error) return writeError(error);
  return NextResponse.json({ id: data.id });
}
