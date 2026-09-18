To Do list

A number of tasks outlined in either the supporting documents, or tasks that the user has given to claude code that aren't to be resolved right away due to their size or the fact that they aren't currently relevant to the task on hand



1\.

2\.

3\.



**BACKLOG**

Add letterboxd integration to the web app related to the profile 'heygoogoo' titles will show if 'heygoogoo' has watched a movie or reviewed it and what they scored it etc. perhaps option to allow for other chosen letterboxd profiles to be intergrated.



Design the logo for the web app

Add More settings to the settings feature in the web app



Intergrate Danfl1x 4.0 titles from server into web app and database somehow, ask me specifically about this if we get up to it, as I might end up writing out a whole other document to explain this



~~Build the public-repo sanitization script...~~ Done in Phase 0 (scripts/src/sanitize-public-repo.ts).

If the barcode-backfill queue (Phase 1) feels too slow on UPCitemdb's free 100/day tier, consider paying for a single month of their $99/mo DEV tier (20,000/day) to blast through the backlog, then drop back to free for ongoing 20-50/day use. Not decided - just here so it isn't forgotten as an option.

Listing alternate physical editions/releases of a film once it's been identified during barcode scanning (e.g. "this is Paper Planes (2014) - here are its other known DVD/Blu-ray releases") - explicitly moved to the backlog rather than built, since no database of DVD/Blu-ray edition data appears to exist anywhere online that this project can actually reach (Blu-ray.com has the closest thing but no API, and OMDB/UPCitemdb only track one entry per film, never per physical release). The user's plan instead: invent new spreadsheet categories/columns and manual workarounds to cover this later, to be revisited and specified when we get to it.

Rental Dashboard + DVD Page rental controls (Phase 2+ web app) - see WEB APP DESIGN.md's "RENTAL DASHBOARD" and DVD Pages sections for the full plan. Not built yet since the web app has no browse/DVD-page UI at all yet (only the Phase 1 scan-confirm API routes exist so far) - revisit once Phase 2's title pages exist to build the rental control against.

TMDb attribution: once the actual browsable web app (Phase 2+) displays Rating/Studio data pulled from TMDb (see Claude/TECH STACK AND ARCHITECTURE/backfill-rescan-and-letterboxd.md's TMDb Terms of Use note), TMDb's API Terms of Use require showing their logo plus the exact notice "This [product] uses TMDB and the TMDB APIs but is not endorsed, certified, or otherwise approved by TMDB" (less prominent than the app's own branding). Not needed for the mobile scan-confirm tool itself (private, single-owner), only for the public-facing web UI once it exists.

**Known bug (2026-09-18), user says fix later**: 47 titles have a confirmed Rotten Tomatoes score but no `rotten_tomatoes_page` link saved - the automated slug-guessing lookup (`rottenTomatoes.ts`) can't find every real RT URL (their robots.txt disallows scraping `/search`, so there's no automated fallback available). Run `npm run find-missing-rotten-tomatoes --workspace=scripts` (read-only audit) to get the current list, then manually search Rotten Tomatoes for each and paste the real URL into that title's cell in the Sheet. Full root cause in `Claude/TECH STACK AND ARCHITECTURE/barcode-scanning-pipeline.md`'s "ROTTEN TOMATOES LINK GAPS" section.

**Scan-the-cover feature (2026-09-18)** - deliberately deferred until after Collection and TV series integration is sorted, per the user's own explicit sequencing. The idea: extend the vision-model format detection already built (`formatVision.ts`) into a proper "scan the cover" mode, not exclusive to barcode scanning - the user's own framing is "you can choose to scan the cover or the barcode or both, one is not exclusive to the other, but scanning both of course could get the most detail." From a single cover photo alone (no web search needed), the user expects we could realistically pull: title, format, disc count, edition/cut, a usable product image (the photo itself), the format of any special-features disc (already proven via the "4K UHD + Blu-Ray" banner-reading logic), franchise, an estimated price (if a price tag/sticker is still visibly attached to the cover), and a rating (PG/G/M/etc., if printed on the cover art). Not specified yet: the actual camera UI/flow for a cover-scan mode, or how its results would merge with a barcode scan's own results when both are used together on the same disc.

**Miss Marple revisit (2026-09-18)**: "Miss Marple: The Blue Geranium" and "Miss Marples: The Pale Horse" were reclassified from `movie_or_tv="Movie"` to `"TV Movie"` (with the stray `season_no="Unknown"` cleared) as part of the TV-scanning normalization pass - see `Claude/TECH STACK AND ARCHITECTURE/barcode-review-screen-fields.md`'s TV Scanning section. The user flagged that these might really be better modeled as a 2-disc collection of 2 TV movies (IMDb nests them inside a nominal "series" with an "Unknown" season) rather than two independent TV Movie rows - deliberately left as plain TV Movie rows for now since Collection support isn't built yet; revisit once it is.

~~Collection-wide misspelling audit~~ Done. Audited all 3,064 titles (movies + TV/documentary) against the fuzzy TMDb title indexes, found 199 genuine misspellings (systematic ones like "Carribbean"->"Caribbean", "Abbot"->"Abbott" across ~16 rows, "Tripple"->"Triple" across 11 rows, "Downtown Abbey"->"Downton Abbey", plus ~180 one-off typos). Reported as a filterable web page; the user then approved fixing all of them except "Devilship Pirates" and "The Compelete Claymation Minifigger Collection" (left as-is on request). 198 corrections applied to both the Sheet and Supabase (`scripts/src/backfill-misspelling-corrections.ts`, one-time/already run) - 2 title-text drifts between the audit snapshot and the live Sheet (a trailing space, and a box-set description that had grown since the audit ran) were caught and fixed by hand during the same pass. This surfaced two follow-on features, both built the same session: the "custom/homemade disc" spellcheck-skip toggle and the Pending Scans "+" manual-entry button (both in Claude/TECH STACK AND ARCHITECTURE/barcode-review-screen-fields.md's manual title-search section) - the TV/documentary spelling fixes themselves are done, but no equivalent live spellcheck-skip/fuzzy-index wiring exists for TV search yet (the manual title-search route is movie-only), since TV wasn't scanned via barcode in this pass at all.

