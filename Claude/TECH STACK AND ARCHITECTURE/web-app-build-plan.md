**WEB APP BUILD PLAN (Phase 2 - started 2026-10-06)**

The concrete plan for building WEB APP DESIGN.md's website (Vercel-hosted Next.js app in `apps/web`), written so several Claude Code agents can build it in parallel without colliding. Read WEB APP DESIGN.md first for the user's own description of every page; this file only adds the engineering decisions. Once the website works, it gets ported into the mobile app (user's own sequencing, 2026-10-06).

**Decisions confirmed with the user (2026-10-06)**

- The website reads the live Supabase `titles` table, so the whole collection (3,090 rows synced from the Sheet) plus every future scan appears automatically - nothing to export or re-import.
- Viewing needs no login: anyone with the link can browse. Every page is `noindex`/`nofollow` and `robots.txt` disallows everything, so search engines skip it. A login may be added later if other users want saved preferences. Editing features (rental controls, Direct Database Access) are owner-only and come later.
- Film metadata (posters, synopsis, cast, crew) comes from TMDb, and scores (IMDb rating, Rotten Tomatoes, Metacritic) from OMDb. The IMDb link already saved on 2,790 titles is only used as the ID to look each film up - nothing is taken from IMDb itself. Metadata is stored in the database (not fetched live), so search can find titles by actor and person pages can list everything owned.
- OMDb's free tier is 1,000 requests/day, so the score backfill for all ~2,800 IMDb-linked titles runs over ~3 days. Titles that went through the scanner are done first. New confirms get their metadata immediately.
- OMDb credit savings (2026-10-06, after the first backfill's accidental whole-collection run spent ~800 requests on unscanned titles):
  - A scan confirm saves the scores from the OMDb record it has already fetched, and skips OMDb when the stored scores are still fresh, so a confirm costs no extra metadata request. `omdbGetById` also keeps successful answers for an hour, so the scan's lookup and the confirm's lookup of the same film share one request.
  - Scores are re-checked every 90 days for films under two years old and once a year for older ones (`omdbRefreshAgeMs`).
  - IMDb ratings and vote counts come from IMDb's free daily data file (`datasets.imdbws.com/title.ratings.tsv.gz`, personal non-commercial licence) via `import-imdb-ratings`, which the backfill runs first. So an IMDb score never waits on OMDb; OMDb remains the only free source for Rotten Tomatoes and Metacritic.

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

Dark gradient backgrounds; rigid, non-rounded, angular shapes (clipped corners, triangles, chevrons - no pill or rounded buttons); light blue accents; early-2000s "techno chrome" panels in the spirit of the 2Advanced Studios reference (`Design Asthetic/aesthetic-01.webp`) and the banner sheet (`aesthetic-05.webp`): thin rule lines, small uppercase labels, subtle grid/scanline texture. Title pages use a blurred, darkened, zoomed-in copy of the poster as the page background. Logo is the text "DANFLIX 5.0" in light blue, top-left. Light skeuomorphism (the user, 2026-10-06: "it needs a touch more skeuomorphism"): light from above, so raised surfaces (panels, `chrome-bar`, the `chrome-plate` header) get a lit top edge, a shaded bottom edge and a sheen; buttons, selected tabs, badges and bar/meter fills use `gloss` (bright upper half, darker lower half, presses in on click); tracks and the search field are recessed `well`s; poster images get a drop shadow and a plastic-case glare. Keep it subtle - a touch, not a full Aqua-style makeover. The scanner app matches it (2026-10-07, the user's request): `apps/mobile/src/theme.ts` holds the same tokens and fonts (Chakra Petch / Barlow via @expo-google-fonts, loaded in App.tsx). It sets square corners everywhere except true circles, glossy raised buttons, bevelled panels, recessed inputs and tracks, gradient screens and brushed-metal headers (React Native's `experimental_backgroundImage` / `boxShadow`, so no wrapper components), plus the DANFLIX 5.0 logo bar on the camera screen. Corners are square rather than cut, because React Native can't clip a view to a polygon. Browse rows each end - no infinite looping within a row. All tokens live in `apps/web/src/app/globals.css` (Tailwind v4 `@theme`); components use the tokens, not one-off colours.

**Build order and file ownership**

Agents work in the same working tree, so each owns a disjoint set of files. Shared files belong to the Foundation agent; later agents may add new files but must not restructure shared ones.

1. Wave 1, in parallel:
   - **Foundation** - owns `apps/web/src/app/layout.tsx`, `globals.css`, `robots.ts`, `apps/web/src/components/` (header, search box shell, settings menu, PosterCard, ScrollRow, PageHeader with back button, panel/section primitives), and `apps/web/src/lib/catalog/` (server-only data access: types, Supabase read client, queries for titles/collections/works/franchises, image URL helpers). Home page stub.
   - **Enrichment** - owns `supabase/migrations/0043_title_metadata.sql`, `packages/backend/src/metadata/`, `scripts/src/backfill-title-metadata.ts`, and the post-confirm metadata hook in `apps/web/src/app/api/scan/confirm/route.ts` (fire-and-forget, like the Estimated Value trigger).
2. Wave 2, in parallel, after Wave 1: **Home/Browse rows**, **Movie/TV + DVD + Collection pages**, **Person + Franchise pages**, **Search** (header dropdown + `/search`). Each owns its own route folder under `apps/web/src/app/` and may add query files under `apps/web/src/lib/catalog/`.
3. Later phases (not now): Advanced Search taste profiles (Phase 3; the filters and sorting themselves were built 2026-10-07 - see "Advanced Search filters" below), Rental Dashboard, Direct Database Access and owner auth (Phase 4), Vercel deployment, then the port to the mobile app.

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
- **Series browser shows only the episodes on owned discs (2026-10-06).** Season 3 of Doctor Who lists just The Savages' 4 episodes ("4 of 45 episodes // on my discs"), not the whole season.
  - Story/serial discs are matched to TMDb's episode names ("The Savages (1)".."(4)"), capped at the disc's episode count. This was checked against the classic Who serial index: same episode ranges.
  - Whole-season sets show every episode.
  - "Part N" discs show the Nth block of episodes, assuming the parts split the season evenly.
  - Anything that can't be pinned down shows the whole season.
  - Code: `ownedEpisodeNumbers` in `titlePages.ts`.
- **Row scroll arrows** now sit flat against the page edge, with the angled side facing the cards. Before, the point sat at the edge and left gaps at the corners.
- **Per-serial Letterboxd accordion (private build only, 2026-10-06).** In the Series browser, each episode of a serial the user rated on Letterboxd shows a score badge. Clicking any of them opens the serial's score and review under its last episode.
  - Data is in `letterboxd_serial_reviews` (migration `0048`, private only), filled by `import-letterboxd-reviews`. Matching is "Doctor Who: <serial>" against `classic_who_serial_index`, which gives the season. The rating is Letterboxd stars x 2.
  - `TvSeriesBrowser` takes a generic `storyExtras` prop; the Letterboxd parts come from the excluded `LetterboxdTake.tsx` / `letterboxdReview.ts`.
- **Home rows:** TV Series and TV Mini-Series are now separate rows.
- **Search:** Film/TV results show the film's TMDb poster. DVD/collection results keep the case photo.
- **Director/actor/franchise pages:** the Movie/TV tab's thumbnails use the film's TMDb poster. The DVD tab keeps case photos.
- **Hover outline:** a band of light circles the outline of hovered/focused cards, tiles and links (`flow-ring` utility in `globals.css`); reduced-motion users get a steady outline.
- **Circular portraits:** the bright arcs spin slowly, with a second faint arc turning the other way. Cast/crew circles get a spinning arc on hover. Still for reduced-motion users.
- **"Weird and Wonderful" comes from the 366 Weird Movies lists** (366weirdmovies.com), at the user's request. The old rule-based row (rare genres, puppetry, 3D discs) is gone.
  - `weird_movie_list` (migration `0049`) holds the Canon (366), Apocrypha and Apocrypha Candidates (the site's ~500-title shortlist).
  - `titles.weird_tag` is set by `npm run import-weird-movie-list -w scripts` for the whole collection (59 titles) and by `/api/scan/confirm` for new scans.
  - Hand-picked 'similar' titles, chosen for comparable weirdness in plot and aesthetic, are listed with reasons in the script's `SIMILAR_PICKS`: The Elephant Man, One from the Heart, All That Jazz, Bride of the Monster, Bride of Frankenstein, Confessions of a Dangerous Mind, Jodorowsky's Dune.
  - Scanned titles on the lists so far: Vertigo (Canon) and Capone (Candidate; no IMDb link yet, so not shown on the Film/TV-only home page).
- **Archive stats** show the total as a big number, then bar charts by format and by type.
- **Hover effects:** the flowing outline was removed from poster/case images (the user found it distracting) and kept on tiles/links. The circular people/franchise icons keep their spinning arcs. Hover animations were slowed (6 s per lap).


**Advanced Search filters (built 2026-10-07, the user's request; spec from WEB APP DESIGN.md's Advanced Search section)**

- **Where it lives:** /search has a "Filters & sort" panel (`components/search/FilterPanel.tsx`). The header search bar has a filter button that opens it. With filters (or a sort) and no search text, /search becomes a browse page ("all 4K horror films").
- **State:** filters live in the URL (`lib/catalog/searchFilters.ts` parses and writes them), so a filtered view can be bookmarked. Searching again from /search keeps the filters.
- **Filters:**
  - result type (films/TV, physical titles, box sets, franchises, directors, actors & crew - people need typed text)
  - include/block chips for: Movie or TV, format, genre, franchise, age rating, animation/live action, documentary/realism, studio, disc region and release month
  - two-handled sliders for release year (with decade shortcuts), runtime, IMDb, Rotten Tomatoes and Metacritic
  - Any/Only/Hide for steelbook, is a box set, and is in a box set
  - "My score" (titles.personal_rating) - private build only. Its loader `letterboxdScores.ts` is excluded and its call sites are LETTERBOXD sentinel blocks in search.ts and the search page.
- **Sorts:** best match, alphabetical (ignoring "The"), release date, recently added, popularity (IMDb votes), runtime, IMDb, Rotten Tomatoes, RT audience, Metacritic, and My score (private) - each either direction.
- **How filtering works:** the search index (search.ts) carries each row's filterable facts, so filtering costs no extra queries. A film passes when any copy passes. A box set passes on its own steelbook/box-set flags plus any disc inside it passing the rest. Facet values are OR within a facet and AND across facets, and a blocked value removes a title outright.
- **RT audience** range filter and sort were added once MDBList supplied the score (see below; originally listed here as not built - no data source).
- **Filter panel layout (2026-10-07):** each group is a collapsible section (accordion): Show (open by default), Taste profiles, Release year & runtime, Scores, Steelbooks & box sets, then one per facet with its option count. A section starts open when something in it is set, and its header shows how many are set.
- **Match any / Match all (2026-10-07):** Genre and Franchise (one title carries several) have a switch; Match all needs every picked value (URL match=genre / match=fr). Every other facet always matches any picked value.
- **Documentary / realism slider (2026-10-07):** a notched two-handled slider, Documentary - Dramatization - Biopic - True events - Mockumentary - Fiction, left to right (order chosen by the user, flipped at their request), written as `doc` includes; performance/recording values stay as chips under it.
- **Score-site links (2026-10-07):** title_metadata.metacritic_url / rotten_tomatoes_url (migration 0052) from MDBList, so the Metacritic tile links and the RT tile links even when the Sheet has no RT page.
- **Options that follow the other filters (2026-10-07):** /api/search/facets returns, per list, how many titles each value still matches given every *other* filter in the draft (so picking Blu-ray hides DVD-only regions but Format still offers DVD). Zero-match values are hidden (picked ones always stay). Lists over 8 values show their top 5 by live count; the find box and "Show all" reach the rest. Multi-region discs count under each region.
- **Letterboxd community average (private build only, 2026-10-07):** from the same MDBList replies (migration 0051, title_metadata.letterboxd_rating, 0.5-5). Shown as a Letterboxd tile and offered as a filter/sort. The owner's own Sheet/Letterboxd ratings and reviews are now labelled **Danflix score** / **Danflix review**. Rotten Tomatoes critics and audience share one tile.
- **Taste profiles (built 2026-10-07):**
  - **Storage:** saved Advanced Search filters with a name, in the `taste_profiles` table that migration 0001 created long ago. Its `filters` jsonb holds the /search URL-parameter string as a JSON string, re-parsed on every read.
  - **Using them:** in the filter panel, anyone with the link can pick profiles (`?profile=<id>`, up to 10). Picking several shows only titles that pass every one - the user's "suit everyone" choice - on top of the panel's own filters.
  - **Changing them:** "Manage profiles" saves the current filters as a profile, loads a profile's filters back into the panel, saves over one, renames or deletes. These go through /api/taste-profiles and need the owner passcode (`OWNER_PASSCODE` in the web app's env, checked in constant time, 8 wrong tries per address locks it for 15 minutes). The user chose this over browser-only or anyone-can-edit.
  - **Names:** the private build uses real names; the public demo will get made-up ones when its data is seeded.
- **Rotten Tomatoes Audience Score (built 2026-10-07):** OMDb doesn't carry it, so it comes from MDBList (mdblist.com, free key in MDBLIST_API_KEY, 1,000 requests/day), whose "popcorn" rating source is the RT audience score. Stored in title_metadata.rt_audience_score (+ mdblist_fetched_at, migration 0050). packages/backend/src/metadata/mdblistScores.ts uses MDBList's batch endpoint (100 IMDb ids per request; movies and shows separately), so the backfill (backfill-title-metadata.ts, last step, --skip-mdblist) covered all 108 scanned films in 3 requests; each scan confirm spends one request (same freshness windows as OMDb). Shown as an "RT Audience" score tile (popcorn icon; upright at 60%+, spilled below), an "RT audience" range filter (rta) and sort.
