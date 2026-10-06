import { buildOrientationPreviews } from "./imageCrop";

/**
 * Reads a cover-photo scan's captured image (front and/or back of a disc case) and extracts
 * whatever cataloguing signal is printed on it - title, primary format, disc count,
 * movie-or-TV, NZ/OFLC classification rating, banner-implied extra discs, and whether a
 * special-features list is printed - so the resolver can feed the title into the exact same
 * best-match search a typed title already uses (searchTitleCandidates, titleTextSearch.ts),
 * without the user ever typing anything, while the rest ride along in
 * resolved_candidates.coverAnalysis purely as ConfirmScreen pre-fill suggestions (same
 * "review before it's confirmed" status as visionFormatGuess - see that field's own comment
 * in packages/backend/src/scanResolver.ts). Added 2026-09-28 as part of cover-photo scanning,
 * rating extraction added 2026-09-29, extraDiscs/specialFeaturesListed added 2026-09-29 (later
 * the same day, after a real "Five Nights at Freddy's" scan whose own cover photo plainly
 * showed a multi-disc banner and a back-cover special-features list, neither of which this
 * file asked about at all before now) - see Claude/TECH STACK AND ARCHITECTURE/
 * barcode-scanning-pipeline.md.
 *
 * Also classifies which side of the case the photo actually shows ("front" - poster art, the
 * disc's own title treatment, and the format banner formatVision.ts already reads; "back" -
 * synopsis/cast/spec-block text; "unclear" if the model can't tell) rather than asking the
 * user to label it at capture time (see decision 7 in the plan this file implements). This
 * classification is what decides whether a staged photo is ever promoted into the permanent
 * `case-images` bucket as the title's stored product image - see
 * promoteStagedCoverToCaseImage (coverStagingStorage.ts) and confirm/route.ts's front-cover
 * priority - a back cover is never a stored product image even though it's read for text the
 * exact same way.
 *
 * Same house convention as formatVision.ts in every other respect: Gemini
 * `gemini-flash-lite-latest` via plain REST `generateContent`, `GEMINI_API_KEY`,
 * `responseSchema`-forced JSON, `temperature: 0` for a consistent classification rather than
 * creative variation, and `null` on any failure (missing key, network error, unparseable
 * response, or the model itself saying it can't tell) - never throws, since this is a pre-fill
 * signal the resolver can always fall back away from, never a value trusted enough to block a
 * scan. Takes raw bytes + mime type directly (not a URL, unlike formatVision.ts) because a
 * staged cover photo lives in the private `cover-scan-staging` bucket with no fetchable URL at
 * all - the caller already has the bytes in hand via downloadStagedCoverPhoto.
 */

const MODEL = "gemini-flash-lite-latest";
const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

// Matches formatVision.ts's own FORMAT_OPTIONS exactly, so a cover-read format guess never
// disagrees with the barcode-photo vision fallback or a manually-typed value on how the same
// format is spelled (both ultimately feed the same packages/shared/src/titleParsing.ts
// FORMAT_ALIASES canonical spellings).
const FORMAT_OPTIONS = ["DVD", "Blu-Ray", "Blu-Ray 3D", "4K UHD Blu-Ray", "VHS", "CD Movie", "Unclear"] as const;
const SIDE_OPTIONS = ["front", "back", "unclear"] as const;
const MEDIA_TYPE_OPTIONS = ["Movie", "TV Series", "Unclear"] as const;
// Matches formatVision.ts's own EXTRA_DISCS_OPTIONS exactly - see that file's header comment
// for the full reasoning (why DIGITAL/DIGITAL DOWNLOAD wording is excluded, why an unlabeled
// "BONUS DISC" format is deliberately left to deriveDiscConfigFromExtraDiscs rather than
// guessed here). Added 2026-09-29 after a real "Five Nights at Freddy's" 4K UHD scan whose
// own cover photo (not just a barcode listing photo) plainly showed a "4K ULTRA HD + BLU-RAY"
// banner that went unread - formatVision.ts only ever runs against the barcode listing's own
// stock photo, which isn't always present or clear, so this same read now also happens
// directly against the user's own cover photo instead of depending on that second source.
const EXTRA_DISCS_OPTIONS = ["NONE", "ONE_EXTRA", "TWO_EXTRA"] as const;
// This collection's real NZ/Oceania classification scheme - matches packages/shared/src/
// titleParsing.ts's VALID_NZ_RATINGS exactly, kept in sync by hand the same way
// FORMAT_OPTIONS above is hand-kept in sync with formatVision.ts's own copy, rather than
// imported, since a Gemini responseSchema enum needs a literal array in this file anyway.
const RATING_OPTIONS = ["G", "PG", "M", "R12", "R13", "R15", "R16", "R18", "Unclear"] as const;
// Added 2026-10-01 for classic-era Doctor Who's animated-reconstruction releases (see
// classicWhoSerials.ts) - a serial whose surviving footage is incomplete or gone entirely is
// often officially reissued with the missing episode(s) redrawn as animation, and that cover
// art looks visibly different from an ordinary photographic/live-action cover (flat colour,
// linework, a cel/comic-style illustration rather than a photo of the actors). Kept as a
// generic art-style read here, not Doctor-Who-specific wording, since the same signal is
// useful as a second, independent confirming check alongside the missing-episode data match -
// ConfirmScreen.tsx only ever actually acts on it for a classic Who serial match, per the
// user's own scoping rule for this whole feature area.
const ART_STYLE_OPTIONS = ["drawn", "photographic", "unclear"] as const;

