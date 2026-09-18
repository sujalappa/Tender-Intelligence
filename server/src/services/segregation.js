import path from "node:path";
import { config } from "../config.js";
import { Tender } from "../models/Tender.js";
import { Clause } from "../models/Clause.js";
import { extractPages, estimateTokens, renderPages, windowPages, mergeFiles, rehydratePages } from "./pdf.js";
import { fetchLinkedFiles } from "./linkedDocs.js";
import { AskedQuestion } from "../models/AskedQuestion.js";
import { completeJson, contextWindowFor, withRetry } from "./llm/index.js";
import {
  CATEGORY_KEYS,
  EXTRACTION_SCHEMA,
  VERIFY_SCHEMA,
  OVERVIEW_SCHEMA,
  extractionPrompt,
  verificationPrompt,
  overviewPrompt,
} from "./prompts.js";

// Reserve room for the prompt scaffolding + the model's output.
const OUTPUT_RESERVE = 80_000;

/**
 * Tracks which tenders have a segregation job genuinely alive in THIS
 * process right now. This is the only reliable source of truth for "is a
 * run actually still running" — a DB status of "segregating" that hasn't
 * updated in a while is ambiguous (a single LLM call can legitimately take
 * 15+ minutes) and cannot be told apart from an abandoned job (server
 * restarted mid-run, the old promise just vanished) by elapsed time alone.
 * Letting a second job start while the first is genuinely still running
 * causes duplicate API spend AND data corruption (one job's cleanup wipes
 * the other's saved clauses) — isJobActive() is the guard against that.
 */
const activeJobs = new Map();
export function isJobActive(tenderId) {
  return activeJobs.has(String(tenderId));
}

/**
 * Full segregation job for one tender:
 *   parse all uploaded PDFs -> auto-fetch linked PDFs found inside them ->
 *   merge into one page corpus -> overview pass -> for each category:
 *   extract (per window) -> verify (per window, missing + incomplete-
 *   correction) -> save
 *
 * `resume: true` skips re-parsing (reuses already-stored pages/files) and
 * skips any category that already has a fully successful extract (+ verify,
 * if enabled) run recorded — so recovering an abandoned job doesn't re-spend
 * the tokens/time already paid for. `resume: false` (default) always does a
 * full fresh run, which is what you want after deliberately changing model/
 * provider/categories.
 */
