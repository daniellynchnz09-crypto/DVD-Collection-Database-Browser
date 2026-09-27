import { createJimp } from "@jimp/core";
import { methods as cropMethods } from "@jimp/plugin-crop";
import jpeg from "@jimp/js-jpeg";
import png from "@jimp/js-png";

// Same minimal individual-@jimp/*-packages build as posterMatch.ts, for the same reason (no
// Node-only font-loading plugin pulled in, stays out of packages/shared so Metro never has
// to resolve it) - see that file's own comment for the full explanation. Only the crop plugin
// is added on top of the two decoders this build already needs.
const Jimp = createJimp({ plugins: [cropMethods], formats: [jpeg, png] });

/**
 * Auto-crops a uniform-color border (almost always a plain white studio background on a
 * retail product photo) from an image buffer - added 2026-09-22 after the user pointed out a
 * real UPCitemdb/reseller listing photo ("Universal Monsters: The Essential Collection") had
 * a wide white border baked into the image itself, not a display artifact, and asked for it
 * to be cropped out "for cleanliness."
 *
 * Uses Jimp's own `autocrop()` (@jimp/plugin-crop) rather than a hand-written pixel scan - it
 * already does exactly this (finds the largest uniform-color frame around the image's edges
 * and crops it away), and is tolerant of the slight compression noise a real JPEG's "flat"
 * background always has. `leaveBorder` keeps a few pixels of margin rather than cropping
 * flush against the product's own edge, so a slightly imprecise detection can't visibly clip
 * it. `cropOnlyFrames: false` (confirmed live against a real listing photo, 2026-09-22 - the
 * "Universal Monsters" one that prompted this) since a real product photo often only has
 * padding on some sides, not a full symmetric frame (that one had white bars on the left/
 * right only, none top/bottom) - `cropOnlyFrames: true` requires whitespace on every side
 * before touching any of them, so it silently no-opped on exactly the shape of image this
 * exists to fix.
 *
 * Same "wrong/missing data is worse than no crop" convention as every other image helper in
 * this codebase: any failure (bad bytes, unsupported format, autocrop finding nothing to
 * crop) returns the ORIGINAL buffer unchanged rather than throwing - a product photo with its
 * white border intact is still a perfectly usable image, so a crop failure should never block
 * the image from being stored at all.
 */
export async function autocropImageBuffer(buffer: Buffer, contentType: string): Promise<Buffer> {
  // autocrop only makes sense for the two raster formats this build can even decode - any
  // other content type (a GIF/WEBP passed straight through, say) is returned untouched.
  if (!/^image\/(jpe?g|png)$/i.test(contentType)) return buffer;
  try {
    const image = await Jimp.fromBuffer(buffer);
    const cropped = cropMethods.autocrop(image, { tolerance: 0.02, cropOnlyFrames: false, leaveBorder: 4 });
    const mime = /png/i.test(contentType) ? "image/png" : "image/jpeg";
    return await cropped.getBuffer(mime);
  } catch {
    return buffer;
  }
}
