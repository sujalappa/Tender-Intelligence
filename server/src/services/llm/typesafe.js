import { config } from "../../config.js";

/**
 * TypeSafe Jev — a "System One" decision model (https://docs.typesafe.ai).
 * It doesn't write text: it takes a state plus typed questions and returns,
 * per question, a choice with a probability for every option and a single
 * 0-1 confidence derived from how concentrated those probabilities are.
 * Used here only to weigh readings DeepSeek has already written out.
 */
// OpenRouter serves TypeSafe's System One API unchanged at its own base URL
// (https://openrouter.ai/docs/guides/community/jev), billed to the OpenRouter
// key — so no separate TypeSafe account is needed.
function target() {
  if (config.typesafe.apiKey) return { url: "https://api.typesafe.ai/v1/systemone", key: config.typesafe.apiKey };
  return { url: "https://openrouter.ai/api/v1/systemone", key: config.openrouter.apiKey };
}

export const typesafeConfigured = () => Boolean(config.typesafe.apiKey || config.openrouter.apiKey);

/**
 * @param state     text the questions are judged against (Jev context ≈32K tokens)
 * @param questions { [id]: { type: "choice", instructions, criteria: { option: description } } }
 * @returns { model, answers: { [id]: { choice, probabilities, confidence } }, usage }
 */
export async function systemOne({ state, questions }) {
  const { url, key } = target();
  if (!key) throw new Error("Neither OPENROUTER_API_KEY nor TYPESAFE_API_KEY is set");
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: config.typesafe.model, state, questions }),
    signal: AbortSignal.timeout(60 * 1000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Jev HTTP ${res.status}: ${body?.error?.message || body?.error || body?.message || "no detail"}`);
  return body;
}
