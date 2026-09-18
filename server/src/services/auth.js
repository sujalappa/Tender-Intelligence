import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { User } from "../models/User.js";
import { config } from "../config.js";

const TOKEN_COOKIE = "bi_session";

export const hashPassword = (plain) => bcrypt.hash(plain, 10);
export const verifyPassword = (plain, hash) => bcrypt.compare(plain, hash);

export function signToken(user) {
  return jwt.sign({ sub: String(user._id), role: user.role }, config.auth.jwtSecret, {
    expiresIn: config.auth.sessionDays + "d",
  });
}

export function setSessionCookie(res, token) {
  res.cookie(TOKEN_COOKIE, token, {
    httpOnly: true, // not readable by page scripts, so an XSS can't lift the session
    sameSite: config.auth.crossSiteCookies ? "none" : "lax",
    // A browser refuses SameSite=None without Secure — crossSiteCookies
    // implies secure regardless of COOKIE_SECURE, since that combination
    // (cross-site + non-secure) can never actually work.
    secure: config.auth.crossSiteCookies || config.auth.cookieSecure,
    maxAge: config.auth.sessionDays * 24 * 60 * 60 * 1000,
  });
}

export const clearSessionCookie = (res) => res.clearCookie(TOKEN_COOKIE);

/**
 * Populates req.user when a valid session cookie is present. Does NOT reject —
 * route guards do that, so a public route can stay public.
 */
export async function attachUser(req, _res, next) {
  const token = req.cookies?.[TOKEN_COOKIE];
  if (!token) return next();
  try {
    const payload = jwt.verify(token, config.auth.jwtSecret);
    const user = await User.findById(payload.sub);
    // A deactivated account must lose access immediately, not when its token
    // happens to expire — so `active` is re-checked on every request, not
    // trusted from the token.
    if (user?.active) req.user = user;
  } catch {
    // expired / tampered / unknown user — treated as signed out
  }
  next();
}

export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Sign in required" });
  next();
}

export function requireSuperAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Sign in required" });
  if (req.user.role !== "superadmin") {
    return res.status(403).json({ error: "Only a super admin can do this" });
  }
  next();
}

export const isSuperAdmin = (user) => user?.role === "superadmin";

/**
 * Create the super admin accounts from .env on boot so there is always a way
 * in. Existing accounts are left alone — this never overwrites a password
 * someone has since changed.
 */
export async function seedSuperAdmins() {
  const specs = config.auth.superAdmins;
  if (!specs.length) {
    const count = await User.countDocuments({ role: "superadmin" });
    if (!count) {
      console.warn(
        "[auth] No super admins exist and SUPERADMINS is not set in .env — nobody can sign in.\n" +
          '        Set SUPERADMINS="name:email:password,name2:email2:password2" and restart.'
      );
    }
    return;
  }
  for (const { name, email, password } of specs) {
    const existing = await User.findOne({ email });
    if (existing) continue;
    await User.create({ name, email, passwordHash: await hashPassword(password), role: "superadmin" });
    console.log(`[auth] created super admin ${email}`);
  }
}
