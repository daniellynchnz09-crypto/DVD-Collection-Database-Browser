**TECH STACK AND ARCHITECTURE**

This document turns the plan in AIM.md and STEP BY STEP PROCESS AND AUTOMATION.md into a concrete technical design. It doesn't replace those documents, it specifies how to build what they describe. If a future session changes any of these decisions, update this file and move the old decision to the Backlog section at the bottom rather than deleting it.



**REPO / MONOREPO LAYOUT**

One monorepo (Turborepo + npm workspaces — pnpm was the original plan, but its global install hit a Windows permissions error via corepack, so npm workspaces are used instead; functionally equivalent) during development, split into the public/private GitHub repos described in Claude.md at publish time (see PUBLIC VS PRIVATE BUILD PIPELINE below).

- apps/web — Next.js (TypeScript) web app. Deployed to Vercel. This is the Netflix/IMDB-hybrid browse and search experience described in WEB APP DESIGN.md.
- apps/mobile — Expo/React Native app. Same browse/search UI reused where practical, plus the barcode scanner screen. Exported to an APK via `eas build --platform android` so it can be sideloaded per STEP BY STEP PROCESS AND AUTOMATION.md's "export as .apk" note.
- packages/shared — TypeScript types for the DVD/collection schema, the Supabase client wrapper, search/filter/taste-profile logic, and other pure/fetch-based helpers used by both apps (crucially including `apps/mobile`) so the matching algorithm only exists once. Nothing here should need a Node-core module (`fs`, `util`, `stream`, ...) that Metro can't bundle.
- packages/backend — Node-only backend logic (currently just the barcode-scan resolver and its cover-photo image-matching, which needs Jimp for image decoding) that only `apps/web` and `scripts/` import, never `apps/mobile`. Split out from packages/shared specifically because Jimp broke Metro's bundling of the mobile app once it became reachable from shared's barrel export - see the BARCODE SCANNING PIPELINE section below for the full story.
- scripts/ — the Google Sheet ⇄ Supabase sync jobs and the public-repo sanitization script.

Reasoning: a single native codebase (Expo) covers both "export as .apk" and iOS later if wanted, and the shared package means the taste-profile/search logic behind Aim Three and Aim Four is written once and used identically on web and phone.



**DATABASE DESIGN (Supabase / Postgres)**

Supabase was chosen over a self-hosted SQL database because it gives a managed Postgres instance, auth, file storage (for DVD case images), an auto-generated REST/JS client, and Row Level Security, all on a free tier sufficient for a personal collection database. This satisfies STEP BY STEP PROCESS AND AUTOMATION.md step 1 ("copy the Google Sheet data into a high-performance SQL database that takes priority over the Sheet for processing time").

Two separate Supabase projects, not one project with filtered views:
- A private project holding the entire real collection and real taste-profile names.
- A public project holding only the Friends TV show, X-Men, Star Wars, and the Film Noir boxset, with anonymized taste-profile names, matching Claude.md's public-build description exactly.

Keeping these as two physically separate databases (rather than a filter flag on one database) means the public build can never accidentally expose private rows through a bug in a query filter.

