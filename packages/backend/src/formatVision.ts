/**
 * Detects a disc's format (DVD/Blu-Ray/4K UHD Blu-Ray/etc.) and whether the case is a
 * Steelbook by asking a vision-capable AI model to read the standardized format banner
 * printed on real retail disc packaging (4K UHD's black-and-silver banner, Blu-Ray's blue
 * branding, etc.) from the barcode's own product photo - added 2026-09-17 after the user
 * pointed out a real "Blade Runner: The Final Cut" scan whose product image clearly showed a
 * 4K UHD banner that had to be entered by hand.
 *
 * DELIBERATELY the last resort, not the first check - `scanResolver.ts` only calls this when
 * `extractFormatHint` (packages/shared/src/formatHints.ts) already failed to find the format
 * as plain text in the barcode listing's own title/description, per the user's own explicit
 * instruction: "If the information about the format can be found in the parsed text... use
 * that instead as taking that information from the text is always going to be more reliable
 * than a model guessing from an image." Text is cheap (no API call) and unambiguous when
 * present; the vision call only runs for the minority of listings where the format isn't
 * named anywhere in the text at all.
 *
 * MODEL CHOICE: Google Gemini, via a real (but non-Anthropic) API key the user provided,
 * specifically so this feature keeps working if the user ever cancels their separate Claude
 * Pro/Claude Code subscription - the two are unrelated products/billing (confirmed directly
 * with the user), but Gemini was still the user's own choice once that was clarified, driven
 * by wanting a model whose free tier fits the task rather than paying per call at all.
 * `gemini-flash-lite-latest` (Google's own always-current alias for its lightest/cheapest/
 * highest-free-quota tier, confirmed live via this exact API key on 2026-09-17 - the
 * available model list included everything from `gemini-2.5-flash-lite` through
 * `gemini-3.5-flash-lite`, and the "latest" alias resolves to whichever is current without
 * this file ever needing a version bump) - the user explicitly asked for "a model that will
 * give us the amount of prompts that we will need," i.e. the highest-free-quota tier over the
 * most capable one. This task doesn't need Gemini's smartest tier anyway: reading a
 * high-contrast, standardized printed banner is closer to logo/OCR recognition than open-
 * ended visual reasoning, a case the lite tier handles fine.
 *
 * NOT fine-tuned/trained on a custom image set - confirmed directly with the user this isn't
 * needed. A pretrained vision-language model already has ample exposure to real-world retail
 * packaging conventions; the prompt below describes what each banner looks like in plain
 * English rather than relying on any training data collection.
 *
 * Uses Gemini's plain REST `generateContent` endpoint via `fetch` (no `@google/genai`
 * dependency added) - consistent with every other external API in this codebase (ebay.ts,
 * omdb.ts, tmdb.ts all call `fetch` directly rather than pulling in an official SDK for a
 * single endpoint). `responseSchema` + `responseMimeType: "application/json"` (confirmed live
 * to return clean, unfenced JSON - a plain text prompt without this returned the same answer
 * wrapped in a ```json code fence instead, which would need extra unwrapping) is Gemini's own
 * structured-output mechanism, avoiding fragile prose-parsing.
 *
 * Same "wrong data is worse than no data" convention as every scraper/lookup in this
 * codebase: any failure (missing key, network error, non-2xx, unparseable response, or the
 * model itself saying it can't tell) returns `null`, never throws - this is a pre-fill
 * convenience on ConfirmScreen, never a value trusted enough to block or auto-commit a scan.
 *
 * MULTI-DISC BANNERS (added 2026-09-18, same day as the rest of this file) - the user pointed
 * out that a 4K UHD case's banner often also says "+ BLU-RAY" or "+ BLU-RAY + BONUS DISC",
 * meaning the case actually holds 2 or 3 discs (the 4K disc plus one or two special-features
 * discs), and a plain Blu-ray case's banner can likewise say "+ DVD" for its own bonus disc.
 * Found live the same day against the user's own real Blade Runner: The Final Cut case, whose
 * banner actually reads "4K UHD + BLU-RAY + DIGITAL DOWNLOAD" - a real-world case the initial
 * prompt got wrong (counted "DIGITAL DOWNLOAD" as a second real disc, reporting `TWO_EXTRA`
 * instead of the correct `ONE_EXTRA`). A digital download/digital copy code isn't a physical
 * disc at all, so the PROMPT below now explicitly excludes "DIGITAL"/"DIGITAL DOWNLOAD"/
 * "DIGITAL COPY" wording from the extraDiscs count entirely - only real disc-format words and
 * a generic "BONUS DISC" mention count toward NONE/ONE_EXTRA/TWO_EXTRA.
 * The model only reports what the banner literally lists (`extraDiscs` - see PROMPT above);
 * ConfirmScreen.tsx's `deriveDiscConfigFromExtraDiscs` is what actually decides disc
 * count/special-features fields from that, including which format to assume for an unlabeled
 * "Bonus Disc" (Blu-ray alongside a 4K UHD primary, DVD alongside a Blu-ray primary - the
 * user's own stated real-world experience, never seen otherwise) - kept as plain, editable
 * app code rather than folded into the prompt, so it stays auditable and easy to correct or
 * extend if a different combination ever turns up.
 */

