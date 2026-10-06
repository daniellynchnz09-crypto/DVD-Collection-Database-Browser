import type { SupabaseClient } from "@supabase/supabase-js";
import { extractImdbIdFromPage } from "@danflix/shared";

/**
 * Matching titles against the 366 Weird Movies lists (migration 0049, the user's request for
 * "Weird and Wonderful", 2026-10-06). A list entry matches a disc when their match keys are
 * equal and the release years are within one of each other. The match key is the title folded
 * to plain lowercase ASCII, "&" read as "and", punctuation dropped and a leading "The/A/An"
 * removed, so "The Cook, the Thief, His Wife & Her Lover" and "Cook the Thief His Wife and Her
 * Lover" agree. TMDb's title and original title are tried too, for foreign-language releases.
 */

export function weirdMatchKey(title: string): string {
  return title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(the|a|an) /, "");
}

type Section = "canon" | "apocrypha" | "candidate";
const SECTION_ORDER: Section[] = ["canon", "apocrypha", "candidate"];

interface TitleRow {
  unique_id: string;
  title: string;
  release_date: string | null;
  imdb_page: string | null;
  is_collection: boolean;
  weird_tag: string | null;
}

/**
 * Sets weird_tag on whichever of `uniqueIds` are on the list (all titles when null). Never
 * touches a hand-set 'similar' tag. Returns how many rows were tagged.
 */
export async function tagWeirdMovieMatches(supabase: SupabaseClient, uniqueIds: string[] | null): Promise<number> {
  const rows: TitleRow[] = [];
  for (let from = 0; ; from += 1000) {
    let q = supabase.from("titles").select("unique_id, title, release_date, imdb_page, is_collection, weird_tag");
    if (uniqueIds) q = q.in("unique_id", uniqueIds.slice(0, 500));
    const { data, error } = await q.order("unique_id").range(from, from + 999);
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as TitleRow[]));
    if (uniqueIds || !data || data.length < 1000) break;
  }
  const candidates = rows.filter((r) => !r.is_collection && r.weird_tag !== "similar");
  if (candidates.length === 0) return 0;

  const imdbIds = [...new Set(candidates.map((r) => extractImdbIdFromPage(r.imdb_page)).filter((id): id is string => !!id))];
  const meta = new Map<string, { title: string | null; original_title: string | null; release_date: string | null }>();
  for (let i = 0; i < imdbIds.length; i += 300) {
    const { data } = await supabase.from("title_metadata").select("imdb_id, title, original_title, release_date").in("imdb_id", imdbIds.slice(i, i + 300));
    for (const m of data ?? []) meta.set(m.imdb_id, m);
  }

  const keysByRow = new Map<string, { keys: Set<string>; years: number[] }>();
  for (const r of candidates) {
    const m = meta.get(extractImdbIdFromPage(r.imdb_page) ?? "");
    const keys = new Set([r.title, m?.title, m?.original_title].filter((t): t is string => !!t).map(weirdMatchKey));
    const years = [r.release_date, m?.release_date].map((d) => parseInt(d?.slice(0, 4) ?? "", 10)).filter((y) => Number.isFinite(y));
    keysByRow.set(r.unique_id, { keys, years });
  }

  const allKeys = [...new Set([...keysByRow.values()].flatMap((v) => [...v.keys]))];
  const list: Array<{ section: Section; year: number; match_key: string }> = [];
  for (let i = 0; i < allKeys.length; i += 300) {
    const { data, error } = await supabase.from("weird_movie_list").select("section, year, match_key").in("match_key", allKeys.slice(i, i + 300));
    if (error) throw new Error(error.message);
    list.push(...((data ?? []) as typeof list));
  }

  let tagged = 0;
  for (const r of candidates) {
    const { keys, years } = keysByRow.get(r.unique_id)!;
    const hits = list.filter((l) => keys.has(l.match_key) && (years.length === 0 || years.some((y) => Math.abs(y - l.year) <= 1)));
    if (hits.length === 0) continue;
    const best = SECTION_ORDER.find((s) => hits.some((h) => h.section === s))!;
    if (r.weird_tag === best) continue;
    const { error } = await supabase.from("titles").update({ weird_tag: best }).eq("unique_id", r.unique_id);
    if (error) throw new Error(error.message);
    tagged++;
  }
  return tagged;
}
