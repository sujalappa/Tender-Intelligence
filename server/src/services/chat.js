import { Tender } from "../models/Tender.js";
import { Clause } from "../models/Clause.js";
import { config } from "../config.js";
import { completeJson, withRetry } from "./llm/index.js";
import { chatPrompt, CHAT_SCHEMA } from "./prompts.js";
import { rehydratePages, renderPages } from "./pdf.js";
import { ChatMessage } from "../models/ChatMessage.js";
import { recordUsage } from "../models/UsageEvent.js";

// A chat answer is a few hundred tokens. Reserving the extraction-sized
// ceiling (OPENROUTER_MAX_TOKENS, 40k) makes OpenRouter hold credit for
// output that will never be generated, which fails with a 402 on a modest
// balance for no reason. Reasoning tokens are billed as output and count
// against this same cap, so it's raised a bit past the old 4000 to leave
// room for "low"-effort thinking before the reply is written, without
// getting anywhere near the extraction-sized ceiling.
const CHAT_MAX_TOKENS = 8000;
// Chat needs to stay responsive — "low" effort (not the "medium" default
// used for the deep extraction/verify passes) trades a little quality for
// speed, which matters more for a back-and-forth conversation.
const CHAT_REASONING_EFFORT = "low";
import { AskedQuestion, normaliseQuestion } from "../models/AskedQuestion.js";

/**
 * Pool the question into the global, cross-tender question bank so later
 * extractions cover it up front (see buildLearnedQuestions in segregation).
 * Stores the model's tender-agnostic rewrite, not the raw question, so the
 * bank stays reusable. Never allowed to break a chat reply.
 */
async function recordQuestion({ topic, category, tenderId }) {
  const text = String(topic || "").trim();
  const key = normaliseQuestion(text);
  if (key.length < 8) return; // too vague to be worth pooling
  try {
    await AskedQuestion.updateOne(
      { key },
      {
        $set: { text, category, lastAskedAt: new Date() },
        $inc: { asked: 1 },
        $addToSet: { tenderIds: tenderId },
      },
      { upsert: true }
    );
  } catch (e) {
    console.warn("[chat] could not record question:", e.message);
  }
}

/**
 * Answer one chat question about a tender, grounded in its already-extracted
 * clauses + overview (see chatPrompt() for why this skips embeddings/RAG).
 * Read-only with respect to Tender/Clause — never mutates segregation state,
 * so it's always safe to call regardless of whether a segregation job is
 * running for a DIFFERENT tender.
 */
// `actor` (not `user`) because the prompt payload already binds `user` to
// the prompt text — this is the person who asked.
export async function answerChat(tenderId, { message, history = [], provider, model, actor } = {}) {
  if (!message?.trim()) throw new Error("message is required");
  const tender = await Tender.findById(tenderId).lean();
  if (!tender) throw new Error("Tender not found");

  const clauses = await Clause.find({ tenderId }).lean();
  if (!clauses.length && !tender.overview) {
    throw new Error("Nothing extracted for this tender yet — chat needs at least one finished category");
  }

  const p = provider || tender.provider || config.defaultProvider;
  const m = model || tender.model || (p === "gemini" ? config.gemini.model : config.openrouter.model);
  const { system, user } = chatPrompt(tender, clauses, history, message);

  const t0 = Date.now();
  let res = await withRetry(() => completeJson({ provider: p, model: m, system, user, schema: CHAT_SCHEMA, maxTokens: CHAT_MAX_TOKENS, reasoningEffort: CHAT_REASONING_EFFORT }));
  let searchedFullDocument = false;
  let usage = { ...res.usage };

  // The extracted clauses are a lossy view of the tender — if extraction
  // missed something, answering only from them would quietly report "not in
  // this tender" for a clause that is plainly on page 40. When the model
  // says the clauses didn't hold the answer, ask again with the full page
  // text. Costs ~3x a normal question, but only on the questions that would
  // otherwise have been answered wrongly.
  if (res.json.answeredFromClauses === false) {
    const full = await Tender.findById(tenderId, { pages: 1 }).lean();
    if (full?.pages?.length) {
      searchedFullDocument = true;
      const { taggedPages } = rehydratePages(
        full.pages.map((pg) => ({ file: pg.file, page: pg.page, text: pg.text, links: pg.links || [] }))
      );
      const retry = chatPrompt(tender, clauses, history, message, renderPages(taggedPages));
      const res2 = await withRetry(() => completeJson({ provider: p, model: m, system: retry.system, user: retry.user, schema: CHAT_SCHEMA, maxTokens: CHAT_MAX_TOKENS, reasoningEffort: CHAT_REASONING_EFFORT }));
      usage = {
        inputTokens: (usage.inputTokens || 0) + (res2.usage?.inputTokens || 0),
        outputTokens: (usage.outputTokens || 0) + (res2.usage?.outputTokens || 0),
      };
      res = res2;
    }
  }

  await recordQuestion({ topic: res.json.topic, category: res.json.category, tenderId });

  const reply = res.json.reply || "(no answer returned)";
  const durationMs = Date.now() - t0;

  if (actor) {
    // Persist both turns so the conversation survives a reload and a super
    // admin can see what was asked, and log the spend — chat used to be
    // billed without appearing in the tender's usage total at all.
    await ChatMessage.create([
      { tenderId, userId: actor._id, role: "user", text: message.trim() },
      {
        tenderId, userId: actor._id, role: "assistant", text: reply,
        category: res.json.category || "", searchedFullDocument,
        inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, durationMs,
      },
    ]).catch((e) => console.warn("[chat] could not save history:", e.message));

    await recordUsage({
      tenderId, userId: actor._id,
      kind: searchedFullDocument ? "chat-fulldoc" : "chat",
      provider: p, model: m,
      inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, durationMs,
    });
  }

  return {
    reply,
    topic: res.json.topic || "",
    category: res.json.category || "",
    searchedFullDocument,
    usage,
    durationMs,
  };
}
