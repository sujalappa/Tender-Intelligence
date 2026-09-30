import { Tender } from "../models/Tender.js";
import { Clause } from "../models/Clause.js";
import { config } from "../config.js";
import { completeJson, withRetry } from "./llm/index.js";
import { executiveSummaryPrompt, EXEC_SUMMARY_SCHEMA } from "./prompts.js";
import { recordUsage } from "../models/UsageEvent.js";
import { SummaryKey } from "../models/SummaryKey.js";
import { answerKeys, toStanding } from "./summaryKeys.js";

const CATEGORY_ORDER = ["commercial", "financial", "technical", "legal", "technical_qualification"];

/**
 * Ask the model to compress this tender's critical (+ conflicting) clauses
 * into a one-page executive brief, and store it on the Tender. One LLM call.
 * Reads Clause docs only; writes only `tender.execSummary` — never touches
 * segregation state, so safe to run at any time once there's data.
 */
// `actor` (not `user`) — the prompt payload already binds `user` to the
// prompt text; this is the person who triggered the generation.
export async function generateExecutiveSummary(tenderId, { provider, model, actor } = {}) {
  const tender = await Tender.findById(tenderId).lean();
  if (!tender) throw new Error("Tender not found");

  const clauses = await Clause.find({
    tenderId,
    $or: [{ importance: "critical" }, { clauseStatus: "CONFLICT" }],
  }).lean();
  if (!clauses.length) throw new Error("No critical clauses extracted yet — run segregation first");

  const p = provider || tender.provider || config.defaultProvider;
  const m = model || tender.model || (p === "gemini" ? config.gemini.model : config.openrouter.model);
  const { system, user } = executiveSummaryPrompt(tender, clauses);

  const t0 = Date.now();
  // The team's standing keys are answered alongside, from ALL clauses (plus
  // the full text if needed) — the brief itself only sees critical clauses,
  // and a standing key is often not one of those. A failure there must not
  // cost the brief: the rows are simply missing and "Fill missing keys"
  // retries them.
  const keys = await SummaryKey.find({}).sort({ createdAt: 1 }).lean();
  const [res, standing] = await Promise.all([
    withRetry(() => completeJson({ provider: p, model: m, system, user, schema: EXEC_SUMMARY_SCHEMA, maxTokens: 16000 })),
    answerKeys(tenderId, keys, { actor }).catch((e) => {
      console.warn(`[exec-summary ${tenderId}] summary keys failed: ${e.message}`);
      return [];
    }),
  ]);
  const json = res.json || {};

  // Validate citations against real files/pages so a hallucinated page can't
  // render as a working-looking link.
  const known = new Set(clauses.map((c) => `${c.sourceFile}\u0000${c.page}`));
  const fix = (pt) => {
    const ok = known.has(`${pt.file}\u0000${pt.page}`);
    return { label: String(pt.label || "").trim(), value: String(pt.value || "").trim(), file: ok ? pt.file : "", page: ok ? Number(pt.page) : 0 };
  };
  const sections = (json.sections || [])
    .filter((s) => CATEGORY_ORDER.includes(s.category))
    .sort((a, b) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category))
    .map((s) => ({ category: s.category, points: (s.points || []).map(fix).filter((x) => x.label && x.value) }));

  const execSummary = {
    headline: String(json.headline || "").trim(),
    atAGlance: (json.atAGlance || []).map(fix).filter((x) => x.label && x.value),
    sections,
    watchouts: (json.watchouts || []).map((w) => String(w).trim()).filter(Boolean),
    standing: standing.map(toStanding),
    generatedAt: new Date(),
    provider: p,
    model: m,
    sourceClauseCount: clauses.length,
    usage: res.usage,
    durationMs: Date.now() - t0,
  };
  await Tender.updateOne({ _id: tenderId }, { $set: { execSummary } });
  await recordUsage({
    tenderId, userId: actor?._id, kind: "exec-summary",
    provider: p, model: m,
    inputTokens: res.usage?.inputTokens, outputTokens: res.usage?.outputTokens,
    durationMs: execSummary.durationMs,
  });
  return execSummary;
}
