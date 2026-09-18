import { Router } from "express";
import multer from "multer";
import path from "node:path";
import fs from "node:fs/promises";
import { Tender } from "../models/Tender.js";
import { Clause, CATEGORIES } from "../models/Clause.js";
import { segregateTender, isJobActive, refreshOverview } from "../services/segregation.js";
import { answerChat } from "../services/chat.js";
import { generateExecutiveSummary } from "../services/execSummary.js";
import { AskedQuestion } from "../models/AskedQuestion.js";
import { CATEGORY_DEFS } from "../services/prompts.js";
import { listOpenrouterModels } from "../services/llm/openrouter.js";
import { config } from "../config.js";
import { UsageEvent } from "../models/UsageEvent.js";
import notesRouter, { chatHistoryRouter } from "./notes.js";
import { requireAuth, requireSuperAdmin } from "../services/auth.js";

const router = Router();

// Per-tender, per-user collections.
router.use("/:id/notes", notesRouter);
router.use("/:id/chat-history", chatHistoryRouter);
// Overridable so a host with an ephemeral filesystem (most PaaS platforms,
// including Render's default web service) can be pointed at a mounted
// persistent disk — without this, every redeploy silently wipes every
// uploaded tender PDF, breaking the "open the real PDF page" citation proof
// even though the extracted clauses/text remain fine (those live in Mongo).
const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || "uploads");

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, file, cb) => cb(null, `${Date.now()}-${file.originalname.replace(/[^\w.-]/g, "_")}`),
  }),
  limits: { fileSize: 200 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, file.mimetype === "application/pdf" || file.originalname.toLowerCase().endsWith(".pdf")),
});

/** Category metadata for the UI */
router.get("/meta/categories", requireAuth, (_req, res) => {
  res.json(CATEGORIES.map((key) => ({ key, label: CATEGORY_DEFS[key].label })));
});

/** Provider / model options for the UI */
router.get("/meta/models", requireSuperAdmin, async (_req, res) => {
  const out = {
    defaultProvider: config.defaultProvider,
    gemini: { configured: Boolean(config.gemini.apiKey), default: config.gemini.model, models: ["gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.5-flash"] },
    openrouter: { configured: Boolean(config.openrouter.apiKey), default: config.openrouter.model, models: [] },
  };
  try {
    const all = await listOpenrouterModels();
    // Only models that can honour a JSON schema and hold at least ~128k context are useful here
    out.openrouter.models = all.filter((m) => m.structuredOutputs && m.contextLength >= 128000);
  } catch (e) {
    out.openrouter.error = e.message;
  }
  res.json(out);
});

/** Upload one or more tender PDFs and start segregation. Any hyperlinks
 *  found inside them that point to other PDFs are auto-fetched too (see
 *  services/linkedDocs.js) unless followLinks=false is passed. */
router.post("/", requireSuperAdmin, upload.array("files", 20), async (req, res, next) => {
  try {
    if (!req.files?.length) return res.status(400).json({ error: "At least one PDF file required (field name: files)" });
    const tender = await Tender.create({
      title: req.body.title || req.files[0].originalname.replace(/\.pdf$/i, ""),
      files: req.files.map((f) => ({ name: f.originalname, filePath: f.path, kind: "uploaded" })),
      status: "uploaded",
    });
    const opts = {
      provider: req.body.provider || undefined,
      model: req.body.model || undefined,
      verify: req.body.verify === undefined ? undefined : req.body.verify !== "false",
      followLinks: req.body.followLinks === undefined ? undefined : req.body.followLinks !== "false",
    };
    // Fire and forget; client polls GET /:id
    segregateTender(tender._id, opts).catch(() => {});
    res.status(202).json({ id: tender._id, status: "uploaded" });
  } catch (e) {
    next(e);
  }
});

