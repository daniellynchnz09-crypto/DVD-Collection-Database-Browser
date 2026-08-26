**TECH STACK AND ARCHITECTURE**

This document turns the plan in AIM.md and STEP BY STEP PROCESS AND AUTOMATION.md into a concrete technical design. It doesn't replace those documents, it specifies how to build what they describe. If a future session changes any of these decisions, update this file and move the old decision to the Backlog section at the bottom rather than deleting it.



**REPO / MONOREPO LAYOUT**

One monorepo (Turborepo + pnpm workspaces) during development, split into the public/private GitHub repos described in Claude.md at publish time (see PUBLIC VS PRIVATE BUILD PIPELINE below).

- apps/web — Next.js (TypeScript) web app. Deployed to Vercel. This is the Netflix/IMDB-hybrid browse and search experience described in WEB APP DESIGN.md.
- apps/mobile — Expo/React Native app. Same browse/search UI reused where practical, plus the barcode scanner screen. Exported to an APK via `eas build --platform android` so it can be sideloaded per STEP BY STEP PROCESS AND AUTOMATION.md's "export as .apk" note.
- packages/shared — TypeScript types for the DVD/collection schema, the Supabase client wrapper, and search/filter/taste-profile logic used by both apps so the matching algorithm only exists once.
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

Direction starts one-way (Sheet → Supabase), because ~3,000 existing entries already live in the Sheet and Supabase starts empty. A Google Apps Script `onEdit` trigger posts changed rows to a small sync endpoint (a Vercel API route or a Supabase Edge Function), which upserts into Postgres keyed on unique_id.

Once the app can also originate writes (barcode scans, or edits made through Direct Database Access), those writes go to Supabase first, then push back to the Sheet via the Sheets API, so both stay in sync. The `last_updated` column is what lets the sync logic detect which side changed most recently and avoid clobbering a newer edit. Supabase remains the source of truth for anything the live app reads, per STEP BY STEP PROCESS AND AUTOMATION.md step 1 — the Sheet becomes a mirror/manual-entry surface rather than the primary store.



**BARCODE SCANNING PIPELINE (Aim One)**

1. Expo camera screen (expo-camera / a barcode-scanning library) reads the UPC/EAN barcode on the disc case.
2. The barcode is looked up against a UPC/EAN lookup service to identify the physical release.
3. Cross-reference against Blu-ray.com for disc-specific details (region, disc count, special features) — Blu-ray.com has no public API, so this step is either a careful, low-volume/rate-limited fetch or, if that proves unreliable or against their terms, a manual-entry fallback. This should be revisited once we're actually implementing it.
4. Cross-reference against OMDB for movie metadata (OMDB is prioritized over IMDB per RESOURCES.md, since OMDB has a public API and IMDB does not).
5. Anything still unresolved is asked of the user through a sequence of dialog boxes (mirroring how Claude's own clarifying-question UI works, per STEP BY STEP PROCESS AND AUTOMATION.md), skipping fields that don't apply (e.g. never asking for a season number on a movie).
6. The completed entry (and, if applicable, every title in a collection at once) is written to Supabase, then synced to the Sheet.
7. A shelf-location suggestion is computed from genre_location: alphabetical order within that genre, by release date for same-titled entries, with the historical-chronology exception for documentaries called out in STEP BY STEP PROCESS AND AUTOMATION.md.
8. The scanner returns to the camera view, ready for the next disc.

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



**SECURITY & SECRETS**

- All API keys/secrets live in .env.local (gitignored) and Vercel/EAS project environment settings — never committed, per Claude.md's stability/security section.
- Supabase Row Level Security is the actual access boundary for reads/writes, not just conditional UI rendering.
- Public-facing API routes get basic rate limiting to prevent the spam/DoS concern Claude.md raises.
- If case images or any private data go through Supabase Storage, private buckets use signed URLs rather than public links.
- Because Rotten Tomatoes/Letterboxd/Blu-ray.com have no public API, any scraping must be low-volume and respectful of robots.txt/ToS — this is a legal/ethical constraint worth re-checking at implementation time, not just a technical one.



**PHASED BUILD ORDER**

This refines STEP BY STEP PROCESS AND AUTOMATION.md's existing sequence into engineering phases. Each phase maps back to the section of that document it fulfills.

Phase 0 — Foundations
Set up the Turborepo, both Supabase projects, the core schema, and the one-way Sheet → Supabase sync. (Maps to STEP BY STEP PROCESS AND AUTOMATION.md's SETUP and steps 1-4 of STEP BY STEP PROCESS FOR ENTIRE BUILD.)

Phase 1 — Barcode Scanning
Build the Expo scanner screen, the lookup/cross-reference pipeline, the manual-fill dialog flow, and the shelf-location suggestion. (Maps to BARCODE SCANNING and steps 5-7.)

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
