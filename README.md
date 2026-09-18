# Bhushilp Tender Intelligence

MERN system that reads a full tender — one or more PDFs, up to ~500 pages, plus any PDFs
linked from inside them — and segregates every clause into
**Commercial · Financial · Technical · Legal · Technical Qualification** with page citations.

## How segregation works (server/src/services/segregation.js)

Prompt design adapted from a prior tender-analysis prompt library (`Tender Genie/prompts`) — the "sweep method" + "depth standard" + CONFLICT handling proved to be a stronger completeness bar than a plain keyword-extraction prompt. See `server/src/services/prompts.js` for the full text.

1. **Parse every uploaded file** – `pdfjs-dist` extracts text page by page per file. Hyperlink annotations (portal links, "refer https://..." references, linked annexures) are pulled separately — pdfjs's text layer doesn't include them.
2. **Follow links (one level deep)** – every link found on every page is checked (`services/linkedDocs.js`): if it resolves to a real PDF (content-type **and** magic-byte sniff, not just the URL), it's downloaded and parsed the same way, tagged `kind: "linked"` with `sourceUrl` + which page it was found on. Links found *inside* a linked PDF are not auto-followed — this bounds cost regardless of how deep a chain of cross-references goes. Capped by `MAX_LINKED_DOCS` (default 8) / `MAX_LINKED_MB` (default 60) / 15s per fetch; toggle with `FOLLOW_LINKS` or the upload checkbox.
3. **Merge into one corpus** (`mergeFiles` in `services/pdf.js`) – all files' pages (uploaded + linked) are concatenated in order behind one running global page index, so the model only ever reports one number (no schema field for "which file"). Each page marker shows both: `<<< PAGE 340 (GCC.pdf p.12) >>>` — the model reports `340`, the server translates it back to `{file: "GCC.pdf", page: 12}` for storage/citation via a lookup table built at merge time. This is also what makes the CONFLICT rule below work across files (NIT vs GCC vs SCC are now just different labelled blocks in the same context).
4. **Window** – if the merged corpus fits the model's context (Gemini 3.8 Flash / DeepSeek V4 Flash: 1M tokens) it is sent whole. Otherwise it is split into overlapping page windows. No top-k retrieval → nothing is skipped.
5. **Overview pass** – one cheap call against the first window: NIT/reference number, issuing authority, key dates (pre-bid meeting, submission, opening), estimated value, EMD, tender fee — the facts an executive checks first. Stored on `Tender.overview`, citations as `"file.pdf#12"`.
6. **Extract pass** – one call per category with a strict JSON schema. The prompt sweeps the document page by page, heading by heading, sub-clause by sub-clause — not keyword search — and the category bullet lists are explicitly illustrative, not exhaustive: the model is told to extract anything that clearly serves the category's purpose even if it matches no listed bullet. Every item must pass the **acceptance test**: *"could a tender executive act on this without reopening the tender at that page?"* — so `requirementDescription` is a complete, self-contained, multi-sentence brief (figures, basis, deadline, exemptions, proof, consequence), not a keyword + a number. `verbatim` still carries the exact quoted text, including attached notes/provisos. When the same term is restated with a different number elsewhere in the tender (NIT vs GCC vs SCC), each occurrence is kept and flagged `clauseStatus: CONFLICT` instead of silently merged.
7. **Verify pass** – a second call per category that audits pass 1 for two distinct failure modes: clauses **missing entirely**, and clauses pass 1 found but captured **incompletely** (e.g. got the threshold, dropped the recency window) — the latter merges the correction into the existing item (`correctedByVerify: true`) rather than creating a confusing duplicate. Toggle with `VERIFY_PASS` / the UI checkbox.
8. **Dedupe & store** – overlapping windows are merged (matched by same file + adjacent page); clauses land in MongoDB with `sourceFile`, `page` (both file-local, human-checkable), `source: extract|verify`, `clauseStatus`, and `mandatoryStatus` (for qualification/financial criteria).

Cost per run ≈ (doc tokens × categories × passes) — now including any linked PDFs pulled in. A 350k-token tender on Gemini 3.8 Flash ≈ 11 calls (1 overview + 5×2) × 350k ≈ 3.9M input tokens ≈ $3 at introductory pricing — output tokens run higher than before since each item is now a full brief rather than a short summary; that's a deliberate quality/cost tradeoff (see the option chosen when this was integrated).

## Run

```bash
# 1. server
cd server
cp .env.example .env        # fill GEMINI_API_KEY / OPENROUTER_API_KEY / MONGODB_URI
npm install
npm run dev                 # http://localhost:4000

# 2. client
cd ../client
npm install
npm run dev                 # http://localhost:5173 (proxies /api to :4000)
```

CLI without the UI:

```bash
cd server
npm run segregate -- ../path/to/tender.pdf --provider gemini
npm run segregate -- ../path/to/nit.pdf ../path/to/boq.pdf --provider openrouter --model deepseek/deepseek-v4-flash
npm run segregate -- ../path/to/tender.pdf --categories legal,commercial --no-verify --no-links
```

## API

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/tenders` (multipart `files[]`, `title?`, `provider?`, `model?`, `verify?`, `followLinks?`) | upload one or more PDFs + start segregation |
| GET | `/api/tenders` | list |
| GET | `/api/tenders/:id` | status, progress, token usage, per-category summary, `files[]`, `linkLog[]` |
| GET | `/api/tenders/:id/clauses?category=&importance=&q=` | segregated clauses (each carries `sourceFile`) |
| GET | `/api/tenders/:id/pages/:page?file=<name>` | raw page text + links (context view); `file` disambiguates when multiple PDFs are in context |
| POST | `/api/tenders/:id/segregate` `{provider, model, verify, followLinks, categories}` | re-run with another model |
| GET | `/api/tenders/meta/models` | providers + OpenRouter models that support JSON schema & ≥128k ctx |

## Providers

- **Gemini direct** – `@google/genai`, `responseSchema` structured output, `thinkingLevel` from env.
- **OpenRouter** – `openai` SDK pointed at `https://openrouter.ai/api/v1`; `response_format: json_schema` with `provider.require_parameters` so only schema-capable providers are routed. Any model id works: `deepseek/deepseek-v4-flash`, `anthropic/claude-*`, `openai/*`, `google/*`.

## Next steps

- Chatbot over the stored clauses + page text (hybrid BM25/vector retrieval, "deep read" mode re-sending the doc with caching).
- Company profile DB → auto-match against `technical_qualification` criteria (`criterion / comparator / threshold` are already structured for this).
- OCR fallback for scanned pages (pages with no text are flagged in the log).