export async function segregateTender(tenderId, { provider, model, verify = config.verifyPass, followLinks = config.followLinks, categories, resume = false } = {}) {
  const key = String(tenderId);
  if (activeJobs.has(key)) throw new Error("Segregation is already running for this tender");
  activeJobs.set(key, { startedAt: Date.now() });

  // When the caller names categories explicitly on a resume, they mean "run
  // THESE" — including ones that already have a successful run (e.g. to
  // redo a category whose extraction turned out to be bad). Without an
  // explicit list, resume skips whatever already succeeded.
  const forced = resume && Array.isArray(categories) && categories.length > 0;
  categories = Array.isArray(categories) && categories.length ? categories : CATEGORY_KEYS;

  try {
    const tender = await Tender.findById(tenderId);
    if (!tender) throw new Error("Tender not found");
    provider ||= config.defaultProvider;
    model ||= provider === "gemini" ? config.gemini.model : config.openrouter.model;
    const priorRuns = resume ? (tender.runs || []).map((r) => ({ category: r.category, pass: r.pass, error: r.error })) : [];

    const log = async (progress, patch = {}) => {
      console.log(`[segregate ${tenderId}] ${progress}`);
      await Tender.updateOne({ _id: tenderId }, { $set: { progress, ...patch } });
    };
    // Audit trail of attempts — separate from `runs`, which only records
    // attempts that actually came back.
    const note = async (msg) => {
      const line = `${new Date().toISOString()} ${msg}`;
      console.log(`[segregate ${tenderId}] [event] ${msg}`);
      await Tender.updateOne({ _id: tenderId }, { $push: { events: line } });
    };
    const linkLog = resume ? [...(tender.linkLog || [])] : [];
    const logLink = (msg) => { console.log(`[segregate ${tenderId}] [links] ${msg}`); linkLog.push(msg); };

    try {
      // ---- 1. Parse (or reuse, when resuming) --------------------------------
      const initialPatch = { status: "parsing", provider, model, error: "" };
      if (!resume) Object.assign(initialPatch, { runs: [], linkLog: [], events: [] });
      await log(resume ? "Resuming…" : "Parsing PDF(s)", initialPatch);

      // If the previous process died mid-call, the tender is still frozen on a
      // "calling …" progress line with no matching run. Say so explicitly —
      // that attempt was billed by the provider but its result never arrived.
      if (resume && /calling/.test(tender.progress || "")) {
        const m = tender.progress.match(/^(\w+): (extract|verify)/);
        await note(`previous attempt lost — server restarted while waiting on "${m ? `${m[1]} ${m[2]}` : tender.progress}" (billed by provider, result never received)`);
      }
      if (forced) await note(`resume with forced categories: ${categories.join(", ")} (will redo even if already done)`);

      let taggedPages, pageIndex, toGlobal, totalPages;
      const canReuseParse = resume && tender.pages?.length && tender.files?.length;

      if (canReuseParse) {
        await log("Reusing already-parsed pages and files — skipping re-parse and re-link-fetch");
        ({ taggedPages, pageIndex, toGlobal, totalPages } = rehydratePages(
          tender.pages.map((p) => ({ file: p.file, page: p.page, text: p.text, links: p.links || [] }))
        ));
      } else {
        const uploaded = tender.files.filter((f) => f.kind === "uploaded");
        const parsedUploaded = [];
        for (const f of uploaded) {
          const { pageCount, pages } = await extractPages(f.filePath);
          parsedUploaded.push({ name: f.name, filePath: f.filePath, kind: "uploaded", pageCount, pages });
        }

        // ---- Follow links found inside the uploaded PDFs -------------------
        let parsedLinked = [];
        if (followLinks) {
          await log("Checking links inside the PDF(s) for attached documents…");
          const destDir = uploaded[0]?.filePath ? path.dirname(uploaded[0].filePath) : "uploads";
          const { linked, candidateCount } = await fetchLinkedFiles(parsedUploaded, destDir, {
            maxLinked: config.maxLinkedDocs,
            maxAttempts: config.maxLinkedDocs * 2,
            onLog: logLink,
          });
          parsedLinked = linked;
          if (candidateCount === 0) logLink("no links found in the uploaded PDF(s)");
          else if (linked.length === 0) logLink(`found ${candidateCount} link(s), none were fetchable PDFs`);
        }

        const allParsed = [...parsedUploaded, ...parsedLinked];
        ({ taggedPages, pageIndex, toGlobal, totalPages } = mergeFiles(allParsed));

        const fullText = taggedPages.map((p) => p.text).join("\n");
        await Tender.updateOne(
          { _id: tenderId },
          {
            $set: {
              files: allParsed.map((f) => ({
                name: f.name,
                filePath: f.filePath,
                kind: f.kind,
                pageCount: f.pageCount,
                sourceUrl: f.sourceUrl,
                fetchedFrom: f.fetchedFrom,
              })),
              pages: taggedPages.map((p) => ({ file: p.file, page: p.page, text: p.text, links: p.links })),
              pageCount: totalPages,
              charCount: fullText.length,
              linkLog,
            },
          }
        );

        const scanned = taggedPages.filter((p) => p.text.length < 20).length;
        if (scanned > 0) console.warn(`[segregate ${tenderId}] ${scanned}/${totalPages} pages have no text (scanned?)`);
      }

      const toLocal = (globalPage) => pageIndex[globalPage] || { file: taggedPages[0]?.file, page: globalPage };
      const estTokens = estimateTokens(renderPages(taggedPages));
      await Tender.updateOne({ _id: tenderId }, { $set: { estTokens } });

      // ---- 2. Window ------------------------------------------------------
      const budget = Math.min(config.maxInputTokens, contextWindowFor(model) - OUTPUT_RESERVE);
      const windows = estTokens <= budget ? [{ from: 1, to: totalPages, pages: taggedPages }] : windowPages(taggedPages, budget);
      const windowInfo = (w) => (windows.length > 1 ? { from: w.from, to: w.to, total: totalPages } : null);
      await log(
        `${new Set(taggedPages.map((p) => p.file)).size} file(s), ${totalPages} pages, ≈${estTokens.toLocaleString()} tokens, ${windows.length} window(s). Segregating…`,
        { status: "segregating" }
      );

      // Never wipe clauses a person added by hand — those aren't the model's
      // to reproduce, so a re-extraction can't recreate them.
      if (!resume) await Clause.deleteMany({ tenderId, source: { $ne: "manual" } });

      // A pass counts as already-done only if every window succeeded.
      const passOk = (category, pass) =>
        priorRuns.filter((r) => r.category === category && r.pass === pass && !r.error).length >= windows.length;

      // ---- 3. Per category ----------------------------------------------------
      const summary = {};
      const stamp = () => new Date().toLocaleTimeString("en-IN", { hour12: false });
      for (const category of categories) {
        const alreadyDone = resume && !forced && passOk(category, "extract") && (!verify || passOk(category, "verify"));
        if (alreadyDone) {
          const existing = await Clause.find({ tenderId, category }).lean();
          summary[category] = summarise(existing);
          await Tender.updateOne({ _id: tenderId }, { $set: { [`summary.${category}`]: summary[category] } });
          await log(`${category}: already done (resumed) — ${existing.length} items kept`);
          continue;
        }
        // Same here: clear this category's machine-extracted leftovers before
        // redoing it, but keep anything a person captured into it by hand.
        if (resume) await Clause.deleteMany({ tenderId, category, source: { $ne: "manual" } });

        const learnedQuestions = await buildLearnedQuestions(category);
        if (learnedQuestions.length) await note(`${category}: prompt includes ${learnedQuestions.length} question(s) this team has asked before`);

        let found = [];

        // Extract pass
        for (const w of windows) {
          const docText = renderPages(w.pages);
          const { system, user } = extractionPrompt(category, docText, windowInfo(w), learnedQuestions);
          await note(`${category} extract: attempt 1 started`);
          await log(`${category}: extract ${w.from}-${w.to} — calling ${provider}/${model}… (started ${stamp()})`);
          const run = await callModel({ provider, model, system, user, category, pass: "extract", schema: EXTRACTION_SCHEMA, note });
          await Tender.updateOne({ _id: tenderId }, { $push: { runs: { ...run.record, window: `p${w.from}-p${w.to}` } } });
          if (run.record.error) await note(`${category} extract: gave up — ${run.record.error.slice(0, 160)}`);
          else await note(`${category} extract: completed, ${run.json.items?.length ?? 0} raw items in ${Math.round(run.record.durationMs / 1000)}s`);
          found.push(...normalise(run.json.items, category, "extract", model, toLocal));
          await log(`${category}: extract ${w.from}-${w.to} → ${run.json.items?.length ?? 0} items`);
        }
        // No de-duplication: everything the model returned is kept as-is.
        // (With multiple windows this means a clause in the overlap zone can
        // appear twice — the user prefers seeing it twice to losing it.)

        // Verify pass — audits for BOTH wholly-missed clauses and clauses pass 1
        // captured only partially (a real recall gap a plain "what's missing?"
        // prompt does not catch).
        if (verify) {
          for (const w of windows) {
            const docText = renderPages(w.pages);
            const inWindow = found.filter((c) => w.pages.some((p) => p.file === c.sourceFile && p.page === c.page));
            const { system, user } = verificationPrompt(category, docText, inWindow, windowInfo(w), toGlobal);
            await note(`${category} verify: attempt 1 started`);
            await log(`${category}: verify ${w.from}-${w.to} — calling ${provider}/${model}… (started ${stamp()})`);
            const run = await callModel({ provider, model, system, user, category, pass: "verify", schema: VERIFY_SCHEMA, note });
            await Tender.updateOne({ _id: tenderId }, { $push: { runs: { ...run.record, window: `p${w.from}-p${w.to}` } } });
            if (run.record.error) await note(`${category} verify: gave up — ${run.record.error.slice(0, 160)}`);

            const missing = normalise(run.json.missing, category, "verify", model, toLocal);
            const corrected = applyCorrections(found, run.json.incomplete, category, model, toLocal);
            found = [...found, ...missing];
            await log(`${category}: verify ${w.from}-${w.to} → +${missing.length} missed, ${corrected} corrected`);
          }
        }

        found.sort((a, b) => a.page - b.page || (a.clauseRef || "").localeCompare(b.clauseRef || ""));
        if (found.length) await Clause.insertMany(found.map((c) => ({ ...c, tenderId })));
        summary[category] = summarise(found);
        // Publish this category's count immediately — the UI shows finished
        // categories while the rest are still running, not only at the end.
        await Tender.updateOne({ _id: tenderId }, { $set: { [`summary.${category}`]: summary[category] } });
      }

      // Categories not in this run (a forced partial redo) keep their existing
      // data — the summary must still reflect it or the UI tabs show 0.
      for (const category of CATEGORY_KEYS) {
        if (summary[category]) continue;
        summary[category] = summarise(await Clause.find({ tenderId, category }).lean());
      }

      // ---- 4. Overview pass — runs LAST, after every category has its own
      // detailed clause-by-clause data to draw on. Working from raw page text
      // alone, this pass was unreliable at transcribing a value into its field
      // even when it clearly found and cited the right page (e.g. would write
      // "EMD is Rs. 10,66,000" in its free-text notes but leave the emdAmount
      // field blank) — while category extraction, focused on one thing at a
      // time, reliably gets it (financial: "EMD Amount" = 1,066,000 INR, found
      // independently on 4 different pages). Handing those already-verified
      // findings to the overview pass as grounding fixes exactly that gap,
      // without asking it to just trust them blindly over its own reading.
      if (resume && !forced && priorRuns.some((r) => r.pass === "overview" && !r.error) && tender.overview?.referenceNumber !== undefined) {
        await log("Overview already extracted (resumed)");
      } else {
        const priorFindings = await buildOverviewHints(tenderId);
        await runOverview(tenderId, { provider, model, firstWindow: windows[0], toLocal, priorFindings });
        await log("Overview extracted");
      }

      await log("Done", { status: "done", summary });
      return summary;
    } catch (err) {
      console.error(`[segregate ${tenderId}] FAILED`, err);
      await Tender.updateOne({ _id: tenderId }, { $set: { status: "failed", error: err.message, progress: "Failed" } });
      throw err;
    }
  } finally {
    activeJobs.delete(key);
  }
}

