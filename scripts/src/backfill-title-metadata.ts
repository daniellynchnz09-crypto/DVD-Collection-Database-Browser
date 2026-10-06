/**
 * Backfills title_metadata/people/title_credits (supabase/migrations/0043_title_metadata.sql)
 * for every film in `titles` that has an IMDb link - TMDb details/cast/crew plus OMDb scores.
 * See Claude/TECH STACK AND ARCHITECTURE/web-app-build-plan.md.
 *
 * Scope (2026-10-06): only films with at least one `scanned` row (migration 0046) - the website
 * lists scanned rows only, so fetching the rest of the Sheet would just spend OMDb's daily
 * budget on films nobody can see yet. `--all` restores the whole-collection run, where the
 * ordering below still applies.
 *
 * Ordering (--all): films with at least one "scanner" row go first - a row referenced by a confirmed
 * pending_scans.resolved_title_id, or with a case_image_path or date_added (both only ever set
 * by the scan-confirm flow; resolved_title_id alone misses collection members, since it only
 * stores a confirm's first created row). Everything else follows in table order.
 *
 * OMDb's free tier is 1,000 requests/day, so the OMDb half stops at --omdb-budget (default
 * 950). The budget is per rolling 24h, not per run: rows whose omdb_fetched_at falls in the
 * last 24h (including scan-confirm refreshes) count against it, so re-running the same day
 * can't overspend. Resumable: ids fetched recently are skipped (TMDb within ~5 months - under
 * TMDb's 6-month cache limit; OMDb within 90 days), so just re-run daily until it reports
 * nothing left. TMDb has no meaningful daily cap and always runs for every due id.
 *
 * Dry run by default: prints the plan and fetches/shapes a few sample ids WITHOUT writing
 * (each sample spends one OMDb request). `--apply` writes.
 *
 *   npm run backfill-title-metadata -w scripts                       # dry run, 3 samples
 *   npm run backfill-title-metadata -w scripts -- --ids=tt0052357,tt1642620
 *   npm run backfill-title-metadata -w scripts -- --apply [--omdb-budget=950] [--limit=N]
 *       [--skip-tmdb] [--skip-omdb] [--force] [--bios] [--all]
 *
 * --bios also fills biography/birthday/etc. for directors and the top 5 billed cast whose
 * people row has never been fully fetched (TMDb only, one request each).
 *
 * Required env vars (scripts/.env): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
 * TMDB_READ_ACCESS_TOKEN, OMDB_API_KEY.
 */

import "dotenv/config";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { extractImdbIdFromPage } from "@danflix/shared";
import {
  fetchOmdbScores,
  fetchTmdbMetadata,
  refreshOmdbScores,
  refreshPersonDetails,
  refreshTmdbMetadata,
} from "@danflix/backend";

const PAGE_SIZE = 1000; // PostgREST's per-request row cap.
const TMDB_STALE_MS = 150 * 24 * 60 * 60 * 1000;
const OMDB_STALE_MS = 90 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const TMDB_WORKERS = 4; // Requests are still capped by the shared TMDb rate limiter.
const BIO_CAST_DEPTH = 5;

interface Args {
  apply: boolean;
  omdbBudget: number;
  limit: number | null;
  ids: string[] | null;
  sample: number;
  skipTmdb: boolean;
  skipOmdb: boolean;
  force: boolean;
  bios: boolean;
  all: boolean;
}

function parseArgs(argv: string[]): Args {
  const value = (name: string) => argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
  const intValue = (name: string, fallback: number | null) => {
    const raw = value(name);
    const n = raw === undefined ? NaN : parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  const ids = value("ids");
  return {
    apply: argv.includes("--apply"),
    omdbBudget: intValue("omdb-budget", 950) ?? 950,
    limit: intValue("limit", null),
    ids: ids ? ids.split(",").map((s) => s.trim()).filter((s) => /^tt\d+$/.test(s)) : null,
    sample: intValue("sample", 3) ?? 3,
    skipTmdb: argv.includes("--skip-tmdb"),
    skipOmdb: argv.includes("--skip-omdb"),
    force: argv.includes("--force"),
    bios: argv.includes("--bios"),
    all: argv.includes("--all"),
  };
}

/** Pages through a query builder factory until a short page comes back. */
async function fetchAll<T>(build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await build(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE_SIZE) return rows;
  }
}

interface TitleRow {
  unique_id: string;
  imdb_page: string | null;
  case_image_path: string | null;
  date_added: string | null;
}