const MODEL = "gemini-flash-lite-latest";
const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

// Matches packages/shared/src/titleParsing.ts's FORMAT_ALIASES canonical spellings, so a
// vision guess never disagrees with a manually-typed or text-hint-derived value on how the
// same format is spelled. "Unclear" is a real enum option (not just "omit the field") so the
// model has an explicit, easy way to say "I can't tell" rather than being forced to guess.
const FORMAT_OPTIONS = ["DVD", "Blu-Ray", "4K UHD Blu-Ray", "VHS", "CD Movie", "Unclear"] as const;

// The model's ONLY job for this part is to read what the banner itself literally lists
// alongside the primary format (added 2026-09-18, per the user's own real-world observations
// about multi-disc banners) - it does NOT decide what a bonus disc's own format actually is.
// That's a separate, deterministic, human-auditable mapping in
// deriveDiscConfigFromExtraDiscs (ConfirmScreen.tsx), not something baked into an opaque
// prompt - keeping "what does this banner combination imply" as plain, editable app code
// rather than model reasoning, so it can be corrected/extended later without touching the
// prompt at all.
const EXTRA_DISCS_OPTIONS = ["NONE", "ONE_EXTRA", "TWO_EXTRA"] as const;

const PROMPT = `You are looking at a photo of a physical movie disc's retail packaging (the front or spine of a DVD/Blu-ray/4K UHD case). Real disc packaging prints a standardized format banner or color scheme:
- 4K UHD Blu-ray: a black background band, usually with silver/white text, often near the top of the case, saying "4K ULTRA HD" or "ULTRA HD".
- Blu-ray (not 4K): predominantly blue-toned packaging/spine, usually with the blue Blu-ray Disc logo.
- DVD: no such banner - plain packaging, sometimes with a small "DVD" logo, no strong blue or black-and-silver banner.
- VHS: a cassette tape in a cardboard/plastic sleeve, not a disc case at all.
- CD Movie: a CD jewel case or slim case, not a DVD/Blu-ray-style case.

Identify the PRIMARY format from the banner/packaging shown, as "format".

Also check whether the banner lists MORE than one disc format together (e.g. "4K UHD + BLU-RAY", "BLU-RAY + DVD", or "4K UHD + BLU-RAY + BONUS DISC") - report this as "extraDiscs":
- "NONE" if the banner only names the one primary format, with nothing else listed alongside it.
- "ONE_EXTRA" if the banner names exactly one additional format/disc alongside the primary one (e.g. "4K UHD + BLU-RAY", or "BLU-RAY + DVD").
- "TWO_EXTRA" if the banner names two additional real DISCS alongside the primary format (e.g. "4K UHD + BLU-RAY + BONUS DISC" - a second format word plus a generic "BONUS DISC" mention both count as the two extras).
Do NOT try to guess what format a "BONUS DISC" itself is - just report that it's there.

IMPORTANT: "DIGITAL DOWNLOAD" or just "DIGITAL" is NOT a disc - it means a digital copy code included in the case, not a physical disc at all. NEVER count it as one of the extras. For example, a banner reading "4K UHD + BLU-RAY + DIGITAL DOWNLOAD" only has 2 real discs (the 4K UHD disc and one Blu-ray disc) - that's "ONE_EXTRA", the same as if the banner had just said "4K UHD + BLU-RAY" with no digital mention at all. Only count actual physical disc formats (4K UHD, BLU-RAY, DVD) and a generic "BONUS DISC" mention toward extraDiscs - ignore "DIGITAL"/"DIGITAL DOWNLOAD"/"DIGITAL COPY" wording entirely when deciding NONE/ONE_EXTRA/TWO_EXTRA.

Also state whether the case is a "Steelbook" - a metal (not cardboard/plastic) case, usually with distinctive embossed or glossy metallic artwork, often sold as a limited edition.

If the image is too unclear, cropped, or doesn't show enough of the packaging to tell the primary format, answer "Unclear" for format rather than guessing (in that case, answer "NONE" for extraDiscs too).`;