/**
 * Re-run ONLY the overview pass — one cheap LLM call (~80k in / ~2k out) —
 * using the already-stored pages and the already-extracted clauses as hints.
 * Touches nothing else: no clause is read for writing, `runs`/`summary`/
 * status are left alone (one "overview" run record is appended so cost is
 * still accounted for). For when the overview came back mostly empty but
 * the category extraction is fine and not worth re-paying for.
 */
export async function refreshOverview(tenderId, { provider, model } = {}) {
  const key = String(tenderId);
  if (activeJobs.has(key)) throw new Error("Segregation is already running for this tender");
  activeJobs.set(key, { startedAt: Date.now(), kind: "overview" });
  try {
    const tender = await Tender.findById(tenderId).lean();
    if (!tender) throw new Error("Tender not found");
    if (!tender.pages?.length) throw new Error("No parsed pages stored for this tender — run segregation first");
    provider ||= tender.provider || config.defaultProvider;
    model ||= tender.model || (provider === "gemini" ? config.gemini.model : config.openrouter.model);

    const { taggedPages, pageIndex, totalPages } = rehydratePages(
      tender.pages.map((p) => ({ file: p.file, page: p.page, text: p.text, links: p.links || [] }))
    );
    const toLocal = (g) => pageIndex[g] || { file: taggedPages[0]?.file, page: g };
    const estTokens = estimateTokens(renderPages(taggedPages));
    const budget = Math.min(config.maxInputTokens, contextWindowFor(model) - OUTPUT_RESERVE);
    const windows = estTokens <= budget ? [{ from: 1, to: totalPages, pages: taggedPages }] : windowPages(taggedPages, budget);

    const priorFindings = await buildOverviewHints(tenderId);
    await Tender.updateOne({ _id: tenderId }, { $push: { events: `${new Date().toISOString()} overview refresh: attempt 1 started (${priorFindings.length} hints from extracted clauses)` } });
    const before = tender.overview || {};
    await runOverview(tenderId, { provider, model, firstWindow: windows[0], toLocal, priorFindings });
    const after = (await Tender.findById(tenderId, { overview: 1 }).lean())?.overview || {};
    const filled = OVERVIEW_FIELD_KEYS_LIST.filter((k) => after[k]).length;
    const wasFilled = OVERVIEW_FIELD_KEYS_LIST.filter((k) => before[k]).length;
    await Tender.updateOne({ _id: tenderId }, { $push: { events: `${new Date().toISOString()} overview refresh: completed — ${filled}/${OVERVIEW_FIELD_KEYS_LIST.length} fields filled (was ${wasFilled})` } });
    return after;
  } finally {
    activeJobs.delete(key);
  }
}