const PROMPT = `You are looking at a photo of a physical movie/TV disc case (DVD/Blu-ray/4K UHD/VHS/CD), cropped to just the case's cover art. Two different things could be shown:
- The FRONT cover: the main poster/key art, the release's own title treatment (large, stylized text), and often a format banner (see below).
- The BACK cover: a synopsis paragraph, cast/crew list, and a technical spec block (aspect ratio, runtime, audio tracks, chapter list, disc count) - little or no poster art.

First decide which side this is, as "side": "front", "back", or "unclear" if you genuinely cannot tell (e.g. the case is closed/spine-only, or the image is too cropped/blurry).

Then, regardless of which side it is, read whatever of the following you can actually find printed on it:
- "title": the exact title as printed on the case (the main release title - if a specific cut/edition is named, e.g. "The Final Cut" or "Director's Cut", include that suffix exactly as printed). Null if no legible title text is visible at all.
- "mediaType": "Movie" if this is a single film, "TV Series" if the case is for a TV show/season (look for wording like "Season", "Series", "The Complete First Season", multi-episode listings), or "Unclear" if you cannot tell.
- "format": the disc format, read from the top edge banner/header band on the case (the strip of colour running along the top of the cover, distinct from the poster art below it) - "4K UHD Blu-Ray" (black background band, silver/white "4K ULTRA HD" text), "Blu-Ray 3D" (a blue band like plain Blu-Ray, but explicitly labelled "3D" - often with a glasses icon), "Blu-Ray" (blue-toned band, no "3D" wording), "DVD" (no such coloured band at all), "VHS" (a cassette, not a disc case), "CD Movie" (a CD jewel/slim case), or "Unclear" if a band is present but you can't tell which of these it is. Only answer "DVD" when you're confident there's genuinely no banner - not just when the banner itself is illegible.
- "discCount": the total number of discs this case holds, as a plain integer, if a spec block or spine text states it (e.g. "2-Disc Set", "3 Discs"). Null if not stated anywhere visible.
- "rating": this collection's classification scheme is New Zealand's OFLC system, printed as a small logo (a coloured box with the letter/code in it) usually in a bottom corner of the cover - one of "G", "PG", "M", "R12", "R13", "R15", "R16", "R18". If the logo shown is a different country's classification system (e.g. a US MPAA rating like "PG-13", a UK BBFC logo like "15"), do not translate it - answer "Unclear" instead, since only a genuine NZ/OFLC logo should be reported here. Null if no rating logo is visible at all.
- "extraDiscs": ONLY relevant when you can see the top-edge format banner described above (a back cover usually has no such banner). Check whether the banner lists MORE than one disc format together (e.g. "4K UHD + BLU-RAY", "BLU-RAY + DVD", "4K UHD + BLU-RAY + BONUS DISC"): "ONE_EXTRA" if it names exactly one additional format/disc alongside the primary one, "TWO_EXTRA" if it names two additional real discs (a second format word plus a generic "BONUS DISC" mention both count as the two extras), "NONE" if the banner only names the one primary format, or if no banner is visible at all. Do NOT guess what format an unlabeled "BONUS DISC" itself is - just report that it's there. IMPORTANT: "DIGITAL DOWNLOAD"/"DIGITAL COPY"/"DIGITAL" is NOT a disc - never count it as one of the extras (a banner reading "4K UHD + BLU-RAY + DIGITAL DOWNLOAD" is "ONE_EXTRA", the same as "4K UHD + BLU-RAY" alone).
- "specialFeaturesListed": true if this side indicates the disc includes ANY bonus content beyond the main feature - not only the classic "Special Features"/"Bonus Features"/"Extras" heading followed by an itemized list (deleted scenes, making-of, commentary, featurettes, gag reel, etc.), typically part of a back cover's spec block, but ALSO any shorter banner-style callout woven into other cover text that gives the same impression without a heading+list of its own - e.g. "Includes Exclusive Bonus", "Bonus Content", "Plus Bonus Features", "Exclusive Extras", "Featuring an all-new interview with...", or similar wording naming or implying even just one extra mini-featurette/interview/behind-the-scenes piece. Treat any of these phrasings as equivalent - the disc doesn't need its own dedicated "Special Features" section printed for this to be true. false if this side is legible enough to be confident NO such heading, list, or bonus-content callout of any kind is printed on it. Null if you genuinely can't tell (too blurry/cropped, or a front cover with no spec block/callout visible at all to judge from).
- "region": the disc region coding printed anywhere on this side - a small logo or line of text (e.g. "Region 4", "Region A", "Region Free", "All Regions", "Region 0"). Also include a video-standard mark if one is printed - "PAL" or "NTSC", often in the spec block or beside the region mark (e.g. report "PAL Region 0", or just "PAL" if that's all there is). On a BACK cover specifically, look just above the rating logo (that logo itself usually sits in the bottom-right corner - see "rating" above) - the region mark is commonly a small icon/text directly above it, easy to miss if you only scan the main spec block. It can also appear near the format banner, or on the front cover instead of the back, so check whichever side this actually is rather than assuming it's back-cover-only or spec-block-only. IMPORTANT - a Blu-ray region-free disc is very often marked with a COMBINED badge: three small hexagons joined together in a honeycomb/triangle cluster, each with one letter inside ("A", "B", "C" - typically A on top, B and C below it) - this single combined icon means the disc plays in ALL THREE Blu-ray regions, not just whichever one letter happens to be most visible or centred. If you see this three-hexagon cluster badge (regardless of which single letter you can read most clearly within it), report "Region Free" - never report just one of its three letters, since that would wrongly describe a disc as single-region-locked when it's actually region-free. A genuinely single-region disc shows only ONE hexagon/letter on its own, with no honeycomb cluster of three. Likewise, a DVD region-free disc is often marked with a small region badge (usually a globe, or a disc/circle shape, sometimes with a DVD logo) that has the word "ALL" printed inside or right beside it where a region number would normally be - that badge means the disc plays in every region. If you see it, report "Region ALL" (add PAL/NTSC if printed, e.g. "Region ALL PAL") - never null just because the badge has a word instead of a number. The same kind of badge showing "0" means region 0, also every region - report "Region 0". Report exactly what's printed, verbatim - do not translate/resolve a country name yourself, just report it as printed if that's genuinely all that's shown (e.g. "UK"). Null if no region information is printed anywhere on this side at all.
- "releaseName": a distinct packaging/marketing EDITION name printed on the case, separate from the film's own base title - e.g. "Night Shift Edition", "Special Edition", "Collector's Edition", "Ultimate Edition", "Steelbook Edition". This is different from a specific CUT of the film (e.g. "The Final Cut", "Director's Cut", "Theatrical Cut") - a cut name belongs in "title" instead, per the rule above, not here. Report the edition name only, exactly as printed (e.g. "Night Shift Edition", not "Five Nights at Freddy's Night Shift Edition"). Null if no such edition/release name is printed anywhere on this side, or if the only relevant wording found is a cut name already reported in "title".
- "artStyle": the main cover art's style - "drawn" if it's an illustrated/painted/animated-style image (flat colours, visible linework, a cel/comic-book look - not a photo of real actors, even if stylized), "photographic" if it's a real photo or photorealistic render of the actors/scene (the ordinary case for almost every live-action release), or "unclear" if you can't tell (too blurry/cropped) or this side has no real cover art to judge at all (e.g. a back cover that's just text).
- "collectionMemberTitles": if this case is a box set/collection holding MULTIPLE distinct films or TV seasons (the case's own "title" reads like a collection name - "Collection", "Box Set", "Trilogy", a franchise/person's name, etc. - rather than one film's title), list the individual member titles it actually names, e.g. ["Rear Window", "Psycho", "The Birds", "Vertigo"]. These are usually laid out with real visual separation on the cover - separate lines, a column/grid, or one small poster thumbnail per title - not run together in one sentence, so read each title as its own distinct block of text rather than guessing where one title's words end and the next begins from a comma or "and". Skip any non-title text mixed into that layout (a tagline, year, "Digitally Remastered", a bonus-disc mention). Only include a title here if it's independently legible as a real, complete film/show name - if the list is only partially readable (some thumbnails too small/blurry to read), still report whichever ones genuinely are legible rather than skipping the whole field. Null (not an empty array) if this case isn't a multi-title collection at all, or if it is but no member titles are actually legible anywhere on this side.

Only report what is actually legible in the image - never guess a value that isn't genuinely readable. If almost nothing is legible, answer "unclear" for side and null/"Unclear"/"NONE" for the rest rather than inventing an answer.`;