/** Unique IMDb ids, scanner-sourced films first. */
async function loadOrderedImdbIds(supabase: SupabaseClient, all: boolean): Promise<{ ordered: string[]; priorityCount: number }> {
  const titles = await fetchAll<TitleRow>((from, to) => {
    let q = supabase.from("titles").select("unique_id, imdb_page, case_image_path, date_added").not("imdb_page", "is", null);
    if (!all) q = q.eq("scanned", true);
    return q.order("unique_id").range(from, to);
  });
  const confirmed = await fetchAll<{ resolved_title_id: string | null }>((from, to) =>
    supabase
      .from("pending_scans")
      .select("resolved_title_id")
      .eq("status", "confirmed")
      .not("resolved_title_id", "is", null)
      .order("id")
      .range(from, to)
  );
  const scannedRowIds = new Set(confirmed.map((r) => r.resolved_title_id));

  const priority = new Set<string>();
  const rest = new Set<string>();
  for (const row of titles) {
    const imdbId = extractImdbIdFromPage(row.imdb_page);
    if (!imdbId) continue;
    if (scannedRowIds.has(row.unique_id) || row.case_image_path || row.date_added) priority.add(imdbId);
    else rest.add(imdbId);
  }
  const ordered = [...priority, ...[...rest].filter((id) => !priority.has(id))];
  console.log(`titles with imdb_page: ${titles.length}; unique IMDb ids: ${ordered.length} (${priority.size} scanner-sourced first)`);
  return { ordered, priorityCount: priority.size };
}

interface ExistingMeta {
  imdb_id: string;
  tmdb_fetched_at: string | null;
  omdb_fetched_at: string | null;
}

/** Existing title_metadata freshness. Returns null if the table doesn't exist yet. */
async function loadExisting(supabase: SupabaseClient): Promise<Map<string, ExistingMeta> | null> {
  try {
    const rows = await fetchAll<ExistingMeta>((from, to) =>
      supabase.from("title_metadata").select("imdb_id, tmdb_fetched_at, omdb_fetched_at").order("imdb_id").range(from, to)
    );
    return new Map(rows.map((r) => [r.imdb_id, r]));
  } catch (err) {
    console.warn(`title_metadata not readable (${err instanceof Error ? err.message : err}) - has 0043 been applied?`);
    return null;
  }
}

const isFresh = (iso: string | null | undefined, maxAgeMs: number) => !!iso && Date.now() - new Date(iso).getTime() < maxAgeMs;

async function dryRunSamples(ids: string[], args: Args) {
  console.log(`\nDry run - fetching and shaping ${ids.length} sample id(s), nothing is written:`);
  for (const imdbId of ids) {
    console.log(`\n=== ${imdbId} ===`);
    if (!args.skipTmdb) {
      const tmdb = await fetchTmdbMetadata(imdbId);
      if (!tmdb) {
        console.log("TMDb: no match");
      } else {
        const cast = tmdb.credits.filter((c) => c.credit_type === "cast");
        const crew = tmdb.credits.filter((c) => c.credit_type === "crew");
        const nameOf = (id: number) => tmdb.people.find((p) => p.tmdb_person_id === id)?.name;
        console.log("title_metadata (TMDb):", JSON.stringify({ ...tmdb.metadata, overview: truncate(tmdb.metadata.overview) }, null, 2));
        console.log(`people: ${tmdb.people.length} rows, e.g.`, JSON.stringify(tmdb.people.slice(0, 2)));
        console.log(`title_credits: ${cast.length} cast, ${crew.length} crew`);
        console.log("  cast:", cast.slice(0, 5).map((c) => `#${c.credit_order} ${nameOf(c.tmdb_person_id)} as ${c.character}`).join("; "));
        console.log("  crew:", crew.map((c) => `${c.job}: ${nameOf(c.tmdb_person_id)}`).join("; "));
      }
    }
    if (!args.skipOmdb) {
      const omdb = await fetchOmdbScores(imdbId);
      console.log("OMDb:", JSON.stringify(omdb));
    }
  }
}

function truncate(text: string | null, max = 120): string | null {
  return text && text.length > max ? `${text.slice(0, max)}...` : text;
}

async function runPool<T>(items: T[], workers: number, fn: (item: T, index: number) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(workers, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        await fn(items[i], i);
      }
    })
  );
}

