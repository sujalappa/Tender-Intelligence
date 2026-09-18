import OpenAI from "openai";
import { config } from "../../config.js";
import { parseJson } from "./gemini.js";

let client;
function getClient() {
  if (!config.openrouter.apiKey) throw new Error("OPENROUTER_API_KEY is not set");
  client ??= new OpenAI({
    baseURL: "https://openrouter.ai/api/v1",
    apiKey: config.openrouter.apiKey,
    defaultHeaders: {
      "HTTP-Referer": config.openrouter.siteUrl,
      "X-Title": config.openrouter.appName,
    },
  });
  return client;
}

/**
 * Structured JSON completion via OpenRouter (OpenAI-compatible).
 * Works for deepseek/*, anthropic/*, openai/*, google/* etc.
 */
export async function openrouterJson({ model, system, user, schema, maxTokens, reasoningEffort = config.openrouter.reasoningEffort }) {
  const ai = getClient();
  // "none" (or any falsy value) omits the field entirely rather than sending
  // reasoning:{effort:"none"} — OpenRouter's own enum doesn't include "none",
  // and a model that doesn't support reasoning just ignores an absent field.
  const reasoning = reasoningEffort && reasoningEffort !== "none"
    ? { effort: reasoningEffort, exclude: true } // exclude: don't return reasoning text — we only want the structured JSON, and returning it would just inflate the response for nothing we use
    : undefined;
  const res = await ai.chat.completions.create(
    {
      model: model || config.openrouter.model,
      temperature: 0.1,
      ...(reasoning ? { reasoning } : {}),
      // Without an explicit cap, OpenRouter pre-authorizes credit against the
      // model's full output capacity (we saw it request headroom for 131072
      // tokens even though real usage here tops out around 18-25k) — that
      // reservation check is what a 402 "requires more credits" error is
      // about, regardless of what a call would actually end up costing. Cap
      // it at something well above real observed usage so the reservation
      // matches reality instead of the model's theoretical max.
      max_tokens: maxTokens || config.openrouter.maxTokens,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: "extraction", strict: false, schema },
      },
      // Only route to providers that honour response_format, and prefer the
      // fastest one. OpenRouter spreads deepseek-v4-flash across upstreams
      // whose speed differs ~10x (observed: the same 90k-token extraction
      // took 5 min on one provider and 20+ min on another) — without this,
      // routing is by price, which is what produced the 20-minute calls.
      provider: { require_parameters: true, sort: "throughput" },
    },
    // Fail fast on a hung upstream request instead of the SDK's 10-minute
    // default, so withRetry actually gets a chance to retry. NOTE: the SDK's
    // own `timeout` option (per-call AND client-construction) is silently
    // ignored when talking to OpenRouter's baseURL — verified empirically
    // (a 3s timeout let a real request run 18-33s past it). A raw
    // AbortSignal passed as `signal` is what actually cancels the request.
    { signal: AbortSignal.timeout(config.llmTimeoutMs) }
  );
  const raw = res.choices?.[0]?.message?.content ?? "";
  return {
    json: parseJson(raw),
    raw,
    usage: {
      inputTokens: res.usage?.prompt_tokens ?? 0,
      outputTokens: res.usage?.completion_tokens ?? 0,
    },
  };
}

/** List models available on OpenRouter (for the UI dropdown). */
export async function listOpenrouterModels() {
  const r = await fetch("https://openrouter.ai/api/v1/models");
  if (!r.ok) throw new Error(`OpenRouter models fetch failed: ${r.status}`);
  const { data } = await r.json();
  return data
    .map((m) => ({
      id: m.id,
      name: m.name,
      contextLength: m.context_length,
      pricing: m.pricing,
      structuredOutputs: (m.supported_parameters || []).includes("structured_outputs"),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}