/** Re-run segregation on an existing tender (e.g. with a different model, or
 *  to recover an abandoned run). Blocking is based on isJobActive() — whether
 *  a job for this tender is genuinely still executing in this process — not
 *  on how long ago the DB last updated, since a single LLM call can
 *  legitimately take 15+ minutes and elapsed time alone can't tell a slow
 *  call apart from a dead one. If isJobActive() says no, whatever the DB
 *  status is, it's safe to start: either nothing was running, or a previous
 *  process died mid-run and left it stuck (STALE_RUN_MS is only used by the
 *  client to decide when to surface the "resume" option, not to gate here).
 *  Pass resume:true to skip already-completed categories instead of a full
 *  restart. */
router.post("/:id/segregate", requireSuperAdmin, async (req, res, next) => {
  try {
    const tender = await Tender.findById(req.params.id);
    if (!tender) return res.status(404).json({ error: "Not found" });
    if (isJobActive(tender._id)) {
      return res.status(409).json({ error: "Already running" });
    }
    const { provider, model, verify, followLinks, categories, resume } = req.body || {};
    segregateTender(tender._id, { provider, model, verify, followLinks, categories, resume }).catch(() => {});
    res.status(202).json({ id: tender._id });
  } catch (e) {
    next(e);
  }
});

router.get("/", requireAuth, async (_req, res, next) => {
  try {
    const list = await Tender.find({}, { pages: 0, runs: 0 }).sort({ createdAt: -1 }).lean();
    res.json(list);
  } catch (e) {
    next(e);
  }
});

router.get("/:id", requireAuth, async (req, res, next) => {
  try {
    const tender = await Tender.findById(req.params.id, { pages: 0 }).lean();
    if (!tender) return res.status(404).json({ error: "Not found" });
    // `runs` only ever held segregation passes, so chat and executive-summary
    // calls were real spend that never showed up in this total. UsageEvent
    // captures those; the number the UI shows is the sum of both.
    const usage = (tender.runs || []).reduce(
      (acc, r) => ({ inputTokens: acc.inputTokens + (r.inputTokens || 0), outputTokens: acc.outputTokens + (r.outputTokens || 0), calls: acc.calls + 1, errors: acc.errors + (r.error ? 1 : 0) }),
      { inputTokens: 0, outputTokens: 0, calls: 0, errors: 0 }
    );
    const events = await UsageEvent.find({ tenderId: req.params.id }, { kind: 1, inputTokens: 1, outputTokens: 1 }).lean();
    const byKind = {};
    for (const e of events) {
      byKind[e.kind] ||= { calls: 0, inputTokens: 0, outputTokens: 0 };
      byKind[e.kind].calls++;
      byKind[e.kind].inputTokens += e.inputTokens || 0;
      byKind[e.kind].outputTokens += e.outputTokens || 0;
      usage.inputTokens += e.inputTokens || 0;
      usage.outputTokens += e.outputTokens || 0;
      usage.calls++;
    }
    usage.segregationOnly = (tender.runs || []).reduce(
      (acc, r) => ({ inputTokens: acc.inputTokens + (r.inputTokens || 0), outputTokens: acc.outputTokens + (r.outputTokens || 0) }),
      { inputTokens: 0, outputTokens: 0 }
    );
    usage.byKind = byKind;
    res.json({ ...tender, usage });
  } catch (e) {
    next(e);
  }
});

