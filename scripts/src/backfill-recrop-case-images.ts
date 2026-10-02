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
 * Dry run by default - only writes to the `case-images` bucket with `--apply`, same
 * convention as this project's other backfill scripts. Safe to re-run: a title that no
 * longer needs cropping (already fixed by a previous --apply run) is skipped the same way an
 * already-small product photo is.
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { detectCoverBoundingBox, cropImageBufferToBox } from "@danflix/backend";

const MIN_SIZE_BYTES = 500_000;
const MAX_UNCROPPED_AREA_FRACTION = 0.85;
const BUCKET = "case-images";

async function main() {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY - copy .env.example to .env and fill them in.");
    process.exit(1);
  }
  const apply = process.argv.includes("--apply");
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: titles, error } = await supabase.from("titles").select("unique_id,title,case_image_path").not("case_image_path", "is", null);
  if (error || !titles) {
    console.error("Failed to load titles:", error?.message);
    process.exit(1);
  }

  console.log(`Checking ${titles.length} titles with a case_image_path...`);
  let recropped = 0;
  let skippedSmall = 0;
  let skippedAlreadyTight = 0;
  let skippedNoBox = 0;

  for (const row of titles) {
    const path = row.case_image_path as string;
    const { data: fileData, error: downloadError } = await supabase.storage.from(BUCKET).download(path);
    if (downloadError || !fileData) {
      console.log(`  SKIP (download failed) - ${row.title}`);
      continue;
    }
    const contentType = fileData.type || "image/jpeg";
    const bytes = Buffer.from(await fileData.arrayBuffer());

    if (bytes.length < MIN_SIZE_BYTES) {
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
    if (apply) {
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
  if (!apply) console.log("Dry run - re-run with --apply to actually update the stored images.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
