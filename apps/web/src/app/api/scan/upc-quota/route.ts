import { NextResponse } from "next/server";
import { requireScanSecret } from "@/lib/scanAuth";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { getUpcQuotaStatus } from "@danflix/backend";

/**
 * Reports today's tracked UPCitemdb usage - added 2026-09-19 so PendingScansScreen can show a
 * quota progress bar (per the user's own request), same idea as the Amazon quota bar on
 * AutoEstimatedDetailScreen but for the barcode-scanning pipeline's own lookup provider.
 * Read-only - never spends any quota itself. Core feature, present in both the public and
 * private builds (unlike amazon-quota/route.ts, which is private-project-only).
 */
export async function POST(request: Request) {
  const authError = requireScanSecret(request);
  if (authError) return authError;

  const supabase = getSupabaseServerClient();
  const quota = await getUpcQuotaStatus(supabase);

  return NextResponse.json({ quota });
}