interface GeminiResponsePart {
  text?: string;
}
interface GeminiCandidate {
  content?: { parts?: GeminiResponsePart[] };
}
interface GeminiGenerateContentResponse {
  candidates?: GeminiCandidate[];
}

export interface CoverVisionResult {
  side: (typeof SIDE_OPTIONS)[number];
  title: string | null;
  mediaType: (typeof MEDIA_TYPE_OPTIONS)[number];
  /** Same canonical spellings as formatVision.ts's FormatVisionResult["format"] (plus
   * "Blu-Ray 3D", which formatVision.ts has no need to distinguish since it's only ever
   * called once a plain Blu-Ray banner is already known to be there), but nullable here
   * since a cover photo (especially a back cover with no banner visible) often just doesn't
   * show the format at all - unlike formatVision.ts, which is only ever called once a
   * format banner is already known to be the thing being photographed. */
  format: "DVD" | "Blu-Ray" | "Blu-Ray 3D" | "4K UHD Blu-Ray" | "VHS" | "CD Movie" | null;
  discCount: number | null;
  /** This collection's real NZ/Oceania classification scheme (packages/shared/src/
   * titleParsing.ts's VALID_NZ_RATINGS) - null if no rating logo is visible, or if a
   * visible logo is a different country's classification system (see PROMPT). */
  rating: "G" | "PG" | "M" | "R12" | "R13" | "R15" | "R16" | "R18" | null;
  /** What the format banner itself lists alongside the primary format, read directly off
   * this cover photo - same meaning as formatVision.ts's own FormatVisionResult["extraDiscs"],
   * kept as a plain reported enum rather than an interpretation (see deriveDiscConfigFromExtraDiscs
   * in ConfirmScreen.tsx for what a listed extra disc's own format is assumed to be). "NONE"
   * whenever no banner is visible at all (e.g. a back cover), not just when one is present and
   * silent. */
  extraDiscs: (typeof EXTRA_DISCS_OPTIONS)[number];
  /** Whether this side indicates ANY bonus content beyond the main feature - a classic
   * "Special Features"/"Bonus Features"/"Extras" heading+list, OR a shorter banner-style
   * callout naming/implying even one extra featurette/interview without its own dedicated
   * list (e.g. "Includes Exclusive Bonus...", "Featuring an all-new interview with...") -
   * broadened 2026-09-30 after a real "Piece by Piece" scan whose back cover only ever used
   * the latter phrasing, which the original heading+list-only definition missed entirely (see
   * Claude/TECH STACK AND ARCHITECTURE/barcode-scanning-pipeline.md). ConfirmScreen.tsx uses a
   * true reading here to auto-check the Special Features toggle even when no banner-implied
   * bonus disc exists at all (the features can just be on the movie's own disc). Null when the
   * model can't tell either way. */
  specialFeaturesListed: boolean | null;
  /** Verbatim disc-region text as printed on this side (e.g. "Region 4", "Region B", "UK"),
   * not yet resolved to a real code - ConfirmScreen.tsx runs this through the same
   * resolveDiskRegionText (packages/shared/src/formatHints.ts) already used for the LLM
   * listing-text extraction's own "region" field, rather than asking the model to resolve a
   * country name/free-region wording itself. Can legitimately come from either the front or
   * back photo - added 2026-09-29 after the user pointed out region markings aren't
   * front-cover-only. Null if nothing is printed on this side at all. */
  region: string | null;
  /** "drawn" vs "photographic" cover-art style (see PROMPT/ART_STYLE_OPTIONS above) - "unclear"
   * is never actually returned here, it's mapped to null the same way a "Unclear" rating is,
   * since a caller only ever cares about a confident "drawn" read (the animated-reconstruction
   * signal) and has no separate use for a confirmed-"photographic" vs. genuinely-unknown
   * distinction. */
  artStyle: "drawn" | "photographic" | null;
  /** The bare packaging/marketing edition SUFFIX distinct from the base title (e.g. "Night
   * Shift Edition"), deliberately NOT including the title itself - not a content-different
   * cut, which stays merged into `title` instead (see PROMPT). A saved `release_name` always
   * includes the film's own base title before this suffix (the user's own explicit standing
   * convention, e.g. "Five Nights at Freddy's Night Shift Edition" - matching every existing
   * release_name in this collection, like the "Gladiator Special Edition" example in
   * database-design.md); ConfirmScreen.tsx composes that full string itself (`manualTitle` +
   * this suffix) rather than asking the model to retype the title a second time inside this
   * field, which would risk a subtly different spelling/apostrophe/capitalization between the
   * two. It then unchecks "Release Name matches Title" the moment a guess exists, flagging the
   * row amber for the user to confirm - a vision read is a good candidate, not an authoritative
   * one. Added 2026-09-29 after a real "Five Nights at Freddy's: Night Shift Edition" case
   * showed this printed on the cover with no automatic way to catch it before now
   * (release_name's own original design note only ever ruled out a *listing-text* signal,
   * never a cover-photo one). Null if no distinct edition name is printed anywhere on this
   * side. */
  releaseName: string | null;
  /** The individual member titles a box set's own cover lists (e.g. ["Rear Window", "Psycho",
   * "The Birds", "Vertigo"]) - added 2026-09-30, per the user's own observation that a
   * collection's member titles, not just the set's own name, are often printed right on the
   * cover too. Deliberately never auto-added to a collection's member list on its own -
   * ConfirmScreen.tsx surfaces these as tappable suggestion chips in the "Titles in this set"
   * step, each running the exact same OMDB search/pick flow a manually-typed title already
   * goes through (TitleSearchPicker), so a vision misread is reviewed like every other title on
   * this screen rather than silently trusted. Null if this case isn't a multi-title collection
   * at all, or is but no member titles are actually legible on this side. */
  collectionMemberTitles: string[] | null;
}

