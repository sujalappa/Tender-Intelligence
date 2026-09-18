import "dotenv/config";

const bool = (v, d) => (v === undefined ? d : /^(1|true|yes)$/i.test(v));

export const config = {
  port: Number(process.env.PORT || 4000),
  mongoUri: process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/tender_intel",
  defaultProvider: process.env.DEFAULT_PROVIDER || "gemini",
  gemini: {
    apiKey: process.env.GEMINI_API_KEY,
    model: process.env.GEMINI_MODEL || "gemini-3.8-flash",
    thinkingLevel: process.env.GEMINI_THINKING_LEVEL || "low",
  },
  openrouter: {
    apiKey: process.env.OPENROUTER_API_KEY,
    model: process.env.OPENROUTER_MODEL || "deepseek/deepseek-v4-flash",
    siteUrl: process.env.OPENROUTER_SITE_URL || "http://localhost:5173",
    appName: process.env.OPENROUTER_APP_NAME || "Tender Intelligence",
    // Real output for a category extract/verify pass has topped out around
    // 25-30k tokens; leaving max_tokens unset lets OpenRouter pre-authorize
    // credit against the model's full capacity (seen: 131072) instead of
    // what a call will realistically use, which trips a 402 on a modest
    // balance even though the call would have cost a fraction of that.
    maxTokens: Number(process.env.OPENROUTER_MAX_TOKENS || 40000),
    // DeepSeek v4 (and most models OpenRouter routes to) support the unified
    // `reasoning` param — extended thinking before the structured JSON is
    // written. "low"/"medium"/"high" (OpenRouter's own scale), or "none" to
    // omit the param entirely. Reasoning tokens are billed as output tokens
    // and count against max_tokens, so a caller with a small maxTokens cap
    // (chat) should ask for "low", not this default meant for the deep
    // extraction/verify passes.
    reasoningEffort: process.env.OPENROUTER_REASONING_EFFORT || "medium",
  },
  auth: {
    // Changing this invalidates every existing session, which is the intended
    // way to force everyone to sign in again.
    jwtSecret: process.env.JWT_SECRET || "dev-only-insecure-secret-change-me",
    sessionDays: Number(process.env.SESSION_DAYS || 7),
    // Only set this true behind HTTPS — a `secure` cookie is silently dropped
    // over plain http, which looks like "login succeeds then bounces back".
    cookieSecure: bool(process.env.COOKIE_SECURE, false),
    // Where the UI is served from. Must list concrete origins (not "*"),
    // because a browser refuses to send cookies to a wildcard origin. Add the
    // machine's LAN address here when other people start using it, e.g.
    // ALLOWED_ORIGINS="http://localhost:5173,http://192.168.1.20:5173"
    allowedOrigins: (process.env.ALLOWED_ORIGINS || "http://localhost:5173,http://127.0.0.1:5173")
      .split(",").map((s) => s.trim()).filter(Boolean),
    // SUPERADMINS="Name:email@x.com:password,Name2:email2@x.com:password2"
    // Seeded on boot if the email doesn't already exist. Everyone else is
    // created by a super admin from the Users page.
    superAdmins: (process.env.SUPERADMINS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((entry) => {
        const [name, email, ...rest] = entry.split(":");
        return { name: name?.trim(), email: email?.trim().toLowerCase(), password: rest.join(":") };
      })
      .filter((s) => s.name && s.email && s.password),
  },
  maxInputTokens: Number(process.env.MAX_INPUT_TOKENS || 800000),
  verifyPass: bool(process.env.VERIFY_PASS, true),
  followLinks: bool(process.env.FOLLOW_LINKS, true),
  maxLinkedDocs: Number(process.env.MAX_LINKED_DOCS || 8),
  maxLinkedMb: Number(process.env.MAX_LINKED_MB || 60),
  // Per-call LLM request timeout. Measured real successful calls on a large
  // (85k-token) document with the depth-standard extraction prompt have
  // taken up to ~16 minutes — this must sit comfortably above that or it
  // kills genuinely-working requests. Aborting client-side also does NOT
  // reliably cancel the request server-side (verified: aborted OpenRouter
  // requests kept counting against available credits, causing subsequent
  // calls to fail with 402 "exceeds available credits given in-flight
  // requests") — so this is a last-resort ceiling for a truly dead
  // connection, not a knob to make things "fail fast."
  llmTimeoutMs: Number(process.env.LLM_TIMEOUT_MS || 20 * 60 * 1000),
  // A tender stuck in parsing/segregating with no progress update for this
  // long is treated as abandoned (e.g. the server restarted mid-run and the
  // dangling promise never got to write "failed") — re-run is then allowed
  // even without an explicit force flag, instead of being 409'd forever.
  staleRunMs: Number(process.env.STALE_RUN_MS || 6 * 60 * 1000),
};
