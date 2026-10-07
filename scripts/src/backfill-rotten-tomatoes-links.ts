/**
 * Fills the Sheet's empty "Rotten Tomatoes Page" cells from MDBList (2026-10-07, To Do list:
 * "47 titles have a confirmed Rotten Tomatoes score but no rotten_tomatoes_page link saved").
 *
 * Why this works where rottenTomatoes.ts couldn't: that lookup has to GUESS a slug from the
 * title (RT's robots.txt disallows /search), so irregular real slugs ("1005371-day_the_earth_
 * stood_still", "wolf_man" for The Wolf Man) were unreachable. MDBList returns each film's real
 * RT path along with its Tomatometer, batched 100 IMDb ids per request - so the whole Sheet
 * costs a handful of its 1,000 daily requests and no OMDb calls (find-missing-rotten-tomatoes.ts
 * spends one OMDb request per title).
 *
 * Rules (RESOURCES.md: the RT page column "does not apply to collections or titles that don't
 * have a rotten tomatoes score"):
 *   - only rows whose RT cell is empty/n/a, that have an IMDb link, and aren't box sets;
 *   - only when MDBList has an RT critics score for the film - a page with no score isn't linked;
 *   - every link is fetched once (plain GET of the /m/ or /tv/ page, which robots.txt allows) and
 *     kept only if it answers 200, so a wrong or dead link is never written ("wrong link is
 *     worse than no link", rottenTomatoes.ts).
 * Writes the Sheet cells and the same rows' titles.rotten_tomatoes_page in Supabase (an API
 * write to the Sheet doesn't fire its edit webhook, so Supabase is updated directly).
 *
 * Dry run by default (spends the MDBList + RT page requests, writes nothing):
 *   npm run backfill-rotten-tomatoes-links -w scripts
 *   npm run backfill-rotten-tomatoes-links -w scripts -- --apply
 *
 * Required env vars (scripts/.env): GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY,
 * GOOGLE_SHEET_ID, GOOGLE_SHEET_RANGE, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, MDBLIST_API_KEY.
 */

import "dotenv/config";
import { google } from "googleapis";
import { createClient } from "@supabase/supabase-js";
import { buildColumnIndexes, cleanCell, columnLetter, extractImdbIdFromPage, toBoolean } from "@danflix/shared";
import { fetchMdblistAudienceScores, MDBLIST_BATCH_SIZE, type MdblistMediaType, type MdblistScores } from "@danflix/backend";

const TV_KINDS = /tv series|mini-series|miniseries/i;
const PAGE_CHECK_GAP_MS = 400; // one RT page at a time, politely spaced

interface Candidate {
  sheetRow: number; // 1-indexed Sheet row
  uniqueId: string | null;
  title: string;
  imdbId: string;
  mediaType: MdblistMediaType;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchScores(ids: string[], mediaType: MdblistMediaType): Promise<Map<string, MdblistScores>> {
  const found = new Map<string, MdblistScores>();
  for (let i = 0; i < ids.length; i += MDBLIST_BATCH_SIZE) {
    const batch = ids.slice(i, i + MDBLIST_BATCH_SIZE);
    let result = await fetchMdblistAudienceScores(batch, mediaType);
    // MDBList's gateway occasionally answers 502/503 (seen 2026-10-07); two spaced retries.
    for (let attempt = 1; attempt <= 2 && result.status === "error" && /HTTP 5\d\d/.test(result.message); attempt++) {
      await sleep(5_000 * attempt);
      result = await fetchMdblistAudienceScores(batch, mediaType);
    }
    if (result.status !== "ok") throw new Error(`MDBList ${mediaType} batch failed: ${result.status === "error" ? result.message : "daily limit reached"}`);
    for (const [id, s] of result.scores) found.set(id, s);
  }
  return found;
}

async function pageAnswers(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { redirect: "follow", headers: { "user-agent": "Mozilla/5.0 (DANFLIX collection link check)" } });
    return res.status === 200 && /^https:\/\/www\.rottentomatoes\.com\/(m|tv)\//.test(res.url);
  } catch {
    return false;
  }
}

