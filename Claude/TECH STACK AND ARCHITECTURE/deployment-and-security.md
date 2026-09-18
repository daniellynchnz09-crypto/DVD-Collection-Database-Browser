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
- Schema changes (migrations) run against both live Supabase projects via the Management API (`api.supabase.com`), using a short-lived personal access token the user provides in-chat when needed — direct Postgres access (port 5432) is blocked from this environment's sandbox, only HTTPS is reachable. The token is used only for the immediate API calls it was given for and is never written to a file, committed, or persisted anywhere for reuse - a fresh one is requested each time a migration needs to be applied this way.
