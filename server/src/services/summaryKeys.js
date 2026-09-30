import { Tender } from "../models/Tender.js";
import { Clause } from "../models/Clause.js";
import { SummaryKey } from "../models/SummaryKey.js";
import { config } from "../config.js";
import { completeJson, withRetry } from "./llm/index.js";
import { summaryKeysPrompt, SUMMARY_KEYS_SCHEMA } from "./prompts.js";
import { rehydratePages, renderPages } from "./pdf.js";
import { recordUsage } from "../models/UsageEvent.js";

const CATEGORIES = ["commercial", "financial", "technical", "legal", "technical_qualification"];
const MAX_TOKENS = 8000;

/** Shown for a key the tender doesn't answer — the row stays, so the gap is visible. */
export const NOT_MENTIONED = "Not mentioned";

/**
 * Answer a set of summary keys for one tender. Pass 1 reads the extracted
 * clauses (cheap). Any key still unanswered gets pass 2 over the full tender
 * text — the clauses only hold what extraction judged relevant, and a
 * standing key ("site visit mandatory?") is often a clause nobody flagged.
 * Same escalation chat uses.
 *
 * @param keys [{ _id?, label?, question }] — label may be empty for a new
 *             question; the model then proposes one.
 * @returns [{ keyId, label, question, value, found, file, page, category }] in `keys` order
 */
export async function answerKeys(tenderId, keys, { actor } = {}) {
  if (!keys.length) return [];
  const tender = await Tender.findById(tenderId).lean();
  if (!tender) throw new Error("Tender not found");
  const clauses = await Clause.find({ tenderId }).lean();
  if (!clauses.length && !tender.pages?.length) throw new Error("Nothing extracted for this tender yet");

  const p = tender.provider || config.defaultProvider;
  const m = tender.model || (p === "gemini" ? config.gemini.model : config.openrouter.model);
  const withIds = keys.map((k, i) => ({ ...k, id: `k${i + 1}` }));
  const usage = { inputTokens: 0, outputTokens: 0 };
  const t0 = Date.now();

  const ask = async (subset, docText) => {
    const { system, user } = summaryKeysPrompt(tender, clauses, subset, docText);
    const res = await withRetry(() =>
      completeJson({ provider: p, model: m, system, user, schema: SUMMARY_KEYS_SCHEMA, maxTokens: MAX_TOKENS, reasoningEffort: "low" })
    );
    usage.inputTokens += res.usage?.inputTokens || 0;
    usage.outputTokens += res.usage?.outputTokens || 0;
    const byId = {};
    for (const a of res.json?.answers || []) if (a?.id) byId[a.id] = a;
    return byId;
  };

  const answers = await ask(withIds);
  const unanswered = withIds.filter((k) => !(answers[k.id]?.found && String(answers[k.id]?.value || "").trim()));
  if (unanswered.length && tender.pages?.length) {
    const { taggedPages } = rehydratePages(tender.pages.map((pg) => ({ file: pg.file, page: pg.page, text: pg.text, links: pg.links || [], ocr: pg.ocr })));
    const second = await ask(unanswered, renderPages(taggedPages));
    // Keep a pass-1 label when pass 2 answers, so a proposed label doesn't flip between passes.
    for (const k of unanswered) if (second[k.id]) answers[k.id] = { ...second[k.id], label: answers[k.id]?.label || second[k.id].label };
  }

  await recordUsage({
    tenderId, userId: actor?._id, kind: "summary-keys", provider: p, model: m,
    inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, durationMs: Date.now() - t0,
  });

  // A citation only counts if that file+page really exists in this tender.
  const realPages = new Set((tender.pages || []).map((pg) => `${pg.file}\u0000${pg.page}`));
  return withIds.map((k) => {
    const a = answers[k.id] || {};
    const value = String(a.value || "").trim();
    const found = Boolean(a.found && value);
    const cited = found && realPages.has(`${a.file}\u0000${a.page}`);
    return {
      keyId: k._id ? String(k._id) : undefined,
      label: String(k.label || a.label || "").trim().slice(0, 80) || k.question.slice(0, 60),
      question: k.question,
      value: found ? value : NOT_MENTIONED,
      found,
      file: cited ? a.file : "",
      page: cited ? Number(a.page) : 0,
      category: CATEGORIES.includes(a.category) ? a.category : undefined,
    };
  });
}

/** Stored shape of one standing row on tender.execSummary.standing. */
export const toStanding = (a) => ({ keyId: a.keyId, label: a.label, value: a.value, found: a.found, file: a.file, page: a.page });

/**
 * Answer the keys this tender's summary doesn't have a row for yet (keys
 * added after the summary was generated) and store them. Existing rows are
 * left exactly as they are.
 */
export async function fillMissingKeys(tenderId, { actor } = {}) {
  const tender = await Tender.findById(tenderId, { execSummary: 1 }).lean();
  if (!tender?.execSummary) throw new Error("Generate the executive summary first");
  const have = new Set((tender.execSummary.standing || []).map((s) => s.keyId));
  const missing = (await SummaryKey.find({}).sort({ createdAt: 1 }).lean()).filter((k) => !have.has(String(k._id)));
  if (!missing.length) return tender.execSummary;
  const answered = await answerKeys(tenderId, missing, { actor });
  await Tender.updateOne({ _id: tenderId }, { $push: { "execSummary.standing": { $each: answered.map(toStanding) } } });
  return (await Tender.findById(tenderId, { execSummary: 1 }).lean()).execSummary;
}
