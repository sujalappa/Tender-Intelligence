import { Router } from "express";
import { Note } from "../models/Note.js";
import { User } from "../models/User.js";
import { ChatMessage } from "../models/ChatMessage.js";
import { createNote } from "../services/notes.js";
import { requireAuth, requireSuperAdmin, isSuperAdmin } from "../services/auth.js";

const router = Router({ mergeParams: true });

/** My notes on this tender (or, for a super admin with ?userId=, someone else's). */
router.get("/", requireAuth, async (req, res, next) => {
  try {
    const filter = { tenderId: req.params.id };
    if (req.query.userId) {
      // Reading another person's notes is a super-admin-only action.
      if (!isSuperAdmin(req.user) && String(req.query.userId) !== String(req.user._id)) {
        return res.status(403).json({ error: "You can only read your own notes" });
      }
      filter.userId = req.query.userId;
    } else if (req.query.all === "true") {
      if (!isSuperAdmin(req.user)) return res.status(403).json({ error: "Only a super admin can read everyone's notes" });
    } else {
      filter.userId = req.user._id;
    }

    const notes = await Note.find(filter).sort({ createdAt: -1 }).lean();
    // Attribute them when a super admin is looking across people.
    if (!filter.userId) {
      const users = await User.find({}, { name: 1, email: 1 }).lean();
      const byId = Object.fromEntries(users.map((u) => [String(u._id), u]));
      return res.json(notes.map((n) => ({ ...n, author: byId[String(n.userId)]?.name || "(removed user)" })));
    }
    res.json(notes);
  } catch (e) {
    next(e);
  }
});

router.post("/", requireAuth, async (req, res, next) => {
  try {
    const out = await createNote(req.params.id, req.user, req.body || {});
    res.status(201).json(out);
  } catch (e) {
    if (/required|not found|not generated/i.test(e.message)) return res.status(400).json({ error: e.message });
    next(e);
  }
});

router.patch("/:noteId", requireAuth, async (req, res, next) => {
  try {
    const note = await Note.findOne({ _id: req.params.noteId, tenderId: req.params.id });
    if (!note) return res.status(404).json({ error: "Note not found" });
    // A super admin can read any note but still cannot rewrite someone's own
    // words — editing stays with the author.
    if (String(note.userId) !== String(req.user._id)) return res.status(403).json({ error: "You can only edit your own notes" });

    const { title, text, importance, category } = req.body || {};
    if (title) note.title = String(title).trim();
    if (text) note.text = String(text).trim();
    if (["critical", "high", "medium", "low"].includes(importance)) note.importance = importance;
    if (category !== undefined) note.category = category;
    await note.save();
    res.json({ note: note.toObject() });
  } catch (e) {
    next(e);
  }
});

router.delete("/:noteId", requireAuth, async (req, res, next) => {
  try {
    const note = await Note.findOne({ _id: req.params.noteId, tenderId: req.params.id });
    if (!note) return res.status(404).json({ error: "Note not found" });
    if (String(note.userId) !== String(req.user._id) && !isSuperAdmin(req.user)) {
      return res.status(403).json({ error: "You can only delete your own notes" });
    }
    await note.deleteOne();
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

export default router;

// ---------------------------------------------------------------------------
// Chat history — mounted separately in tenders.js
// ---------------------------------------------------------------------------

export const chatHistoryRouter = Router({ mergeParams: true });

/** My chat history on this tender; ?all=true or ?userId= for super admins. */
chatHistoryRouter.get("/", requireAuth, async (req, res, next) => {
  try {
    const filter = { tenderId: req.params.id };
    if (req.query.all === "true") {
      if (!isSuperAdmin(req.user)) return res.status(403).json({ error: "Only a super admin can read everyone's chat history" });
    } else if (req.query.userId) {
      if (!isSuperAdmin(req.user) && String(req.query.userId) !== String(req.user._id)) {
        return res.status(403).json({ error: "You can only read your own chat history" });
      }
      filter.userId = req.query.userId;
    } else {
      filter.userId = req.user._id;
    }

    // `_id` breaks ties: the question and its answer are written in one
    // create([...]) batch and so share a createdAt to the millisecond —
    // sorting on createdAt alone left their order undefined, which showed
    // the answer above the question about half the time. ObjectIds are
    // generated in array order, so they restore the real sequence.
    const messages = await ChatMessage.find(filter).sort({ createdAt: 1, _id: 1 }).limit(500).lean();
    if (!filter.userId) {
      const users = await User.find({}, { name: 1 }).lean();
      const byId = Object.fromEntries(users.map((u) => [String(u._id), u.name]));
      return res.json(messages.map((m) => ({ ...m, author: byId[String(m.userId)] || "(removed user)" })));
    }
    res.json(messages);
  } catch (e) {
    next(e);
  }
});

/** Clear my own history on this tender (super admins keep the record). */
chatHistoryRouter.delete("/", requireAuth, async (req, res, next) => {
  try {
    await ChatMessage.deleteMany({ tenderId: req.params.id, userId: req.user._id });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

/** Cross-tender activity view for super admins: who asked what, where. */
export const adminActivityRouter = Router();
adminActivityRouter.get("/activity", requireSuperAdmin, async (_req, res, next) => {
  try {
    const [notes, messages, users] = await Promise.all([
      Note.find({}).sort({ createdAt: -1 }).limit(200).lean(),
      ChatMessage.find({ role: "user" }).sort({ createdAt: -1 }).limit(200).lean(),
      User.find({}, { name: 1 }).lean(),
    ]);
    const byId = Object.fromEntries(users.map((u) => [String(u._id), u.name]));
    res.json({
      notes: notes.map((n) => ({ ...n, author: byId[String(n.userId)] || "(removed user)" })),
      questions: messages.map((m) => ({ ...m, author: byId[String(m.userId)] || "(removed user)" })),
    });
  } catch (e) {
    next(e);
  }
});
