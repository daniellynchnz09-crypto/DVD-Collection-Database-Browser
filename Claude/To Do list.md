To Do list

A number of tasks outlined in either the supporting documents, or tasks that the user has given to claude code that aren't to be resolved right away due to their size or the fact that they aren't currently relevant to the task on hand



1\. **Direct Letterboxd data import in the app (added 2026-10-07, the user's request).** Today a fresh Letterboxd export only reaches the database when Claude runs the import scripts by hand (`scripts/src/import-letterboxd.ts` for ratings -> titles.personal_rating, `import-letterboxd-reviews.ts` for reviews -> letterboxd_reviews / letterboxd_serial_reviews, reading a locally unzipped `Letterboxd/<export>/` folder). The goal: the application processes new Letterboxd data itself. For example, an owner-only upload (the export ZIP or its CSVs) on the website, behind owner sign-in or the owner passcode, that runs the same matching (letterboxdMatch: normalized title + release year within one, exactly-one-match rule, Doctor Who serial matching) and shows a dry-run summary (new/changed ratings, new reviews, ambiguous or unmatched names) before applying. Private build only (no Letterboxd features in the public build). Open questions for the user when we get to it: upload the ZIP vs. the separate CSVs; whether to also pull from the public Letterboxd RSS feed for 'heygoogoo' automatically (newest diary entries only, no full history); how to resolve ambiguous matches in the UI.

2\.

3\.



**BACKLOG**

Add letterboxd integration to the web app related to the profile 'heygoogoo' titles will show if 'heygoogoo' has watched a movie or reviewed it and what they scored it etc. perhaps option to allow for other chosen letterboxd profiles to be intergrated.



Design the logo for the web app (2026-10-07: the user is happy with the text logo "DANFLIX 5.0" for now - keep as is)

~~Test the Price Analytics provider for Estimated Value~~ Dropped by the user 2026-10-07 ("forget" it) - kept here only as a record.

Add More settings to the settings feature in the web app



Intergrate Danfl1x 4.0 titles from server into web app and database somehow, ask me specifically about this if we get up to it, as I might end up writing out a whole other document to explain this



~~Build the public-repo sanitization script...~~ Done in Phase 0 (scripts/src/sanitize-public-repo.ts).

If the barcode-backfill queue (Phase 1) feels too slow on UPCitemdb's free 100/day tier, consider paying for a single month of their $99/mo DEV tier (20,000/day) to blast through the backlog, then drop back to free for ongoing 20-50/day use. Not decided - just here so it isn't forgotten as an option.

Listing alternate physical editions/releases of a film once it's been identified during barcode scanning (e.g. "this is Paper Planes (2014) - here are its other known DVD/Blu-ray releases") - explicitly moved to the backlog rather than built, since no database of DVD/Blu-ray edition data appears to exist anywhere online that this project can actually reach (Blu-ray.com has the closest thing but no API, and OMDB/UPCitemdb only track one entry per film, never per physical release). The user's plan instead: invent new spreadsheet categories/columns and manual workarounds to cover this later, to be revisited and specified when we get to it.

Rental Dashboard + DVD Page rental controls (Phase 2+ web app) - see WEB APP DESIGN.md's "RENTAL DASHBOARD" and DVD Pages sections for the full plan. Not built yet since the web app has no browse/DVD-page UI at all yet (only the Phase 1 scan-confirm API routes exist so far) - revisit once Phase 2's title pages exist to build the rental control against.

TMDb attribution: once the actual browsable web app (Phase 2+) displays Rating/Studio data pulled from TMDb (see Claude/TECH STACK AND ARCHITECTURE/backfill-rescan-and-letterboxd.md's TMDb Terms of Use note), TMDb's API Terms of Use require showing their logo plus the exact notice "This [product] uses TMDB and the TMDB APIs but is not endorsed, certified, or otherwise approved by TMDB" (less prominent than the app's own branding). Not needed for the mobile scan-confirm tool itself (private, single-owner), only for the public-facing web UI once it exists.

~~**Known bug (2026-09-18)**: titles with an RT score but no rotten_tomatoes_page link~~ Done 2026-10-07: scripts/src/backfill-rotten-tomatoes-links.ts took each film's real RT path and Tomatometer from MDBList (batched, no OMDb calls), checked every link answered 200, and filled 76 Sheet rows (67 films) plus the same rows in Supabase. 463 films have an RT page but no critics score, so per RESOURCES.md they stay unlinked. Re-run it after big imports. Original note: **Known bug (2026-09-18), user says fix later**: 47 titles have a confirmed Rotten Tomatoes score but no `rotten_tomatoes_page` link saved - the automated slug-guessing lookup (`rottenTomatoes.ts`) can't find every real RT URL (their robots.txt disallows scraping `/search`, so there's no automated fallback available). Run `npm run find-missing-rotten-tomatoes --workspace=scripts` (read-only audit) to get the current list, then manually search Rotten Tomatoes for each and paste the real URL into that title's cell in the Sheet. Full root cause in `Claude/TECH STACK AND ARCHITECTURE/barcode-scanning-pipeline.md`'s "ROTTEN TOMATOES LINK GAPS" section.

**Scan-the-cover feature (2026-09-18)** - deliberately deferred until after Collection and TV series integration is sorted, per the user's own explicit sequencing. The idea: extend the vision-model format detection already built (`formatVision.ts`) into a proper "scan the cover" mode, not exclusive to barcode scanning - the user's own framing is "you can choose to scan the cover or the barcode or both, one is not exclusive to the other, but scanning both of course could get the most detail." From a single cover photo alone (no web search needed), the user expects we could realistically pull: title, format, disc count, edition/cut, a usable product image (the photo itself), the format of any special-features disc (already proven via the "4K UHD + Blu-Ray" banner-reading logic), franchise, an estimated price (if a price tag/sticker is still visibly attached to the cover), and a rating (PG/G/M/etc., if printed on the cover art). Not specified yet: the actual camera UI/flow for a cover-scan mode, or how its results would merge with a barcode scan's own results when both are used together on the same disc.

**Public project Studio dedup** - checked 2026-10-07 via the Management API: the public project's titles table is empty (0 rows; the demo set was never seeded), so there is nothing to fix. Sheet syncs and scans normalize Studio automatically, so the demo data will arrive clean when it is seeded. Original note: **Public project Studio dedup, not yet checked (2026-09-20)**: the Studio-column normalization (see `database-design.md`'s Studio normalization note) was verified end-to-end against the private Supabase project, but the public demo project's `titles` table returned 0 rows via its anon key when checked - no service-role key is stored for that project in this environment, so its own data couldn't be read or fixed this session. Revisit once that project's data is next refreshed from the private one, or a service-role key is provided.

**Miss Marple revisit (2026-09-18)**: "Miss Marple: The Blue Geranium" and "Miss Marples: The Pale Horse" were reclassified from `movie_or_tv="Movie"` to `"TV Movie"` (with the stray `season_no="Unknown"` cleared) as part of the TV-scanning normalization pass - see `Claude/TECH STACK AND ARCHITECTURE/barcode-review-screen-fields.md`'s TV Scanning section. The user flagged that these might really be better modeled as a 2-disc collection of 2 TV movies (IMDb nests them inside a nominal "series" with an "Unknown" season) rather than two independent TV Movie rows - deliberately left as plain TV Movie rows for now since Collection support isn't built yet; revisit once it is.

~~Collection-wide misspelling audit~~ Done. Audited all 3,064 titles (movies + TV/documentary) against the fuzzy TMDb title indexes, found 199 genuine misspellings (systematic ones like "Carribbean"->"Caribbean", "Abbot"->"Abbott" across ~16 rows, "Tripple"->"Triple" across 11 rows, "Downtown Abbey"->"Downton Abbey", plus ~180 one-off typos). Reported as a filterable web page; the user then approved fixing all of them except "Devilship Pirates" and "The Compelete Claymation Minifigger Collection" (left as-is on request). 198 corrections applied to both the Sheet and Supabase (`scripts/src/backfill-misspelling-corrections.ts`, one-time/already run) - 2 title-text drifts between the audit snapshot and the live Sheet (a trailing space, and a box-set description that had grown since the audit ran) were caught and fixed by hand during the same pass. This surfaced two follow-on features, both built the same session: the "custom/homemade disc" spellcheck-skip toggle and the Pending Scans "+" manual-entry button (both in Claude/TECH STACK AND ARCHITECTURE/barcode-review-screen-fields.md's manual title-search section) - the TV/documentary spelling fixes themselves are done, but no equivalent live spellcheck-skip/fuzzy-index wiring exists for TV search yet (the manual title-search route is movie-only), since TV wasn't scanned via barcode in this pass at all.



**SCANNER APP ROADMAP (given by the user 2026-09-19, for the session after the weekly limit reset, Tuesday)**

Order of work. The user does the testing and critique at each "user" step; Claude fixes what they report:

1. User bug-fixes and critiques the single-title SLIDES design until it is right and fast to use (built 2026-09-19: match page first, Review last with expanding rows, big-button slides, FranchiseEditor; see Prompt Journal).
2. ~~Move the slides format to COLLECTIONS~~ Done 2026-09-22 - both the Collection header (`ConfirmScreen.tsx`'s `isCollectionOverride` branch) and the per-member "add/edit a title" form (`TitleSearchPicker.tsx`) are now `SlideFlow`-based, matching the single-title flow's own shape/look (BigChoice/SummaryRow reused throughout). Not yet tested on the phone - see the matching Prompt Journal entry for the exact slide breakdown.
3. User bug-fixes, tests and critiques the collection slides.
4. User stress-tests the system with a very complex Doctor Who title (many stories/discs/seasons, lots of extras).
5. Integrate the FRONT-of-case cover scan (approved plan: photo slide, migration `case_photo_path`, Gemini reads the photo, web image priority = scan photo > UPC image > Estimated Value image; plan file was `C:\Users\OEM\.claude\plans\compiled-singing-ocean.md`, Phase 2 - not started).
6. User bug-fixes, tests and critiques the cover scan design.
7. "Metalheart" design pass (the user's name for the visual design pass).
8. Big bug-fix / efficiency / security scan of the scanner app.
9. Move on to the next project phase.

Open loose ends going into Tuesday: nothing pushed to GitHub this session; slides (single-title) and the barcode-number-in-title fix are untested by the user beyond the first look; 143 Letterboxd review items unresolved; Price Analytics provider untested.
