> Measured 2026-10-09 (after this report was written): private Supabase storage 524 MB of 1 GB (case-images 92 files / 181.5 MB, avg 2.0 MB; retail-product-images 1,501 / 326.8 MB; cover-scan-staging 12.6 MB; poster-images 2.6 MB); database 144 MB; public project 11 MB, no titles. Cover uploads now save at JPEG 0.7 full resolution (re-compressed further if over ~4 MB base64), but stored case images are still re-encoded full size at quality 88. The user asked to keep photo dimensions, so storage options are pending their decision. Web version: https://claude.ai/artifact/D55PVSEvbXorDDkHL5iSu7

# DANFLIX 5.0: Rate limits, quotas and what to do about them

*Written 2026-10-09. All limit pages below were checked on 2026-10-09 unless marked otherwise. This was read-only research: no code was changed, and no paid or rate-limited API was called. Secret values are referred to by variable name only.*

---

## Read this first: the five things that matter most

1. **The background jobs in `apps/web/instrumentation.ts` will not work on Vercel.** These are the scan resolver every 15 seconds, the hourly TMDb refresh and the 30-minute Estimated Value refresh. On Vercel they won't run on a schedule. Worse, they may start up inside random copies of the server and run at the same time, which can spend the same UPC lookup twice. Vercel Hobby only allows cron jobs **once per day**. They need a replacement before deploying (see Deployment blockers).
2. **Cover photos are too big for Vercel.** The phone sends full-resolution photos (`quality: 0.9`, base64) through `/api/scan/cover-photo`. Vercel rejects any request body over **4.5 MB**, and a typical phone photo encoded this way is about 4 to 7 MB. Most cover-photo uploads would fail with a "413 payload too large" error.
3. **The GitHub Actions scan backstop (`resolve-scans.yml`, every 5 minutes) almost certainly uses more free GitHub minutes than you have.** The repo is private. A free account gets 2,000 minutes a month. Every 5 minutes is 8,640 runs a month, and each run costs at least 1 minute. When the minutes run out, GitHub blocks all workflows, including the **Supabase keep-alive**, so the public Supabase project could then be paused.
4. **UPCitemdb's free tier has a burst limit of 6 lookups per minute, not just 100 per day.** The resolver can fire up to 20 lookups in one batch. When UPCitemdb refuses one, the code treats it as "this barcode has no listing", so the scan quietly falls back to cover-only or "needs manual". Real barcode data is lost without any warning.
5. **Full-resolution case photos will fill Supabase's 1 GB free storage** well before the whole collection is scanned. They also burn through Vercel's 5,000 free image conversions a month and Supabase's 5 GB free download allowance. Shrinking each photo once, when it's saved, fixes all three problems.

---

## 1. Summary table

"Normal day" = a few dozen scans. "Box set" = one confirm with about 10 titles. "Backfill" = a whole-collection run over about 3,000 titles or about 1,600 IMDb ids.

