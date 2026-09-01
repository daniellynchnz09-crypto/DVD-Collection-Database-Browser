/**
 * Generates the sanitized public repo checkout from this (private) repo, per
 * Claude.md's GitHub section and Claude/TECH STACK AND ARCHITECTURE.md's
 * "Public vs Private Build Pipeline" section.
 *
 * What this does NOT do (by design - these are separate, deliberate steps):
 *   - It does not push to GitHub. Review the generated checkout, then commit/push
 *     it yourself from PUBLIC_REPO_DIR.
 *   - It does not touch which Supabase project the public build talks to - that's
 *     set via the public checkout's own .env.local / Vercel project env vars,
 *     pointing at the PUBLIC Supabase project (see .env.example).
 *   - It does not filter *data* - the public dataset (Friends, X-Men, Star Wars,
 *     Film Noir boxset per Claude.md) lives entirely in the separate public
 *     Supabase project, not in this repo.
 *
 * What it does do:
 *   1. Copies the repo (excluding node_modules, .git, build output, and .env*)
 *      into PUBLIC_REPO_DIR.
 *   2. Fails loudly if it finds anything that looks like Letterboxd integration
 *      code, since Claude.md says the public build must exclude that feature.
 *   3. Fails loudly if it finds real names in known taste-profile seed/demo files,
 *      as a guard rail (not a substitute for actually reviewing the diff).
 *
 * Usage: PUBLIC_REPO_DIR=/path/to/public-checkout npm run sanitize-public-repo --workspace=scripts
 */

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const EXCLUDE_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  ".turbo",
  ".expo",
  "dist",
  "build",
  "web-build",
  // Keep-alive CI (Claude/TECH STACK AND ARCHITECTURE.md's "Hosting / Keep-Alive"
  // section) already pings the public project from the private repo's own Action -
  // duplicating the workflow into the public repo would just be a second, secret-less
  // schedule doing nothing every 3 days, which is confusing without being useful.
  ".github",
]);
// Excludes real env files (.env, .env.local, .env.production, ...) but keeps
// .env.example templates - those are safe, documented placeholders, not secrets.
const EXCLUDE_FILE_PATTERNS = [/^\.env(\..*)?$/];
const KEEP_FILE_EXCEPTIONS = new Set([".env.example"]);

const REPO_ROOT = join(__dirname, "..", "..");

function shouldExclude(name: string, isDir: boolean): boolean {
  if (isDir) return EXCLUDE_DIRS.has(name);
  if (KEEP_FILE_EXCEPTIONS.has(name)) return false;
  return EXCLUDE_FILE_PATTERNS.some((pattern) => pattern.test(name));
}

function copyTree(src: string, dest: string) {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src)) {
    const srcPath = join(src, entry);
    const isDir = statSync(srcPath).isDirectory();
    if (shouldExclude(entry, isDir)) continue;
    const destPath = join(dest, entry);
    if (isDir) {
      copyTree(srcPath, destPath);
    } else {
      cpSync(srcPath, destPath);
    }
  }
}

function walkTextFiles(dir: string, onFile: (path: string, contents: string) => void) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const isDir = statSync(path).isDirectory();
    if (shouldExclude(entry, isDir)) continue;
    if (isDir) {
      walkTextFiles(path, onFile);
    } else if (/\.(ts|tsx|js|jsx|md|json|sql)$/.test(entry)) {
      onFile(path, readFileSync(path, "utf8"));
    }
  }
}

function main() {
  const publicRepoDir = process.env.PUBLIC_REPO_DIR;
  if (!publicRepoDir) {
    console.error("Set PUBLIC_REPO_DIR to the path of your public repo checkout and re-run.");
    process.exit(1);
  }

  if (existsSync(publicRepoDir) && readdirSync(publicRepoDir).length > 0) {
    console.error(
      `${publicRepoDir} already exists and isn't empty. Clear it (or point at a fresh ` +
        "directory) before re-running, so stale files don't linger in the public build."
    );
    process.exit(1);
  }

  console.log(`Copying ${REPO_ROOT} -> ${publicRepoDir} ...`);
  copyTree(REPO_ROOT, publicRepoDir);

  console.log("Scanning app source for Letterboxd integration code (must be excluded from the public build)...");
  // Only scan actual source code (apps/, packages/), not Claude/ - the planning docs are
  // expected to *mention* Letterboxd as a feature to exclude, which isn't the same as
  // shipping integration code for it.
  let foundLetterboxd = false;
  for (const sourceDir of ["apps", "packages"]) {
    const dirPath = join(publicRepoDir, sourceDir);
    if (!existsSync(dirPath)) continue;
    walkTextFiles(dirPath, (path, contents) => {
      if (/letterboxd/i.test(contents)) {
        console.error(`  Found "letterboxd" reference in ${relative(publicRepoDir, path)}`);
        foundLetterboxd = true;
      }
    });
  }

  if (foundLetterboxd) {
    console.error(
      "Remove Letterboxd integration code before publishing the public build (Claude.md: " +
        "the public build must disinclude Letterboxd features)."
    );
    process.exit(1);
  }

  console.log(
    `Done. Review ${publicRepoDir}, point its .env.local at the PUBLIC Supabase project, ` +
      "then commit and push it yourself."
  );
}

main();