/**
 * The questions this team has actually had to ask the chatbot, for this
 * category, most-asked first. Fed into the extraction prompt so a new tender
 * answers them up front instead of being interrogated afterwards. Capped so
 * a growing bank can't quietly inflate every extraction prompt.
 */
async function buildLearnedQuestions(category, limit = 12) {
  try {
    const rows = await AskedQuestion.find({ category }).sort({ asked: -1, lastAskedAt: -1 }).limit(limit).lean();
    return rows.map((r) => r.text).filter(Boolean);
  } catch (e) {
    console.warn(`[segregate] could not load learned questions: ${e.message}`);
    return [];
  }
}

const summarise = (list) => ({
  total: list.length,
  critical: list.filter((c) => c.importance === "critical").length,
  conflicts: list.filter((c) => c.clauseStatus === "CONFLICT").length,
  fromVerify: list.filter((c) => c.source === "verify").length,
  corrected: list.filter((c) => c.correctedByVerify).length,
});

// Known overview fields + a few observed near-miss names the model has
// produced despite the prompt asking for exact field names (schema isn't in
// strict mode, so this kind of drift can still happen) — mapped back rather
// than silently dropped. Anything else unrecognised is dropped, not guessed.
const OVERVIEW_FIELD_KEYS_LIST = [
  "tenderTitle", "referenceNumber", "issuingAuthority", "location", "scopeSummary",
  "contractPeriod", "estimatedValue", "tenderFee", "emdAmount", "emdExemptions",
  "preBidMeeting", "clarificationDeadline", "bidSubmissionStart", "bidSubmissionEnd", "bidOpeningDate",
];
const OVERVIEW_FIELD_KEYS = new Set(OVERVIEW_FIELD_KEYS_LIST);
const CITATION_KEY_ALIASES = {
  bidOpening: "bidOpeningDate",
  bidOpeningTime: "bidOpeningDate",
  emdExemption: "emdExemptions",
  estimatedBidValue: "estimatedValue",
  estimatedCost: "estimatedValue",
};