/** A cover-vision read paired with the staged path it came from - the resolver needs this
 * pairing (not just the bare CoverVisionResult) so a later promote/dismiss step can find which
 * staged file to actually copy into the permanent case-images bucket. */
export interface StagedCoverAnalysis {
  stagedPath: string;
  analysis: CoverVisionResult;
}

/** Picks which staged cover photo (if any) should be promoted into the permanent `case-images`
 * bucket as the title's stored product image - see promoteStagedCoverToCaseImage
 * (coverStagingStorage.ts) and decision 4/5 in Claude/TECH STACK AND ARCHITECTURE/
 * barcode-scanning-pipeline.md: a front cover always wins when captured, a back cover is
 * never used as the product image even though it's read for text the same way.
 *
 * A photo classified "front" wins outright (using the first if the model somehow called more
 * than one photo "front" in the same session). Failing that, a single "unclear" photo is used
 * as a reasonable fallback - there's nothing else to go on, but it's still very likely the only
 * cover photo captured this session. Returns null (never guesses) when the classification is
 * genuinely ambiguous - two or more "unclear" photos with no confident front - or when every
 * staged photo was confidently classified "back": a wrong case-image guess is worse than
 * falling back to whatever other image source (a UPC listing photo) the scan already had.
 */
export function pickFrontCoverPath(analyses: StagedCoverAnalysis[]): string | null {
  const front = analyses.find((a) => a.analysis.side === "front");
  if (front) return front.stagedPath;
  const unclear = analyses.filter((a) => a.analysis.side === "unclear");
  if (unclear.length === 1) return unclear[0].stagedPath;
  return null;
}

