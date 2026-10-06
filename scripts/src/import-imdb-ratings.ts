/**
 * Copies IMDb ratings and vote counts from IMDb's own free data file into title_metadata, so
 * IMDb scores never wait on OMDb's 1,000-a-day allowance (2026-10-06, the user asked for OMDb
 * credits to go further). OMDb is still the only free source of Rotten Tomatoes and Metacritic.
 *
 *   npm run import-imdb-ratings -w scripts              # dry run: counts what would change
 *   npm run import-imdb-ratings -w scripts -- --apply
 *
 * Source: https://datasets.imdbws.com/title.ratings.tsv.gz (refreshed daily by IMDb, ~8 MB,
 * "tconst  averageRating  numVotes"). IMDb licenses these files for personal, non-commercial
 * use, which this catalogue is. Only rows already in title_metadata are updated (TMDb creates
 * them), and only when the rating or vote count has changed. backfill-title-metadata runs this
 * first on every --apply, so a normal backfill keeps them current without this script.
 *
 * Required env vars (scripts/.env): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
 */

import "dotenv/config";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const RATINGS_URL = "https://datasets.imdbws.com/title.ratings.tsv.gz";
const PAGE_SIZE = 1000;

export interface ImdbRatingsResult {
  checked: number;
  changed: number;
}

/** Updates title_metadata's imdb_rating/imdb_votes from IMDb's data file. `apply: false` only counts. */
export async function importImdbRatings(supabase: SupabaseClient, apply: boolean): Promise<ImdbRatingsResult> {
  const current = new Map<string, { rating: number | null; votes: number | null }>();
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase.from("title_metadata").select("imdb_id, imdb_rating, imdb_votes").order("imdb_id").range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    for (const r of data ?? []) current.set(r.imdb_id, { rating: r.imdb_rating === null ? null : Number(r.imdb_rating), votes: r.imdb_votes });
    if (!data || data.length < PAGE_SIZE) break;
  }

  const res = await fetch(RATINGS_URL);
  if (!res.ok || !res.body) throw new Error(`${RATINGS_URL} returned ${res.status}`);
  const lines = createInterface({ input: Readable.fromWeb(res.body as import("node:stream/web").ReadableStream).pipe(createGunzip()) });

  const changes: Array<{ imdb_id: string; imdb_rating: number; imdb_votes: number }> = [];
  let checked = 0;
  for await (const line of lines) {
    const [id, ratingText, votesText] = line.split("\t");
    const have = current.get(id);
    if (!have) continue;
    checked++;
    const rating = Number(ratingText);
    const votes = Number(votesText);
    if (!Number.isFinite(rating) || !Number.isFinite(votes)) continue;
    if (have.rating !== rating || have.votes !== votes) changes.push({ imdb_id: id, imdb_rating: rating, imdb_votes: votes });
  }

  if (apply) {
    // Every id already has a row, so this upsert only ever updates these two columns.
    for (let i = 0; i < changes.length; i += 500) {
      const { error } = await supabase.from("title_metadata").upsert(changes.slice(i, i + 500), { onConflict: "imdb_id" });
      if (error) throw new Error(error.message);
    }
  }
  return { checked, changed: changes.length };
}

async function main() {
  const apply = process.argv.includes("--apply");
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error("Missing env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (scripts/.env).");
    process.exit(1);
  }
  const { checked, changed } = await importImdbRatings(createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY), apply);
  console.log(`IMDb ratings: ${checked} films found in IMDb's file, ${changed} ${apply ? "updated" : "would change"}.`);
  if (!apply) console.log("Dry run - re-run with --apply to write.");
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