interface GeminiResponsePart {
  text?: string;
}
interface GeminiCandidate {
  content?: { parts?: GeminiResponsePart[] };
}
interface GeminiGenerateContentResponse {
  candidates?: GeminiCandidate[];
}

export interface FormatVisionResult {
  format: "DVD" | "Blu-Ray" | "4K UHD Blu-Ray" | "VHS" | "CD Movie";
  steelbook: boolean;
  /** What the banner itself lists alongside the primary format - see PROMPT above for the
   * exact definitions. Deliberately NOT an interpretation of what those extra discs' own
   * formats are - see deriveDiscConfigFromExtraDiscs in ConfirmScreen.tsx for that mapping,
   * kept separate and human-auditable rather than asked of the model. */
  extraDiscs: (typeof EXTRA_DISCS_OPTIONS)[number];
}

/** Fetches the image and base64-encodes it for Gemini's `inline_data` part - simpler than
 * Gemini's separate Files-API upload flow, and fine at this feature's low, on-demand call
 * volume (one image per scan that actually needs it, never a bulk job). */
async function fetchImageAsBase64(imageUrl: string): Promise<{ mimeType: string; data: string } | null> {
  try {
    const res = await fetch(imageUrl);
    if (!res.ok) return null;
    const contentType = res.headers.get("content-type");
    if (!contentType?.startsWith("image/")) return null;
    const buffer = Buffer.from(await res.arrayBuffer());
    return { mimeType: contentType.split(";")[0], data: buffer.toString("base64") };
  } catch {
    return null;
  }
}

export async function detectFormatFromImage(imageUrl: string): Promise<FormatVisionResult | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  // Same "missing config = no guess, not an error" convention as every scraper's missing-key
  // handling elsewhere in this codebase.
  if (!apiKey) return null;

  const image = await fetchImageAsBase64(imageUrl);
  if (!image) return null;

  try {
    const res = await fetch(`${API_URL}?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            parts: [{ text: PROMPT }, { inline_data: { mime_type: image.mimeType, data: image.data } }],
          },
        ],
        generationConfig: {
          // Pinned to 0 (added 2026-09-18) after finding the exact same prompt against the
          // exact same real product photo returned "ONE_EXTRA" on one call and "TWO_EXTRA" on
          // another, confirmed live via two direct raw API calls - Gemini's default sampling
          // temperature makes a borderline classification like this genuinely non-
          // deterministic, not a code/deployment issue. 0 asks for the model's single most
          // likely answer every time instead of sampling, which is what a classification task
          // like this wants - consistency, not creative variation.
          temperature: 0,
          responseMimeType: "application/json",
          responseSchema: {
            type: "OBJECT",
            properties: {
              format: { type: "STRING", enum: [...FORMAT_OPTIONS] },
              extraDiscs: { type: "STRING", enum: [...EXTRA_DISCS_OPTIONS] },
              steelbook: { type: "BOOLEAN" },
            },
            required: ["format", "extraDiscs", "steelbook"],
          },
        },
      }),
    });
    if (!res.ok) return null;

    const data = (await res.json()) as GeminiGenerateContentResponse;
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) return null;

    const parsed = JSON.parse(text) as { format?: string; extraDiscs?: string; steelbook?: boolean };
    if (!parsed.format || parsed.format === "Unclear") return null;
    if (!(FORMAT_OPTIONS as readonly string[]).includes(parsed.format)) return null;

    const extraDiscs = (EXTRA_DISCS_OPTIONS as readonly string[]).includes(parsed.extraDiscs ?? "")
      ? (parsed.extraDiscs as FormatVisionResult["extraDiscs"])
      : "NONE";

    return { format: parsed.format as FormatVisionResult["format"], steelbook: parsed.steelbook === true, extraDiscs };
  } catch {
    return null;
  }
}
