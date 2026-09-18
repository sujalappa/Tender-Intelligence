import { GoogleGenAI } from "@google/genai";
import { config } from "../../config.js";

let client;
function getClient() {
  if (!config.gemini.apiKey) throw new Error("GEMINI_API_KEY is not set");
  client ??= new GoogleGenAI({ apiKey: config.gemini.apiKey });
  return client;
}

/**
 * Structured JSON completion via Gemini.
 * @returns {{ json: any, usage: {inputTokens, outputTokens}, raw: string }}
 */
export async function geminiJson({ model, system, user, schema, thinkingLevel = config.gemini.thinkingLevel }) {
  const ai = getClient();
  const res = await ai.models.generateContent({
    model: model || config.gemini.model,
    contents: [{ role: "user", parts: [{ text: user }] }],
    config: {
      systemInstruction: system,
      responseMimeType: "application/json",
      responseSchema: schema,
      temperature: 0.1,
      thinkingConfig: { thinkingLevel },
      maxOutputTokens: 65536,
      // Fail fast on a hung request instead of waiting indefinitely, so
      // withRetry actually gets a chance to retry. httpOptions.timeout is
      // the documented mechanism, but the equivalent option on the OpenAI
      // SDK turned out to silently NOT abort a hung request (verified
      // empirically) — abortSignal is added as a defensive second path
      // since it's the same raw-AbortSignal pattern that verified working
      // there. Unverified here specifically (no GEMINI_API_KEY configured
      // to test against) — if calls still hang past llmTimeoutMs on this
      // provider, that's the first thing to check.
      httpOptions: { timeout: config.llmTimeoutMs },
      abortSignal: AbortSignal.timeout(config.llmTimeoutMs),
    },
  });
  const raw = res.text ?? "";
  const u = res.usageMetadata || {};
  return {
    json: parseJson(raw),
    raw,
    usage: {
      inputTokens: u.promptTokenCount ?? 0,
      outputTokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0),
    },
  };
}

export function parseJson(raw) {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    // Try to salvage the largest {...} block
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error(`Model returned non-JSON output: ${e.message}\n${raw.slice(0, 400)}`);
  }
}
