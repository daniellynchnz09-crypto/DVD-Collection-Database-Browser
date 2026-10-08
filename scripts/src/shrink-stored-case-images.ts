/**
 * ONE-TIME: scales every photo already in the `case-images` bucket down to the size new uploads
 * get (2026-10-09, the user's call after the rate-limit report: "keep the aspect ratio, but you
 * can change the dimensions to shrink the image"). Uses the same shrinkForStorage as the live
 * upload paths (packages/backend/src/imageCrop.ts): long side capped at 1200px, JPEG quality 80,
 * aspect ratio unchanged, never enlarged. A photo that wouldn't get smaller is left alone.
 *
 * Dry run by default - downloads and shrinks in memory, prints the before/after totals, writes
 * nothing. `--apply` uploads the smaller copies over the originals (same paths, so nothing that
 * points at them changes).
 *
 *   npm run shrink-stored-case-images            # dry run
 *   npm run shrink-stored-case-images -- --apply
 *
 * Required env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { shrinkForStorage } from "@danflix/backend";

const BUCKET = "case-images";

async function main() {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in scripts/.env.");
    process.exit(1);
  }
  const apply = process.argv.includes("--apply");
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // Every stored photo sits at titles/{id}/<file>; list the folders, then each folder.
  const paths: string[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data: folders, error } = await supabase.storage.from(BUCKET).list("titles", { limit: 1000, offset });
    if (error) throw new Error(error.message);
    for (const folder of folders ?? []) {
      const { data: files } = await supabase.storage.from(BUCKET).list(`titles/${folder.name}`, { limit: 100 });
      for (const file of files ?? []) paths.push(`titles/${folder.name}/${file.name}`);
    }
    if ((folders?.length ?? 0) < 1000) break;
  }
  console.log(`${paths.length} stored case photo(s). ${apply ? "Shrinking and uploading." : "Dry run - nothing is written."}`);

  let before = 0;
  let after = 0;
  let changed = 0;
  for (const [i, path] of paths.entries()) {
    const { data, error } = await supabase.storage.from(BUCKET).download(path);
    if (error || !data) {
      console.warn(`  ${path}: couldn't download (${error?.message ?? "no data"})`);
      continue;
    }
    const contentType = data.type || "image/jpeg";
    const original = Buffer.from(await data.arrayBuffer());
    const shrunk = await shrinkForStorage(original, contentType);
    before += original.length;
    after += shrunk.length;
    if (shrunk.length < original.length) {
      changed++;
      if (apply) {
        const { error: uploadError } = await supabase.storage.from(BUCKET).upload(path, shrunk, { contentType, upsert: true });
        if (uploadError) console.warn(`  ${path}: upload failed (${uploadError.message})`);
      }
    }
    if ((i + 1) % 10 === 0) console.log(`  ${i + 1}/${paths.length}...`);
  }

  const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;
  console.log(`${changed} of ${paths.length} would shrink: ${mb(before)} -> ${mb(after)}.${apply ? " Uploaded." : ""}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
