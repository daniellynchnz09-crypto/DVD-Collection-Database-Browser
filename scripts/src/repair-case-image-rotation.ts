/**
 * ONE-TIME repair for stored case photos (`case-images` bucket) that were saved sideways or
 * upside down before coverVision.ts's detectCoverRotation was rebuilt (2026-10-06, see its own
 * comment: the raw phone photos carry no EXIF orientation tag, and the old detector's calls
 * mostly failed silently). Runs every stored case photo through the new four-way check and
 * rotates the ones it says aren't upright.
 *
 *   npm run repair-case-image-rotation -w scripts                  # dry run: lists what would turn
 *   npm run repair-case-image-rotation -w scripts -- --apply
 *   ... -- --preview-dir=<folder>   # dry run also saves each flagged photo, turned, for checking by eye
 *
 * Calls are spaced ~4.5s apart to stay under Gemini's free-tier per-minute limit. Safe to
 * re-run: a photo already upright comes back 0 and is skipped.
 *
 * Required env vars (scripts/.env): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GEMINI_API_KEY.
 */

import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import { createClient } from "@supabase/supabase-js";
import { detectCoverRotation, rotateImageBuffer } from "@danflix/backend";

const BUCKET = "case-images";
const GAP_MS = 4500;

async function main() {
  const apply = process.argv.includes("--apply");
  const previewDir = process.argv.find((a) => a.startsWith("--preview-dir="))?.split("=")[1] ?? null;
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !process.env.GEMINI_API_KEY) {
    console.error("Missing env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GEMINI_API_KEY (scripts/.env).");
    process.exit(1);
  }
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  if (previewDir) fs.mkdirSync(previewDir, { recursive: true });

  const { data: rows, error } = await supabase
    .from("titles")
    .select("unique_id, title, case_image_path")
    .not("case_image_path", "is", null)
    .order("title");
  if (error) throw new Error(error.message);
  console.log(`${rows.length} stored case photos to check${apply ? "" : " (dry run)"}`);

  let turned = 0;
  let unknown = 0;
  for (const [i, row] of rows.entries()) {
    if (i > 0) await new Promise((r) => setTimeout(r, GAP_MS));
    const { data: file, error: dlError } = await supabase.storage.from(BUCKET).download(row.case_image_path);
    if (dlError || !file) {
      console.log(`  ! ${row.title}: download failed (${dlError?.message})`);
      continue;
    }
    const bytes = Buffer.from(await file.arrayBuffer());
    const contentType = file.type || "image/jpeg";
    const rotation = await detectCoverRotation(bytes, contentType);
    if (rotation === null) {
      unknown++;
      console.log(`  ? ${row.title}: no answer (left as is)`);
      continue;
    }
    if (rotation === 0) continue;

    turned++;
    console.log(`  > ${row.title}: rotate ${rotation} clockwise`);
    const fixed = await rotateImageBuffer(bytes, contentType, rotation);
    if (!fixed) continue;
    if (previewDir) fs.writeFileSync(path.join(previewDir, `${row.unique_id}.jpg`), fixed);
    if (apply) {
      const { error: upError } = await supabase.storage.from(BUCKET).upload(row.case_image_path, fixed, { contentType, upsert: true });
      if (upError) console.log(`    upload failed: ${upError.message}`);
    }
  }
  console.log(`Done: ${turned} ${apply ? "rotated" : "would rotate"}, ${unknown} unanswered, ${rows.length - turned - unknown} already upright.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
