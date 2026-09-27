/**
 * Fixed proportional guide rectangle that cover-photo scanning asks the user to line a disc
 * case up with (see CoverCaptureGuide.tsx) - a plain static rectangle, not real corner/edge
 * detection (per the user's own explicit decision: no computer vision on the live feed, no
 * native module, plain Expo Go throughout).
 *
 * Because this rectangle's screen position is fixed and known ahead of time, it doubles as the
 * crop boundary: `computeCoverCropRegion` below crops a freshly-captured photo to these exact
 * same ratios against the photo's own pixel dimensions, rather than analyzing where the case
 * actually ended up in the frame - a deterministic, content-blind crop, not a smart/AI one. Per
 * the user's own words: "it's just so that it makes it easier for the system to crop the image
 * later" - approximate alignment is the whole point, not pixel-perfect registration.
 *
 * Sized for a standard DVD/Blu-ray case's front/back cover, which is closer to square than a
 * typical poster (roughly 27:38 mm cover panel), centered horizontally with headroom above for
 * the hint text and below for the Capture button.
 */
export const COVER_GUIDE = {
  widthRatio: 0.72,
  /** width / height */
  aspectRatio: 27 / 38,
  topRatio: 0.16,
} as const;

export interface CoverCropRegion {
  originX: number;
  originY: number;
  width: number;
  height: number;
}

/** Translates the on-screen guide's ratios into a pixel crop rectangle against a captured
 * photo's own width/height. The photo's raw aspect ratio isn't guaranteed to exactly match the
 * screen's (camera sensors often return their native FOV rather than exactly what the preview
 * cropped to fill the screen with) - this is a known, accepted approximation, not a precise
 * preview-to-capture mapping; the crop is meant to land close to the case's cover, not register
 * it exactly. `height` is clamped so the region never runs past the photo's own bottom edge. */
export function computeCoverCropRegion(photoWidth: number, photoHeight: number): CoverCropRegion {
  const width = Math.round(photoWidth * COVER_GUIDE.widthRatio);
  const height = Math.round(width / COVER_GUIDE.aspectRatio);
  const originX = Math.round((photoWidth - width) / 2);
  const originY = Math.round(photoHeight * COVER_GUIDE.topRatio);
  return { originX, originY, width, height: Math.min(height, photoHeight - originY) };
}
