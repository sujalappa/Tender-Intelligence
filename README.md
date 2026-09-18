# Bhushilp Tender Intelligence

MERN system that reads a full tender — one or more PDFs, up to ~500 pages, plus any PDFs
linked from inside them — and segregates every clause into
**Commercial · Financial · Technical · Legal · Technical Qualification** with page citations,
then lets a small team work through it together: a chatbot grounded in what was extracted,
a model-written executive brief, and private per-user notes.

Repo: https://github.com/sujalappa/Tender-Intelligence

## Features

- **Clause-by-clause extraction** with page citations back to the source PDF, across five
  categories, from one or more uploaded files plus any PDFs linked from inside them.
- **Conflict detection** across documents (NIT vs GCC vs SCC) via a shared global page index.
- **Chatbot** grounded in the extracted clauses (~35k tokens of context, no embeddings/RAG —
  see [How chat works](#how-chat-works)); falls back to reading the *entire* tender text when
  the extracted clauses don't have the answer, and says so.
- **Executive summary** — a one-page, key/value brief compressed by the model from the critical
  and conflicting clauses, for handing up the chain.
- **Private notes per person** — capture a clause or a chat answer into your own notes (never
  wiped by a re-extraction), optionally also folding a compressed line into the shared
  executive brief.
- **Question bank** — every question asked in chat is pooled (rewritten tender-agnostically)
  across all tenders and fed into future extraction prompts, so a class of question the team
  keeps asking gets answered by the report itself, up front.
- **Accounts and roles** — email/password sign-in, two access levels (see
  [Authentication](#authentication--accounts)).
- **PDF proof** — every citation opens the actual source PDF page (not just extracted text),
  so a claim can be checked against the real document in one click.

## How segregation works (server/src/services/segregation.js)

Prompt design adapted from a prior tender-analysis prompt library (`Tender Genie/prompts`) — the "sweep method" + "depth standard" + CONFLICT handling proved to be a stronger completeness bar than a plain keyword-extraction prompt. See `server/src/services/prompts.js` for the full text.

1. **Parse every uploaded file** – `pdfjs-dist` extracts text page by page per file. Hyperlink annotations (portal links, "refer https://..." references, linked annexures) are pulled separately — pdfjs's text layer doesn't include them.
2. **Follow links (one level deep)** – every link found on every page is checked (`services/linkedDocs.js`): if it resolves to a real PDF (content-type **and** magic-byte sniff, not just the URL), it's downloaded and parsed the same way, tagged `kind: "linked"` with `sourceUrl` + which page it was found on. Links found *inside* a linked PDF are not auto-followed — this bounds cost regardless of how deep a chain of cross-references goes. Capped by `MAX_LINKED_DOCS` (default 8) / `MAX_LINKED_MB` (default 60) / 15s per fetch; toggle with `FOLLOW_LINKS` or the upload checkbox.
3. **Merge into one corpus** (`mergeFiles` in `services/pdf.js`) – all files' pages (uploaded + linked) are concatenated in order behind one running global page index, so the model only ever reports one number (no schema field for "which file"). Each page marker shows both: `<<< PAGE 340 (GCC.pdf p.12) >>>` — the model reports `340`, the server translates it back to `{file: "GCC.pdf", page: 12}` for storage/citation via a lookup table built at merge time. This is also what makes the CONFLICT rule below work across files (NIT vs GCC vs SCC are now just different labelled blocks in the same context).
4. **Window** – if the merged corpus fits the model's context (Gemini 3.8 Flash / DeepSeek V4 Flash: 1M tokens) it is sent whole. Otherwise it is split into overlapping page windows. No top-k retrieval → nothing is skipped.
5. **Category extract + verify passes** – one call per category with a strict JSON schema; every field is `required` (an optional field is simply omitted by the model in non-strict JSON mode, which is how earlier runs silently lost `amount`/`deadline`/`threshold` on many clauses). The prompt sweeps the document page by page, heading by heading, sub-clause by sub-clause — not keyword search — and the category bullet lists are explicitly illustrative, not exhaustive. Every item must pass the **acceptance test**: *"could a tender executive act on this without reopening the tender at that page?"* — so `requirementDescription` is a complete, self-contained, multi-sentence brief, not a keyword + a number. When the same term is restated with a different number elsewhere in the tender, each occurrence is kept and flagged `clauseStatus: CONFLICT` instead of silently merged. A **verify pass** then audits pass 1 for clauses **missing entirely** vs. clauses found but captured **incompletely** (`correctedByVerify: true`).
6. **Overview pass** – runs *last*, after every category has finished, and is given the already-extracted facts (EMD, dates, etc.) as grounding hints (`buildOverviewHints`). Running it last — instead of first, against raw pages alone — is what fixed the overview citing the right page but leaving the field blank: category extraction (focused on one thing at a time) finds the fact reliably, and showing the overview pass "here's what you already found" closes the transcription gap. Can be re-run on its own (`POST /:id/overview`, super admin only) without touching any clause — one cheap ~80k-token call.
7. **No client-side deduplication** — overlapping-window duplicates are shown grouped in the UI rather than deleted, so a borderline item is never silently dropped. Clauses land in MongoDB with `sourceFile`, `page` (both file-local, human-checkable), `source: extract|verify|manual`, `clauseStatus`, and `mandatoryStatus` (for qualification/financial criteria).

**Resume** (`resume: true`) skips re-parsing (reuses stored pages/files) and skips any category with an already-successful run, redoing only what's incomplete or explicitly named — recovering an abandoned run doesn't re-spend what already succeeded. An in-memory `activeJobs` map (per server process) is the single source of truth for "is a job genuinely still running," rejecting a second concurrent attempt with 409 rather than guessing from elapsed time.

Cost per run ≈ (doc tokens × categories × passes). A ~350k-token tender ≈ 11 calls (1 overview + 5×2) × ~85k tokens each ≈ under $1 at DeepSeek V4 Flash pricing via OpenRouter — output runs higher than a short summary would, since each item is a full brief; that's a deliberate quality/cost tradeoff.

## How chat works

`server/src/services/chat.js` answers in two stages, never more than needed:

1. **Extracted clauses + overview** (~35k tokens) are sent as context every time — the full
   set, not a retrieved subset, so chat can never miss a clause the way top-k retrieval might.
2. If the model reports the clauses didn't actually contain the answer
   (`answeredFromClauses: false` in its structured reply), the server automatically re-asks
   with the **entire stored tender text** instead (only that call, not both) — this is the
   fallback for something extraction genuinely missed. The reply is badged in the UI so it's
   visible that extraction has a gap, with a one-click "save to my notes" to capture it.

Every chat call is logged to `UsageEvent` (see [Token usage](#token-usage)) and, when signed
in, persisted to `ChatMessage` — history survives a reload and is visible to super admins.

## Authentication & accounts

No self sign-up. Two super-admin accounts are seeded from `server/.env` on first boot
(`SUPERADMINS="Name:email:password,Name2:email2:password2"`, comma-separated, only created if
the email doesn't already exist) — they then create the rest of the team from the **Users**
page in the app, where passwords can also be reset and accounts deactivated. Sessions are a
signed, httpOnly JWT cookie (`JWT_SECRET`, `SESSION_DAYS`); a deactivated account loses access
immediately, not when its token happens to expire.

| Can do | User | Super admin |
|---|:---:|:---:|
| View tenders, clauses, PDF pages, chat | ✅ | ✅ |
| Keep private notes; add a note to the executive brief (tagged with their name) | ✅ | ✅ |
| Upload / re-run extraction, refresh overview | ❌ | ✅ |
| Generate / regenerate the executive summary; edit or remove its points | ❌ | ✅ |
| Edit/remove a clause's importance | ❌ | ✅ |
| Read anyone's notes or chat history; the cross-tender activity view | ❌ | ✅ |
| Manage user accounts | ❌ | ✅ |

Running behind more than `localhost` (an office LAN, a shared machine): add the machine's real
address to `ALLOWED_ORIGINS` in `.env` (the session cookie is rejected cross-origin otherwise),
and only set `COOKIE_SECURE=true` once it's served over HTTPS — a "secure" cookie is silently
dropped over plain http, which looks like "login works then immediately bounces back."

## Token usage

Every LLM call is billed against OpenRouter/Gemini whether or not it's part of a segregation
run. `Tender.runs` records extraction/verify/overview passes; a separate `UsageEvent`
collection records chat, executive-summary generation, and note→exec-summary compression calls,
each attributed to the user who triggered it. `GET /api/tenders/:id` returns the combined total
(`usage.segregationOnly` isolates just the extraction spend, `usage.byKind` breaks down the
rest) — so "is chat eating tokens" has an actual number behind it rather than being invisible.

## Run

```bash
# 1. server
cd server
cp .env.example .env
# fill in: GEMINI_API_KEY / OPENROUTER_API_KEY, MONGODB_URI,
# JWT_SECRET (openssl rand -hex 48, or any long random string), and
# SUPERADMINS with your own name/email/password — see Authentication above
npm install
npm run dev                 # http://localhost:4000

# 2. client
cd ../client
npm install
npm run dev                 # http://localhost:5173 (proxies /api to :4000)
```

Sign in with the email/password you set in `SUPERADMINS`, then add the rest of the team from
the Users page. Editing `.env` after the first boot does nothing to existing accounts — use the
Users page to reset a password later.

CLI without the UI (extraction only, no auth needed):

```bash
cd server
npm run segregate -- ../path/to/tender.pdf --provider gemini
npm run segregate -- ../path/to/nit.pdf ../path/to/boq.pdf --provider openrouter --model deepseek/deepseek-v4-flash
npm run segregate -- ../path/to/tender.pdf --categories legal,commercial --no-verify --no-links
```

## API

All routes below `/api/tenders` and `/api/admin` require a signed-in session; routes marked
**(admin)** additionally require the super-admin role. See the permission table above for the
full breakdown.

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/auth/login` `{email, password}` | sign in, sets the session cookie |
| POST | `/api/auth/logout` | clear the session |
| GET | `/api/auth/me` | current user, or `{user: null}` |
| POST | `/api/auth/password` `{currentPassword, newPassword}` | change your own password |
| GET | `/api/auth/users` **(admin)** | list accounts with note/question counts |
| POST | `/api/auth/users` **(admin)** `{name, email, password, role}` | create an account |
| PATCH | `/api/auth/users/:id` **(admin)** `{name?, password?, role?, active?}` | edit/reset/deactivate |
| GET | `/api/admin/activity` **(admin)** | 200 most recent notes + questions, across all tenders |
| POST | `/api/tenders` **(admin)** (multipart `files[]`, `title?`, `provider?`, `model?`, `verify?`, `followLinks?`) | upload one or more PDFs + start segregation |
| DELETE | `/api/tenders/:id` **(admin)** | delete a tender and its clauses |
| GET | `/api/tenders` | list |
| GET | `/api/tenders/:id` | status, progress, combined token usage, per-category summary, `files[]`, `linkLog[]` |
| GET | `/api/tenders/:id/clauses?category=&importance=&q=` | segregated clauses (each carries `sourceFile`) |
| GET | `/api/tenders/:id/pages/:page?file=<name>` | raw page text + links + `fileIndex` (for the PDF viewer) |
| GET | `/api/tenders/:id/file/:index` | streams the actual source PDF (citation "proof") |
| POST | `/api/tenders/:id/segregate` **(admin)** `{provider, model, verify, followLinks, categories, resume}` | re-run, optionally resuming |
| POST | `/api/tenders/:id/overview` **(admin)** | re-run only the overview pass |
| POST | `/api/tenders/:id/chat` `{message, history}` | ask the chatbot (see [How chat works](#how-chat-works)) |
| GET / DELETE | `/api/tenders/:id/chat-history?all=|userId=` | persisted chat turns; `all`/`userId` are admin-only for someone else's |
| POST | `/api/tenders/:id/executive-summary` **(admin)** | generate/regenerate the brief |
| DELETE | `/api/tenders/:id/executive-summary/:category/:pointIndex` **(admin)** | remove one point from the brief |
| GET / POST | `/api/tenders/:id/notes?userId=|all=` | your notes (or, for an admin, someone else's / everyone's); create one, optionally folding it into the brief |
| PATCH / DELETE | `/api/tenders/:id/notes/:noteId` | edit or delete your own note |
| PATCH / DELETE | `/api/tenders/:id/clauses/:clauseId` **(admin)** | change importance / remove a clause |
| GET | `/api/tenders/meta/questions` | the pooled cross-tender question bank |
| DELETE | `/api/tenders/meta/questions/:qid` **(admin)** | remove a pooled question |
| GET | `/api/tenders/meta/models` **(admin)** | providers + OpenRouter models that support JSON schema & ≥128k ctx |

## Providers

- **Gemini direct** – `@google/genai`, `responseSchema` structured output, `thinkingLevel` from env.
- **OpenRouter** – `openai` SDK pointed at `https://openrouter.ai/api/v1`; `response_format: json_schema` with `provider.require_parameters` so only schema-capable providers are routed, `sort: "throughput"` since the same model's speed varies ~10x across OpenRouter's upstreams. Any model id works: `deepseek/deepseek-v4-flash`, `anthropic/claude-*`, `openai/*`, `google/*`. Extended-thinking depth is set per call via `OPENROUTER_REASONING_EFFORT` (`low`/`medium`/`high`/`none`) — `medium` by default for the deep extraction/verify/overview/exec-summary passes, explicitly `low` for chat and note compression to stay responsive.

## Next steps

- Company profile DB → auto-match against `technical_qualification` criteria (`criterion / comparator / threshold` are already structured for this).
- OCR fallback for scanned pages (pages with no text are flagged in the log).
- Merge multiple extraction *passes* of the same tender (rather than one run) so run-to-run
  variance becomes a coverage signal — a clause found in every pass is solid, one found in only
  one pass is exactly where a person should look — instead of every re-upload starting over.