// A bare currency symbol/prefix with no actual figure ("Rs.", "INR", "₹") is
// worse than an empty field — it looks populated but tells the executive
// nothing. Strip it so an empty state (flagged in the UI) is what shows.
const CURRENCY_ONLY = /^(rs\.?|inr|usd|₹|\$)\s*[:.]?\s*$/i;
function sanitiseOverview(raw) {
  const out = {};
  for (const key of OVERVIEW_FIELD_KEYS) {
    const v = str(raw[key]);
    out[key] = CURRENCY_ONLY.test(v) ? "" : v;
  }
  out.notes = str(raw.notes);
  return out;
}

// Pull already-extracted clauses that look relevant to an overview field
// (EMD, estimated value, fee, key dates, contract period) and format them as
// compact grounding for the overview prompt. Read-only — never touches
// Clause documents, only reads them.
const OVERVIEW_HINT_KEYWORDS = /emd|earnest|estimated value|estimated bid|tender fee|processing fee|pre-?bid|clarification|bid submission|bid opening|bid validity|contract period|completion period|mobilization period/i;
async function buildOverviewHints(tenderId) {
  const all = await Clause.find({ tenderId }, { title: 1, criterion: 1, threshold: 1, unit: 1, amount: 1, deadline: 1, page: 1, sourceFile: 1, category: 1 }).lean();
  const relevant = all.filter((c) => OVERVIEW_HINT_KEYWORDS.test(`${c.title} ${c.criterion}`));
  return relevant.map((c) => {
    const bits = [c.title];
    if (c.threshold) bits.push(`threshold=${c.threshold}${c.unit ? " " + c.unit : ""}`);
    if (c.amount) bits.push(`amount=${c.amount}`);
    if (c.deadline) bits.push(`deadline=${c.deadline}`);
    return `- [${c.category} p${c.page}] ${bits.join(", ")}`;
  });
}