export async function detectCoverFromImage(
  imageBytes: Buffer,
  mimeType: string
): Promise<CoverVisionResult | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  // Same "missing config = no guess, not an error" convention as every scraper's missing-key
  // handling elsewhere in this codebase.
  if (!apiKey) return null;

  try {
    const res = await fetch(`${API_URL}?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: PROMPT },
              { inline_data: { mime_type: mimeType, data: imageBytes.toString("base64") } },
            ],
          },
        ],
        generationConfig: {
          // Same reasoning as formatVision.ts's own temperature: 0 - a borderline front/back
          // or format classification should give the same answer every time, not sample.
          temperature: 0,
          responseMimeType: "application/json",
          responseSchema: {
            type: "OBJECT",
            properties: {
              side: { type: "STRING", enum: [...SIDE_OPTIONS] },
              title: { type: "STRING", nullable: true },
              mediaType: { type: "STRING", enum: [...MEDIA_TYPE_OPTIONS] },
              format: { type: "STRING", enum: [...FORMAT_OPTIONS] },
              discCount: { type: "INTEGER", nullable: true },
              rating: { type: "STRING", enum: [...RATING_OPTIONS] },
              extraDiscs: { type: "STRING", enum: [...EXTRA_DISCS_OPTIONS] },
              specialFeaturesListed: { type: "BOOLEAN", nullable: true },
              region: { type: "STRING", nullable: true },
              artStyle: { type: "STRING", enum: [...ART_STYLE_OPTIONS] },
              releaseName: { type: "STRING", nullable: true },
              collectionMemberTitles: { type: "ARRAY", items: { type: "STRING" }, nullable: true },
            },
            required: ["side", "mediaType", "format", "rating", "artStyle"],
          },
        },
      }),
    });
    if (!res.ok) return null;

    const data = (await res.json()) as GeminiGenerateContentResponse;
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) return null;

    const parsed = JSON.parse(text) as {
      side?: string;
      title?: string | null;
      mediaType?: string;
      format?: string;
      discCount?: number | null;
      rating?: string;
      extraDiscs?: string;
      specialFeaturesListed?: boolean | null;
      region?: string | null;
      artStyle?: string;
      releaseName?: string | null;
      collectionMemberTitles?: string[] | null;
    };

    if (!parsed.side || !(SIDE_OPTIONS as readonly string[]).includes(parsed.side)) return null;

    const format =
      parsed.format && (FORMAT_OPTIONS as readonly string[]).includes(parsed.format) && parsed.format !== "Unclear"
        ? (parsed.format as CoverVisionResult["format"])
        : null;
    const mediaType = (MEDIA_TYPE_OPTIONS as readonly string[]).includes(parsed.mediaType ?? "")
      ? (parsed.mediaType as CoverVisionResult["mediaType"])
      : "Unclear";
    const rating =
      parsed.rating && (RATING_OPTIONS as readonly string[]).includes(parsed.rating) && parsed.rating !== "Unclear"
        ? (parsed.rating as CoverVisionResult["rating"])
        : null;
    const extraDiscs = (EXTRA_DISCS_OPTIONS as readonly string[]).includes(parsed.extraDiscs ?? "")
      ? (parsed.extraDiscs as CoverVisionResult["extraDiscs"])
      : "NONE";
    const artStyle = parsed.artStyle === "drawn" || parsed.artStyle === "photographic" ? parsed.artStyle : null;

    return {
      side: parsed.side as CoverVisionResult["side"],
      title: typeof parsed.title === "string" && parsed.title.trim() ? parsed.title.trim() : null,
      mediaType,
      format,
      discCount: typeof parsed.discCount === "number" && parsed.discCount > 0 ? parsed.discCount : null,
      rating,
      extraDiscs,
      specialFeaturesListed: typeof parsed.specialFeaturesListed === "boolean" ? parsed.specialFeaturesListed : null,
      region: typeof parsed.region === "string" && parsed.region.trim() ? parsed.region.trim() : null,
      artStyle,
      releaseName:
        typeof parsed.releaseName === "string" && parsed.releaseName.trim() ? parsed.releaseName.trim() : null,
      collectionMemberTitles: Array.isArray(parsed.collectionMemberTitles)
        ? (() => {
            const cleaned = parsed.collectionMemberTitles
              .filter((t): t is string => typeof t === "string" && t.trim().length > 0)
              .map((t) => t.trim());
            return cleaned.length > 0 ? cleaned : null;
          })()
        : null,
    };
  } catch {
    return null;
  }
}

const BOUNDING_BOX_PROMPT = `You are looking at a photo taken to catalogue a physical movie/TV disc case (DVD/Blu-ray/4K UHD/VHS/CD). The photo may also show other objects in the background or foreground - papers, a keyboard, a desk, hands, furniture, anything else in the room - that are NOT the disc case itself.

Find the single disc case (or cassette, for VHS) in this photo and report a tight bounding box around just that object, excluding everything else in the frame. Report the box as percentages of the full image width/height (0-100, where 0 is the left/top edge and 100 is the right/bottom edge): "xMin", "yMin" (top-left corner) and "xMax", "yMax" (bottom-right corner).

If you cannot confidently identify a single disc case in the photo (none visible, more than one equally prominent, or the photo is too blurry/cropped already to tell), answer "found": false and leave the coordinates null rather than guessing.`;

export interface CoverBoundingBox {
  /** Percentages of the full image's width/height (0-100), not pixels - the caller converts
   * to pixel coordinates against whatever the actual source image's real dimensions are. */
  xMin: number;
  yMin: number;
  xMax: number;
  yMax: number;
}

/**
 * Finds where the physical disc case actually is within a freshly-captured cover photo, so the
 * resolver can crop to just that region before either reading it (detectCoverFromImage above)
 * or promoting it into case-images as the title's stored product image - added 2026-09-29,
 * replacing the previous client-side fixed-guide-rectangle crop (ScannerScreen.tsx's old
 * CoverCaptureGuide), which the user found "obviously isn't working" for real photos where the
 * case doesn't fill the guide as tightly as the guide assumed, and which the user specifically
 * wanted done *before* the text-extraction read above, "so the scan doesn't get confused with
 * other documents that might also be in the shot."
 *
 * A second, separate Gemini call from detectCoverFromImage rather than one combined call,
 * specifically so the crop can be applied and the *cropped* result fed to the text-extraction
 * call - a single combined call would still have analyzed the full, uncropped, potentially
 * cluttered photo for its title/format/rating read. Same house conventions as every other
 * vision call in this file: `gemini-flash-lite-latest`, `temperature: 0`, never throws, `null`
 * on any failure or low-confidence read - the caller (scanResolver.ts) must fall back to
 * analyzing/promoting the original uncropped photo unchanged when this returns null, same
 * "a cache miss is fine, a bad write isn't" posture as everything else here. Bounding-box
 * accuracy from a fast/cheap model like this is approximate, not pixel-perfect - a real,
 * disclosed limitation, not a guarantee of a tight crop every time.
 */
export async function detectCoverBoundingBox(imageBytes: Buffer, mimeType: string): Promise<CoverBoundingBox | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  try {
    const res = await fetch(`${API_URL}?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: BOUNDING_BOX_PROMPT },
              { inline_data: { mime_type: mimeType, data: imageBytes.toString("base64") } },
            ],
          },
        ],
        generationConfig: {
          temperature: 0,
          responseMimeType: "application/json",
          responseSchema: {
            type: "OBJECT",
            properties: {
              found: { type: "BOOLEAN" },
              xMin: { type: "NUMBER", nullable: true },
              yMin: { type: "NUMBER", nullable: true },
              xMax: { type: "NUMBER", nullable: true },
              yMax: { type: "NUMBER", nullable: true },
            },
            // All four coordinates are required whenever the schema is satisfied at all - NOT
            // just "found" (see this function's own comment above for why: leaving them
            // optional/nullable let the model silently omit xMax/yMax on most real calls,
            // which is what caused nearly every real cover-photo crop to silently fall back to
            // "no crop" while looking, from the caller's side, like a rare/occasional miss).
            required: ["found", "xMin", "yMin", "xMax", "yMax"],
          },
        },
      }),
    });
    if (!res.ok) return null;

    const data = (await res.json()) as GeminiGenerateContentResponse;
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) return null;

    const parsed = JSON.parse(text) as {
      found?: boolean;
      xMin?: number | null;
      yMin?: number | null;
      xMax?: number | null;
      yMax?: number | null;
    };
    if (!parsed.found) return null;
    const { xMin, yMin, xMax, yMax } = parsed;
    if (typeof xMin !== "number" || typeof yMin !== "number" || typeof xMax !== "number" || typeof yMax !== "number") {
      return null;
    }

    const box = normalizeBoxScale({ xMin, yMin, xMax, yMax });
    if (!box || box.xMin < 0 || box.yMin < 0 || box.xMax > 100 || box.yMax > 100 || box.xMax <= box.xMin || box.yMax <= box.yMin) {
      return null;
    }
    return box;
  } catch {
    return null;
  }
}

