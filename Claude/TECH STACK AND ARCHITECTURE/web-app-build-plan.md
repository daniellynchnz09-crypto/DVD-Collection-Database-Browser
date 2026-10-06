**WEB APP BUILD PLAN (Phase 2 - started 2026-10-06)**

The concrete plan for building WEB APP DESIGN.md's website (Vercel-hosted Next.js app in `apps/web`), written so several Claude Code agents can build it in parallel without colliding. Read WEB APP DESIGN.md first for the user's own description of every page; this file only adds the engineering decisions. Once the website works, it gets ported into the mobile app (user's own sequencing, 2026-10-06).

**Decisions confirmed with the user (2026-10-06)**

- The website reads the live Supabase `titles` table, so the whole collection (3,090 rows synced from the Sheet) plus every future scan appears automatically - nothing to export or re-import.
- Viewing needs no login: anyone with the link can browse. Every page is `noindex`/`nofollow` and `robots.txt` disallows everything, so search engines skip it. A login may be added later if other users want saved preferences. Editing features (rental controls, Direct Database Access) are owner-only and come later.
- Film metadata (posters, synopsis, cast, crew) comes from TMDb, and scores (IMDb rating, Rotten Tomatoes, Metacritic) from OMDb. The IMDb link already saved on 2,790 titles is only used as the ID to look each film up - nothing is taken from IMDb itself. Metadata is stored in the database (not fetched live), so search can find titles by actor and person pages can list everything owned.
- OMDb's free tier is 1,000 requests/day, so the score backfill for all ~2,800 IMDb-linked titles runs over ~3 days. Titles that went through the scanner are done first. New confirms get their metadata immediately.

**Data model - how rows become pages**

- A `titles` row is one physical item -> a **DVD Page** (`/disc/[uniqueId]`).
- A row with `is_collection = true` is a box set header -> a **DVD Collection Page** (`/collection/[uniqueId]`). Its members are the rows with `title_in_a_collection = true` and the same `name_of_collection`.
- A **Movie/TV Page** (`/title/[imdbId]`) is the film itself, grouping every physical row that shares the same IMDb id (extracted from `imdb_page` with `extractImdbIdFromPage` in `packages/shared/src/titleParsing.ts`). Rows with no IMDb id get no Movie/TV Page; their DVD Page is the only page.
- **Person pages** (`/person/[tmdbPersonId]`) list every owned title the person is credited on, via `title_credits`.
- **Franchise pages** (`/franchise/[slug]`) list every row whose `franchise` array contains that franchise (case-insensitive).
- **Search** (`/search?q=`) plus the header's live dropdown return films, physical items, collections, people and franchises as separate result types, per WEB APP DESIGN.md's Vertigo example.

**New tables (migration `0043_title_metadata.sql`, public-read RLS, service-role writes; applied to both projects 2026-10-06. Private backfill started that day: TMDb for all ids, OMDb at 950/day. The public project's demo subset is still to be backfilled, by running the script with the public project's env.)**

- `title_metadata` - one row per film, primary key `imdb_id` (text, e.g. `tt0052357`): `tmdb_id`, `tmdb_media_type` ('movie'|'tv'), `title`, `original_title`, `tagline`, `overview`, `poster_path` and `backdrop_path` (TMDb image paths; build URLs with `https://image.tmdb.org/t/p/{size}{path}`), `release_date`, `runtime_mins`, `genres` text[], `imdb_rating` numeric, `imdb_votes` integer, `rotten_tomatoes_score` integer (0-100), `metacritic_score` integer (0-100), `number_of_seasons`, `number_of_episodes`, `tmdb_fetched_at`, `omdb_fetched_at`.
- `people` - primary key `tmdb_person_id` (integer): `name`, `profile_path`, `biography`, `known_for_department`, `birthday`, `deathday`, `place_of_birth`, `fetched_at`. Biography/profile are filled lazily (only when a person page is first built, or by the backfill for directors and top-billed cast).
- `title_credits` - `imdb_id` -> `title_metadata`, `tmdb_person_id` -> `people`, `credit_type` ('cast'|'crew'), `character` (cast), `job` and `department` (crew), `credit_order` integer. Cast is capped at the top 20 billed; crew keeps Director, Writer/Screenplay, Producer, Original Music Composer and Director of Photography.
- TV episode lists for the Series browser are fetched live from TMDb's `/tv/{id}/season/{n}` and cached by Next - not stored.

**Privacy rules for every page (non-negotiable)**

The site is public-by-link, so pages must never show: `estimated_value` or any other Estimated Value column (financially sensitive, private-build-only feature), `rented_by_who` / `date_rented` (a real third party's name), `personal_rating`, `case_notes`, `disc_condition`, `barcode_id`. Showing that a disc is currently rented out (without who) is fine. Read through a server-only Supabase client and select explicit column lists - never `select("*")` into a page.

**Design system (WEB APP DESIGN.md + `Claude/concept design/`)**

Dark gradient backgrounds; rigid, non-rounded, angular shapes (clipped corners, triangles, chevrons - no pill or rounded buttons); light blue accents; early-2000s "techno chrome" panels in the spirit of the 2Advanced Studios reference (`Design Asthetic/aesthetic-01.webp`) and the banner sheet (`aesthetic-05.webp`): thin rule lines, small uppercase labels, subtle grid/scanline texture. Title pages use a blurred, darkened, zoomed-in copy of the poster as the page background. Logo is the text "DANFLIX 5.0" in light blue, top-left. Browse rows each end - no infinite looping within a row. All tokens live in `apps/web/src/app/globals.css` (Tailwind v4 `@theme`); components use the tokens, not one-off colours.

**Build order and file ownership**

Agents work in the same working tree, so each owns a disjoint set of files. Shared files belong to the Foundation agent; later agents may add new files but must not restructure shared ones.

1. Wave 1, in parallel:
   - **Foundation** - owns `apps/web/src/app/layout.tsx`, `globals.css`, `robots.ts`, `apps/web/src/components/` (header, search box shell, settings menu, PosterCard, ScrollRow, PageHeader with back button, panel/section primitives), and `apps/web/src/lib/catalog/` (server-only data access: types, Supabase read client, queries for titles/collections/works/franchises, image URL helpers). Home page stub.
   - **Enrichment** - owns `supabase/migrations/0043_title_metadata.sql`, `packages/backend/src/metadata/`, `scripts/src/backfill-title-metadata.ts`, and the post-confirm metadata hook in `apps/web/src/app/api/scan/confirm/route.ts` (fire-and-forget, like the Estimated Value trigger).
2. Wave 2, in parallel, after Wave 1: **Home/Browse rows**, **Movie/TV + DVD + Collection pages**, **Person + Franchise pages**, **Search** (header dropdown + `/search`). Each owns its own route folder under `apps/web/src/app/` and may add query files under `apps/web/src/lib/catalog/`.
3. Later phases (not now): Advanced Search filters and taste profiles (Phase 3), Rental Dashboard, Direct Database Access and owner auth (Phase 4), Vercel deployment, then the port to the mobile app.

## Changes after the first review (2026-10-06)

The original plan above is kept as written; these replace parts of it.

- **Only scanned titles appear on the site.** The user's rule: everything scanned with the app so far, plus everything scanned from now on. Sheet-only rows wait until the scanning backlog reaches them. Backed by `titles.scanned` (migration `0046`), which:
  - was backfilled from confirmed scans, case photos, `date_added`, and members of scanned box sets;
  - is set by `/api/scan/confirm` on every row it writes;
  - is filtered on by every query in `apps/web/src/lib/catalog`.
  The metadata backfill also covers scanned titles only now; `--all` brings back the whole-collection run.
- **The home page shows Film/TV entries only.** Each card stands for a film, not a disc:
  - one card per IMDb id per row, using the TMDb poster and linking to `/title/[imdbId]`;
  - rows without an IMDb id are left off the home page;
  - DVD pages are reached through search or from a Film/TV page.
  The featured title opens its Film/TV page too, and the "SYS.FEATURE / SEQ" labels above it were removed (the rule line stays).
- **Images on DVD/collection pages and cards:** the user's own scanned case photo comes first (`case_image_path`, then TMDb, then `movie_poster_path`, then `case_image_url`). The Movie/TV page keeps the TMDb poster.
- **Case-shaped frames.** A case photo's frame starts at its format's standard case shape:

  | Format | Case size (width × height) |
  |---|---|
  | DVD | 135 × 190 |
  | Blu-ray / 4K | 135 × 171.5 |
  | VHS | 130 × 210 |
  | CD | 142 × 125 |

  The frame then settles on the photo's own measured shape (`components/ImageFrame.tsx`, `caseAspect` in `display.ts`).
- **Scores are graphics:**
  - IMDb: star icon with a /10 meter;
  - RT: fresh tomato or rotten splat with a % meter;
  - Metacritic: favourable/mixed/unfavourable colour box.
  Outbound links appear only until OMDb has scores for the title.
- **Letterboxd tile (private build only).** It shows the user's own Sheet score (`personal_rating`, 1-10) as a tile, plus their Letterboxd review as a preview that expands.
  - Reviews are in `letterboxd_reviews` (migration `0047`, private only), filled by `npm run import-letterboxd-reviews -w scripts`; re-run it after downloading a new export.
  - `0047` also gives the anon key back read access to `personal_rating` on the private project, at the user's request.
  - All of it is stripped from the public build (excluded files, plus LETTERBOXD markers in the title page).
- **Phone access in development.** `allowedDevOrigins: ["192.168.1.70"]` is now in `next.config.ts`. Without it, Next 16 blocked its own scripts on the phone. Plain links still worked, but the Back button, search and the endless home rows did not.