Schema: one core table modeled directly on the "All DVDs and Specs" Google Sheet columns from RESOURCES.md (Title, Movie or TV, Season No., Part of a Season No., Episode Count, Release Date, Running Time, Genre, Director, Franchise, Sub-franchise, Rating, Format, Disc Count, Special Features, Special Features Disk Count, Special Features Disk Format, Animation/Live Action, Documentary, Collection, Name of Collection, Title in a Collection, Number of Titles in a Collection, Rotten Tomatoes Page, IMDB Page, Studio, Disk Region), plus the new columns STEP BY STEP PROCESS AND AUTOMATION.md already calls for:
- unique_id (primary key used for barcode re-scans and future column backfills)
- barcode_id (so re-scanning a title later doesn't require re-scanning the physical barcode)
- case_image_url (points at Supabase Storage)
- genre_location (the single genre the title actually sits under on the shelf, separate from the possibly-multiple Genre column, used for the shelf-location suggestion in Aim Five)
- last_updated (timestamp, needed for the Sheet sync below)

Row Level Security: public read access for anything the browse/search UI needs; all writes require the authenticated owner (Supabase Auth, single account — see AUTH below). This is the actual security boundary, not just hiding UI elements.



**GOOGLE SHEET SYNC**

Phase 0 ran a one-off manual sync (`scripts/src/sync-sheet.ts`, Sheet → Supabase) to get the real ~3,063 existing entries into the private Supabase project for the first time — that script also auto-created the Unique Identifier/Barcode Identifier/Genre Location columns the Sheet didn't have yet, and backfilled a UUID into every row.

Ongoing sync is bidirectional and near-real-time, not one-way or manual, because the user will keep editing the Sheet directly (typos, genre reclassification, bulk cleanup) alongside app-originated writes, and the database must never go stale relative to either source:
- **Sheet → Supabase**: a Google Apps Script bound to the spreadsheet with an `onEdit(e)` trigger `UrlFetchApp.fetch()`s the edited row to a `/api/sheet-webhook` endpoint (`apps/web`, secret-gated), which upserts just that row into Postgres using the same field-normalization helpers as everything else (`packages/shared/src/titleParsing.ts`). See BARCODE SCANNING PIPELINE below — the Apps Script source lives in `apps/sheet-scripts/onEdit.gs` since Apps Script itself runs inside the Sheet, not in this codebase; the user pastes it in via Extensions → Apps Script.
- **Supabase → Sheet**: writes that originate from the app (barcode-scan confirms, later Direct Database Access edits) go to Supabase first, then push back to the Sheet via the Sheets API, reusing the same append/update logic `sync-sheet.ts` established.

The `last_updated` column (auto-set by a Postgres trigger on every row write) is available if last-write-wins conflict detection is ever needed, but isn't load-bearing yet since each direction currently writes disjoint fields per event rather than racing on the same row.



**BARCODE SCANNING PIPELINE (Aim One)**

Blu-ray.com is confirmed to have no API or sanctioned query path at all (their own forum: "Does blu-ray.com provide an API for developers? No" — asked repeatedly since 2018, never changed), and their per-IP scraping tolerance is undocumented and unprotected, so it's excluded entirely as a data source, not just deprioritized.

The user also clarified this isn't just steady-state logging of new purchases — the entire existing collection needs its barcode/case-image data backfilled too, which is a bulk operation, not a trickle. That reshapes the pipeline: **scanning and lookup are decoupled**, so a free API's daily rate limit never gates how fast the user can physically scan their shelves.

1. Expo camera screen (`expo-camera`'s `CameraView`, `barcodeScannerSettings.barcodeTypes: ['ean13','upc_a','upc_e']`, `onBarcodeScanned`, permission via `useCameraPermissions()` — confirmed current for SDK 57; the older `expo-barcode-scanner` package is deprecated/removed since SDK 51) reads the barcode and immediately writes `{ barcode, scanned_at }` to a new `pending_scans` Supabase table via a secret-gated endpoint, then returns straight to the camera. No network wait, no per-scan lookup — the user can scan hundreds of discs in one sitting. Two independent debounce layers prevent duplicate queueing: `SIGHTING_GAP_MS` (2s, local state inside `ScannerScreen.tsx`) collapses `CameraView`'s repeated per-frame firing while the same code stays continuously in shot, and `RECENT_QUEUE_COOLDOWN_MS` (5 minutes, per the user's own suggestion) separately remembers every barcode's last-queued time so pointing back at the same case a few seconds or minutes later doesn't create a second `pending_scans` row for it. Both are keyed on the literal barcode value, so two different physical releases of the same film — which necessarily have different barcodes — are never affected by either debounce. The 5-minute map lives in `App.tsx`, not `ScannerScreen.tsx` itself, since `ScannerScreen` unmounts every time the user navigates to Pending Scans and back (App.tsx's screen switch is plain conditional rendering, not a navigator that keeps screens mounted) — local state there would silently reset the cooldown on every trip to review scans. Deleting a pending scan (either the Pending Scans list's bulk delete, or Confirm screen's single discard) also forgets that barcode's cooldown entry immediately, per the user's own request: having just discarded it, they clearly want to rescan it right away rather than wait out the rest of the 5 minutes.
2. A **resolver** (reusable function, called from a manual script, an auto-poller, and, later, a scheduled job) works through `pending_scans` at a safe rate: looks the barcode up against UPCitemdb (chosen UPC/EAN lookup service — free tier, no signup/card, 100 requests/day; the only other options found either have no free tier at all or an undocumented one, and buying UPCitemdb's cheapest paid tier is $99/mo, which is only worth it as a one-time month if the free-tier backfill drain feels too slow later — not decided now), then cross-references OMDB for movie metadata (OMDB prioritized over IMDB per RESOURCES.md, since OMDB has a public API and IMDB doesn't) using OMDB's own `Type` field (`movie`/`series`/`episode`) to know whether TV-only fields even apply. Marks each pending scan `resolved` (found confident candidates) or `needs_manual` (nothing confident found).
   - **Auto-polling in `apps/web`**: `instrumentation.ts`'s `register()` hook (a stable Next.js server-boot hook, not a route) starts a 15-second `setInterval` that calls the resolver on whatever's pending (batch limit 20) for as long as `next dev`/the deployed server process is running — this replaced repeatedly running `npm run resolve-scans` by hand during real-device testing, which was mistaken for a bug ("I scanned it but it's not showing up") more than once before this existed. Deliberately still a poll rather than resolving on every `/api/scan/queue` call, so scanning and lookup stay decoupled and a bulk shelf-scanning burst can't blow through UPCitemdb's 100/day cap just by scanning fast — a big backlog drains gradually over many ticks instead of firing one lookup per scan back-to-back. The manual script and `/api/scan/resolve` route both still exist (the route is what a Vercel Cron job will call once deployed, superseding this poller then).
3. A pending-scans review screen (mobile) lists resolved/needs-manual entries; the user confirms the suggested match, edits fields, or fills in manually — mirroring Claude's own clarifying-question style per STEP BY STEP PROCESS AND AUTOMATION.md (skipping fields that don't apply, e.g. never asking for a season number on a movie).
4. **Review-screen auto-fill and candidate narrowing** — the review screen never presents a bare barcode; several fields start pre-filled as editable guesses, and the OMDB candidate list itself is narrowed before the user ever sees it:
   - `title` starts pre-filled with the UPC listing's own title, cleaned the same way the OMDB search query is (packaging/format words, marketplace-resale noise, and packaging-edition qualifiers like "Special Edition"/"Collector's Edition" stripped — those are marketing fluff, not a content distinction, unlike a genuinely different cut like "Final Cut" which the user does keep in a title). Always editable, never presented as confirmed.
   - `format` starts pre-filled from a text-pattern match on the listing (`extractFormatHint` in `packages/shared/src/formatHints.ts` — checks for 4K/UHD before Blu-ray so a "4K UHD Blu-ray" combo isn't miscategorized as plain Blu-ray). This can only work with words actually present in the listing text — if a listing just says "Blu-ray" with no "4K"/"UHD" mention at all even though the physical disc is a 4K combo pack, there's no text signal to catch that; the field stays user-editable specifically because this guess can be wrong.
   - The OMDB candidate list is narrowed using the listing's own year as a chronological upper bound (`extractProductYear` + `filterCandidatesByMaxYear`): a listing's year is the disc's *home-video release* year, not necessarily the film's, but home video always follows theatrical release, so any OMDB candidate whose Year is *after* the listing's year is eliminated outright — a disc can't exist for a film that hasn't been released yet. Never eliminates every candidate (falls back to the unfiltered list) since the extracted year is itself just best-effort text parsing.
   - When UPCitemdb's own listing has a product photo, it's shown on the review screen captioned as "your scanned item" specifically because it's a photo of the actual listing, not a generic poster — the most useful single signal for telling apart releases of the same film that share a title and year (special editions, different regions, different bonus-features packaging) but look different on the shelf. Candidates without their own photo still show OMDB's poster in the horizontal candidate list, but that's a generic per-*film* image, not a per-*edition* one.
   - **Auto-matching by cover photo**: when the listing has its own photo, it's automatically compared against every OMDB candidate's poster using perceptual image hashing (`matchPosterToCandidates` in `packages/backend/src/posterMatch.ts` — Jimp's pHash/compareHashes, a DCT-based hash compared by Hamming distance, normalized 0..1 where 0 is identical). Deliberately conservative: only reports a confident match when the best result is both close in absolute terms *and* clearly ahead of the runner-up, since a resale-listing photo of a plastic case often looks quite different from OMDB's stylized theatrical poster even for the objectively correct film (different framing, cropping, an added disc-shaped overlay, background) — thresholds were verified against synthetic identical/unrelated-image pairs (0 vs. ~0.375), not yet against a real photo-vs-poster pair from an actual scan, since no scan so far has had both a UPC photo and needed disambiguation. When confident, the review screen shows just that one matched candidate with a "Not this item" escape hatch that reveals the full poster list (everything it was compared against) to pick from manually instead; when not confident (or there's no listing photo at all), the full list shows as before with nothing pre-selected. Skipped entirely for collections, since a box-set's own cover doesn't correspond to any single film's poster.
   - This poster-matching code lives in a separate `packages/backend` workspace, not `packages/shared` — image decoding (Jimp, for the perceptual hash) pulls in Node-core modules (`fs`, `util`, `stream`) that Metro (the mobile app's bundler) can't resolve, and `packages/shared` is the one package the mobile app also depends on. `packages/backend` depends on `packages/shared` and is itself only imported by `apps/web`'s API routes and `scripts/`, never by `apps/mobile`.
   - Explicitly **not implemented**, and moved to the backlog rather than built: listing alternate physical releases/editions of a film once it's been identified (e.g. "here are the other known DVD/Blu-ray releases of this film"). This hits a hard data-availability wall rather than an effort one — OMDB holds exactly one entry per film with no per-edition/per-pressing data at all, and no API in this stack tracks that (Blu-ray.com, which would have it, has no API and is already excluded entirely — see above). The user's plan is to invent spreadsheet categories/manual workarounds for this instead, to be specified later (see Claude/To Do list.md's BACKLOG).
5. **Collections**: since individual titles inside a box set have no barcode of their own, the resolver additionally strips filler words from the collection's product title ("4-Film Collection", "Box Set") to extract a likely franchise/director/actor name, searches OMDB for that, and presents the results as a checklist in the review screen ("which of these are actually in this set?") rather than assuming automatically. Checked titles get their own prefilled entries; an "add a title not found here" manual option covers gaps. Each member title keeps its own real, verbatim `title` (confirmed against the live data - e.g. "The 39 Steps", "Sabotage") plus a `name_of_collection` naming the physical box set; when a box set's own name is too vague to be unique on its own (e.g. "Hugh Grant Collection 4 Favourites" — there could be more than one box set with that same base name over time), the user's convention is to suffix `name_of_collection` with a colon and the comma-separated list of titles actually inside that specific set (confirmed in the real data, e.g. "Alfred Hitchcock A Collection of 10 Classic Alfred Hitchcock Movies: Murder, The Skin Game, Rich and Strange, ..."). This doesn't affect single-title backfill matching (point 8 below), which matches on `title`, not `name_of_collection` - but it will matter once box-set barcode matching is built: disambiguating which physical box set a scan belongs to must compare the full colon-suffixed `name_of_collection` string, not just its vague prefix.
6. **Documentary chronology**: the user's physical shelf splits documentaries into a contemporary/alphabetical section and a "History Documentary" section ordered by the era each one *depicts* (often explicit in the title/synopsis — "The Spanish Civil War", "1936-1939"). A nullable `depicted_era_start` (integer year) column on `titles` is prefilled by a regex pass over the title+synopsis looking for a year/decade/range, falling back to a manual field when nothing is found — no LLM/AI inference call added for this, the regex-plus-manual-fallback approach covers what the user described.
7. On confirm, the completed entry (and every checked title in a collection) is written to Supabase, then to the Sheet.
8. **Backfill matching** (single-title scans only, not yet extended to collections): before creating a new row, the confirm flow checks whether the chosen title is already in the collection without a barcode attached — the actual bulk-backfill case, since most of the ~3,063 existing entries were typed in from the Sheet and have never been scanned. Matching is by base title text (ignoring cut-suffix differences like "Final Cut"/"Director's Cut" — the user names titles verbatim except when a box set distinguishes cuts inline), then narrowed using format/disc-count hints pulled from the UPC product text, but only when a hint actually narrows the set — an unreliable hint should never eliminate a real candidate. If exactly one candidate remains, it's offered as an automatic match; if more than one remains, the user picks from the narrowed list; if none match, it proceeds to create a new row as normal. Attaching to an existing entry only ever sets the barcode + case image plus a conservative refresh of fields that genuinely come from IMDb/OMDB (release date, genre, director, rating, IMDb page) — never packaging fields the user already entered by hand (format, disc count, disk region, franchise, genre location, etc.), and never runtime when the matched title looks like a specific cut/edition, since OMDB only has one canonical runtime per film, not one per cut.
9. Shelf-location suggestion: alphabetical order within `genre_location`, except when `genre_location` is the History Documentary bucket, which orders by `depicted_era_start` instead.
10. The scanner returns to the camera view, ready for the next disc.

Note: neither Rotten Tomatoes nor Letterboxd exposes a public API. Their scores are needed for search/sort (WEB APP DESIGN.md's Advanced Search filters) but not for identifying a disc, so fetching those can happen asynchronously after the entry is created rather than blocking the scan flow.



**WEB APP UI**

Directly follows WEB APP DESIGN.md — Next.js implementing the Home/Browse page (header with logo/search/settings, Netflix-style scrolling rows that each terminate rather than looping forever), the four title-page templates (Movie/TV, DVD, DVD Collection, Cast/Crew/Franchise), and Advanced Search with filter chips, range sliders, and saved taste profiles. Design system: dark gradient background, rigid non-rounded icons/triangles, light blue accents, per the concept-design references in Claude/concept design/. Tailwind CSS is a natural fit for implementing that design language quickly and consistently across both apps (Tailwind/NativeWind on the Expo side).

Taste-profile "middle ground" matching (Aim Four) lives in packages/shared as a pure function so both apps call the same logic: each profile is a set of filter constraints, and matching two profiles means intersecting their constraint ranges rather than merging two separate search results.



**DIRECT DATABASE ACCESS**

The settings page's "Direct Database Access" entry (WEB APP DESIGN.md) is a spreadsheet-like admin UI: global + per-column search, multi-row selection that pins matches to the top of the list, and bulk-edit (editing one selected cell propagates to all selected rows). Because this writes directly to Supabase, it's gated behind the owner's Supabase Auth session — it should not be reachable, even by URL, without authentication. Edits made here flow through the same Sheet-sync path as any other write.



**AUTH**

Single owner account via Supabase Auth, used only to gate write access (barcode-scan submissions, Direct Database Access, any future settings). Taste profiles (Aim Four) do not need real user accounts — they're closer to named presets a household member fills out for a movie night — so they can be stored as simple named rows rather than requiring login, unless the user later wants profiles to persist per person across devices.



**PUBLIC VS PRIVATE BUILD PIPELINE**

The private repo/project is the actual working codebase. A script in scripts/ generates the sanitized public repo before each GitHub push described in Claude.md:
- Points environment config at the public Supabase project instead of the private one.
- Excludes any Letterboxd integration code (Claude.md: the public build disincludes potential Letterboxd features).
- Confirms taste-profile names in the public dataset are placeholders, not real names.

This keeps the "public build = subset + anonymized" rule enforced by tooling rather than by memory.



**HOSTING / KEEP-ALIVE**

Both Supabase projects are on the free tier, which auto-pauses a project after 7 days with no activity (confirmed by an actual pause-warning email Supabase sent for the public project in September 2026, since it's a demo dataset that doesn't get real day-to-day traffic the way the private project does from personal scanning/testing). A pause is recoverable within 90 days from the dashboard, but the goal is to just not let it happen.

Fix: scripts/src/keep-alive.ts does a trivial read (select unique_id from titles limit 1) against each project it has credentials for, and .github/workflows/keep-alive.yml runs it on a schedule (every 3 days, comfortably inside the 7-day window) via GitHub Actions - so it keeps running even if no one's local machine is on. Credentials are GitHub Actions repo secrets: SUPABASE_URL/SUPABASE_ANON_KEY for the private project, PUBLIC_SUPABASE_URL/PUBLIC_SUPABASE_ANON_KEY for the public one. Both use the anon key rather than the service-role key the other scripts in this folder need - titles' RLS already permits a public select, so there's no reason to hand a more powerful key to a scheduled CI job than the task requires. Either target is skipped rather than failed if its secrets aren't set, so this doubles as a runnable-by-hand single-project check (npm run keep-alive from the repo root) when only one side is configured locally. A failed ping exits non-zero, which shows as a red Action run and (per GitHub's default notification settings) emails the repo owner - a free early-warning signal if a project's URL/key ever goes stale, separate from the inactivity-pause problem this was built to solve.



**SECURITY & SECRETS**

- All API keys/secrets live in .env.local (gitignored) and Vercel/EAS project environment settings — never committed, per Claude.md's stability/security section.
- Supabase Row Level Security is the actual access boundary for reads/writes, not just conditional UI rendering.
- Public-facing API routes get basic rate limiting to prevent the spam/DoS concern Claude.md raises.
- If case images or any private data go through Supabase Storage, private buckets use signed URLs rather than public links.
- Because Rotten Tomatoes/Letterboxd/Blu-ray.com have no public API, any scraping must be low-volume and respectful of robots.txt/ToS — this is a legal/ethical constraint worth re-checking at implementation time, not just a technical one.



**PHASED BUILD ORDER**

This refines STEP BY STEP PROCESS AND AUTOMATION.md's existing sequence into engineering phases. Each phase maps back to the section of that document it fulfills.

Phase 0 — Foundations (done)
Turborepo, both Supabase projects, the core schema, and the real ~3,063-row collection synced from the Sheet into the private project. (Maps to STEP BY STEP PROCESS AND AUTOMATION.md's SETUP and steps 1-4 of STEP BY STEP PROCESS FOR ENTIRE BUILD.)

Phase 1 — Barcode Scanning
The scan → queue → resolve → review/confirm pipeline (including collections and documentary chronology, brought forward into this phase rather than deferred), the shelf-location suggestion, and the bidirectional Sheet ⇄ Supabase sync. (Maps to BARCODE SCANNING and steps 5-7.)

Phase 2 — Web Browse/Search
Header, Home/Browse rows, basic search, and the four title-page templates. (Maps to WEB APP DESIGN.md HOME/BROWSE PAGE and TITLE PAGES, and steps 8-13.)

Phase 3 — Advanced Search & Taste Profiles
Filter/sort UI and the taste-profile middle-ground matching. (Maps to WEB APP DESIGN.md ADVANCED SEARCH FEATURES and steps 14-15.)

Phase 4 — Direct Database Access & Hardening
Admin bulk-edit UI, then the security/efficiency pass and the public-repo sanitization pipeline. (Maps to WEB APP DESIGN.md DIRECT DATABASE ACCESS and steps 16-21.)

Each phase ends with the bugfix/refine step the original document already specifies before moving on.



**BACKLOG (superseded or deferred decisions)**

- Original STEP BY STEP PROCESS AND AUTOMATION.md phrasing left the database engine unspecified ("may or may not be made with SQL"). Decided: Postgres via Supabase.
- A browser-based PWA scanner (using the phone browser's camera, no separate app) was considered as a lower-effort alternative to a native app, and rejected in favor of Expo/React Native to match the original "export as .apk" vision.
- An early Phase 1 draft deferred collections and documentary chronological ordering to a later phase; the user asked for both to be tackled within Phase 1 itself instead (deprioritized to build last within it, not pushed to a separate phase) — see BARCODE SCANNING PIPELINE above.
- Considered live per-scan lookup (scan → immediate API call → show match) as the barcode-scanning flow; rejected once the user clarified the entire existing collection needs backfilling in bulk, since a 100/day free API limit would then gate physical scanning speed. Decoupled via a pending_scans queue + separate resolver instead.
