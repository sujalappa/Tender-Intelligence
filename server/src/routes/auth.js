import { Router } from "express";
import { User, ROLES } from "../models/User.js";
import { Note } from "../models/Note.js";
import { ChatMessage } from "../models/ChatMessage.js";
import {
  hashPassword, verifyPassword, signToken, setSessionCookie, clearSessionCookie,
  requireAuth, requireSuperAdmin,
} from "../services/auth.js";

const router = Router();

router.post("/login", async (req, res, next) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");
    if (!email || !password) return res.status(400).json({ error: "Email and password are required" });

    const user = await User.findOne({ email });
    // Same message and the same work either way — a different response for
    // "no such user" would let anyone enumerate who has an account.
    const ok = user && user.active && (await verifyPassword(password, user.passwordHash));
    if (!ok) return res.status(401).json({ error: "Wrong email or password" });

    user.lastLoginAt = new Date();
    await user.save();
    setSessionCookie(res, signToken(user));
    res.json({ user: user.toSafe() });
  } catch (e) {
    next(e);
  }
});

router.post("/logout", (_req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

/** Who am I? Drives the client's auth state on load. */
router.get("/me", (req, res) => {
  res.json({ user: req.user ? req.user.toSafe() : null });
});

/** Change your own password. */
router.post("/password", requireAuth, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!newPassword || String(newPassword).length < 8) {
      return res.status(400).json({ error: "New password must be at least 8 characters" });
    }
    if (!(await verifyPassword(String(currentPassword || ""), req.user.passwordHash))) {
      return res.status(401).json({ error: "Current password is wrong" });
    }
    req.user.passwordHash = await hashPassword(String(newPassword));
    await req.user.save();
    // Re-issue, so the session survives the change on this device.
    setSessionCookie(res, signToken(req.user));
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

// ---------------------------------------------------------------------------
// Super-admin user management
// ---------------------------------------------------------------------------

router.get("/users", requireSuperAdmin, async (_req, res, next) => {
  try {
    const users = await User.find({}).sort({ role: 1, name: 1 });
    // Show what each person has actually done — the point of the page is
    // knowing who is working on what, not just who has an account.
    const [noteCounts, chatCounts] = await Promise.all([
      Note.aggregate([{ $group: { _id: "$userId", n: { $sum: 1 } } }]),
      ChatMessage.aggregate([{ $match: { role: "user" } }, { $group: { _id: "$userId", n: { $sum: 1 } } }]),
    ]);
    const notesBy = Object.fromEntries(noteCounts.map((r) => [String(r._id), r.n]));
    const chatBy = Object.fromEntries(chatCounts.map((r) => [String(r._id), r.n]));
    res.json(
      users.map((u) => ({
        ...u.toSafe(),
        noteCount: notesBy[String(u._id)] || 0,
        questionCount: chatBy[String(u._id)] || 0,
      }))
    );
  } catch (e) {
    next(e);
  }
});

router.post("/users", requireSuperAdmin, async (req, res, next) => {
  try {
    const name = String(req.body?.name || "").trim();
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");
    const role = ROLES.includes(req.body?.role) ? req.body.role : "user";
    if (!name || !email) return res.status(400).json({ error: "Name and email are required" });
    if (password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters" });
    if (await User.findOne({ email })) return res.status(409).json({ error: "That email already has an account" });

    const user = await User.create({
      name, email, role, passwordHash: await hashPassword(password), createdBy: req.user._id,
    });
    res.status(201).json({ user: user.toSafe() });
  } catch (e) {
    next(e);
  }
});

/** Reset someone's password, rename them, change role, or deactivate. */
router.patch("/users/:id", requireSuperAdmin, async (req, res, next) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: "User not found" });

    const { name, password, role, active } = req.body || {};
    if (name) user.name = String(name).trim();
    if (password) {
      if (String(password).length < 8) return res.status(400).json({ error: "Password must be at least 8 characters" });
      user.passwordHash = await hashPassword(String(password));
    }
    if (role && ROLES.includes(role)) user.role = role;
    if (active !== undefined) user.active = Boolean(active);

    // Don't let the last super admin demote or disable themselves into a
    // system nobody can administer.
    if (user.role !== "superadmin" || user.active === false) {
      const others = await User.countDocuments({ role: "superadmin", active: true, _id: { $ne: user._id } });
      if (!others) return res.status(400).json({ error: "This is the last active super admin — promote someone else first" });
    }

    await user.save();
    res.json({ user: user.toSafe() });
  } catch (e) {
    next(e);
  }
});

export default router;