/** Clauses, optionally filtered: ?category=legal&importance=critical&q=arbitration */
router.get("/:id/clauses", requireAuth, async (req, res, next) => {
  try {
    const filter = { tenderId: req.params.id };
    if (req.query.category) filter.category = req.query.category;
    if (req.query.importance) filter.importance = req.query.importance;
    if (req.query.q) {
      const rx = new RegExp(String(req.query.q).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      filter.$or = [{ title: rx }, { verbatim: rx }, { requirementDescription: rx }, { summary: rx }, { clauseRef: rx }, { criterion: rx }];
    }
    const clauses = await Clause.find(filter).sort({ category: 1, page: 1 }).lean();
    res.json(clauses);
  } catch (e) {
    next(e);
  }
});

/** Raw text of one page – lets the UI show the clause in context.
 *  ?file=<name> disambiguates when the tender bundles multiple PDFs (page
 *  numbers reset per file); defaults to the first uploaded file. */
router.get("/:id/pages/:page", requireAuth, async (req, res, next) => {
  try {
    const page = Number(req.params.page);
    const tender = await Tender.findById(req.params.id, { pages: 1, files: 1 }).lean();
    if (!tender) return res.status(404).json({ error: "Not found" });
    const file = req.query.file || tender.files?.[0]?.name;
    // `pages` is flat and in file order, so the global index of the matched
    // page tells us exactly which file entry it belongs to — needed because
    // two different files in one bundle can share a name (e.g. two
    // "slafds.pdf" fetched from different links).
    const gi = tender.pages?.findIndex((p) => p.page === page && p.file === file);
    let fileIndex = -1;
    if (gi >= 0) {
      let acc = 0;
      for (let i = 0; i < (tender.files || []).length; i++) {
        acc += tender.files[i].pageCount || 0;
        if (gi < acc) { fileIndex = i; break; }
      }
    }
    const found = gi >= 0 ? tender.pages[gi] : null;
    res.json({ ...(found || { page, file, text: "" }), fileIndex });
  } catch (e) {
    next(e);
  }
});

/** Stream one of the tender's source PDFs inline, so the UI can show the
 *  real page (iframe + #page=N) instead of just the extracted text — an
 *  executive verifying a clause needs to see the actual document. Addressed
 *  by index because filenames within a bundle are not unique. */
router.get("/:id/file/:index", requireAuth, async (req, res, next) => {
  try {
    const tender = await Tender.findById(req.params.id, { files: 1, title: 1 }).lean();
    if (!tender) return res.status(404).json({ error: "Not found" });
    const f = tender.files?.[Number(req.params.index)];
    if (!f?.filePath) return res.status(404).json({ error: "File not found" });
    // Never serve anything outside the upload dir, whatever is in the DB.
    const resolved = path.resolve(f.filePath);
    if (!resolved.startsWith(UPLOAD_DIR + path.sep)) return res.status(403).json({ error: "Forbidden" });
    await fs.access(resolved).catch(() => { throw new Error("missing-on-disk"); });
    res.type("application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(f.name || "document.pdf")}"`);
    res.sendFile(resolved);
  } catch (e) {
    if (e.message === "missing-on-disk") return res.status(410).json({ error: "The source PDF is no longer on disk" });
    next(e);
  }
});

/** Re-run only the overview pass (one cheap call) using stored pages plus
 *  the extracted clauses as hints. Never touches clauses/runs/status. */
router.post("/:id/overview", requireSuperAdmin, async (req, res, next) => {
  try {
    if (isJobActive(req.params.id)) return res.status(409).json({ error: "Already running" });
    const { provider, model } = req.body || {};
    const overview = await refreshOverview(req.params.id, { provider, model });
    res.json({ overview });
  } catch (e) {
    if (/not found|No parsed pages|already running/i.test(e.message)) return res.status(400).json({ error: e.message });
    next(e);
  }
});

/** Generate (or regenerate) the one-page executive brief. One LLM call over
 *  the critical + conflicting clauses; result is stored on the tender and
 *  comes back with GET /:id afterwards. Read-only wrt clauses/segregation. */
router.post("/:id/executive-summary", requireSuperAdmin, async (req, res, next) => {
  try {
    const { provider, model } = req.body || {};
    const execSummary = await generateExecutiveSummary(req.params.id, { provider, model, actor: req.user });
    res.json({ execSummary });
  } catch (e) {
    if (/not found|No critical/i.test(e.message)) return res.status(400).json({ error: e.message });
    next(e);
  }
});

/** Ask a question about this tender, grounded in its already-extracted
 *  clauses + overview. Purely read-only (no Tender/Clause mutation), so it's
 *  safe to call anytime, including while a DIFFERENT tender is segregating.
 *  Client holds conversation history and re-sends it each call. */
router.post("/:id/chat", requireAuth, async (req, res, next) => {
  try {
    const { message, history, provider, model } = req.body || {};
    const out = await answerChat(req.params.id, { message, history, provider, model, actor: req.user });
    res.json(out);
  } catch (e) {
    if (/required|not found|Nothing extracted/i.test(e.message)) return res.status(400).json({ error: e.message });
    next(e);
  }
});

/** Change a clause's importance ranking, or remove it. Removing is a real
 *  delete — a re-extraction would bring a machine-found clause back anyway,
 *  and a manual one is the user's to discard. */
router.patch("/:id/clauses/:clauseId", requireSuperAdmin, async (req, res, next) => {
  try {
    const { importance } = req.body || {};
    if (!["critical", "high", "medium", "low"].includes(importance)) {
      return res.status(400).json({ error: "importance must be critical, high, medium or low" });
    }
    const clause = await Clause.findOneAndUpdate(
      { _id: req.params.clauseId, tenderId: req.params.id },
      { $set: { importance } },
      { new: true }
    ).lean();
    if (!clause) return res.status(404).json({ error: "Clause not found" });
    res.json({ clause });
  } catch (e) {
    next(e);
  }
});

router.delete("/:id/clauses/:clauseId", requireSuperAdmin, async (req, res, next) => {
  try {
    const r = await Clause.deleteOne({ _id: req.params.clauseId, tenderId: req.params.id });
    if (!r.deletedCount) return res.status(404).json({ error: "Clause not found" });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

/** Remove one point from the executive brief — either a headline "at a
 *  glance" fact or a point inside a category section. Pulled by value with
 *  $pull rather than read-modify-write, so two people pruning the brief at
 *  once can't erase each other's edits. */
router.delete("/:id/executive-summary/:category/:pointIndex", requireSuperAdmin, async (req, res, next) => {
  try {
    const { id, category, pointIndex } = req.params;
    const tender = await Tender.findById(id, { execSummary: 1 }).lean();
    if (!tender?.execSummary) return res.status(404).json({ error: "No executive summary" });

    const glance = category === "__glance__";
    const point = glance
      ? tender.execSummary.atAGlance?.[Number(pointIndex)]
      : (tender.execSummary.sections || []).find((s) => s.category === category)?.points?.[Number(pointIndex)];
    if (!point) return res.status(404).json({ error: "Point not found" });

    if (glance) {
      await Tender.updateOne(
        { _id: id },
        { $pull: { "execSummary.atAGlance": { label: point.label, value: point.value } } }
      );
    } else {
      await Tender.updateOne(
        { _id: id, "execSummary.sections.category": category },
        { $pull: { "execSummary.sections.$.points": { label: point.label, value: point.value } } }
      );
    }
    const after = await Tender.findById(id, { execSummary: 1 }).lean();
    res.json({ execSummary: after?.execSummary || null });
  } catch (e) {
    next(e);
  }
});

/** The pooled, cross-tender question bank — what this team keeps asking.
 *  Shown in the UI so it's visible (and prunable) rather than invisible
 *  state that silently shapes every future extraction. */
router.get("/meta/questions", requireAuth, async (_req, res, next) => {
  try {
    const rows = await AskedQuestion.find({}).sort({ asked: -1, lastAskedAt: -1 }).limit(200).lean();
    res.json(rows.map((r) => ({ id: r._id, text: r.text, category: r.category, asked: r.asked, tenders: (r.tenderIds || []).length, lastAskedAt: r.lastAskedAt })));
  } catch (e) {
    next(e);
  }
});

router.delete("/meta/questions/:qid", requireSuperAdmin, async (req, res, next) => {
  try {
    await AskedQuestion.deleteOne({ _id: req.params.qid });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

router.delete("/:id", requireSuperAdmin, async (req, res, next) => {
  try {
    const tender = await Tender.findByIdAndDelete(req.params.id);
    if (!tender) return res.status(404).json({ error: "Not found" });
    await Clause.deleteMany({ tenderId: tender._id });
    await Promise.all((tender.files || []).map((f) => f.filePath && fs.rm(f.filePath, { force: true })));
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

export default router;
