/**
 * LLM-based fallback for parsing a UPC listing title into its real component parts (title,
 * cast, format, region) - added 2026-09-22 after a real scan of "Bride of the Monster" (1955)
 * returned zero OMDB candidates. UPCitemdb's listing title was
 * "Bela Lugosi, Tor Johnson-bride Of The Monster (uk Import) Dvd" - the actor names are glued
 * directly onto the title with a hyphen and NO surrounding space ("Johnson-bride"), which the
 * existing " - " (space-hyphen-space) splitting rule in cleanProductTitleForSearch never
 * touches, so the OMDB search query came out as "Bela Lugosi Tor Johnson-bride Of The Monster"
 * and matched nothing.
 *
 * This is the latest in a recurring category of bug (see cleanProductTitleForSearch's own doc
 * comment in packages/shared/src/omdb.ts for the "|"-delimited and appended-barcode cases found
 * in earlier sessions) - every one so far has been a genuinely new shape of junk UPCitemdb
 * listings jam onto the real title with no consistent delimiter. Regex can keep chasing each
 * new shape as it's found, but this specific shape has no reliable syntactic signal at all:
 * nothing marks "Bela Lugosi, Tor Johnson" as actor names other than actually knowing those are
 * real actors' names, which is exactly what an LLM (rather than a hand-written pattern) is
 * suited for. Discussed directly with the user, who chose this fallback design over trying to
 * expand the regex approach further.
 *
 * DELIBERATELY A FALLBACK, NOT THE FIRST ATTEMPT - scanResolver.ts only calls this when the
 * existing free/instant regex-cleaned title already returned zero raw OMDB candidates, per the
 * user's own explicit choice (matching the "cheap first, escalate only on failure" pattern
 * already used for Estimated Value's Amazon auto-shorten-then-retry-once). Never runs on the
 * common case where the regex cleanup already works fine.
 *
 * MODEL CHOICE: same as formatVision.ts - `gemini-flash-lite-latest` via a plain REST
 * `generateContent` call (no `@google/genai` dependency), `GEMINI_API_KEY` (already configured
 * for the vision format-detection feature). Same "wrong data is worse than no data" convention:
 * any failure (missing key, network error, non-2xx, unparseable response) returns `null`, never
 * throws - this only ever feeds a second OMDB search attempt and some read-only display
 * context, never something trusted enough to block or auto-commit a scan.
 */

const MODEL = "gemini-flash-lite-latest";
const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

const PROMPT = `You are looking at the raw listing title (and sometimes a short description) of a UPC/barcode lookup for a physical DVD/Blu-ray/4K UHD/CD movie disc, scraped from resale/retail listings. These listings are messy - they often glue actor names, disc format, region, and condition text onto the real film/show title with no consistent separator (commas, hyphens with no surrounding space, pipes, brackets, or nothing at all).

Your job is to pull apart what's actually in the text:
- "title": your best guess at just the real film or TV show title, with every actor name, format word, region annotation, and condition/marketing text removed. If you genuinely cannot tell what the title is, use an empty string.
- "actors": an array of any actor/cast names mentioned in the text (their names as written), or an empty array if none are mentioned.
- "format": the disc format if explicitly mentioned in the text - one of "DVD", "Blu-Ray", "4K UHD Blu-Ray", "VHS", "CD Movie" - or null if not mentioned or unclear.
- "region": any disc region text mentioned (e.g. "UK", "Region 2", "Region B", "Region 4", "NTSC", "PAL") exactly as written, or null if not mentioned.

Example input: "Bela Lugosi, Tor Johnson-bride Of The Monster (uk Import) Dvd"
Example output: {"title": "Bride of the Monster", "actors": ["Bela Lugosi", "Tor Johnson"], "format": "DVD", "region": "UK"}

Only report what the text actually says - never invent an actor, format, or region that isn't genuinely present in it.`;

interface GeminiResponsePart {
  text?: string;
}
interface GeminiCandidate {
  content?: { parts?: GeminiResponsePart[] };
}
interface GeminiGenerateContentResponse {
  candidates?: GeminiCandidate[];
}

export interface ListingTextExtraction {
  /** Empty string means the model couldn't isolate a title at all. */
  title: string;
  actors: string[];
  format: "DVD" | "Blu-Ray" | "4K UHD Blu-Ray" | "VHS" | "CD Movie" | null;
  region: string | null;
}

const FORMAT_OPTIONS = ["DVD", "Blu-Ray", "4K UHD Blu-Ray", "VHS", "CD Movie"] as const;

export async function extractListingTextFields(
  listingTitle: string,
  listingDescription?: string
): Promise<ListingTextExtraction | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  const text = listingDescription ? `${listingTitle}\n${listingDescription}` : listingTitle;

  try {
    const res = await fetch(`${API_URL}?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: `${PROMPT}\n\nText to parse: ${JSON.stringify(text)}` }] }],
        generationConfig: {
          // Same reasoning as formatVision.ts: pinned to 0 for a consistent, non-creative
          // extraction rather than sampled variation across identical inputs.
          temperature: 0,
          responseMimeType: "application/json",
          responseSchema: {
            type: "OBJECT",
            properties: {
              title: { type: "STRING" },
              actors: { type: "ARRAY", items: { type: "STRING" } },
              format: { type: "STRING", enum: [...FORMAT_OPTIONS] },
              region: { type: "STRING" },
            },
            required: ["title", "actors"],
          },
        },
      }),
    });
    if (!res.ok) return null;

    const data = (await res.json()) as GeminiGenerateContentResponse;
    const responseText = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!responseText) return null;

    const parsed = JSON.parse(responseText) as {
      title?: string;
      actors?: string[];
      format?: string;
      region?: string;
    };

    const format = (FORMAT_OPTIONS as readonly string[]).includes(parsed.format ?? "")
      ? (parsed.format as ListingTextExtraction["format"])
      : null;

    return {
      title: parsed.title?.trim() ?? "",
      actors: (parsed.actors ?? []).map((a) => a.trim()).filter((a) => a.length > 0),
      format,
      region: parsed.region?.trim() || null,
    };
  } catch {
    return null;
  }
}
