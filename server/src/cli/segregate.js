/**
 * CLI: segregate one or more PDFs without the web UI.
 *   npm run segregate -- a.pdf [b.pdf ...] [--provider gemini|openrouter] [--model id] [--no-verify] [--no-links] [--categories legal,commercial]
 * Any hyperlinks found inside the uploaded PDF(s) that point to other PDFs
 * are auto-fetched and included too, unless --no-links is passed.
 * Prints a summary and writes <first-pdf>.segregation.json next to it.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { connectDb } from "../db.js";
import { Tender } from "../models/Tender.js";
import { Clause } from "../models/Clause.js";
import { segregateTender } from "../services/segregation.js";

const args = process.argv.slice(2);
const BOOLEAN_FLAGS = new Set(["--no-verify", "--no-links"]);
const files = [];
for (let i = 0; i < args.length; i++) {
  if (BOOLEAN_FLAGS.has(args[i])) continue;
  if (args[i].startsWith("--")) { i++; continue; } // value-taking flag — skip its value too
  files.push(args[i]);
}
if (!files.length) {
  console.error("usage: npm run segregate -- <file.pdf> [more.pdf ...] [--provider gemini|openrouter] [--model id] [--no-verify] [--no-links] [--categories a,b]");
  process.exit(1);
}
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

await connectDb();
const tender = await Tender.create({
  title: path.basename(files[0]),
  files: files.map((f) => ({ name: path.basename(f), filePath: path.resolve(f), kind: "uploaded" })),
});
console.log("tender id:", tender._id.toString());

const summary = await segregateTender(tender._id, {
  provider: opt("provider"),
  model: opt("model"),
  verify: !args.includes("--no-verify"),
  followLinks: !args.includes("--no-links"),
  categories: opt("categories")?.split(","),
});

const clauses = await Clause.find({ tenderId: tender._id }).lean();
const t = await Tender.findById(tender._id, { pages: 0 }).lean();
const out = `${files[0]}.segregation.json`;
await fs.writeFile(out, JSON.stringify({ tender: t, summary, clauses }, null, 2));

console.log("\n--- files in context ---");
for (const f of t.files) console.log(`${f.kind === "linked" ? "↳ linked" : "  uploaded"}  ${f.name}  (${f.pageCount ?? "?"} pages)${f.sourceUrl ? `  <- ${f.sourceUrl}` : ""}`);
if (t.linkLog?.length) { console.log("\n--- link log ---"); t.linkLog.forEach((l) => console.log(" ", l)); }

if (t.overview) {
  console.log("\n--- overview ---");
  console.log(t.overview.tenderTitle, "|", t.overview.referenceNumber, "|", t.overview.issuingAuthority);
  console.log("EMD:", t.overview.emdAmount || "-", " Value:", t.overview.estimatedValue || "-", " Opening:", t.overview.bidOpeningDate || "-");
}
console.log("\n--- per category ---");
console.table(summary);
const usage = t.runs.reduce((a, r) => ({ in: a.in + (r.inputTokens || 0), out: a.out + (r.outputTokens || 0) }), { in: 0, out: 0 });
console.log(`tokens in=${usage.in.toLocaleString()} out=${usage.out.toLocaleString()} calls=${t.runs.length} errors=${t.runs.filter((r) => r.error).length}`);
console.log("written:", out);
process.exit(0);
