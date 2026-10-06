/**
 * ONE-TIME backfill for titles whose `case_image_path` was stored uncropped before the
 * 2026-09-30 fix (see coverVision.ts's `detectCoverBoundingBox`/`normalizeBoxScale` and
 * Claude/TECH STACK AND ARCHITECTURE/barcode-scanning-pipeline.md's "COVER-PHOTO CROP WAS
 * SILENTLY FAILING" note): the bounding-box detection call's schema only required "found",
 * so the model frequently omitted xMax/yMax outright, or reverted to Gemini's native 0-1000
 * coordinate scale instead of the requested 0-100 percentages - either way, validation
 * rejected the result and silently fell back to the raw, uncropped phone photo. That fix is
 * forward-only (new scans only), so any title confirmed before it still has its full,
 * cluttered phone photo (desk, papers, whatever else was in frame) as its permanent case
 * image - this re-runs the now-fixed detection against every already-stored case image and
 * re-crops the ones that actually need it.
 *
 * Cheap pre-filter before spending any Gemini calls: a raw, unprocessed phone photo from
 * this collection's real scans is consistently 2-5MB (verified live against Eddington/Piece
 * by Piece/Madame Web/TMNT/Gidget), while an already-clean UPC/retailer product photo (never
 * needed this crop at all, autocropImageBuffer's uniform-border crop is enough for those) is
 * consistently under a few hundred KB (Ice Age: 45KB). Only files at or above
 * MIN_SIZE_BYTES are even downloaded/analyzed - everything else is skipped outright as
 * "clearly already a clean product photo, not a phone photo."
 *
 * For anything that IS analyzed, a detected box only counts as "needs cropping" if it's
 * meaningfully smaller than the full frame (covers less than MAX_UNCROPPED_AREA_FRACTION of
 * the total area) - a box spanning almost the whole image (e.g. an already-tightly-cropped
 * photo like Eddington, re-analyzed here for completeness) would otherwise get needlessly
 * re-uploaded for a crop that changes essentially nothing.
 *
 * `--include-small` (2026-10-06) skips that pre-filter, for the listing photos the Estimated
 * Value feature and UPC lookups stored (small files, but often a case on a table or at an
 * angle) - the user asked for those to be cropped to the case like their own photos.
 *
 * Dry run by default - only writes to the `case-images` bucket with `--apply`, same
 * convention as this project's other backfill scripts. Safe to re-run: a title that no
 * longer needs cropping (already fixed by a previous --apply run) is skipped the same way an
 * already-small product photo is.
 *
 * Plan files (2026-10-07, to spend each image's Gemini call once - the user asked for API
 * credits to go further): `--plan=<file.json>` on a dry run saves every crop it would make
 * (and `--preview-dir=<folder>` saves each cropped result for checking by eye). Then
 * `--apply --plan=<file.json>` applies exactly that plan with no Gemini calls at all. Every
 * --apply first saves the original image to `--backup-dir` (default
 * .playwright-mcp/recrop-backups, git-ignored), and `--restore --plan=<file.json>` puts those
 * originals back.
 *
 *   npm run backfill-recrop-case-images -w scripts -- --include-small --plan=recrop.json --preview-dir=previews
 *   npm run backfill-recrop-case-images -w scripts -- --apply --plan=recrop.json
 */

import "dotenv/config";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { detectCoverBoundingBox, cropImageBufferToBox } from "@danflix/backend";

const MIN_SIZE_BYTES = 500_000;
const MAX_UNCROPPED_AREA_FRACTION = 0.85;
const BUCKET = "case-images";

type Box = NonNullable<Awaited<ReturnType<typeof detectCoverBoundingBox>>>;
interface PlanEntry {
  path: string;
  titles: string[];
  box: Box;
}

const argValue = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;
const safeName = (path: string) => path.replace(/[^a-zA-Z0-9._-]+/g, "_");

