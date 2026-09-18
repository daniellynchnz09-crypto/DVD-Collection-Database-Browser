**TECH STACK AND ARCHITECTURE**

This document turns the plan in AIM.md and STEP BY STEP PROCESS AND AUTOMATION.md into a concrete technical design. It doesn't replace those documents, it specifies how to build what they describe. If a future session changes any of these decisions, update the relevant file below and move the old decision to the BACKLOG section at the bottom of this index rather than deleting it.

Split into this folder on 2026-09-14 (originally one file) because it had grown too large to comfortably load in one piece. Each file below covers one topic; skim this index first, then open only the file(s) actually relevant to the task at hand.

**Files in this folder:**

- `repo-layout.md` — REPO / MONOREPO LAYOUT: the apps/web, apps/mobile, packages/shared, packages/backend, scripts/ split and why.
- `database-design.md` — DATABASE DESIGN: the Supabase/Postgres schema, the two-project (private/public) split, Row Level Security, and every free-text field normalization bug found and fixed (Format, Rating, Running Time, boolean Yes/No, the Sheet-append bug).
- `google-sheet-sync.md` — GOOGLE SHEET SYNC: the bidirectional Sheet ⇄ Supabase sync design (Apps Script `onEdit` trigger + `/api/sheet-webhook` one way, app writes pushed back via the Sheets API the other), and why it's immune to Sheet column reordering/deletion.
- `barcode-scanning-pipeline.md` — BARCODE SCANNING PIPELINE (Aim One): the core scan → queue → resolve → review/confirm flow, the hold-steady countdown and debounce logic, the auto-resolve poller, collections, documentary chronology, and shelf-location suggestion. **Includes the "both dev servers must be running to test scanning" gotcha.**
- `barcode-review-screen-fields.md` — the mobile Confirm screen's auto-fill and candidate-narrowing design in full: title/format pre-fill, year-based candidate filtering, cover-photo auto-matching, every autocomplete/normalized field (Disk Region, Animation/Live Action, Rating/Studio via TMDb), the multi-value Franchise field (merged with the former Sub-franchise column), the manual title-search + three-pass typo-correction fallback, in-progress draft state, and the keyboard-avoidance saga.
- `backfill-rescan-and-letterboxd.md` — the full-collection backfill rescan (which fields had to be captured physically vs. which can be backfilled later from an API, the canonical-id requirement, `disc_condition`/`case_notes`/`watched`/etc.) and the one-time Letterboxd watched-status import built alongside it (tag vocabulary, format-compatibility rules, TV/season completeness, known data-quality caveats).
- `web-app-and-auth.md` — WEB APP UI, DIRECT DATABASE ACCESS, and AUTH: the browse/search web app, the spreadsheet-like admin edit UI, and the single-owner Supabase Auth model.
- `deployment-and-security.md` — PUBLIC VS PRIVATE BUILD PIPELINE, HOSTING / KEEP-ALIVE, and SECURITY & SECRETS: how the sanitized public repo/DB is generated, why/how both free-tier Supabase projects are kept from auto-pausing, and the security posture (RLS as the real boundary, secrets handling, rate limiting, migration-via-Management-API pattern).
- `estimated-value.md` — ESTIMATED VALUE: the per-title NZD resale-value background job (search-title construction, NZ/international retail scraping, confidence scoring reusing the poster-pHash machinery, the "Pending Value" manual-review screen, and the first case where the public/private builds' database schemas actually diverge).



**PHASED BUILD ORDER**

This refines STEP BY STEP PROCESS AND AUTOMATION.md's existing sequence into engineering phases. Each phase maps back to the section of that document it fulfills.

Phase 0 — Foundations (done)
Turborepo, both Supabase projects, the core schema, and the real ~3,063-row collection synced from the Sheet into the private project. (Maps to STEP BY STEP PROCESS AND AUTOMATION.md's SETUP and steps 1-4 of STEP BY STEP PROCESS FOR ENTIRE BUILD.)

Phase 1 — Barcode Scanning (in progress)
The scan → queue → resolve → review/confirm pipeline (including collections and documentary chronology, brought forward into this phase rather than deferred), the shelf-location suggestion, and the bidirectional Sheet ⇄ Supabase sync. (Maps to `barcode-scanning-pipeline.md`, `barcode-review-screen-fields.md`, `backfill-rescan-and-letterboxd.md`, and steps 5-7.) The full-collection physical rescan and Letterboxd import are both real, scoped sub-efforts of this phase, not separate phases.

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
- An early Phase 1 draft deferred collections and documentary chronological ordering to a later phase; the user asked for both to be tackled within Phase 1 itself instead (deprioritized to build last within it, not pushed to a separate phase) — see `barcode-scanning-pipeline.md`.
- Considered live per-scan lookup (scan → immediate API call → show match) as the barcode-scanning flow; rejected once the user clarified the entire existing collection needs backfilling in bulk, since a 100/day free API limit would then gate physical scanning speed. Decoupled via a pending_scans queue + separate resolver instead.
- `imdb_id` was added as its own column during the backfill-rescan (see `backfill-rescan-and-letterboxd.md`), then dropped again (`0019_drop_imdb_id.sql`, 2026-09-14) once it became clear it was redundant with `imdb_page`, which already embeds the same id.
- `franchise`/`sub_franchise` were originally two separate scalar columns (one nesting level - franchise + one sub-franchise). Merged into one multi-value `franchise: text[]` column (`0020_merge_franchise_columns.sql`, 2026-09-14) once the user pointed out a film can belong to several franchises at once at different specificities, not just one parent/child pair - see `database-design.md`'s Franchise/sub_franchise merge note for the full design and the real-data verification behind the existing-row merge.
- `scripts/src/import-letterboxd.ts` had the same unpaginated `.from("titles").select(...)` gotcha as `find-existing/route.ts` - fixed (2026-09-14) and confirmed it was real, not theoretical: a `--verbose` dry run against the fixed version found 225 rows genuinely missing a correct `watched`/`watched_disc`/`last_watched_date` that the original capped run could never have seen. Re-run for real (`--apply`) plus a second one-off manual pass resolving the ~18 titles the script itself still couldn't disambiguate (multi-copy/format-mismatch cases) using details the user provided directly - see `backfill-rescan-and-letterboxd.md` and the Prompt Journal for the full breakdown. The script's old `letterboxd_review_queue` write path was also removed (that table was dropped in 0016 after the original review pass finished) - unresolved items are now just printed via `--verbose`, since the throwaway review page/table were a one-time tool, not meant to be rebuilt each run.
- TMDb's own `original_language` field (bare ISO 639-1 code, e.g. "en") was considered as an auto-fill source for the new `original_language` column (`0022_add_rental_and_language_fields.sql`) and initially left manual-only (a code isn't the human-readable name the field's own autocomplete vocabulary expects; a real ISO-code-to-name table would be needed first) - **built 2026-09-15**: `packages/backend/src/iso639.ts` is that table, `original_language_is_manual` (`0023_add_original_language_is_manual.sql`) follows the `rating_is_manual`/`studio_is_manual` precedent, and the field now auto-fills/hides on the scan form exactly like Rating and Studio - see `barcode-review-screen-fields.md`'s Original Language note for the full design.
- **Migration numbering collision (2026-09-14, resolved)**: a rental/rating/language feature's migration and a concurrent, independently-developed Estimated Value feature's migration both claimed `0021` at the same time, built on separate worktrees (neither depends on or conflicts with the other's actual schema changes). Resolved when merging both into `main`: Estimated Value kept `0021_estimated_value.sql` (merged first), the rental/rating/language migration was renumbered to `0022_add_rental_and_language_fields.sql`.
