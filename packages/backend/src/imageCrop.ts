import { createJimp } from "@jimp/core";
import { methods as cropMethods } from "@jimp/plugin-crop";
import { methods as rotateMethods } from "@jimp/plugin-rotate";
import jpeg from "@jimp/js-jpeg";
import png from "@jimp/js-png";

// Same minimal individual-@jimp/*-packages build as posterMatch.ts, for the same reason (no
// Node-only font-loading plugin pulled in, stays out of packages/shared so Metro never has
// to resolve it) - see that file's own comment for the full explanation. Crop and rotate are
// both added on top of the two decoders this build needs (rotate() itself also pulls in
// @jimp/plugin-resize as a peer, since rotating resizes the canvas to fit).
const Jimp = createJimp({ plugins: [cropMethods, rotateMethods], formats: [jpeg, png] });

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

/**
 * Crops an image buffer to a content-aware bounding box (coverVision.ts's
 * detectCoverBoundingBox, percentages of width/height) rather than a uniform-color border -
 * added 2026-09-29 to replace the old client-side fixed-guide-rectangle crop, which the user
 * found didn't reliably frame the actual disc case. Converts the percentage box to real pixel
 * coordinates against this specific image's own dimensions (never assumes a fixed resolution),
 * and clamps into bounds in case the model's box edges land fractionally outside the image.
 * Same "wrong/missing data is worse than no crop" convention as autocropImageBuffer above -
 * any failure returns the ORIGINAL buffer unchanged rather than throwing, since a failed crop
 * must never block the photo from being analyzed/stored at all. */
/**
 * Bakes a phone photo's EXIF orientation tag into its actual pixels (added 2026-10-03) - a
 * real batch of cover photos (Fahrenheit 9/11, The Story of Movie Westerns, Elvis At The
 * Movies) came out stored upside down. An Android camera JPEG often keeps its pixels in sensor
 * orientation plus an EXIF tag saying how to turn them; Jimp's own `fromBuffer` honours that
 * tag (@jimp/core's attemptExifRotate) but Gemini doesn't reliably, so detectCoverRotation
 * judged the RAW pixels ("needs 180 degrees") while rotateImageBuffer then turned the already
 * EXIF-corrected image - flipping an upright photo upside down. Round-tripping through Jimp
 * once up front means every later step (rotation check, bounding box, crop, the stored file)
 * sees the same, tag-free, upright-as-shot pixels. Any failure returns the original buffer. */
export async function normalizeImageOrientation(buffer: Buffer, contentType: string): Promise<Buffer> {
  if (!/^image\/jpe?g$/i.test(contentType)) return buffer;
  try {
    const image = await Jimp.fromBuffer(buffer);
    return await image.getBuffer("image/jpeg");
  } catch {
    return buffer;
  }
}

/**
 * Rotates an image buffer by a clockwise angle (0/90/180/270 - coverVision.ts's
 * detectCoverRotation) so a cover photo taken with the phone held sideways ends up right-way-up
 * before cropping/analysis - added 2026-09-29 after the user found their Eddington cover photo
 * came out landscape instead of portrait. Jimp's own `rotate()` (@jimp/plugin-rotate) takes a
 * COUNTER-clockwise angle, so `degreesClockwise` is negated here to convert it - callers always
 * think in "how far clockwise does this need to turn to stand upright," which is what Gemini is
 * asked for. A 0° rotation is a no-op returned as-is rather than round-tripped through Jimp.
 * Same "wrong/missing data is worse than no rotation" convention as the rest of this file: any
 * failure returns the ORIGINAL buffer unchanged rather than throwing. */
export async function rotateImageBuffer(
  buffer: Buffer,
  contentType: string,
  degreesClockwise: 0 | 90 | 180 | 270
): Promise<Buffer> {
  if (degreesClockwise === 0) return buffer;
  if (!/^image\/(jpe?g|png)$/i.test(contentType)) return buffer;
  try {
    const image = await Jimp.fromBuffer(buffer);
    const rotated = rotateMethods.rotate(image, -degreesClockwise);
    const mime = /png/i.test(contentType) ? "image/png" : "image/jpeg";
    return await rotated.getBuffer(mime);
  } catch {
    return buffer;
  }
}

export async function cropImageBufferToBox(
  buffer: Buffer,
  contentType: string,
  box: { xMin: number; yMin: number; xMax: number; yMax: number }
): Promise<Buffer> {
  if (!/^image\/(jpe?g|png)$/i.test(contentType)) return buffer;
  try {
    const image = await Jimp.fromBuffer(buffer);
    const imgWidth = image.bitmap.width;
    const imgHeight = image.bitmap.height;
    const x = Math.max(0, Math.round((box.xMin / 100) * imgWidth));
    const y = Math.max(0, Math.round((box.yMin / 100) * imgHeight));
    const w = Math.min(imgWidth - x, Math.round(((box.xMax - box.xMin) / 100) * imgWidth));
    const h = Math.min(imgHeight - y, Math.round(((box.yMax - box.yMin) / 100) * imgHeight));
    if (w <= 0 || h <= 0) return buffer;
    const cropped = cropMethods.crop(image, { x, y, w, h });
    const mime = /png/i.test(contentType) ? "image/png" : "image/jpeg";
    return await cropped.getBuffer(mime);
  } catch {
    return buffer;
  }
}