async function main() {
  const apply = process.argv.includes("--apply");
  const env = process.env;
  for (const name of ["GOOGLE_SERVICE_ACCOUNT_EMAIL", "GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY", "GOOGLE_SHEET_ID", "GOOGLE_SHEET_RANGE", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "MDBLIST_API_KEY"]) {
    if (!env[name]) {
      console.error(`Missing ${name} (scripts/.env).`);
      process.exit(1);
    }
  }

  const auth = new google.auth.JWT({
    email: env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY!.replace(/\\n/g, "\n"),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const sheets = google.sheets({ version: "v4", auth });
  const sheetTabName = env.GOOGLE_SHEET_RANGE!.split("!")[0];
  const { data } = await sheets.spreadsheets.values.get({ spreadsheetId: env.GOOGLE_SHEET_ID, range: env.GOOGLE_SHEET_RANGE });
  const [header, ...rows] = (data.values ?? []) as string[][];
  const col = buildColumnIndexes(header ?? []);
  for (const key of ["title", "imdb_page", "rotten_tomatoes_page", "unique_id"]) {
    if (col[key] === undefined) throw new Error(`Sheet has no column for ${key}.`);
  }

  const candidates: Candidate[] = [];
  rows.forEach((row, i) => {
    if (cleanCell(row[col["rotten_tomatoes_page"]])) return;
    if (col["is_collection"] !== undefined && toBoolean(row[col["is_collection"]])) return;
    const imdbId = extractImdbIdFromPage(cleanCell(row[col["imdb_page"]]));
    if (!imdbId) return;
    const kind = col["movie_or_tv"] !== undefined ? (row[col["movie_or_tv"]] ?? "") : "";
    candidates.push({
      sheetRow: i + 2,
      uniqueId: cleanCell(row[col["unique_id"]]),
      title: cleanCell(row[col["title"]]) ?? "(untitled)",
      imdbId,
      mediaType: TV_KINDS.test(kind) ? "show" : "movie",
    });
  });
  const ids = (type: MdblistMediaType) => [...new Set(candidates.filter((c) => c.mediaType === type).map((c) => c.imdbId))];
  console.log(`Sheet rows without an RT link (not box sets, with an IMDb link): ${candidates.length} (${ids("movie").length} movie ids, ${ids("show").length} show ids)`);

  // Ask each endpoint for its own ids, then retry the misses on the other one (a TV movie or a
  // mislabelled row can live under either).
  const scores = new Map<string, MdblistScores>();
  for (const type of ["movie", "show"] as const) for (const [id, s] of await fetchScores(ids(type), type)) scores.set(id, s);
  for (const type of ["movie", "show"] as const) {
    const other: MdblistMediaType = type === "movie" ? "show" : "movie";
    const missed = ids(type).filter((id) => !scores.has(id));
    for (const [id, s] of await fetchScores(missed, other)) scores.set(id, s);
  }

  const linkFor = new Map<string, string>();
  const noScore: string[] = [];
  const dead: string[] = [];
  const toCheck = [...new Set(candidates.map((c) => c.imdbId))];
  for (const imdbId of toCheck) {
    const s = scores.get(imdbId);
    if (!s?.rottenTomatoesUrl) continue;
    if (s.criticsScore === null) {
      noScore.push(imdbId);
      continue;
    }
    if (await pageAnswers(s.rottenTomatoesUrl)) linkFor.set(imdbId, s.rottenTomatoesUrl);
    else dead.push(`${imdbId} ${s.rottenTomatoesUrl}`);
    await sleep(PAGE_CHECK_GAP_MS);
  }

  const fills = candidates.filter((c) => linkFor.has(c.imdbId));
  console.log(`\nLinks found and checked: ${linkFor.size} films -> ${fills.length} Sheet rows`);
  console.log(`Skipped: ${noScore.length} with an RT page but no critics score; ${dead.length} links that didn't answer 200`);
  for (const d of dead) console.log(`  dead: ${d}`);
  for (const f of fills) console.log(`  row ${f.sheetRow}: ${f.title} -> ${linkFor.get(f.imdbId)}`);

  if (!apply) {
    console.log("\nDry run - nothing written. Re-run with --apply.");
    return;
  }
  if (!fills.length) return;

  const letter = columnLetter(col["rotten_tomatoes_page"]);
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: env.GOOGLE_SHEET_ID,
    requestBody: {
      valueInputOption: "RAW",
      data: fills.map((f) => ({ range: `${sheetTabName}!${letter}${f.sheetRow}`, values: [[linkFor.get(f.imdbId)!]] })),
    },
  });
  console.log(`Wrote ${fills.length} Sheet cells.`);

  const supabase = createClient(env.SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!);
  let updated = 0;
  for (const f of fills) {
    if (!f.uniqueId) continue;
    const { error } = await supabase.from("titles").update({ rotten_tomatoes_page: linkFor.get(f.imdbId) }).eq("unique_id", f.uniqueId).is("rotten_tomatoes_page", null);
    if (error) console.warn(`  Supabase update failed for ${f.title}: ${error.message}`);
    else updated++;
  }
  console.log(`Updated ${updated} rows in Supabase.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