async function fillBiographies(supabase: SupabaseClient) {
  const credits = await fetchAll<{ tmdb_person_id: number; credit_type: string; job: string | null; credit_order: number | null }>((from, to) =>
    supabase
      .from("title_credits")
      .select("tmdb_person_id, credit_type, job, credit_order")
      .or(`job.eq.Director,and(credit_type.eq.cast,credit_order.lt.${BIO_CAST_DEPTH})`)
      .order("id")
      .range(from, to)
  );
  const wanted = new Set(credits.map((c) => c.tmdb_person_id));
  const done = await fetchAll<{ tmdb_person_id: number }>((from, to) =>
    supabase.from("people").select("tmdb_person_id").not("fetched_at", "is", null).order("tmdb_person_id").range(from, to)
  );
  for (const p of done) wanted.delete(p.tmdb_person_id);
  const ids = [...wanted];
  console.log(`\nBios: ${ids.length} director/top-cast people still need full details.`);
  let ok = 0;
  await runPool(ids, TMDB_WORKERS, async (id, i) => {
    if (await refreshPersonDetails(supabase, id)) ok++;
    if ((i + 1) % 100 === 0) console.log(`  bios ${i + 1}/${ids.length}`);
  });
  console.log(`Bios: ${ok}/${ids.length} saved.`);
}

async function main() {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TMDB_READ_ACCESS_TOKEN, OMDB_API_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !TMDB_READ_ACCESS_TOKEN || !OMDB_API_KEY) {
    console.error("Missing env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TMDB_READ_ACCESS_TOKEN, OMDB_API_KEY (scripts/.env).");
    process.exit(1);
  }
  const args = parseArgs(process.argv.slice(2));
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  let { ordered } = args.ids ? { ordered: args.ids } : await loadOrderedImdbIds(supabase, args.all);
  if (args.limit !== null) ordered = ordered.slice(0, args.limit);

  const existing = await loadExisting(supabase);
  const meta = existing ?? new Map<string, ExistingMeta>();
  const tmdbDue = args.skipTmdb ? [] : ordered.filter((id) => args.force || !isFresh(meta.get(id)?.tmdb_fetched_at, TMDB_STALE_MS));
  const omdbDue = args.skipOmdb ? [] : ordered.filter((id) => args.force || !isFresh(meta.get(id)?.omdb_fetched_at, OMDB_STALE_MS));
  const omdbUsedToday = [...meta.values()].filter((m) => isFresh(m.omdb_fetched_at, DAY_MS)).length;
  let omdbRemaining = Math.max(0, args.omdbBudget - omdbUsedToday);

  console.log(`TMDb due: ${tmdbDue.length}; OMDb due: ${omdbDue.length}`);
  console.log(`OMDb budget: ${args.omdbBudget}/24h, ${omdbUsedToday} already used -> ${omdbRemaining} available this run`);
  console.log(`First ids in processing order: ${ordered.slice(0, 10).join(", ")}`);

  if (!args.apply) {
    const sampleIds = args.ids ?? ordered.slice(0, args.sample);
    await dryRunSamples(sampleIds, args);
    console.log("\nDry run complete. Re-run with --apply to write.");
    return;
  }
  if (!existing) {
    console.error("Refusing to --apply: title_metadata isn't readable. Apply migration 0043 first.");
    process.exit(1);
  }

  // TMDb first - no daily cap, and it creates the rows OMDb scores land on.
  const tmdbCounts = { saved: 0, no_match: 0, error: 0 };
  await runPool(tmdbDue, TMDB_WORKERS, async (imdbId, i) => {
    const r = await refreshTmdbMetadata(supabase, imdbId);
    tmdbCounts[r.status]++;
    if ((i + 1) % 50 === 0 || i + 1 === tmdbDue.length) console.log(`  TMDb ${i + 1}/${tmdbDue.length} ${JSON.stringify(tmdbCounts)}`);
  });
  console.log(`TMDb done: ${JSON.stringify(tmdbCounts)}`);

  // OMDb sequentially, in priority order, until the budget or OMDb's own limit stops it.
  const omdbCounts: Record<string, number> = {};
  let processed = 0;
  for (const imdbId of omdbDue) {
    if (omdbRemaining <= 0) {
      console.log("OMDb daily budget reached - re-run tomorrow to continue.");
      break;
    }
    omdbRemaining--;
    const status = await refreshOmdbScores(supabase, imdbId);
    omdbCounts[status] = (omdbCounts[status] ?? 0) + 1;
    processed++;
    if (status === "limit_reached") {
      console.log("OMDb reports its request limit reached - stopping; re-run tomorrow.");
      break;
    }
    if (processed % 50 === 0) console.log(`  OMDb ${processed}/${omdbDue.length} ${JSON.stringify(omdbCounts)}`);
  }
  console.log(`OMDb done: ${processed} requested, ${omdbDue.length - processed} still due. ${JSON.stringify(omdbCounts)}`);

  if (args.bios) await fillBiographies(supabase);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