/**
 * Gemini's own native bounding-box training convention is 0-1000, not 0-100 - confirmed live
 * (2026-09-30) against several real cover-photo scans whose case images came out completely
 * uncropped: the model was answering "found": true with genuinely correct-looking box
 * coordinates (e.g. xMin: 192, yMin: 155), just on the 0-1000 scale it's natively trained on,
 * despite BOUNDING_BOX_PROMPT explicitly asking for 0-100 percentages. The old validation only
 * ever accepted a 0-100 answer, so every one of these got silently discarded and treated as "no
 * box found" - not a rare miss, effectively the common case for any photo where the disc case
 * doesn't fill almost the entire frame edge-to-edge (which is why the one real success seen
 * before this fix, a near-full-frame photo, happened to already score under 100 on either
 * scale). Detected here by checking whether the values divided by 10 land in a sane box shape -
 * never applied blindly, since a genuine 0-100 answer with a value just over 100 (a slightly
 * imprecise edge) should be rejected as out-of-range, not silently rescaled.
 */
function normalizeBoxScale(box: {
  xMin: number;
  yMin: number;
  xMax: number;
  yMax: number;
}): { xMin: number; yMin: number; xMax: number; yMax: number } | null {
  const values = [box.xMin, box.yMin, box.xMax, box.yMax];
  if (values.every((v) => v >= 0 && v <= 100)) return box;
  if (values.every((v) => v >= 0 && v <= 1000)) {
    return { xMin: box.xMin / 10, yMin: box.yMin / 10, xMax: box.xMax / 10, yMax: box.yMax / 10 };
  }
  return null;
}

