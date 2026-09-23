import { Router } from "express";
import multer from "multer";
import path from "node:path";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import { Tender } from "../models/Tender.js";
import { Clause, CATEGORIES } from "../models/Clause.js";
import { segregateTender, isJobActive, refreshOverview } from "../services/segregation.js";
import { answerChat } from "../services/chat.js";
import { generateExecutiveSummary } from "../services/execSummary.js";
import { AskedQuestion } from "../models/AskedQuestion.js";
import { CATEGORY_DEFS } from "../services/prompts.js";
import { extractPages, fetchLinkedPdf } from "../services/pdf.js";
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
const DEFAULT_UPLOAD_DIR = path.resolve("uploads");

/**
 * Resolve the upload directory, falling back to the local default if the
 * configured one can't be created.
 *
 * multer.diskStorage() calls mkdirp on its destination synchronously inside
 * the constructor, i.e. at module load — so pointing UPLOAD_DIR at a path the
 * process can't create (a disk mount path set in env before the disk itself
 * was actually attached, say) threw EACCES and took the entire API down in a
 * boot loop, with nothing running at all. Failing over to the default keeps
 * the service up: uploads are then non-persistent, which is bad but is
 * strictly better than the whole app being unreachable, and the warning says
 * exactly what to fix.
 */
function resolveUploadDir() {
  const configured = path.resolve(process.env.UPLOAD_DIR || DEFAULT_UPLOAD_DIR);
  try {
    fsSync.mkdirSync(configured, { recursive: true });
    return configured;
  } catch (e) {
    console.error(
      `[uploads] cannot use UPLOAD_DIR "${configured}": ${e.code || e.message}.\n` +
        `          Falling back to "${DEFAULT_UPLOAD_DIR}" — uploads will NOT survive a redeploy.\n` +
        `          On Render: attach a Disk with this exact mount path FIRST, then set UPLOAD_DIR to it.`
    );
    try {
      fsSync.mkdirSync(DEFAULT_UPLOAD_DIR, { recursive: true });
    } catch (inner) {
      console.error(`[uploads] default upload dir also unusable: ${inner.message}`);
    }
    return DEFAULT_UPLOAD_DIR;
  }
}

const UPLOAD_DIR = resolveUploadDir();

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

/** Which of this tender's source files still have their PDF on disk. Cheap
 *  — a handful of fs.access() calls — so it's fine to call on every visit to
 *  a tender rather than only when something looks broken. The text/clauses
 *  extracted from a file are safe in MongoDB regardless of this; only the
 *  "open the real PDF page" proof view and future re-extraction of THAT
 *  file need the actual bytes back on disk. */
router.get("/:id/files/status", requireAuth, async (req, res, next) => {
  try {
    const tender = await Tender.findById(req.params.id, { files: 1 }).lean();
    if (!tender) return res.status(404).json({ error: "Not found" });
    const status = await Promise.all(
      (tender.files || []).map(async (f, index) => {
        const available = f.filePath
          ? await fs.access(path.resolve(f.filePath)).then(() => true).catch(() => false)
          : false;
        return { index, name: f.name, kind: f.kind, pageCount: f.pageCount, available };
      })
    );
    res.json(status);
  } catch (e) {
    next(e);
  }
});

/** Replace a missing source file (e.g. lost to an ephemeral filesystem
 *  before a persistent disk was attached) by re-uploading the same PDF.
 *  Never re-runs extraction and never touches Clause/Tender.pages — those
 *  already hold what was extracted, safe in MongoDB. This only restores the
 *  bytes needed for the citation-proof PDF viewer (and for a future
 *  re-extraction of this one file, should that ever be needed).
 *
 *  Guarded by a page-count match against what was recorded at parse time:
 *  a re-upload of the WRONG file would make every citation into this file
 *  point at the wrong page silently, which is worse than the current
 *  explicit "file missing" state — so a mismatch is refused outright rather
 *  than accepted with a warning. */
router.post("/:id/files/:index/restore", requireSuperAdmin, upload.single("file"), async (req, res, next) => {
  let savedPath = req.file?.path;
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded (field name: file)" });
    const tender = await Tender.findById(req.params.id, { files: 1 });
    if (!tender) return res.status(404).json({ error: "Not found" });
    const index = Number(req.params.index);
    const target = tender.files?.[index];
    if (!target) return res.status(404).json({ error: "No such file on this tender" });

    const { pageCount } = await extractPages(savedPath);
    if (target.pageCount && pageCount !== target.pageCount) {
      await fs.unlink(savedPath).catch(() => {});
      return res.status(400).json({
        error: `This PDF has ${pageCount} page(s), but "${target.name}" was originally ${target.pageCount} — doesn't look like the same file. Not restored.`,
      });
    }

    target.filePath = savedPath;
    await tender.save();
    await Tender.updateOne(
      { _id: req.params.id },
      { $push: { events: `${new Date().toISOString()} file restored: "${target.name}" (index ${index}) re-uploaded by ${req.user.name}` } }
    );
    res.json({ file: { index, name: target.name, kind: target.kind, pageCount: target.pageCount, available: true } });
  } catch (e) {
    if (savedPath) await fs.unlink(savedPath).catch(() => {});
    next(e);
  }
});

/** Re-download a lost LINKED file from the URL it was originally auto-fetched
 *  from, instead of asking someone to find and re-upload it by hand (they
 *  likely never had a local copy — it was pulled from a link inside the main
 *  PDF, not something they uploaded themselves). Same page-count safety
 *  check as manual restore; no LLM call, so this costs nothing but the
 *  download. Only for kind: "linked" files — an "uploaded" file has no
 *  sourceUrl to re-fetch from. */
router.post("/:id/files/:index/refetch", requireSuperAdmin, async (req, res, next) => {
  try {
    const tender = await Tender.findById(req.params.id, { files: 1 });
    if (!tender) return res.status(404).json({ error: "Not found" });
    const index = Number(req.params.index);
    const target = tender.files?.[index];
    if (!target) return res.status(404).json({ error: "No such file on this tender" });
    if (target.kind !== "linked" || !target.sourceUrl) {
      return res.status(400).json({ error: "This file wasn't auto-fetched from a link, so there's no source URL to re-download it from — use 'restore this file' to re-upload it instead." });
    }

    const result = await fetchLinkedPdf(target.sourceUrl, UPLOAD_DIR);
    if (!result.ok) {
      return res.status(502).json({ error: `Could not re-download from the original link: ${result.reason}. The link may have expired or the portal may be blocking automated downloads — try 'restore this file' with a manually-downloaded copy instead.` });
    }

    const { pageCount } = await extractPages(result.filePath);
    if (target.pageCount && pageCount !== target.pageCount) {
      await fs.unlink(result.filePath).catch(() => {});
      return res.status(400).json({
        error: `The document at that URL now has ${pageCount} page(s), but "${target.name}" was originally ${target.pageCount} — the portal may have replaced it with a different version. Not restored.`,
      });
    }

    target.filePath = result.filePath;
    await tender.save();
    await Tender.updateOne(
      { _id: req.params.id },
      { $push: { events: `${new Date().toISOString()} file re-fetched from source URL: "${target.name}" (index ${index}) by ${req.user.name}` } }
    );
    res.json({ file: { index, name: target.name, kind: target.kind, pageCount: target.pageCount, available: true } });
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
