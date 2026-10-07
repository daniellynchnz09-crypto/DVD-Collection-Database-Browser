/**
 * One place every Gemini vision/text call goes through (2026-10-06), so a day's scanning isn't
 * capped by a single model's free allowance.
 *
 * Free-tier quotas are counted per MODEL (a 429 names the model it hit - "limit: 500, model:
 * gemini-3.5-flash-lite"), so when one model is out of requests the call moves on to the next
 * one in the chain. Chosen from a live comparison on the user's own case photos the same day:
 *   1. gemini-flash-lite-latest (currently gemini-3.5-flash-lite) - the original model, ~500/day;
 *      38/40 on the four-way rotation check in the agent's run.
 *   2. gemini-3.1-flash-lite  - its own ~500/day; 9/9 on rotation + crop box together.
 *   3. gemma-4-26b-a4b-it     - its own allowance (Gemma's free limits aren't published); 9/9 and
 *                               8/9 on rotation, but its crop boxes were often off (4/9), so last.
 * The bigger Flash models only give ~20 free requests a day, and gemma-4-31b took ~45s per call,
 * so neither is in the chain. Override with GEMINI_MODELS (comma-separated) if needed.
 *
 * A model that answers 429 (quota), 404 (retired) or 5xx (overloaded) is skipped for a while -
 * for a 429, as long as Google's own retryDelay says (a used-up daily quota says ~hours, a
 * per-minute one seconds), otherwise a minute - and the next model is tried straight away.
 * Never throws: null when every model failed, which callers treat as "no answer".
 */

const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const DEFAULT_MODELS = ["gemini-flash-lite-latest", "gemini-3.1-flash-lite", "gemma-4-26b-a4b-it"];

const skipUntil = new Map<string, number>();

function modelChain(): string[] {
  const fromEnv = process.env.GEMINI_MODELS?.split(",").map((m) => m.trim()).filter(Boolean);
  return fromEnv && fromEnv.length > 0 ? fromEnv : DEFAULT_MODELS;
}

/** Google's 429 body carries `"retryDelay": "81548s"`; clamped to 1 minute - 24 hours. */
function retryDelayMs(body: string): number {
  const seconds = Number(body.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/)?.[1]);
  return Math.min(24 * 3600_000, Math.max(60_000, Number.isFinite(seconds) ? seconds * 1000 : 60_000));
}

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> } }>;
}

/**
 * Sends `parts` with `generationConfig` (responseSchema etc.) and returns the model's JSON text,
 * or null. Gemma can wrap its JSON in prose or a code fence, so only the outermost {...} is kept.
 */
export async function generateGeminiJson(parts: unknown[], generationConfig: Record<string, unknown>): Promise<string | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  const body = JSON.stringify({ contents: [{ parts }], generationConfig });

  for (const model of modelChain()) {
    if ((skipUntil.get(model) ?? 0) > Date.now()) continue;
    try {
      // Key in Google's x-goog-api-key header, not the `?key=` query string (2026-10-07), so it
      // can't turn up in a logged or error-reported URL.
      const res = await fetch(`${API_BASE}/${encodeURIComponent(model)}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body,
      });
      if (res.status === 429 || res.status === 404 || res.status >= 500) {
        skipUntil.set(model, Date.now() + (res.status === 429 ? retryDelayMs(await res.text()) : 60_000));
        continue;
      }
      // Anything else (e.g. a 400 for an option one model lacks) - try the next model.
      if (!res.ok) continue;
      const data = (await res.json()) as GeminiResponse;
      const text = (data.candidates?.[0]?.content?.parts ?? [])
        .filter((p) => !p.thought && typeof p.text === "string")
        .map((p) => p.text)
        .join("");
      const start = text.indexOf("{");
      const end = text.lastIndexOf("}");
      return start >= 0 && end > start ? text.slice(start, end + 1) : null;
    } catch {
      continue;
    }
  }
  return null;
}