| Service | Free limit | Our expected usage (normal day / box set / full backfill) | Risk | One-line fix |
|---|---|---|---|---|
| **Google Gemini** (cover reading, crop boxes, format) | Counted per model, per Google Cloud *project*: about 500/day on `gemini-flash-lite-latest` and about 500/day on `gemini-3.1-flash-lite` (taken from Google's own 429 errors in our logs). Per-minute limit is about 15 (unofficial). Gemma limits aren't published. | ~120-150 / ~4-6 / ~12,000 (front+back photo re-read) or ~3,000 (recrop only) | **Medium** (backfill and bursts) | Space out Gemini calls (≤10/minute) and leave a scan "pending" instead of "no answer" when every model is out; spread backfills over days. |
| **UPCitemdb** (barcode lookup) | 100/day **and 6/minute** (free) | ~30-40 / 1 / ~3,000 | **High** | Pace lookups to ≤5/min, check the remaining quota first, and keep unlooked-up scans pending instead of marking them "no listing". |
| **OMDb** | 1,000/day (free) | ~150-400 / ~10-25 / 950 per day (by budget) | **Medium** | Become a $1/month Patreon supporter (100,000/day). This is the cheapest single fix in this report. |
| **TMDb** | About 40 requests/second; cache data no longer than 6 months | ~100-300 / ~20-40 / ~10,000+ spread out | **Low** for rate, **Medium** for the 6-month rule once deployed | Replace the hourly refresh with a daily Vercel cron that refreshes ~50 titles a day. |
| **MDBList** (RT audience score) | 1,000/day (free, per our own docs; not published on MDBList's site) | ~1-5 / 1-2 / ~20-40 | **Low** | Nothing needed. €1.20/month gives 10,000/day if ever needed. |
| **Google Sheets API** | 60 reads + 60 writes per minute per user (our service account counts as one user); 300/min per project; no daily cap | ~3-7 calls per single confirm / ~25-50 per box set / sync script only | **Medium** (two box sets in one minute) | Write a box set's rows in one `batchUpdate` call instead of 2-3 calls per title. |
| **Vercel Hobby** | 300 s per function call; **4.5 MB body**; 1M invocations; 100 GB bandwidth; 4 CPU-hours; **5,000 image conversions/month**; cron **once a day** | n/a | **High** (blockers) | Fix the uploads, background jobs and image URLs before deploying (see section 3). |
| **Supabase Free** | 500 MB database; **1 GB file storage**; 5 GB downloads/month; pauses after 7 days idle; only 2 active free projects | Database ~120-200 MB (estimate); storage grows ~1-2.5 MB per scanned case (estimate) | **High** for storage, **Low** for database | Resize case photos to about 1,000 px (~150 KB) when saving them. |
| **GitHub Actions** (keep-alive, resolve-scans) | 2,000 min/month on private repos (free); blocked when used up | ≥8,640 min/month (resolve-scans) + ~30 (keep-alive) | **High** | Drop `resolve-scans.yml` or run it hourly at most; move scheduling to Supabase Cron. |
| **eBay Browse API** | 5,000 calls/day | ~2-40 / ~1-10 / n/a (no sweeps) | **Low** | Nothing needed. |
| **RapidAPI Amazon** (3 providers) | 100/month each, hard-capped (per our own Sept 2026 check) | Manual button only | **Low** | Keep it manual. |
| **Retail sites** (JB Hi-Fi etc.) | No official limit; our own 5-15 s gap per request | 15 sites × each priced title | **High on Vercel** (too slow for 300 s) | Run pricing from a scheduled job (GitHub Action or local), not inside the confirm request. |
| **Rotten Tomatoes pages** | No published limit; robots.txt allows `/m/` pages | ~0-30 / ~10 / ~3,000 at 400 ms gaps | **Low** | Keep the polite gap; expect some blocks from Vercel's servers. |
| **Wikidata SPARQL** | 60 s of query time per minute per client; 5 parallel; 30 errors/min | A handful | **Low** | Nothing needed. |
| **IMDb datasets** | No rate limit; personal non-commercial use only | 1 download of ~8 MB per backfill | **Low** | Nothing needed. |

---

## 2. Service by service

### 2.1 Google Gemini API

**The limit**
- Free limits are counted **per model and per Google Cloud project, not per API key**. Daily counts reset at midnight Pacific time. Source: https://ai.google.dev/gemini-api/docs/rate-limits (checked 2026-10-09). The official page no longer prints per-model numbers; it sends you to the AI Studio rate-limit page, which needs a login.
- The code uses `gemini-flash-lite-latest` (currently Gemini 3.5 Flash-Lite), then `gemini-3.1-flash-lite`, then `gemma-4-26b-a4b-it` (`packages/backend/src/geminiRequest.ts`, line 23). It can be overridden with the `GEMINI_MODELS` variable.
- **Requests per day:** Google's own 429 error, recorded in our code comments on 2026-10-06, said `limit: 500` for 3.5 Flash-Lite. Third-party guides disagree: some say 3.1 Flash-Lite gets 500/day, others 1,000/day, with about 15 per minute and 250,000 tokens per minute (e.g. https://tinkerllm.com/blog/gemini-api-free-tier-limits-rate-quotas/, https://www.scriptbyai.com/gemini-api-free-tier-limits/, checked 2026-10-09). **Treat the per-minute number (≈15) as unverified.** Google changed free quotas several times in late 2025 and 2026.
- **Gemma 4:** free, with no published limits.
- **Paid prices** (https://ai.google.dev/gemini-api/docs/pricing, checked 2026-10-09):
  - 3.5 Flash-Lite: $0.30 per million input tokens and $2.50 per million output tokens.
  - 3.1 Flash-Lite: $0.25 in and $1.50 out.
  - On the free tier, Google may use your prompts (your cover photos) to improve its products. That's harmless for disc covers, but worth knowing.

**Where we call it**
- `packages/backend/src/geminiRequest.ts`: every call goes through here.
- `packages/backend/src/coverVision.ts` (cover read, orientation + crop box) and `formatVision.ts` (format banner).
- `packages/backend/src/listingTextExtract.ts`, called from `scanResolver.ts` lines 422-427.
- `scripts/src/backfill-recrop-case-images.ts` and `repair-case-image-rotation.ts`.

**How close we come**
- A front+back cover scan costs 4 requests (2 per photo). Up to 2 more come from format vision and listing text. A few dozen scans a day is about 120-150 requests, well under the ~1,000+ a day the two Flash-Lite models give together.
- **Bursts are the problem.** The resolver takes up to 20 scans per batch (`RESOLVE_BATCH_LIMIT`). Twenty cover scans at about 4 requests each means about 80 requests in a few minutes, well above about 15 per minute per model.
- A whole-collection cover re-read (~3,000 cases × 4) is about 12,000 requests, roughly 10-12 days of free allowance.

**What breaks**
- When every model in the chain returns 429, `generateGeminiJson` returns `null`. Callers treat that as "no answer".
- The scan then resolves **without its cover reading**: no title guess, no crop, no rotation. It lands in "needs manual review", or the case photo is saved uncropped and sideways.
- Nothing tells you this was a quota problem rather than an unreadable photo.

**What already protects us**
- The model chain with per-model `skipUntil` back-off, honouring Google's `retryDelay` (`geminiRequest.ts`, lines 25-61).
- Rotation and crop were merged into one request (2026-10-06 change in `barcode-scanning-pipeline.md`).
- Gaps:
  - The `skipUntil` memory lives inside one running server process. On Vercel each new server copy starts with no memory and retries a used-up model again. This wastes time but not quota.
  - The quota is shared by the project. The local dev server, the GitHub Action (which has `GEMINI_API_KEY`) and Vercel all draw from the same pool.

**Recommendations (best first)**
1. *Free:* add a shared Gemini pacer (the existing `createRateLimiter` in `packages/backend/src/metadata/rateLimit.ts`) at about 10 requests per 60 s.
2. *Free:* when every model returns 429, leave the scan `pending` so it's retried later. Don't save it as "no answer". This needs a different return value from `generateGeminiJson`, e.g. `{ status: "quota" }`.
3. *Free:* split big backfills (`backfill-recrop-case-images`) into daily chunks of about 800, the way the OMDb backfill already uses `--omdb-budget`.
4. *Paid:* turn on billing for the Google Cloud project (pay-as-you-go). At Flash-Lite prices, a cover photo (~1,500 image tokens + prompt, ~200 output tokens) costs roughly US$0.001. A 12,000-request backfill would be roughly **US$10-15** (estimate). Set a budget alert in Google Cloud. Note: turning on billing moves that project off the free tier for that model.

---

### 2.2 UPCitemdb

**The limit**
- Free ("trial") tier: **100 requests a day combined, and at most 6 lookups per minute** (searches 2 per 30 s). Source: https://www.upcitemdb.com/wp/docs/main/development/api-rate-limits/ (checked 2026-10-09). This page says searches are capped at 40/day. The plan page (https://www.upcitemdb.com/wp/docs/main/development/plan/) says 20/day. We only use lookups, so it doesn't matter.
- **Paid tiers:**
  - DEV: 20,000 lookups and 2,000 searches a day, burst 15 lookups per 30 s.
  - PRO: 150,000 lookups a day, burst 12 per second.
  - Overage is billed for usage above the plan.
  - **Prices aren't shown on any public page I could reach.** From memory (unverified), DEV was about US$99/month and PRO about US$699/month. Ask UPCitemdb before deciding.

**Where we call it**
- `packages/shared/src/upc.ts`, line 44 (`/prod/trial/lookup`), called only from `packages/backend/src/scanResolver.ts`, line 353.
- Usage is recorded from UPCitemdb's own response headers into `upc_quota_status` (`packages/backend/src/upcQuota.ts`) and shown as a progress bar.

**How close we come**
- A few dozen barcode scans a day is about 30-40 lookups (fine). A box set is 1 lookup.
- A barcode backfill of ~3,000 discs takes **30+ days** on the free tier.
- **The per-minute cap is the real danger.** A batch of 20 barcode-only scans is processed one after another, a few seconds apart, so lookups 7-20 in that minute get refused.

**What breaks**
- `upcLookup` returns `product: null` for **any** non-OK response, including a 429 (`upc.ts`, line 46).
- The resolver then takes the "no barcode listing" branch (`scanResolver.ts`, lines 359-384). The scan becomes `needs_manual` (or uses the cover photo) and is **never retried**.
- What you'd see: a run of scans saying "UPC lookup failed / no listing found" for barcodes that do exist in UPCitemdb. This happens after the 6th scan in a minute, or after the 100th of the day.

**Duplicate spending**
- The resolver picks rows with `status = 'pending'` and doesn't "claim" them first.
- If the local poller, the GitHub Action and (later) a Vercel copy run at the same time, two of them can process the same row and pay for the same lookup twice.
- This is the cross-process version of the 2026-09-30 bug fixed in `instrumentation.ts`.

**What already protects us**
- Scanning and lookup are decoupled.
- The `setTimeout`-after-completion fix stops one process overlapping itself.
- The quota bar shows the real remaining count.
- The comment block in `instrumentation.ts` explains the 100/day reasoning.

**Recommendations (best first)**
1. *Free:* tell a 429 apart from "not found" in `upc.ts`. On a 429, leave the scan `pending` and stop the batch.
2. *Free:* pace lookups to one every ~11 s (≤5/min) with `createRateLimiter(5, 60_000)`.
3. *Free:* read `upc_quota_status` before each lookup. If `remaining` is 0 and the reset hasn't passed, skip barcode lookups until then.
4. *Free:* claim rows atomically before processing, e.g. `update pending_scans set status='processing' where id=… and status='pending'` and only continue if a row came back. Add a timeout that resets stale `processing` rows.
5. *Free:* keep a `barcode → product` cache table, so re-scans and second copies never pay again.
6. *Paid:* the DEV plan only if you plan a fast whole-collection barcode backfill. Otherwise 100/day is enough for steady use.

---

### 2.3 OMDb

**The limit**
- Free key: **1,000 requests a day**. Source: https://www.omdbapi.com/apikey.aspx (checked 2026-10-09).
- Paid tiers are Patreon pledges: about **US$1/month for 100,000/day** and about US$5/month for 500,000/day.
  - The amounts come from a third-party summary (https://apispine.com/open-movie-database/pricing, checked 2026-10-09).
  - The Patreon page itself (https://www.patreon.com/omdb) shows tiers "starting at NZD2/month" but didn't show the request limits to my fetch. **Partly unverified; confirm on Patreon.**

**Where we call it**
- `packages/shared/src/omdb.ts`: `omdbSearch` and `omdbGetById`, with 1-hour in-memory caches.
- `packages/backend/src/scanResolver.ts`: one search per scan, plus up to 10 detail calls in `enrichAndNarrowCandidates` (lines 53-77).
- `apps/web/src/app/api/scan/confirm/route.ts`: about 1-2 detail calls per entry, lines 464 and 488.
- `packages/backend/src/metadata/omdbScores.ts`: limiter of 10/s.
- `scripts/src/backfill-title-metadata.ts`: `--omdb-budget` defaults to 950 per rolling 24 h.

**How close we come**
- Each scan uses 1 search + 0-10 details, and its confirm uses 1-2 more. A few dozen scans comes to about 150-400 a day.
- **On a backfill day, the backfill uses 950 of the 1,000.** Scanning that same day runs out almost immediately.

**What breaks**
- OMDb answers "Request limit reached!".
- In the resolver, the search returns no candidates and the scan goes to "needs manual".
- At confirm time the entry is saved without OMDb fields: plot, director, cast, RT link. The website shows no IMDb, RT or Metacritic scores for it until the next refresh.

**What already protects us**
- The rolling-24 h budget in the backfill.
- `import-imdb-ratings` takes IMDb scores off OMDb entirely.
- Detail and search caches (`omdb.ts`, lines 71-120). Note these are in-memory, so on Vercel they only help within one server copy.
- Confirm passes `omdbDetailById` on to the metadata step so it doesn't refetch.
- The 10-candidate cap in `enrichAndNarrowCandidates`.

**Recommendations (best first)**
1. *Paid, cheap:* the **US$1/month Patreon tier (100,000/day)** removes this limit for good. It's the best value fix in this report.
2. *Free:* run backfills with a lower budget (e.g. `--omdb-budget=600`) on days you plan to scan.
3. *Free:* call `enrichAndNarrowCandidates` only when there's a real tie (`duplicateIds`), not for every candidate whenever `metaText` exists.

---

### 2.4 TMDb

**The limit**
- About **40 requests a second**. TMDb says this "could change at any time" and asks you to respect any 429. Source: https://developer.themoviedb.org/docs/rate-limiting (checked 2026-10-09).
- **Terms of use:** you may not "Cache, for longer than 6 months, any information obtained through or from TMDB". You must show TMDb's logo plus the "uses TMDB… but is not endorsed" notice. Non-commercial use only. Source: https://www.themoviedb.org/api-terms-of-use (checked 2026-10-09).

**Where we call it**
- `packages/backend/src/tmdb.ts`: confirm-time lookups, 10-minute cache, and `refreshTmdbFields` (5-month refresh).
- `packages/backend/src/metadata/tmdbMetadata.ts`: limiter of 40 per 10 s, one retry on 429.
- `apps/web/src/app/api/scan/confirm/route.ts`, line 395: 4 at a time (`TMDB_LOOKUP_CONCURRENCY`).
- `apps/web/src/app/api/scan/tmdb-preview/route.ts`.
- Scripts: `refresh-tmdb*.ts` and `backfill-title-metadata.ts`.

**How close we come**
- A box set is about 20-40 requests, 4 at a time. That's far under 40/s.
- The backfill is limited to 4/s by our own code.
- The image CDN (`image.tmdb.org`) is used directly and `unoptimized`, which is fine.

**What breaks**
- Speed: a 429 in `tmdbFetch` reads as "no match". The entry is saved without its TMDb id, rating or studio (as noted in the comment at `confirm/route.ts`, lines 391-394).
- **The 6-month rule:** `refreshTmdbFields` is only run by the `instrumentation.ts` hourly loop or by hand, and that loop won't run on Vercel. `title_metadata` (cast, crew, posters) is only refreshed when someone runs `backfill-title-metadata`. Without a scheduled job, data would quietly pass the 6-month limit, which breaks TMDb's terms.

**What already protects us**
- The limiters, the 5-month refresh window and the 10-minute cache.
- The attribution text in `apps/web/src/components/title/TitlePageShell.tsx`. Check that the TMDb **logo** is shown too.

**Recommendations**
1. *Free:* a daily scheduled job (Vercel cron is allowed once a day on Hobby) that refreshes about **50 overdue titles a day**.
   - 3,000 titles ÷ 150 days = 20 a day minimum. The current batch of 20 leaves no slack.
   - Include `title_metadata` / credits rows in the same job, not just the `titles` columns.
2. *Free:* show the TMDb logo next to the notice.

---

### 2.5 MDBList

**The limit**
- Free key: **1,000 requests/day**. This is our own earlier finding (`web-app-build-plan.md`, line 133, from 2026-10-07). MDBList's API docs page (https://api.mdblist.com/docs/) didn't load for me, so **the free number is unverified today**.
- Supporter tiers (https://mdblist.memberful.com/join, checked 2026-10-09), per day:

| Tier | Price | Requests/day |
|---|---|---|
| Basic | €1.20/mo or €10/yr | 10,000 |
| Standard | €2/mo | 25,000 |
| Plus | €3/mo | 100,000 |
| VIP | €5-€20/mo | 250,000-1,500,000 |

- **Batch counting is unverified.** Our code assumes one POST with up to 100 IMDb ids counts as 1 request (`mdblistScores.ts`, lines 5-8 and 15). I couldn't confirm this from MDBList's docs. If MDBList counts per id, a full backfill is about 1,600 "requests", still fine over two days.

**Where we call it**
- `packages/backend/src/metadata/mdblistScores.ts`: limiter of 5/s, `limit_reached` on 429.
- `packages/backend/src/metadata/index.ts`: one batch per confirm.
- `scripts/src/backfill-rotten-tomatoes-links.ts` and `backfill-title-metadata.ts`.

**How close we come:** about 1-5 a day, and about 20-40 for a full backfill. Nowhere near the limit.

**What breaks:** RT audience scores are missing until the next run. The rest of the page is fine.

**Recommendations**
1. Nothing needed.
2. *Small security tidy-up:* the key goes in the URL query string (`?apikey=`, line 73). If MDBList accepts it as a header, move it there, as was done for Gemini.

---

### 2.6 Google Sheets API

**The limit:** for reads and for writes separately, **60 per minute per user per project** and 300 per minute per project. There's **no daily limit**. Going over gives a 429, and Google recommends exponential back-off. Source: https://developers.google.com/workspace/sheets/api/limits (checked 2026-10-09). Our service account counts as **one user**, so 60/min is the number that matters.

**Where we call it**
- `apps/web/src/lib/googleSheets.ts`
- `apps/web/src/app/api/scan/confirm/route.ts`
- `apps/web/src/lib/estimatedValueSheetSync.ts`
- `scripts/src/sync-sheet.ts` and many `backfill-*` scripts.

**Calls per confirm (counted from the code)**

| Step | Reads | Writes |
|---|---|---|
| Header row (`getSheetHeaderAndColumns`) | 1 | 0 |
| Each **new** title (`appendRowToSheet`: read column A, then write the row) | 1 | 1 |
| Each **overwrite** (`updateSheetFieldsByUniqueId`: read id column, read row, write) | 2 | 1 |
| Letterboxd match patch, per matched new title (private build) | 2 | 1 |
| Last-watched sync, per sibling copy updated | 2 | 1 |
| Estimated Value push (header + per priced row) | 1 + 2/row | 1/row |

- **Single new title:** 2 reads + 1 write = 3 calls. With Letterboxd and Estimated Value extras, up to about 7-10.
- **Box set of 10 + header row (11 rows):** 12 reads + 11 writes = 23 calls on the main path. If most members match Letterboxd, add up to 22 reads + 11 writes, for a total of about **35-55 calls within a minute or two**.
- **Two box sets confirmed back to back can pass 60 reads a minute.**

**What breaks**
- A 429 from Sheets.
- The googleapis client retries 429s on GET/PUT a few times by default (gaxios defaults; not checked against the current version).
- If it still fails, the confirm's **all-or-nothing journal** (`confirm/route.ts`, lines 985-990) undoes the database writes and keeps the scan pending. You'd see a "confirm failed" error and have to try again.
- The fire-and-forget Letterboxd and Estimated Value Sheet updates aren't covered by that journal. They would just log an error, leaving a Sheet cell out of date.

**What already protects us**
- The rollback journal.
- The 2026-10-07 change that folded the Estimated Value cell into the main row write (it saved 27 calls on a 9-title set).
- The header is read once per confirm.

**Recommendations (free)**
1. Write all of a box set's new rows with **one** `values.batchUpdate`, after a single read of column A. That's about 3 calls per confirm, whatever the size.
2. For overwrites and the Letterboxd/watched patches, read the id column **once** per confirm and reuse it, then write all patches in one `batchUpdate`.
3. Wrap the fire-and-forget Sheet updates in a small retry with back-off (e.g. 3 tries at 2 s, 8 s and 30 s).

There's no paid tier to buy. You can ask Google for a higher per-minute quota in the Cloud Console for free, but with the batching above it won't be needed.

---

### 2.7 Vercel Hobby

**Limits (checked 2026-10-09)**

| Item | Hobby limit | Source |
|---|---|---|
| Function duration | **300 s** default and max (Fluid compute, on by default for new projects) | https://vercel.com/docs/functions/limitations |
| Request/response body | **4.5 MB**, above that error 413 `FUNCTION_PAYLOAD_TOO_LARGE` | same |
| Memory / CPU | 2 GB / 1 vCPU | same |
| Invocations | 1,000,000/month | https://vercel.com/docs/limits/fair-use-guidelines |
| Fast Data Transfer (bandwidth) | 100 GB/month | same |
| Fast Origin Transfer | 10 GB/month | same |
| Active CPU | **4 hours/month** | same |
| Image transformations | **5,000/month**; cache reads 300K; cache writes 100K | https://vercel.com/docs/image-optimization/limits-and-pricing |
| Cron jobs | 100 per project, **at most once per day**, may fire any time within the hour | https://vercel.com/docs/cron-jobs/usage-and-pricing |
| Runtime logs kept | 1 hour | https://vercel.com/docs/limits |

- **Going over:** Hobby isn't charged. When you go over, the project is usually **paused** until usage in the rolling 30-day window falls back under the limit, and you may have to ask support to un-pause it (https://vercel.com/docs/plans/hobby and Vercel community threads, checked 2026-10-09).
- Image optimization is different: new images fail with a 402 error and show their alt text, while already-cached images keep working.

**Is Hobby allowed for this project?** Yes. "Hobby teams are restricted to non-commercial personal use only". Commercial means "financial gain of anyone involved". A personal collection site shared by link, with no ads, payments or affiliate links, is personal use. Estimated Value (checking what your own discs are worth) isn't selling anything. **It would stop qualifying if you added ads, affiliate links (e.g. Amazon referral links) or took payment.**

**Also note**
- Vercel can't connect a Hobby project to a repo owned by a GitHub *organization*. Yours is under a personal account (`daniellynchnz09-crypto`), so that's fine.

**Background pollers:** see section 3.1.

**Image optimization: a hidden problem**
- Case photos and Supabase posters go through `next/image` **with** optimization (`apps/web/src/lib/catalog/images.ts`). Vercel's cache key for remote images includes the **full source URL** (https://vercel.com/docs/image-optimization, "Remote images cache key").
- Our source URLs are Supabase *signed* URLs. Each one has a unique token and is reissued every 12-24 hours, and on every new Vercel server copy, because the signed-URL cache is in memory.
- So every time a URL is reissued, every case image counts as a **new** image again.
- The cache lifetime also defaults to **1 hour** (`minimumCacheTTL` = 3600 s), and each refresh after that counts again.
- Each image is converted at several widths, and each width counts separately.
- With about 3,000 case photos and regular browsing, **5,000 conversions a month is easy to pass**. Once over, new case images show as blank or alt text until the month resets.
- Each conversion also downloads the full-size original from Supabase, which counts against Supabase's 5 GB of downloads.

**Image fixes (free)**
1. Shrink case photos when they're saved (see 2.8). Then serve them `unoptimized`, like TMDb posters.
2. Or give images a stable URL: a small `/img/case/[id]` route that streams from Storage with long `Cache-Control`, so the URL never changes.
3. Set `images.minimumCacheTTL` to something like 2,592,000 (30 days) in `next.config.ts`.

**Active CPU**
- Jimp decoding, rotating and cropping full-resolution photos takes several seconds of CPU per photo (estimate).
- 4 CPU-hours is about 14,400 s, so roughly 3,000-7,000 photos a month.
- Daily scanning fits. **A whole-collection photo backfill done through Vercel could use up Active CPU and pause the site.** Run big backfills from your PC (the `scripts/` folder), not through Vercel.

**Paid option:** Vercel Pro is US$20/month per member, with usage-based billing. It gives per-minute crons and up to 800 s functions, but **the 4.5 MB body limit is the same on Pro**, so the upload fix is needed either way.

---

### 2.8 Supabase (Free)

**Limits** (https://supabase.com/pricing, checked 2026-10-09):
- 500 MB database
- **1 GB file storage**, with a 50 MB maximum per file
- 5 GB downloads ("egress") + 5 GB cached downloads per month
- 50,000 monthly active users
- 500,000 Edge Function calls
- **Paused after 1 week of inactivity**
- **Only 2 active free projects**

Going over: you get an email and a grace period. After that Supabase may make the database read-only, pause the project, or answer every API call with a 402 error (https://supabase.com/docs/guides/platform/billing-faq; egress: https://supabase.com/docs/guides/platform/manage-your-usage/egress).

The REST API has no published per-request rate limit on Free. Auth endpoints do have their own limits.

**Where we use it:** everywhere: `titles`, `pending_scans`, `title_metadata`, `people`/`title_credits`, and the `case-images`, `poster-images`, `cover-scan-staging` and `retail-product-images` buckets.

**How close we come**
- **Database:** 116 MB on 2026-09-16, after the TMDb title-index trim (`database-design.md`). Since then `title_metadata`, `people` and `title_credits` were added for about 2,800 films (top 20 cast + key crew each). Estimated **150-200 MB now**, so that's fine. Check Dashboard, then Settings, then Usage.
- **Storage (estimate):**
  - Cover photos are uploaded at full resolution and quality 0.9 (`ScannerScreen.tsx`, line 189).
  - The server crops and rotates them but **never shrinks** them (`imageCrop.ts` only has crop and rotate; JPEG quality 88).
  - A cropped 12-megapixel photo is roughly **1-2.5 MB** (estimate; the code comment notes a 380 KB product photo became 2.5 MB at quality 100).
  - At about 1.5 MB each, **1 GB holds only about 650 case photos**, against a collection of about 3,000. Staged photos that never got cleaned up add to it.
  - **This is the most likely free-tier limit you'll hit.** Check the current figure under Dashboard, then Storage.
- **Downloads:** once the site is public, Vercel's image converter fetches full-size originals again (see 2.7), and the scanner app shows previews through `/api/scan/case-image-preview` and `/api/scan/staged-cover-preview`. 5 GB a month is only about 2,000-3,500 full-size image fetches.
- **Pausing:**
  - The private project gets real traffic.
  - The public demo project depends entirely on `.github/workflows/keep-alive.yml` (daily: row count, a 50-row read, an Auth health check and a Storage list; see `scripts/src/keep-alive.ts`).
  - **That workflow runs on the same GitHub minutes that `resolve-scans.yml` is using up** (see 2.9). If GitHub blocks workflows, the keep-alive stops too.
- **Project slots:** you're using exactly the 2 free slots (private + public). A third, e.g. a test copy, isn't possible without pausing one or paying.

**What already protects us**
- The trimmed title index and the minimum-popularity filter on re-imports.
- Staged-photo clean-up on confirm and cancel (`coverStagingStorage.ts`).
- The daily keep-alive.
- Batched URL signing (one call per bucket).

**Recommendations (best first)**
1. *Free:* **shrink once, when saving.**
   - In the app, resize before upload with `expo-image-manipulator`, e.g. to 1,600 px on the long side at quality 0.8 (≈300-500 KB). That also fixes the 4.5 MB problem.
   - On the server, save the final case image at about 1,000-1,200 px (≈120-250 KB). Jimp has a resize plugin (`@jimp/plugin-resize`).
   - Then run a one-off script, from your PC, to shrink the photos already stored.
   - Result: 3,000 photos come to about 0.5 GB instead of 3-7 GB.
2. *Free:* a weekly clean-up of `cover-scan-staging` files older than 7 days. Abandoned sessions from app crashes are a documented gap.
3. *Free:* serve case images at a stable URL, or `unoptimized` once small (see 2.7).
4. *Paid:* Supabase Pro, **US$25/month per organization**. It includes 8 GB database, 100 GB storage and 250 GB downloads, never pauses, and adds daily backups. That's worth it if you want backups anyway. Both projects can sit in one Pro organization, though each extra project adds compute cost (check before moving the public one).

---

### 2.9 GitHub Actions (not on your list, but it affects keep-alive)

**The limit**
- Private repos on a free personal account get **2,000 minutes a month**. Public repos are free. When the minutes run out and there's no payment method, "usage is blocked". Linux costs US$0.006/min beyond that. Source: https://docs.github.com/en/billing/concepts/product-billing/github-actions (checked 2026-10-09).
- Schedules can't be more often than every 5 minutes. They are often **delayed or dropped at busy times**, especially on the hour. Source: https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows (checked 2026-10-09).
- GitHub has historically rounded each job **up to a whole minute**. That page didn't state it today, so treat it as likely but unconfirmed.

**Our usage**
- `.github/workflows/resolve-scans.yml` runs `*/5 * * * *`. Each run does `actions/checkout`, then `npm ci` (no cache), then the resolver.
- 288 runs a day × 30 days = **8,640 runs, at least 8,640 minutes a month**, likely more because `npm ci` alone takes a while.
- That's **more than 4 times the free 2,000**. It has been on since 2026-09-29.
- Unless a payment method is on file (in which case you're being charged about US$40-80/month), **the account's Actions are probably blocked already or will be within days of each monthly reset**. Check under GitHub, then Settings, then Billing and plans.

**What breaks:** both workflows stop, the backstop resolver and the Supabase keep-alive. Then the public project pauses after 7 quiet days.

**Recommendations**
1. *Free, now:* turn off or slow down `resolve-scans.yml`. Hourly would be about 720+ minutes; better, keep it manual (`workflow_dispatch` only) until the Vercel replacement below exists.
2. *Free:* add `cache: npm` to `actions/setup-node`, so each keep-alive run is faster.
3. *Free:* move scheduling to Supabase Cron (section 3.1). Keep `keep-alive.yml` daily, which costs about 30-60 minutes a month.

---

### 2.10 eBay Browse API and RapidAPI (Estimated Value, private build)

**Limits**
- **eBay Browse API:** 5,000 calls/day by default. You can ask for more through eBay's "Application Growth Check". Source: https://developer.ebay.com/develop/get-started/api-call-limits (eBay's page returned 403 to my fetch; numbers from the search summary of that page and our own `estimated-value.md`, line 93, checked 2026-10-09).
  - Production access to Buy APIs may need approval (`estimated-value.md`, line 98).
- **RapidAPI Amazon providers:** OpenWeb Ninja, Axesso and 3B Data's Price Analytics, each **100 requests/month, hard-capped**. From our own 2026-09-17 check (`estimated-value.md`, lines 108-118); **not re-checked today**.

**Where we call it**
- `packages/backend/src/estimatedValue/scrapers/ebay.ts` (`EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET`, `EBAY_ENVIRONMENT`).
- `rapidApiAmazon.ts`, `axessoAmazon.ts`, `priceAnalytics.ts` and `amazonProviders.ts` (`RAPIDAPI_KEY`).
- Quota tracking in the `amazon_provider_quota` table (`amazonQuota.ts`).

**How close we come**
- eBay: 1 search per priced title, a few a day. Far below 5,000.
- RapidAPI: only the manual "Try Amazon Search" button, with a waterfall and a monthly counter.

**The real issue is time, not quota**
- `refresh.ts` (`gatherCandidates`, lines 202-208) queries **15 retail sources one after another**, with a random **5-15 s wait before each** (`rateLimiter.ts`).
- That's about 75-225 s of waiting per title, plus page load time.
- One title can come close to Vercel's 300 s; a box set priced member by member can't finish.
- The confirm route starts it with plain `void` (`confirm/route.ts`, line 1045), not `after()`. On Vercel it'll be cut off as soon as the response is sent (the code comment at lines 1040-1044 already warns about this).

**Recommendations**
1. *Free:* make pricing a queue.
   - Confirm only marks titles as "needs pricing".
   - A scheduled job prices them from a machine with no time limit: a GitHub Action once or twice a day (watch minutes: about 3 min per title) or your PC.
   - Or a Vercel daily cron that prices 1 title per run. This is slow, but it stays inside 300 s.
2. *Free:* keep the Amazon providers manual.

---

### 2.11 Rotten Tomatoes pages, Wikidata, IMDb datasets

**Rotten Tomatoes**
- No API and no published rate limit.
- robots.txt (https://www.rottentomatoes.com/robots.txt, checked 2026-10-09) blocks `/m/*/pictures`, `/search` and a few others. Plain `/m/<slug>` pages are allowed. There's no crawl delay.
- Our callers:
  - `packages/backend/src/rottenTomatoes.ts`: one page per confirmed title that OMDb says has a critics' score; identifying User-Agent.
  - `scripts/src/backfill-rotten-tomatoes-links.ts`: one page at a time with a 400 ms gap (`PAGE_CHECK_GAP_MS`).
- Risk: **low**. Big sites often block cloud-server IP addresses (unverified for RT). From Vercel some lookups may just fail, which the code treats safely as "no link".
- Recommendation: run the backfill from your PC. 1-2 s gaps would be even more polite.

**Wikidata SPARQL**
- 60 s query timeout. Each client (User-Agent + IP) gets **60 s of processing time per 60 s** and 30 error queries per minute, with at most 5 parallel queries per IP. Over the limit you get a 429 with `Retry-After`, and clients that ignore 429s can be banned. A proper User-Agent is required. Source: https://www.mediawiki.org/wiki/Wikidata_Query_Service/User_Manual (checked 2026-10-09).
- Our caller: `packages/backend/src/wikidata.ts` (one small query per preview, descriptive User-Agent, never retries), from `apps/web/src/app/api/scan/tmdb-preview/route.ts`.
- Risk: **low**. No changes needed.

**IMDb datasets**
- Allowed for "personal and non-commercial use", refreshed daily, no published rate limit. Source: https://data.imdb.com/non-commercial-datasets/ (checked 2026-10-09).
- Our caller: `scripts/src/import-imdb-ratings.ts`, one ~8 MB download per run.
- Risk: **low**. Keep it to once a day at most. It stays allowed as long as the site stays non-commercial, which also matches the Vercel Hobby and TMDb rules.

---

## 3. Deployment blockers (Vercel Hobby + Supabase Free)

### 3.1 The background pollers in `instrumentation.ts` can't run on Vercel

**Why**
- On Vercel there's no long-running server. Server copies start when requests arrive and are frozen or shut down shortly after.
- `register()` runs **whenever a new copy starts**, so the `setTimeout` loops:
  - don't run when nobody is visiting (scans sit pending);
  - may run briefly in **several copies at once**. Each copy has its own `globalThis` guard, so two copies can pick up the same pending scan and pay for the UPC lookup twice (the cross-process version of the 2026-09-30 bug);
  - use Active CPU and invocations for nothing.
- Vercel Hobby crons can't help directly: **once per day maximum**, and timing can be off by up to 59 minutes.

**What to do**

| Job | Today | Replacement on Hobby (free) |
|---|---|---|
| Scan resolver (15 s) | `instrumentation.ts` + `resolve-scans.yml` | **(a)** Resolve straight away: `session-finish/route.ts` calls `resolvePendingScansBatch(…, 1)` for its own new row inside `after()`. Each run is one scan, well under 300 s, so scans appear within seconds with no polling. **(b)** Backstop: **Supabase Cron** (`pg_cron` + `pg_net`) POSTs to `/api/scan/resolve` (protected by `SCAN_API_SECRET`) every 5-10 minutes with `limit: 3`. **(c)** A daily Vercel cron as a last fallback. |
| TMDb 5-month refresh (hourly) | `instrumentation.ts` | A daily Vercel cron calling a new protected `/api/tmdb/refresh` route with a batch of about 50, plus `title_metadata`. |
| Estimated Value 6-month recheck (30 min) | `instrumentation.ts` | GitHub Action once a day (private repo; about 3 min per title, so keep batches small) or run by hand from your PC. Not on Vercel, because of the 15-site × 5-15 s pacing. |
| Supabase keep-alive | `keep-alive.yml` daily | Keep it. Once the site is live, real traffic keeps the private project awake anyway. |

**Supabase Cron notes**
- `pg_cron` and `pg_net` are Postgres extensions. Supabase's Cron docs (https://supabase.com/docs/guides/cron, checked 2026-10-09) say jobs can run "every second to once a year" and can make HTTP requests.
- The page didn't say whether it's on Free. It's normally available on all plans, so confirm in Dashboard, then Integrations, then Cron.
- Store the scan secret in Supabase Vault, not in the job SQL.

**Fair-use caveat**
- Vercel's fair-use page says "circumventing… Vercel's limits" is a violation.
- An outside scheduler calling your own API every few minutes is a very common pattern, and the calls are cheap. But it's a grey area on Hobby.
- Option (a), resolving on demand from `session-finish`, avoids the question entirely and should carry most of the load.

**Why not Supabase Edge Functions for the resolver itself:** they're limited to 150 s wall-clock and **2 s of CPU** per request on Free (https://supabase.com/docs/guides/functions/limits, checked 2026-10-09). Jimp photo processing needs more CPU than that.

**Add a guard:** in `instrumentation.ts`, skip all three loops when `process.env.VERCEL` is set. They then only run on your local `next dev`.

### 3.2 The 4.5 MB request limit vs cover-photo uploads

- `ScannerScreen.tsx`, line 189: `takePictureAsync({ quality: 0.9, base64: true })`. The full-resolution photo goes as base64 JSON to `/api/scan/cover-photo`.
- That route allows up to 25,000,000 characters (`MAX_UPLOAD_BODY_CHARS`), but **Vercel cuts it off at 4.5 MB first**. Phone photos are typically 3-5 MB, plus a third more for base64, so **most uploads would fail** with "413 FUNCTION_PAYLOAD_TOO_LARGE".
- The same limit applies to **responses**. `staged-cover-preview` and `case-image-preview` send image bytes through a function, so a full-size staged photo over 4.5 MB can't be previewed either.

**Fixes (pick one; both free)**
1. **Resize on the phone before upload.** `expo-image-manipulator`: resize to 1,600 px on the long side, quality about 0.8, so about 300-500 KB (about 0.4-0.7 MB as base64).
   - Simplest fix. It also speeds up uploads and Gemini, and reduces storage and CPU.
   - The barcode-from-photo check (`scanFromURLAsync`) can still use the full-size local file before resizing.
2. **Upload straight to Supabase Storage.** The API route returns a one-time signed upload URL (`createSignedUploadUrl`), and the phone uploads the file there. Nothing passes through Vercel.
   - A good long-term design. Combine it with fix 1 to keep storage small.

### 3.3 Other things that won't survive on Vercel (smaller)

- **Fire-and-forget work using `void`** in `confirm/route.ts` (Estimated Value at line 1045, Letterboxd at line 1063) can be cut off once the response is sent. Use `after()`, which is already used for the metadata step at line 1107, for Letterboxd. Move Estimated Value to a queue (2.10).
- **Local files:**
  - `apps/web/src/lib/scanLog.ts` writes `scan-log/` to local disk. Vercel's disk is read-only apart from `/tmp`. It fails quietly, so the log is simply lost.
  - The Letterboxd matcher reads the local `Letterboxd/` folder (`packages/backend/src/letterboxdMatch/match.ts`, lines 84-116). On Vercel it won't find it and does nothing.
  - If you want either on the deployed site, store the log in a Supabase table and the Letterboxd export in private Storage.
- **In-memory caches** (OMDb, TMDb lookups, signed URLs, Gemini `skipUntil`) only last as long as one server copy. That's fine for correctness, just less effective.
- **The Sheet webhook** (`google-sheet-sync.md`) currently points at a LAN IP. After deploying, point `onEdit.gs`'s `WEBHOOK_URL` at the Vercel URL.

### 3.4 Supabase Free blockers

- **Storage (1 GB)** will fill during a photo backfill unless photos are shrunk (2.8). Check it now.
- **Downloads (5 GB/month)** are at risk once the public site's image converter pulls full-size originals (2.7).
- **Pausing:** the public project relies on GitHub Actions, which is at risk (2.9).
- **2-project cap:** there's no room for a third free project.

---

## 4. Prioritized action list

**Do now (free, quick)**
1. Check GitHub Billing. **Pause `resolve-scans.yml`** (set it to manual only) so the keep-alive keeps running and you aren't charged.
2. Check the Supabase Storage and database size in the dashboard, so you know how much room is left.
3. Become an OMDb Patreon supporter at **US$1/month** (100,000/day). Confirm the tier amount on Patreon first.

**Before deploying to Vercel (free code changes)**
4. Resize cover photos on the phone before upload (fixes the 4.5 MB blocker, storage and CPU together). Later, consider direct-to-Storage signed uploads.
5. Replace the `instrumentation.ts` loops:
   - resolve each scan on demand in `session-finish` with `after()`;
   - a Supabase Cron backstop calling `/api/scan/resolve` (small limit);
   - a daily Vercel cron for the TMDb refresh (about 50/day, including `title_metadata`);
   - Estimated Value pricing through a queue run off Vercel.
   - Add an `if (process.env.VERCEL) return;` guard.
6. UPCitemdb safety:
   - treat 429 as "try later" (keep the scan pending), not "no listing";
   - pace to ≤5/min;
   - check `upc_quota_status` before calling;
   - claim rows atomically so two processes never resolve the same scan.
7. Gemini: pace calls (about 10/min) and keep scans pending when every model is out of quota.
8. Fix image costs:
   - shrink stored case images to about 1,000-1,200 px and re-process existing ones from your PC;
   - then serve them `unoptimized` or through a stable-URL route;
   - set `images.minimumCacheTTL` high.

**Soon after (free)**
9. Batch box-set Sheet writes into one `batchUpdate`, and add back-off retries to the fire-and-forget Sheet updates.
10. Weekly clean-up of old files in the `cover-scan-staging` bucket.
11. Show the TMDb logo with the attribution text.
12. Run heavy backfills (photo recrop, RT links, metadata) from your PC, never through Vercel.

**Only if needed (paid)**
- Google Cloud billing for Gemini during a big photo backfill: roughly US$10-15 for 12,000 requests (estimate). Set a budget alert.
- Supabase Pro, US$25/month: if storage still won't fit, or you want daily backups and no pausing.
- Vercel Pro, US$20/month: only if you need per-minute crons or longer functions. It doesn't lift the 4.5 MB limit.
- UPCitemdb DEV: only for a fast barcode backfill of the whole collection. Get a price quote first.

---

### Unverified or recently changed numbers (summary)
- **Gemini:** per-model free requests per minute and per day. Not on Google's public page any more; ~500/day comes from our own 429 logs, the rest from third-party guides that disagree.
- **UPCitemdb:** paid plan prices aren't published (the ~US$99 and ~US$699 figures are from memory). The free search cap is listed as 40/day on one page and 20/day on another.
- **OMDb:** Patreon tier amounts are from a third-party summary.
- **MDBList:** the free 1,000/day and how batches are counted. The docs page didn't load.
- **eBay:** the 5,000/day Browse limit. eBay's page blocked my fetch; it's in search summaries and our own docs.
- **RapidAPI:** provider limits were not re-checked since 2026-09-17.
- **GitHub:** that each job is rounded up to a whole minute (long-standing, but not on today's page).
- **Our own sizes:** case-image size per photo, current database size, and Active CPU per photo are estimates from the code, not measurements.

---

## 5. What was done about it (2026-10-09, same day)

The user's answers and the action list's items 4-11:

- **GitHub Actions:** `resolve-scans.yml` is manual-only (Actions tab, "Run workflow"). The user's rule: background work should only run while someone is using the site. `keep-alive.yml` stays daily, now with `cache: npm`.
- **Background work (item 5):** `apps/web/instrumentation.ts` is deleted. `apps/web/src/lib/backgroundJobs.ts` runs the jobs in `after()`, and each one claims a row in `background_job_runs` first (migration 0055, both projects), so only one copy runs at a time on any server:
  - `resolve-scans`: started the moment a scan session finishes; also by the Pending Scans list and page views.
  - `tmdb-refresh`: at most every 6 hours of use.
  - `staging-cleanup`: weekly; deletes staged cover photos over a week old that no open scan uses.
  - `estimated-value`: works through `estimated_value_queue` (migration 0056, private only) one title at a time. Confirm queues the new titles instead of pricing them fire-and-forget.
  - `estimated-value-recheck`: the 6-month recheck, one title every 30 minutes of use.
  - What starts them: the website's `ActivityBeacon` pings `/api/activity` on arrival and every 5 minutes while a tab is visible. The scanner app's session-finish, pending-list and confirm requests start the jobs relevant to them. Routes that start work set `maxDuration = 300`, and work stops taking new items after 200 s.
- **UPCitemdb (item 6):** a 429 or 5xx now means "try later". The scan stays pending until the quota resets (or 2 minutes). Lookups are paced 12 s apart (≤5/min). With the day's lookups used up, scans wait without calling. Scans are claimed atomically (`pending_scans.claimed_until`), so two resolvers can't spend two lookups on one barcode. That column also replaces the in-memory 5-minute retry map.
- **Gemini (item 7):** each model gets at most one call every 5 s. When every model is out of quota, a cover-photo scan stays pending until the first comes back (`geminiUnavailableUntil`).
- **Images (item 8 and the user's storage answer):**
  - Every stored case photo is capped at 1200 px on its long side, JPEG 80, with the aspect ratio unchanged (`shrinkForStorage` in imageCrop.ts).
  - The phone now uploads at 1920 px on the long side, quality 0.8.
  - Storage photos are served `unoptimized`, and `images.minimumCacheTTL` is 31 days.
  - `npm run shrink-stored-case-images` re-processes existing photos. A sample went from 2.0 MB to 178 KB (1545×1904 to 974×1200).
  - Retail listing photos (the user's rule) are deleted when their Estimated Value review is answered or removed. They're kept only if the title still has no case image, in which case the accepted ones stay. `npm run remove-retail-listing-images` clears the backlog: the dry run found 1,407 photos, 321.8 MB.
- **Sheets (item 9):** a box set's new rows are written in one call, so the rows themselves are unchanged. Every repeatable Sheets call retries on a 429 or 5xx with 2 s/8 s/30 s back-off. Row deletions are never retried.
- **TMDb (item 11):** the official logo now appears beside the attribution text (`public/tmdb-logo.svg`).
- **Not done:** OMDb's US$1 Patreon - the user declined it (2026-10-09). Hosting: the user chose to stay on Vercel. Hosting: Vercel stays workable now that nothing needs an always-on process. The alternative would be Render's free web service, which sleeps after 15 minutes idle with a ~1-minute cold start; its background workers and cron jobs aren't free. Railway and Fly.io no longer have real free tiers.
