import { config } from "../../config.js";
import { geminiJson } from "./gemini.js";
import { openrouterJson } from "./openrouter.js";

/** Known context windows (tokens). Anything unknown falls back to 128k. */
const CONTEXT = {
  "gemini-3.8-flash": 1_048_576,
  "gemini-3.7-flash": 1_048_576,
  "deepseek/deepseek-v4-flash": 1_000_000,
};

export function contextWindowFor(model) {
  for (const [k, v] of Object.entries(CONTEXT)) if (model.startsWith(k)) return v;
  if (model.includes("claude")) return 1_000_000;
  if (model.includes("gemini")) return 1_000_000;
  return 128_000;
}

/**
 * Uniform entry point: { provider, model, system, user, schema } -> { json, usage }
 */
export async function completeJson({ provider, model, reasoningEffort, ...rest }) {
  provider ||= config.defaultProvider;
  // One knob, mapped to whichever field each provider actually takes:
  // Gemini's thinkingConfig.thinkingLevel (geminiJson's own param name) vs
  // OpenRouter's reasoning.effort (openrouterJson's own param name). Passing
  // `reasoningEffort: undefined` through to geminiJson still lets its default
  // parameter (`= config.gemini.thinkingLevel`) apply, since a destructured
  // default only fires on an explicitly-undefined value.
  if (provider === "gemini") return geminiJson({ model: model || config.gemini.model, thinkingLevel: reasoningEffort, ...rest });
  if (provider === "openrouter") return openrouterJson({ model: model || config.openrouter.model, reasoningEffort, ...rest });
  throw new Error(`Unknown provider: ${provider}`);
}

/**
 * Retry wrapper. `onAttemptFailed(err, attemptNo, willRetry)` fires on every
 * failed attempt — every retry re-sends a ~90k-token prompt, so the caller
 * must be able to surface it; otherwise the UI looks frozen while money is
 * being spent.
 */
export async function withRetry(fn, { retries = 2, baseMs = 2000, onAttemptFailed } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      // A client-side abort/timeout does NOT reliably cancel the request
      // server-side (verified against OpenRouter: an abandoned-but-aborted
      // request kept counting against available credits, causing later
      // calls to fail with 402). Retrying it just piles up more abandoned
      // in-flight requests instead of recovering — so never auto-retry
      // this class of error. A genuine timeout should surface as a failed
      // category the user can explicitly Resume, not a silent retry storm.
      const isAbort = e?.name === "AbortError" || /aborted/i.test(e?.message || "");
      const status = e?.status ?? e?.response?.status;
      const retryable = !isAbort && (!status || status === 429 || status >= 500 || /JSON/.test(e.message));
      const willRetry = retryable && i < retries;
      onAttemptFailed?.(e, i + 1, willRetry);
      if (!willRetry) break;
      await new Promise((r) => setTimeout(r, baseMs * 2 ** i));
    }
  }
  throw lastErr;
}