const ROTATION_PROMPT = `These are four copies of the SAME photo of a physical movie/TV disc case (DVD/Blu-ray/4K UHD/VHS/CD), each turned a different way, labelled Version A, B, C and D. Exactly one of them shows the case the right way up.

1. In "textSeen", copy three or four separate pieces of printed text from the case: the title, plus smaller text such as actor names, a tagline, the age-rating label's wording (e.g. "Parental Guidance Recommended"), a price sticker or a logo.
2. For EACH version, judge how MOST of that printed text appears in it: "upright" (letters stand normally and lines read left to right), "upside_down" (letters inverted, reading right to left), or "sideways" (lines run up or down the image). Go by the majority of the text lines - small print included - not by one large word: some covers print an actor's name or a word vertically along one edge, and that single line must not decide it.
3. In "upright", give the version where most of the printed text is upright. An upright disc case is normally taller than it is wide, a useful tie-breaker when the text is hard to read.`;

const ORIENTATION = { type: "STRING", enum: ["upright", "upside_down", "sideways"] };
const VERSION_DEGREES = { A: 0, B: 90, C: 180, D: 270 } as const;

/**
 * Detects how far clockwise a freshly-captured cover photo needs to be rotated so the disc case
 * ends up upright. scanResolver.ts rotates FIRST and only then runs detectCoverBoundingBox, since
 * the box percentages only mean something in the final orientation.
 *
 * Rebuilt 2026-10-06 after the user kept finding upside-down product images. Findings: the raw
 * phone photos carry no EXIF orientation tag (so the 2026-10-03 EXIF fix never applied), and the
 * old single-image "how many degrees?" question was unreliable - and most of its calls in a
 * real batch were HTTP 429s, which it silently treated as "no rotation". Now the photo goes in
 * as four small previews (0/90/180/270 clockwise, buildOrientationPreviews) and the model picks
 * the one whose printed text - judged across several separate lines, small print included -
 * reads upright: 38/40 correct on the user's real cover photos, every rotation of each tried,
 * the two misses being one cover with a huge vertical actor name. A 429/5xx is retried twice.
 *
 * Never throws; null on failure, which the caller treats as "leave it as is".
 */
