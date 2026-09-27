/**
 * Reads a cover-photo scan's captured image (front and/or back of a disc case) and extracts
 * whatever cataloguing signal is printed on it - title, primary format, disc count, and
 * movie-or-TV - so the resolver can feed it into the exact same best-match search a typed
 * title already uses (searchTitleCandidates, titleTextSearch.ts), without the user ever
 * typing anything. Added 2026-09-28 as part of cover-photo scanning - see Claude/TECH STACK
 * AND ARCHITECTURE/barcode-scanning-pipeline.md.
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
const FORMAT_OPTIONS = ["DVD", "Blu-Ray", "4K UHD Blu-Ray", "VHS", "CD Movie", "Unclear"] as const;
const SIDE_OPTIONS = ["front", "back", "unclear"] as const;
const MEDIA_TYPE_OPTIONS = ["Movie", "TV Series", "Unclear"] as const;

const PROMPT = `You are looking at a photo of a physical movie/TV disc case (DVD/Blu-ray/4K UHD/VHS/CD), cropped to just the case's cover art. Two different things could be shown:
- The FRONT cover: the main poster/key art, the release's own title treatment (large, stylized text), and often a format banner (see below).
- The BACK cover: a synopsis paragraph, cast/crew list, and a technical spec block (aspect ratio, runtime, audio tracks, chapter list, disc count) - little or no poster art.

First decide which side this is, as "side": "front", "back", or "unclear" if you genuinely cannot tell (e.g. the case is closed/spine-only, or the image is too cropped/blurry).

Then, regardless of which side it is, read whatever of the following you can actually find printed on it:
- "title": the exact title as printed on the case (the main release title - if a specific cut/edition is named, e.g. "The Final Cut" or "Director's Cut", include that suffix exactly as printed). Null if no legible title text is visible at all.
- "mediaType": "Movie" if this is a single film, "TV Series" if the case is for a TV show/season (look for wording like "Season", "Series", "The Complete First Season", multi-episode listings), or "Unclear" if you cannot tell.
- "format": the disc format from its packaging/banner - "4K UHD Blu-Ray" (black background band, silver/white "4K ULTRA HD" text), "Blu-Ray" (blue-toned packaging/logo), "DVD" (no such banner), "VHS" (a cassette, not a disc case), "CD Movie" (a CD jewel/slim case), or "Unclear" if you cannot tell.
- "discCount": the total number of discs this case holds, as a plain integer, if a spec block or spine text states it (e.g. "2-Disc Set", "3 Discs"). Null if not stated anywhere visible.

Only report what is actually legible in the image - never guess a value that isn't genuinely readable. If almost nothing is legible, answer "unclear" for side and null/"Unclear" for the rest rather than inventing an answer.`;

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
  /** Same canonical spellings as formatVision.ts's FormatVisionResult["format"], but nullable
   * here since a cover photo (especially a back cover with no banner visible) often just
   * doesn't show the format at all - unlike formatVision.ts, which is only ever called once a
   * format banner is already known to be the thing being photographed. */
  format: "DVD" | "Blu-Ray" | "4K UHD Blu-Ray" | "VHS" | "CD Movie" | null;
  discCount: number | null;
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
            },
            required: ["side", "mediaType", "format"],
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
    };

    if (!parsed.side || !(SIDE_OPTIONS as readonly string[]).includes(parsed.side)) return null;

    const format =
      parsed.format && (FORMAT_OPTIONS as readonly string[]).includes(parsed.format) && parsed.format !== "Unclear"
        ? (parsed.format as CoverVisionResult["format"])
        : null;
    const mediaType = (MEDIA_TYPE_OPTIONS as readonly string[]).includes(parsed.mediaType ?? "")
      ? (parsed.mediaType as CoverVisionResult["mediaType"])
      : "Unclear";

    return {
      side: parsed.side as CoverVisionResult["side"],
      title: typeof parsed.title === "string" && parsed.title.trim() ? parsed.title.trim() : null,
      mediaType,
      format,
      discCount: typeof parsed.discCount === "number" && parsed.discCount > 0 ? parsed.discCount : null,
    };
  } catch {
    return null;
  }
}