async function runOverview(tenderId, { provider, model, firstWindow, toLocal, priorFindings }) {
  if (!firstWindow) return;
  const docText = renderPages(firstWindow.pages);
  const { system, user } = overviewPrompt(docText, priorFindings);
  const run = await callModel({ provider, model, system, user, category: "overview", pass: "overview", schema: OVERVIEW_SCHEMA });
  await Tender.updateOne({ _id: tenderId }, { $push: { runs: run.record } });
  if (run.json && Object.keys(run.json).length) {
    const citations = {};
    for (const [rawKey, globalPage] of Object.entries(run.json.citations || {})) {
      const field = OVERVIEW_FIELD_KEYS.has(rawKey) ? rawKey : CITATION_KEY_ALIASES[rawKey];
      if (!field) continue; // unrecognised key — drop rather than guess
      const loc = toLocal(int(globalPage));
      if (loc) citations[field] = `${loc.file}#${loc.page}`;
    }
    await Tender.updateOne({ _id: tenderId }, { $set: { overview: { ...sanitiseOverview(run.json), citations } } });
  }
}

async function callModel({ provider, model, system, user, category, pass, schema, note }) {
  const t0 = Date.now();
  try {
    const res = await withRetry(() => completeJson({ provider, model, system, user, schema }), {
      onAttemptFailed: (e, attempt, willRetry) =>
        note?.(`${category} ${pass}: attempt ${attempt} failed after ${Math.round((Date.now() - t0) / 1000)}s — ${String(e.message).split("\n")[0].slice(0, 140)}${willRetry ? ` → retrying (attempt ${attempt + 1}, full prompt re-sent)` : ""}`),
    });
    const json = res.json || {};
    const clausesFound = Array.isArray(json.items) ? json.items.length : Array.isArray(json.missing) ? json.missing.length + (json.incomplete?.length || 0) : 0;
    return {
      json,
      record: {
        provider, model, category, pass,
        inputTokens: res.usage.inputTokens,
        outputTokens: res.usage.outputTokens,
        durationMs: Date.now() - t0,
        clausesFound,
      },
    };
  } catch (err) {
    return {
      json: {},
      record: { provider, model, category, pass, durationMs: Date.now() - t0, clausesFound: 0, error: err.message },
    };
  }
}

function normalise(items, category, source, model, toLocal) {
  return (items || [])
    .filter((i) => i && (i.verbatim || i.requirementDescription || i.summary))
    .map((i) => normaliseOne(i, category, source, model, toLocal));
}

// The model sometimes fills `verbatim` with a one-word answer ("Yes") instead
// of a quotation — seen on an entire category at once. Such a value would
// display as a bogus quote; treat it as absent (the item itself is kept).
const PLACEHOLDER = /^(yes|no|n\/?a|none|nil|null|-+|\.+)$/i;
const realQuote = (v) => (v.length >= 20 && !PLACEHOLDER.test(v) ? v : "");

