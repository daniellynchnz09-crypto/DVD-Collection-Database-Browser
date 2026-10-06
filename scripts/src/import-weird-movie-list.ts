/**
 * Loads the 366 Weird Movies lists into `weird_movie_list` and tags the collection's titles
 * (migration 0049) - the home page's "Weird and Wonderful" row comes from these tags.
 *
 *   npm run import-weird-movie-list -w scripts              # dry run
 *   npm run import-weird-movie-list -w scripts -- --apply
 *
 * Source: https://366weirdmovies.com/the-weird-movie-list/ - its index page lists the Canonical
 * 366, the Apocrypha (just missed the Canon) and the Apocrypha Candidates (the shortlist still
 * under consideration) as "Title [Alt title] (year)" lines. The Capsules section after them is
 * everything else the site has reviewed, weird or not, so it's left out.
 *
 * SIMILAR_PICKS are titles in the collection that aren't on the lists but are comparably weird
 * in plot and aesthetic, judged by hand on 2026-10-06 against the user's scanned titles (the
 * user asked for both). They're tagged 'similar'; list matching never overwrites that.
 *
 * Re-run occasionally to pick up list changes. New scans are tagged at confirm time.
 * Required env vars (scripts/.env): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { tagWeirdMovieMatches, weirdMatchKey } from "@danflix/backend";

const SOURCE_URL = "https://366weirdmovies.com/the-weird-movie-list/";

const SIMILAR_PICKS: Array<{ title: string; year: number; why: string }> = [
  { title: "The Elephant Man", year: 1980, why: "David Lynch - nightmarish dream sequences; Lynch has six Canon films" },
  { title: "One from the Heart", year: 1982, why: "Coppola's artificial, neon, all-studio dream musical" },
  { title: "All That Jazz", year: 1979, why: "Hallucinatory death fantasies - Fosse's answer to the Canon's 8 1/2" },
  { title: "Bride of the Monster", year: 1955, why: "Ed Wood - the Canon has his Glen or Glenda" },
  { title: "Bride of Frankenstein", year: 1935, why: "Camp expressionism and tiny people in jars - kin to the Canon's The Black Cat (1934)" },
  { title: "Confessions of a Dangerous Mind", year: 2002, why: "Charlie Kaufman's slippery, surreal reality - the Canon has Being John Malkovich and Adaptation." },
  { title: "Jodorowsky's Dune", year: 2013, why: "The weirdest film never made, by the director of the Canon's El Topo and The Holy Mountain" },
];

type Section = "canon" | "apocrypha" | "candidate";
const SECTION_STARTS: Array<[RegExp, Section | null]> = [
  [/^THE CANONICAL LIST OF 366/i, "canon"],
  [/^APOCRYPHA \(alternates/i, "apocrypha"],
  [/^APOCRYPHA CANDIDATES/i, "candidate"],
  [/^CAPSULES$/i, null],
];

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

async function loadList() {
  const res = await fetch(SOURCE_URL, { headers: { "User-Agent": "Mozilla/5.0 (DANFLIX personal catalogue)" } });
  if (!res.ok) throw new Error(`${SOURCE_URL} returned ${res.status}`);
  const html = await res.text();
  const text = decodeEntities(html.replace(/<br\s*\/?>|<\/p>|<\/li>|<\/h\d>|<\/div>/gi, "\n").replace(/<[^>]+>/g, ""));
  const out = new Map<string, { section: Section; title: string; alt_titles: string[]; year: number; match_key: string }>();
  let section: Section | null = null;
  let started = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const start = SECTION_STARTS.find(([re]) => re.test(line));
    if (start) {
      section = start[1];
      started = true;
      if (!section) break;
      continue;
    }
    if (!started || !section) continue;
    const m = line.match(/^(?:\d+\.\s*)?(.+?)\s*\((\d{4})[^)]*\)/);
    if (!m) continue;
    const title = m[1].replace(/\s*\[[^\]]*\]/g, "").replace(/^[“"]|[”"]$/g, "").trim();
    const alt_titles = [...m[1].matchAll(/\[(?:AKA\s+)?([^\]]+)\]/g)].map((a) => a[1].trim());
    const year = Number(m[2]);
    const key = `${title}|${year}`;
    if (!out.has(key)) out.set(key, { section, title, alt_titles, year, match_key: weirdMatchKey(title) });
    // Alternate titles get their own match rows, so a foreign-language release still matches.
    for (const alt of alt_titles) {
      const altKey = `${alt}|${year}`;
      if (!out.has(altKey)) out.set(altKey, { section, title: alt, alt_titles: [title], year, match_key: weirdMatchKey(alt) });
    }
  }
  return [...out.values()];
}

async function main() {
  const apply = process.argv.includes("--apply");
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error("Missing env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (scripts/.env).");
    process.exit(1);
  }
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const list = await loadList();
  const counts = list.reduce<Record<string, number>>((c, l) => ({ ...c, [l.section]: (c[l.section] ?? 0) + 1 }), {});
  console.log(`Parsed ${list.length} list rows (alternate titles included):`, counts);
  if (!counts.canon || counts.canon < 300) throw new Error("The Canon section didn't parse - has the page layout changed?");
  if (!apply) {
    console.log("Dry run - re-run with --apply to write the list and tag titles.");
    return;
  }

  for (let i = 0; i < list.length; i += 500) {
    const { error } = await supabase.from("weird_movie_list").upsert(list.slice(i, i + 500), { onConflict: "title,year" });
    if (error) throw new Error(error.message);
  }
  const tagged = await tagWeirdMovieMatches(supabase, null);
  console.log(`Tagged ${tagged} titles from the lists.`);

  for (const pick of SIMILAR_PICKS) {
    const { data, error } = await supabase
      .from("titles")
      .update({ weird_tag: "similar" })
      .ilike("title", pick.title)
      // Wide window: the Sheet often holds the disc's release date rather than the film's.
      .gte("release_date", `${pick.year - 3}-01-01`)
      .lte("release_date", `${pick.year + 3}-12-31`)
      .is("weird_tag", null)
      .select("unique_id");
    if (error) throw new Error(error.message);
    console.log(`  similar: ${pick.title} (${pick.year}) - ${data?.length ?? 0} row(s)`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