export async function detectCoverRotation(imageBytes: Buffer, mimeType: string): Promise<0 | 90 | 180 | 270 | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  const previews = await buildOrientationPreviews(imageBytes, mimeType);
  if (!previews) return null;

  const parts: Array<Record<string, unknown>> = [{ text: ROTATION_PROMPT }];
  previews.forEach((preview, i) => {
    parts.push({ text: `Version ${"ABCD"[i]}:` });
    parts.push({ inline_data: { mime_type: "image/jpeg", data: preview.toString("base64") } });
  });
  const body = JSON.stringify({
    contents: [{ parts }],
    generationConfig: {
      temperature: 0,
      responseMimeType: "application/json",
      responseSchema: {
        type: "OBJECT",
        properties: {
          textSeen: { type: "STRING" },
          A: ORIENTATION,
          B: ORIENTATION,
          C: ORIENTATION,
          D: ORIENTATION,
          upright: { type: "STRING", enum: ["A", "B", "C", "D"] },
        },
        required: ["textSeen", "A", "B", "C", "D", "upright"],
        propertyOrdering: ["textSeen", "A", "B", "C", "D", "upright"],
      },
    },
  });

  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, attempt * 4000));
      const res = await fetch(`${API_URL}?key=${apiKey}`, { method: "POST", headers: { "Content-Type": "application/json" }, body });
      if (res.status === 429 || res.status >= 500) continue;
      if (!res.ok) return null;

      const data = (await res.json()) as GeminiGenerateContentResponse;
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) return null;
      const parsed = JSON.parse(text) as { upright?: string } & Record<string, unknown>;
      const pick = parsed.upright as keyof typeof VERSION_DEGREES | undefined;
      if (!pick || !(pick in VERSION_DEGREES)) return null;
      // The pick must agree with its own per-version judgement, or it's a guess.
      if (parsed[pick] !== "upright") return null;
      return VERSION_DEGREES[pick];
    }
    return null;
  } catch {
    return null;
  }
}
