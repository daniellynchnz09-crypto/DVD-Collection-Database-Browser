import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Resolves a freshly-typed value to an existing value already in `titles` that differs
 * only by case/whitespace (e.g. "action " vs "Action"), so the scanner-confirm flow never
 * creates a near-duplicate of a category the user already uses. Genre Location and Disk
 * Region have no fixed enum (unlike Format's FORMAT_ALIASES table in packages/shared),
 * so a live case-insensitive lookup against what's already in the collection is the only
 * thing keeping their autocomplete option lists clean over time.
 */
export async function canonicalizeValue(
  supabase: SupabaseClient,
  column: string,
  value: string | null
): Promise<string | null> {
  if (value == null) return null;
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (!trimmed) return null;

  // Escape ilike's own wildcard characters so a literal "%"/"_" in the value can't
  // accidentally match something else.
  const escaped = trimmed.replace(/[%_]/g, (m) => `\\${m}`);
  const { data } = await supabase.from("titles").select(column).ilike(column, escaped).limit(1);

  const existing = (data?.[0] as Record<string, unknown> | undefined)?.[column];
  return typeof existing === "string" ? existing : trimmed;
}
