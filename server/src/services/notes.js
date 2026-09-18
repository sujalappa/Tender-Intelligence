import { Tender } from "../models/Tender.js";
import { Note } from "../models/Note.js";
import { recordUsage } from "../models/UsageEvent.js";
import { config } from "../config.js";
import { completeJson, withRetry } from "./llm/index.js";

const EXEC_POINT_SCHEMA = {
  type: "object",
  properties: {
    label: { type: "string", description: "2-6 words naming the requirement, e.g. 'Rig capacity', 'LD for delay'" },
    value: { type: "string", description: "The requirement as a fact, max 20 words: the threshold/number/date/condition itself, not a sentence about it. If it is a risk, start with 'RISK — '." },
  },
  required: ["label", "value"],
};

/**
 * Save a note for one person, and optionally also fold it into the SHARED
 * executive brief. The note itself costs nothing; only the executive-summary
 * option makes an LLM call, so the brief's line matches the compressed
 * key/value style of the rest of it instead of pasting in a paragraph.
 *
 * The note is private to `user`; the exec-summary point is visible to
 * everyone and carries the author's name so super admins can see who added
 * what to the document that goes to leadership.
 */
export async function createNote(tenderId, actor, {
  title, text, category = "", importance = "high", source = "manual",
  clauseId = null, askedQuestion = "", sourceFile = "", page = 0, addToExecSummary = false,
} = {}) {
  if (!title?.trim()) throw new Error("title is required");
  if (!text?.trim()) throw new Error("text is required");

  const tender = await Tender.findById(tenderId).lean();
  if (!tender) throw new Error("Tender not found");

  let execSummary = null;
  let addedToExec = false;

  if (addToExecSummary) {
    if (!tender.execSummary) throw new Error("No executive summary generated yet — a super admin must generate it first");
    const p = tender.provider || config.defaultProvider;
    const m = tender.model || (p === "gemini" ? config.gemini.model : config.openrouter.model);
    const t0 = Date.now();
    const res = await withRetry(() =>
      completeJson({
        provider: p,
        model: m,
        system: "You compress one tender requirement into a single key/value line for a one-page brief read by a managing director. The value is the fact itself — number, date, percentage or condition — never a sentence describing it. You output only JSON matching the schema.",
        user: `Compress this into one label/value pair.\n\nTITLE: ${title}\n\nDETAIL: ${text}\n\nReturn JSON now.`,
        schema: EXEC_POINT_SCHEMA,
        reasoningEffort: "low", // a one-line compression doesn't need deep reasoning
        // Without this it falls back to the extraction-sized default (40k) and
        // OpenRouter pre-authorizes credit against that, which 402s on a
        // modest balance for a call that writes about fifty tokens.
        maxTokens: 1500,
      })
    );
    await recordUsage({
      tenderId, userId: actor._id, kind: "note-exec-point",
      provider: p, model: m,
      inputTokens: res.usage?.inputTokens, outputTokens: res.usage?.outputTokens,
      durationMs: Date.now() - t0,
    });

    const point = {
      label: String(res.json?.label || title).trim(),
      value: String(res.json?.value || "").trim() || text.slice(0, 120),
      file: sourceFile || "",
      page: Number(page) || 0,
      addedManually: true,
      addedBy: actor.name,
    };
    const cat = category || "commercial";
    // Append atomically — reading the whole execSummary, splicing the array
    // and writing it back would silently drop a point if two people added one
    // at the same time.
    const hasSection = (tender.execSummary.sections || []).some((s) => s.category === cat);
    if (hasSection) {
      await Tender.updateOne(
        { _id: tenderId, "execSummary.sections.category": cat },
        { $push: { "execSummary.sections.$.points": point } }
      );
    } else {
      await Tender.updateOne({ _id: tenderId }, { $push: { "execSummary.sections": { category: cat, points: [point] } } });
    }
    execSummary = (await Tender.findById(tenderId, { execSummary: 1 }).lean())?.execSummary || null;
    addedToExec = true;
  }

  const note = await Note.create({
    tenderId,
    userId: actor._id,
    category,
    title: title.trim(),
    text: text.trim(),
    importance: ["critical", "high", "medium", "low"].includes(importance) ? importance : "high",
    source,
    clauseId: clauseId || undefined,
    askedQuestion,
    sourceFile,
    page: Number(page) || 0,
    inExecSummary: addedToExec,
  });

  return { note: note.toObject(), execSummary };
}
