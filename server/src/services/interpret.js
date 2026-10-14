import { Tender } from "../models/Tender.js";
import { Clause } from "../models/Clause.js";
import { config } from "../config.js";
import { completeJson, withRetry } from "./llm/index.js";
import { systemOne, typesafeConfigured } from "./llm/typesafe.js";
import { interpretPrompt, INTERPRET_SCHEMA } from "./prompts.js";
import { recordUsage } from "../models/UsageEvent.js";

const NONE = "none_of_these";
const KEYS = ["A", "B", "C", "D"];
// Jev's context is ~32K tokens; this keeps clause + context well inside it.
const CONTEXT_CHARS = 24000;

/**
 * Bands from TypeSafe's own guidance on `confidence`
 * (https://docs.typesafe.ai/confidence): below 0.5, don't act on the model's
 * pick; above 0.9, safe to rely on. In tender terms: below 0.5 the clause is
 * genuinely ambiguous and the buyer has to be asked.
 */
export function verdictFor(confidence) {
  if (confidence == null) return "unscored";
  if (confidence >= 0.9) return "clear";
  if (confidence >= 0.5) return "likely";
  return "ambiguous";
}

/** The clause's own pages plus one either side, in that file — for the cross-references and definitions it leans on. */
function contextFor(tender, clause) {
  const from = (clause.page || 1) - 1;
  const to = (clause.pageEnd || clause.page || 1) + 1;
  const text = (tender.pages || [])
    .filter((p) => p.file === clause.sourceFile && p.page >= from && p.page <= to)
    .map((p) => `<<< ${p.file} p.${p.page} >>>\n${p.text}`)
    .join("\n\n");
  return text.length > CONTEXT_CHARS ? text.slice(0, CONTEXT_CHARS) + "\n[…truncated]" : text;
}

/**
 * Lay out the plausible readings of one clause (DeepSeek), then have Jev
 * weigh them: a probability per reading and one confidence for the pick.
 * Stored on the clause; a cached result is returned unless `refresh`.
 */
export async function interpretClause(tenderId, clauseId, { actor, refresh = false } = {}) {
  const clause = await Clause.findOne({ _id: clauseId, tenderId }).lean();
  if (!clause) throw new Error("Clause not found");
  if (clause.interpretation && !refresh) return clause.interpretation;

  const tender = await Tender.findById(tenderId, { pages: 1, provider: 1, model: 1 }).lean();
  if (!tender) throw new Error("Tender not found");
  const contextText = contextFor(tender, clause);

  // 1. The readings — always DeepSeek V4 Flash (the pipeline model), medium
  //    reasoning: telling a real ambiguity from a reworded one is judgement.
  const p = "openrouter";
  const m = config.openrouter.model;
  const t0 = Date.now();
  const { system, user } = interpretPrompt(clause, contextText);
  const res = await withRetry(() =>
    completeJson({ provider: p, model: m, system, user, schema: INTERPRET_SCHEMA, maxTokens: 12000, reasoningEffort: "medium" })
  );
  const json = res.json || {};
  const readings = (json.readings || [])
    .filter((r) => r?.title && r?.meaning)
    .slice(0, KEYS.length)
    .map((r, i) => ({
      key: KEYS[i],
      title: String(r.title).trim(),
      meaning: String(r.meaning).trim(),
      basis: String(r.basis || "").trim(),
      ifWrong: String(r.ifWrong || "").trim(),
    }));
  if (!readings.length) throw new Error("The model returned no readings for this clause — try again");
  await recordUsage({
    tenderId, userId: actor?._id, kind: "interpret", provider: p, model: m,
    inputTokens: res.usage?.inputTokens, outputTokens: res.usage?.outputTokens, durationMs: Date.now() - t0,
  });

  // 2. The weighing — Jev. A missing key or a failed call never loses the
  //    readings; they're shown unscored with the reason.
  let scoring = { status: "unavailable", reason: "No OpenRouter or TypeSafe API key is set on the server" };
  if (typesafeConfigured()) {
    const t1 = Date.now();
    try {
      const criteria = Object.fromEntries(readings.map((r) => [r.key, `${r.title}. ${r.meaning} Supported by: ${r.basis}`]));
      criteria[NONE] = "None of these readings matches what the clause actually says";
      const out = await systemOne({
        state: `TENDER CLAUSE ${clause.clauseRef || ""} — ${clause.title} [${clause.sourceFile} p${clause.page}]\n\n${clause.verbatim || clause.requirementDescription || ""}\n\nSURROUNDING PAGES\n${contextText}`,
        questions: {
          intended_reading: {
            type: "choice",
            instructions: "Judged only from the wording of this tender clause and the surrounding pages, which reading does the issuing authority most likely intend?",
            criteria,
          },
        },
      });
      const a = out?.answers?.intended_reading || {};
      const confidence = typeof a.confidence === "number" ? a.confidence : null;
      scoring = {
        status: "scored",
        model: out?.model || config.typesafe.model,
        choice: a.choice || null,
        probabilities: a.probabilities || {},
        confidence,
        verdict: verdictFor(confidence),
      };
      await recordUsage({
        tenderId, userId: actor?._id, kind: "interpret-jev", provider: "typesafe", model: scoring.model,
        inputTokens: out?.usage?.input_tokens, outputTokens: out?.usage?.output_tokens, durationMs: Date.now() - t1,
      });
    } catch (e) {
      console.warn(`[interpret ${clauseId}] Jev failed: ${e.message}`);
      scoring = { status: "failed", reason: e.message };
    }
  }

  const interpretation = {
    readings,
    whyAmbiguous: String(json.whyAmbiguous || "").trim(),
    preBidQuery: String(json.preBidQuery || "").trim(),
    scoring,
    generatedAt: new Date(),
    by: actor?.name,
    readingsModel: m,
  };
  await Clause.updateOne({ _id: clauseId }, { $set: { interpretation } });
  return interpretation;
}
