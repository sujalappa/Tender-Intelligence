import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import { config } from "./config.js";
import { connectDb } from "./db.js";
import tenders from "./routes/tenders.js";
import auth from "./routes/auth.js";
import { adminActivityRouter } from "./routes/notes.js";
import { attachUser, seedSuperAdmins } from "./services/auth.js";

const app = express();
// The session lives in a cookie, so the browser must be allowed to send it —
// that needs credentials:true AND a concrete origin (the wildcard `*` that
// bare cors() sends is rejected by browsers for credentialed requests).
app.use(cors({ origin: config.auth.allowedOrigins, credentials: true }));
app.use(express.json({ limit: "2mb" }));
app.use(cookieParser());
app.use(attachUser);

app.get("/api/health", (_req, res) => res.json({ ok: true, provider: config.defaultProvider }));
app.use("/api/auth", auth);
app.use("/api/admin", adminActivityRouter);
app.use("/api/tenders", tenders);

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || "Internal error" });
});

connectDb()
  .then(seedSuperAdmins)
  .then(() => app.listen(config.port, () => console.log(`[api] http://localhost:${config.port}`)))
  .catch((e) => {
    console.error("Failed to start:", e.message);
    process.exit(1);
  });