async function main() {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY - copy .env.example to .env and fill them in.");
    process.exit(1);
  }
  const apply = process.argv.includes("--apply");
  const includeSmall = process.argv.includes("--include-small");
  const planPath = argValue("plan");
  const previewDir = argValue("preview-dir");
  const backupDir = resolve(argValue("backup-dir") ?? join(__dirname, "..", "..", ".playwright-mcp", "recrop-backups"));
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // Undoing a plan: put each entry's backed-up original back.
  if (process.argv.includes("--restore") && planPath && existsSync(planPath)) {
    const plan = JSON.parse(readFileSync(planPath, "utf8")) as PlanEntry[];
    for (const entry of plan) {
      const backup = join(backupDir, safeName(entry.path));
      if (!existsSync(backup)) {
        console.log(`  SKIP (no backup) - ${entry.titles.join(" / ")}`);
        continue;
      }
      const contentType = /\.png$/i.test(entry.path) ? "image/png" : "image/jpeg";
      const { error: uploadError } = await supabase.storage.from(BUCKET).upload(entry.path, readFileSync(backup), { contentType, upsert: true });
      console.log(`  ${uploadError ? `FAILED (${uploadError.message})` : "restored"} - ${entry.titles.join(" / ")}`);
    }
    return;
  }

  // Applying a saved plan: no detection, just back up, crop and upload.
  if (apply && planPath && existsSync(planPath)) {
    const plan = JSON.parse(readFileSync(planPath, "utf8")) as PlanEntry[];
    mkdirSync(backupDir, { recursive: true });
    let done = 0;
    for (const entry of plan) {
      const { data: fileData, error: downloadError } = await supabase.storage.from(BUCKET).download(entry.path);
      if (downloadError || !fileData) {
        console.log(`  SKIP (download failed) - ${entry.titles.join(" / ")}`);
        continue;
      }
      const contentType = fileData.type || "image/jpeg";
      const bytes = Buffer.from(await fileData.arrayBuffer());
      writeFileSync(join(backupDir, safeName(entry.path)), bytes);
      const cropped = await cropImageBufferToBox(bytes, contentType, entry.box);
      const { error: uploadError } = await supabase.storage.from(BUCKET).upload(entry.path, cropped, { contentType, upsert: true });
      if (uploadError) {
        console.log(`  FAILED to upload ${entry.path}: ${uploadError.message}`);
        continue;
      }
      done++;
      console.log(`  cropped - ${entry.titles.join(" / ")} (${bytes.length} -> ${cropped.length} bytes)`);
    }
    console.log(`\nDone. ${done}/${plan.length} cropped from ${planPath}; originals saved in ${backupDir}.`);
    return;
  }

  const { data: titles, error } = await supabase.from("titles").select("unique_id,title,case_image_path").not("case_image_path", "is", null);
  if (error || !titles) {
    console.error("Failed to load titles:", error?.message);
    process.exit(1);
  }

  // One entry per stored file - box-set members often share their set's photo.
  const titlesByPath = new Map<string, string[]>();
  for (const row of titles) titlesByPath.set(row.case_image_path as string, [...(titlesByPath.get(row.case_image_path as string) ?? []), row.title]);
  if (previewDir) mkdirSync(previewDir, { recursive: true });
  if (apply) mkdirSync(backupDir, { recursive: true });
  const plan: PlanEntry[] = [];

  console.log(`Checking ${titlesByPath.size} stored images (${titles.length} titles)...`);
  let recropped = 0;
  let skippedSmall = 0;
  let skippedAlreadyTight = 0;
  let skippedNoBox = 0;

  for (const [path, names] of titlesByPath) {
    const row = { title: names.join(" / ") };
    const { data: fileData, error: downloadError } = await supabase.storage.from(BUCKET).download(path);
    if (downloadError || !fileData) {
      console.log(`  SKIP (download failed) - ${row.title}`);
      continue;
    }
    const contentType = fileData.type || "image/jpeg";
    const bytes = Buffer.from(await fileData.arrayBuffer());

    if (!includeSmall && bytes.length < MIN_SIZE_BYTES) {
      skippedSmall++;
      continue;
    }

    const box = await detectCoverBoundingBox(bytes, contentType);
    if (!box) {
      skippedNoBox++;
      console.log(`  SKIP (no confident box found) - ${row.title}`);
      continue;
    }

    const areaFraction = ((box.xMax - box.xMin) / 100) * ((box.yMax - box.yMin) / 100);
    if (areaFraction >= MAX_UNCROPPED_AREA_FRACTION) {
      skippedAlreadyTight++;
      continue;
    }

    console.log(
      `  ${apply ? "CROPPING" : "WOULD CROP"} - ${row.title} (box ${JSON.stringify(box)}, ${bytes.length} -> ?)`
    );
    plan.push({ path, titles: names, box });
    if (previewDir) {
      writeFileSync(join(previewDir, safeName(path)), await cropImageBufferToBox(bytes, contentType, box));
    }
    if (apply) {
      writeFileSync(join(backupDir, safeName(path)), bytes);
      const cropped = await cropImageBufferToBox(bytes, contentType, box);
      const { error: uploadError } = await supabase.storage.from(BUCKET).upload(path, cropped, { contentType, upsert: true });
      if (uploadError) {
        console.log(`    FAILED to upload: ${uploadError.message}`);
        continue;
      }
      console.log(`    done - ${bytes.length} -> ${cropped.length} bytes`);
    }
    recropped++;
  }

  console.log(
    `\nDone. ${recropped} ${apply ? "recropped" : "would be recropped"}, ${skippedSmall} skipped (already small/clean), ` +
      `${skippedAlreadyTight} skipped (already tight), ${skippedNoBox} skipped (no confident box).`
  );
  if (planPath && !apply) {
    writeFileSync(planPath, JSON.stringify(plan, null, 2));
    console.log(`Plan saved to ${planPath} - re-run with --apply --plan=${planPath} to apply it with no Gemini calls.`);
  } else if (!apply) {
    console.log("Dry run - re-run with --apply to actually update the stored images.");
  }
  if (apply) console.log(`Originals saved in ${backupDir}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
