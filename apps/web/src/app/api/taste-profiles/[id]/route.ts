import { NextResponse } from "next/server";
import { isProfileId } from "@/lib/catalog/tasteProfiles";
import { requireOwnerPasscode } from "@/lib/ownerAuth";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { nameTaken, readProfileBody, writeError } from "../shared";

type Params = { params: Promise<{ id: string }> };

/** Renames a taste profile and/or replaces its filters (owner passcode required). */
export async function PUT(request: Request, { params }: Params) {
  const denied = requireOwnerPasscode(request);
  if (denied) return denied;
  const { id } = await params;
  if (!isProfileId(id)) return NextResponse.json({ error: "Unknown profile." }, { status: 404 });
  const body = await readProfileBody(request);
  if (body instanceof NextResponse) return body;

  const supabase = getSupabaseServerClient();
  if (await nameTaken(supabase, body.name, id)) return NextResponse.json({ error: "There's already a profile with that name." }, { status: 409 });
  const { data, error } = await supabase.from("taste_profiles").update(body).eq("id", id).select("id");
  if (error) return writeError(error);
  if (!data?.length) return NextResponse.json({ error: "Unknown profile." }, { status: 404 });
  return NextResponse.json({ id });
}

/** Deletes a taste profile (owner passcode required). */
export async function DELETE(request: Request, { params }: Params) {
  const denied = requireOwnerPasscode(request);
  if (denied) return denied;
  const { id } = await params;
  if (!isProfileId(id)) return NextResponse.json({ error: "Unknown profile." }, { status: 404 });
  const { error } = await getSupabaseServerClient().from("taste_profiles").delete().eq("id", id);
  if (error) return writeError(error);
  return NextResponse.json({ ok: true });
}