function normaliseOne(i, category, source, model, toLocal) {
  const loc = toLocal(int(i.page));
  const locEnd = i.pageEnd ? toLocal(int(i.pageEnd)) : loc;
  return {
    category,
    source,
    model,
    sourceFile: loc?.file || "",
    clauseRef: str(i.clauseRef),
    title: str(i.title) || str(i.summary).slice(0, 80),
    page: loc?.page || 0,
    pageEnd: (locEnd?.file === loc?.file ? locEnd?.page : loc?.page) || loc?.page || 0,
    verbatim: realQuote(str(i.verbatim)),
    requirementDescription: str(i.requirementDescription),
    summary: str(i.summary),
    importance: ["critical", "high", "medium", "low"].includes(i.importance) ? i.importance : "medium",
    deadline: str(i.deadline),
    amount: str(i.amount),
    link: str(i.link),
    timePeriod: str(i.timePeriod),
    measurementPeriod: str(i.measurementPeriod),
    applicability: str(i.applicability),
    exception: str(i.exception),
    criterion: str(i.criterion),
    threshold: str(i.threshold),
    unit: str(i.unit),
    comparator: str(i.comparator) || "n/a",
    evidenceRequired: str(i.evidenceRequired),
    mandatoryStatus: ["MANDATORY", "CONDITIONAL", "OPTIONAL", "NOT_SPECIFIED"].includes(i.mandatoryStatus) ? i.mandatoryStatus : "",
    clauseStatus: ["EXPLICIT", "CONDITIONAL", "CONFLICT"].includes(i.clauseStatus) ? i.clauseStatus : "EXPLICIT",
    conflictNote: str(i.conflictNote),
    flags: Array.isArray(i.flags) ? i.flags.map(str).filter(Boolean) : [],
    correctedByVerify: false,
  };
}

/**
 * Apply pass-2 "incomplete" corrections in place onto the in-memory `found`
 * array (found is not yet in Mongo at this point, so this is a plain merge,
 * not a DB update). Falls back to inserting as a fresh verify-sourced item
 * when the target clause can't be matched — better a possible duplicate than
 * a silently dropped correction.
 */
function applyCorrections(found, incompleteList, category, model, toLocal) {
  let corrected = 0;
  for (const corr of incompleteList || []) {
    if (!corr?.corrected) continue;
    const targetLoc = toLocal(int(corr.targetPage));
    const targetRef = norm(corr.targetClauseRef);
    let match = found.find((c) => targetRef && norm(c.clauseRef) === targetRef && c.sourceFile === targetLoc?.file && Math.abs(c.page - targetLoc.page) <= 1);
    if (!match) {
      const targetTitle = str(corr.corrected.title);
      match = found.find((c) => c.sourceFile === targetLoc?.file && Math.abs(c.page - targetLoc.page) <= 1 && similar(c.title, targetTitle, 8));
    }
    const normalised = normaliseOne(corr.corrected, category, "extract", model, toLocal);
    if (match) {
      Object.assign(match, normalised, { page: match.page, pageEnd: match.pageEnd, sourceFile: match.sourceFile, source: match.source, correctedByVerify: true });
      corrected++;
    } else {
      found.push({ ...normalised, source: "verify", correctedByVerify: false });
    }
  }
  return corrected;
}

/** Title similarity, used only to match a verify-pass correction to the
 *  extract-pass item it refers to. */
function similar(a, b, minLen = 8) {
  if (!a || !b) return false;
  const na = a.toLowerCase().replace(/[^a-z0-9 ]/g, "");
  const nb = b.toLowerCase().replace(/[^a-z0-9 ]/g, "");
  if (na.length < minLen || nb.length < minLen) return false;
  if (na === nb) return true;
  const short = na.length < nb.length ? na : nb;
  const long = na.length < nb.length ? nb : na;
  if (short.length > 40 && long.includes(short.slice(0, Math.min(short.length, 160)))) return true;
  // token-set overlap
  const ta = new Set(na.split(" ").filter((w) => w.length > 3));
  const tb = new Set(nb.split(" ").filter((w) => w.length > 3));
  if (ta.size < 8 || tb.size < 8) return false;
  let inter = 0;
  for (const w of ta) if (tb.has(w)) inter++;
  return inter / Math.min(ta.size, tb.size) > 0.85;
}

const str = (v) => (v == null ? "" : String(v).trim());
const norm = (v) => str(v).toLowerCase().replace(/\s+/g, "");
const int = (v) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : 0;
};
