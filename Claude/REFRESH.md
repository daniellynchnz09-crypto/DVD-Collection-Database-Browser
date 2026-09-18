**REFRESH**

Read this first in a new session, before diving into any other document. It's a condensed map of the whole project, not the source of truth on any one topic - every claim below links to the file that actually owns the detail. Skim this, then open only what the current task needs.



**WHAT THIS PROJECT IS**

A personal physical-media collection database (DVD/Blu-ray/4K UHD/VHS/CD, ~3,063 items) currently tracked in a Google Sheet, being turned into: a fast barcode-scan logging app (so the user can catalogue new/existing discs without accidentally re-buying a duplicate), a proper Postgres database that takes over from the Sheet as the source of truth, and a Netflix/IMDb-style web+mobile browse/search app with taste-profile "movie night" matching and a shelf-location suggestion feature. Full detail: `Claude.md` (root, project charter) and `AIM.md` (the five original Aims this all maps back to).



**CURRENT STATUS**

Phase 1 (Barcode Scanning) is in progress - Phase 0 (monorepo + both Supabase projects + the real collection synced in) is done. See `TECH STACK AND ARCHITECTURE/INDEX.md`'s PHASED BUILD ORDER for what each phase covers, and `Prompt Journal.md` (bottom of the file) for exactly what happened most recently - always check its last few entries before assuming what state the code is in.

For open work: `To Do list.md`'s BACKLOG (features/fixes not yet done) and `Bug list.md` (known bugs/security gaps not yet resolved).



**REPO / INFRASTRUCTURE AT A GLANCE**

- One monorepo (Turborepo + npm workspaces): `apps/web` (Next.js, browse/search + every scan API route), `apps/mobile` (Expo/React Native, the barcode scanner + review/confirm UI), `packages/shared` (types + logic used by both apps), `packages/backend` (Node-only logic like image matching, used by `apps/web`/`scripts/` but never `apps/mobile`), `scripts/` (Sheet⇄Supabase sync jobs, one-time backfills, the public-repo sanitizer). Full detail: `TECH STACK AND ARCHITECTURE/repo-layout.md`.
- **Two Supabase projects**, not one filtered database: a private project (`lpbsypfwhjluwuosrgnd`, the real ~3,063-item collection, real names) and a public project (`azfpstsvngohgktjilms`, only Friends/X-Men/Star Wars/the Film Noir boxset, anonymized taste profiles). Schema changes must be applied to **both**. Detail: `TECH STACK AND ARCHITECTURE/database-design.md`.
- **Two GitHub repos** (public demo + private full build) generated from one working codebase via `scripts/src/sanitize-public-repo.ts` - see `TECH STACK AND ARCHITECTURE/deployment-and-security.md`.
- The Google Sheet is still live and bidirectionally synced with the private Supabase project (Apps Script `onEdit` trigger one way, app writes pushed back via the Sheets API the other) - see `TECH STACK AND ARCHITECTURE/google-sheet-sync.md`.



**WHERE EVERYTHING LIVES (Claude/ folder map)**

- `Claude.md` (root, one level up) - the original project charter: deliverables, GitHub public/private policy, security posture. Rarely changes; read it once, not every session.
- `AIM.md` - the five original Aims (speed up logging, browse/search web app, sharable collection browser, taste-profile matching, shelf-location suggestion).
- `DEFINITIONS.md` - project-specific vocabulary (Steelbook, Movie Cuts, Remakes, Collection, "SQL Database" meaning Postgres/Supabase). **Existing entries here are never modified, only added to.**
- `RESOURCES.md` - the real Google Sheet's exact column schema, and every external data source (Rotten Tomatoes, Letterboxd, IMDb/OMDB, Blu-ray.com) with notes on API availability.
- `STEP BY STEP PROCESS AND AUTOMATION.md` - the original build sequence; `TECH STACK AND ARCHITECTURE/INDEX.md`'s PHASED BUILD ORDER maps each phase back to specific steps here.
- `WEB APP DESIGN.md` - the browse/search web app's screen-by-screen design (Home/Browse, title-page templates, Advanced Search, Direct Database Access).
- `TECH STACK AND ARCHITECTURE/` - the concrete technical design, split across files by topic (start at `INDEX.md`). This is where almost all "how does X actually work" answers live.
- `To Do list.md` - BACKLOG of not-yet-done work, plus a running list of completed items struck through with `~~...~~` and a summary of what was actually done.
- `Bug list.md` - known bugs/security issues not yet resolved.
- `Prompt Journal.md` - dated chronological log of every session's prompts and what was done/verified. **The lookup history** - check the tail of this file to know what just happened. Must get at least one entry per session (added 2026-09-14 as a standing rule, after the file was found to have fallen behind).
- `concept design/` - reference images for the web app's visual style (not text docs).



**STANDING RULES FOR EVERY SESSION**

- **Update `Prompt Journal.md` before the session ends** - at least one dated entry, even for a small fix.
- **Ask clarifying questions before implementing anything ambiguous**, especially data-modeling/matching/categorization decisions - the user has specific, sometimes idiosyncratic conventions (e.g. the box-set colon-suffix naming rule in `TECH STACK AND ARCHITECTURE/barcode-scanning-pipeline.md`) that are easy to get wrong by assuming a generic default.
- **Write real design decisions into the relevant planning doc as they're made**, not just into chat - this file and the rest of `Claude/` are what future sessions actually see; move a superseded decision to a BACKLOG section rather than deleting it.
- **Never leave test/debug data in the real collection** - delete any test scan/title from both Supabase and the Sheet immediately after verifying a fix (see `Prompt Journal.md`'s many "deleted the temporary row immediately afterward" notes).
- **Testing the barcode scanner requires both dev servers running**: `npx expo start` (apps/mobile) AND `npm run dev` (apps/web) - see `TECH STACK AND ARCHITECTURE/barcode-scanning-pipeline.md` for the exact failure mode when only one is up.
- **Database migrations run via the Supabase Management API** (direct Postgres/psql is blocked from this environment) using a short-lived personal access token the user provides in-chat when needed - never persisted, requested fresh each time. See `TECH STACK AND ARCHITECTURE/deployment-and-security.md`.
- **Every change gets pushed to both GitHub repos** (public + private) per `Claude.md`'s policy - excluding edits to `Claude/`'s own planning docs.
