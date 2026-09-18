/**
 * Category definitions drive both the extraction prompt and the verification
 * prompt. Be generous in what counts – the executive would rather see a
 * clause twice than miss it once.
 *
 * Extraction standard adapted from a prior tender-analysis project's prompt
 * library (the "sweep method" + "depth standard" + BAD/GOOD contrastive
 * examples + notes/provisos rule + cross-reference merge + CONFLICT status).
 * Ported because the acceptance test it encodes — "could a tender executive
 * act on this item without reopening the tender at that page?" — is a
 * stronger completeness bar than a keyword+value extraction.
 */
const NEWLINE = String.fromCharCode(10);

export const CATEGORY_DEFS = {
  commercial: {
    label: "Commercial Terms",
    description: `Terms that govern the commercial relationship and bid process:
- Tender fee, EMD / bid security (amount, form, validity, forfeiture, refund, MSE/Startup exemptions and their proof)
- Performance security / PBG / security deposit / retention money (percentage, basis, format, validity, claim period, release conditions)
- Bid validity period, bid submission mode, deadlines, pre-bid meeting, opening dates
- Payment terms, billing cycle, running account bills, mobilisation/secured advance (percentage, interest, recovery schedule), interest
- Price basis (firm/variable), price escalation / variation formula (verbatim, with indices and base date), taxes & duties (GST, TDS), cess
- Contract period, completion / delivery schedule, milestones tied to payment
- Liquidated damages, penalties, incentives, bonus clauses — exact rate, basis, cap
- Defect liability period, warranty, AMC/O&M obligations, extension of time
- Evaluation method (L1 / QCBS / weightage), price bid format rules, negotiation, splitting of quantity
- Purchase preference (MSE, Make in India), reverse auction, rate contract rules
- Currency, exchange rate, incoterms, freight, insurance during transit
- Buyer-added / non-standard commercial conditions (utility recoveries, demurrage, buyback, integrity pact fees) — extract these even if they don't fit any bullet above`,
  },
  financial: {
    label: "Financial Terms",
    description: `Financial capacity criteria and money-related instructions:
- Minimum average annual turnover, turnover in specific years, net worth, solvency certificate, liquidity / working capital, line of credit, bank guarantee limits — with exact computation basis (e.g. % of annualised estimated cost)
- Audited balance sheet / P&L / ITR / CA certificate requirements (including UDIN, validity window of the certificate), financial year definitions
- Bank/banker certificate requirements for credit lines (CC/OD), validity window
- Bid capacity formula, financial standing, credit rating, profitability requirement (no loss years)
- Estimated cost / tender value, cost of bid document
- BOQ / price schedule structure, item-rate vs lump-sum vs percentage rate, how rates must be quoted (inclusive/exclusive of taxes), abnormally low bid handling
- Financial bid opening, arithmetic correction rules, rounding
- Holding/subsidiary company rules for financial qualification (consolidated report + authorisation letter)
- Any figures in INR / lakhs / crores that define eligibility or contract economics`,
  },
  technical: {
    label: "Technical Terms",
    description: `What must be delivered and how (NOT bidder eligibility/past experience — that belongs to Technical Qualification):
- Scope of work / supply, deliverables, bill of quantities items, quantities, locations
- Equipment / machinery: type, model, capacity, quantity, configuration, accessories, deployment schedule
- Technical specifications: dimensions, power rating, speed, efficiency, accuracy, tolerance, operating limits, environmental conditions
- Performance requirements: guaranteed output, availability KPIs, reliability, performance guarantees
- Materials, grades, quality standards, approved makes/brands/OEM lists
- Standards & codes (IS, ASTM, IEC, BIS, ISO, DGMS, etc.)
- Testing & inspection: FAT/SAT, NABL/ILAC lab test reports, third-party inspection, acceptance criteria, sampling
- Quality assurance plan (QAP), inspection test plans (ITP), documentation obligations
- Drawings, design responsibility, method statements, site conditions, survey/soil data
- Execution requirements: manpower deployment, plant & machinery deployment, shifts, safety (HSE) systems, gas monitoring, environment
- Warranty / DLP / comprehensive AMC / SLA response times / spare parts availability
- Timelines by activity, milestones, work programme, reporting, handover, training, documentation, spares
- Software/IT: architecture, SLAs, uptime, integration, data, security, hosting requirements (if applicable)`,
  },
  legal: {
    label: "Legal Terms",
    description: `Legal, statutory and contractual risk clauses:
- Governing law, jurisdiction, dispute resolution, arbitration (seat, rules, number of arbitrators), conciliation
- Force majeure (defined events, notice deadline, time/cost relief, termination right if prolonged)
- Suspension of work, termination (for convenience / default / insolvency), consequences of termination, risk-purchase clause
- Indemnity, limitation of liability (caps, exclusions), consequential loss, insurance obligations (CAR, WC, TPL, transit/marine — sums insured, deductibles, who bears premium)
- Subcontracting / assignment restrictions
- JV / consortium rules: minimum participation shares (e.g. lead member >= 50%, others >= 20-25%), lock-in period, debarment if the JV breaks midway, each member's liability (joint & several), MSE/EMD exemption non-applicability for JV bidders
- Confidentiality, IP ownership, data protection
- Compliance with labour laws, minimum wages, PF/ESI, contract labour act, child labour, statutory approvals
- Integrity pact, anti-corruption, conflict of interest, blacklisting / debarment / banning of business conditions (including duration, e.g. 12-month ban) and false-information consequences
- Land border / national-security restrictions on bidders, Make in India / local-content requirements
- Right of the employer to reject bids, amend tender, cancel without reason; corrigenda binding
- Variation / change order rules, deviations, order of precedence of documents (which document wins in a conflict), notices, signatures, stamp duty`,
  },
  technical_qualification: {
    label: "Technical Qualification Parameters",
    description: `Every criterion the bidder must satisfy to be technically/financially eligible (pre-qualification / eligibility / PQR criteria — "who is qualified to bid?"). Extract EACH criterion as a separate atomic item:
- Similar work experience: definition of "similar work", number of works, value thresholds (e.g. one work of 80%, two of 50%, three of 40% of estimated cost), completion window (last 5/7 years), ongoing vs completed, escalation factor for old works, ongoing-project handling
- Equipment/technology experience: OEM/manufacturer experience, production achieved by equipment, capacity, deployment history
- Registration / class / category with government departments, licences (electrical, PWD, CPWD), enlistment
- Certifications: ISO 9001/14001/45001, BIS, CE, OEM authorisation (MAF), type-test reports
- Key personnel: roles, qualification, years of experience, number, deployment requirement
- Plant, machinery, equipment, tools to be owned or leased; lab facilities; machinery ratings
- Organisation: years in business, incorporation, PAN/GST/PF/ESI registration, manufacturer vs dealer, MSE/Startup status and required proof (UDYAM/DPIIT)
- JV / consortium rules: lead member share, each member's criteria, max members, experience/turnover sharing rules
- Not blacklisted / no litigation declarations, past performance certificates, site-visit mandates, sample submissions
- Documentary evidence required for each criterion and its format (client certificate, completion certificate, CA certificate with UDIN, banker certificate, OEM MAF)
- Any technical scoring / marking scheme used for shortlisting`,
  },
};

export const CATEGORY_KEYS = Object.keys(CATEGORY_DEFS);
const isCriteriaCategory = (category) => category === "technical_qualification" || category === "financial";

/**
 * Shared rules injected into every extraction prompt. This is the core of
 * why recall is higher than a plain "find the clauses" instruction:
 *   A. sweep the document in strict order, unit by unit — never skim/keyword-jump
 *   B. every item is a complete, self-contained, actionable brief — not a
 *      keyword + a number (with a concrete acceptance test + BAD/GOOD example)
 *   C. never drop notes/provisos/brackets — that's where exemptions/ceilings hide
 *   D. merge cross-references that are present elsewhere in the supplied text
 *   E. when the same term is restated with different numbers across
 *      NIT/ITB/GCC/SCC/ATC, extract every version and flag CONFLICT instead
 *      of silently merging them
 */
const EXTRACTION_STANDARD = `EXTRACTION STANDARD (apply to every item)
--------------------------------------------------------------------------------
A. SWEEP METHOD — work through the supplied pages strictly in order, page by page, heading by heading, sub-clause by sub-clause, list item by list item, table row by table row. Do not skim or jump to keywords. Include annexures, formats, schedules, corrigenda and the BOQ. There is no cap on the number of items — an incomplete sweep is a failed extraction.

B. DEPTH STANDARD — 'requirementDescription' is the primary output for every item. It must be a complete, self-contained, multi-sentence brief that reproduces everything the clause (and its sub-clauses/notes/provisos) says: the exact figures/percentages/amounts verbatim, the calculation basis and formula, ceilings/floors/caps, WHO must do WHAT, in WHAT format, by WHEN, every condition/exception, the procedure, and the CONSEQUENCE of compliance and non-compliance. Write it as full sentences — several sentences is normal and correct.
ACCEPTANCE TEST: "Could a tender executive act on this item — arrange the money, the bank guarantee, the certificate, the deadline — WITHOUT opening the tender at that page?" If no, rewrite until yes.
BAD (rejected — keyword + value only): "Performance Security: 5% PBG within 21 days."
GOOD (required standard): "The successful bidder must furnish Performance Security equal to 5% of the contract value within 21 days of issue of the LOA (a further 14 days is allowed on written request with justification). It may be a Bank Guarantee from a scheduled bank in the format at Annexure-VII or online transfer to the designated account. The BG must remain valid for one year or 90 days beyond the contract period, whichever is more. Failure to submit within the permitted time leads to forfeiture of the EMD and cancellation of the LOA. The security carries no interest and is released after the defect liability period, subject to no dues (Cl. 4.4.2)."

C. NOTES, PROVISOS & EXCEPTIONS — 'Note:', 'Provided that...', asterisked remarks and bracketed text are where exemptions, ceilings and exceptions usually hide. Never drop them; fold them into the item they qualify (use the 'exception' field for relaxations like MSE/Startup/JV non-applicability).

D. CROSS-REFERENCES — if a clause references another ('as per Clause 12 of GCC', 'refer Annexure-IV') and that referenced text is present anywhere in the supplied pages, merge its content into the item instead of leaving a dangling reference.

E. RESTATED / CONFLICTING TERMS — NIT, ITB, GCC, SCC and buyer ATC frequently restate the same term with DIFFERENT numbers (e.g. GCC says PBG 5%, SCC says 3%). Do NOT silently pick one or merge them. Extract EACH occurrence as its own item, and set clauseStatus='CONFLICT' with 'conflictNote' describing the discrepancy and the other clauseRef/page it disagrees with.

F. GRANULARITY — one item per distinct requirement. Split a paragraph into separate items only when it carries independently quantified parameters (e.g. PBG percentage vs PBG deadline vs PBG validity are three items); even when split, each item's requirementDescription still carries the full relevant context — splitting never justifies thinning content.

G. THE CATEGORY LIST IS ILLUSTRATIVE, NOT A CHECKLIST — the bullet points in CATEGORY DEFINITION are common examples, not the full boundary of the category. Every tender, department (GeM, CPPP, MSTC, IREPS, state PWD, PSU) and client writes bespoke, non-standard clauses that won't match any bullet verbatim. If you find a clause, section or paragraph that clearly serves the same purpose as this category — even if it matches no bullet — extract it anyway using your own judgment for its title/criterion name. Do NOT skip a real requirement just because it wasn't named above; do NOT invent one that isn't actually in the text.

H. LINKS — some pages carry a "[LINKS ON THIS PAGE]" block listing hyperlinks found on that page (e-procurement portal URLs, referenced external documents, corrigendum pages). When a link is what a clause is telling the bidder to use (submission portal, download location, reference document), put it in the item's 'link' field. Do not invent a link that is not listed; leave 'link' empty if none applies.`;

/** JSON schema shared by Gemini (responseSchema) and OpenRouter (json_schema). */
export const EXTRACTION_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          clauseRef: { type: "string", description: "Clause / section / annexure reference as printed, e.g. 'Clause 12.3', 'ITB 24', 'Annexure-B (ii)'. Empty string if none." },
          title: { type: "string", description: "Short descriptive title (max 12 words)" },
          page: { type: "integer", description: "The number immediately after 'PAGE' in the nearest preceding <<< PAGE n (file p.m) >>> marker — NOT the 'p.m' number in parentheses, which is only a human-readable label." },
          pageEnd: { type: "integer", description: "Page where the clause ends; same as page if single page" },
          verbatim: { type: "string", description: "Exact text of the clause copied from the document, including attached notes/provisos/exceptions (do not paraphrase). This is ALWAYS a quotation of the source sentences — never a one-word answer like 'Yes'/'No'/'N/A', never a summary. If you genuinely cannot quote it, leave it empty." },
          requirementDescription: { type: "string", description: "The complete, self-contained, actionable brief per the DEPTH STANDARD — several sentences, must pass the acceptance test" },
          summary: { type: "string", description: "Short label, max 15 words, for use in lists/search (a compressed title, not a substitute for requirementDescription)" },
          importance: { type: "string", enum: ["critical", "high", "medium", "low"], description: "critical = can disqualify the bid or cause major loss" },
          deadline: { type: "string", description: "Any date/time/duration mentioned, else empty" },
          amount: { type: "string", description: "Any monetary value or percentage mentioned, else empty" },
          link: { type: "string", description: "URL directly relevant to this clause, copied from a '[LINKS ON THIS PAGE]' block — e.g. the submission portal or a referenced document. Empty if none." },
          timePeriod: { type: "string", description: "Recency/eligibility/validity window, e.g. 'last 7 years', 'valid within 3 months of bid opening'. Empty if none." },
          measurementPeriod: { type: "string", description: "Measurement timeframe basis, e.g. 'one production year / consecutive 365 days', '3 best financial years'. Empty if none." },
          applicability: { type: "string", description: "Which entity this applies to / JV share rules, e.g. 'Lead member >= 50%, other members >= 25%'. Empty if none." },
          exception: { type: "string", description: "Waivers, relaxations, or explicit non-applicability (e.g. 'MSE/Startup relaxation NOT applicable for JV bidders'). Empty if none." },
          criterion: { type: "string", description: "(technical_qualification/financial) name of the criterion, e.g. 'Average annual turnover'" },
          threshold: { type: "string", description: "The numeric/text threshold, e.g. '50 crore', '3 works', 'ISO 9001'" },
          unit: { type: "string", description: "Unit of threshold: INR crore, years, count, percent, ... or empty" },
          comparator: { type: "string", enum: [">=", "<=", "=", "in", "must_have", "n/a"] },
          evidenceRequired: { type: "string", description: "Documents required to prove it (e.g. 'CA certificate with UDIN', 'Work order + completion certificate'), else empty" },
          mandatoryStatus: { type: "string", enum: ["MANDATORY", "CONDITIONAL", "OPTIONAL", "NOT_SPECIFIED", ""], description: "(criteria categories) MANDATORY = explicit pass/fail gate; CONDITIONAL = required only if a stated condition applies; OPTIONAL = scored/optional; NOT_SPECIFIED = tender doesn't establish it" },
          clauseStatus: { type: "string", enum: ["EXPLICIT", "CONDITIONAL", "CONFLICT"], description: "EXPLICIT = clearly and consistently stated; CONDITIONAL = applies only under a stated condition; CONFLICT = this document restates a term found elsewhere with a different number" },
          conflictNote: { type: "string", description: "When clauseStatus='CONFLICT': which other clauseRef/page disagrees and how. Empty otherwise." },
          flags: {
            type: "array",
            items: { type: "string" },
            description: "Any of: ambiguous, deviation_not_allowed, penalty, disqualification_risk, needs_clarification, conflicts_with_other_clause, scanned_page",
          },
        },
        // EVERY field is required. In non-strict JSON mode the model treats
        // any non-required property as optional and simply omits it (seen:
        // DeepSeek returned only the 4 required overview keys and skipped the
        // other 11 entirely, while still citing pages for them). "Empty if
        // none" is expressed as an empty string / empty array, never by
        // leaving the key out.
        required: [
          "clauseRef", "title", "page", "pageEnd", "verbatim", "requirementDescription", "summary", "importance",
          "deadline", "amount", "link", "timePeriod", "measurementPeriod", "applicability", "exception",
          "criterion", "threshold", "unit", "comparator", "evidenceRequired", "mandatoryStatus", "clauseStatus", "conflictNote", "flags",
        ],
      },
    },
    notes: { type: "string", description: "Observations for the tender executive: missing pages, contradictions, unclear sections. Empty if none." },
  },
  required: ["items", "notes"],
};

const BASE_SYSTEM = `You are a senior tender analyst for an Indian EPC / supply contractor. You read government and PSU tender documents line by line and never miss a clause. You are exhaustive: you would rather list a borderline clause than omit it. This document may bundle several separate files (NIT, GCC, SCC, BOQ, corrigenda, and documents attached via a link inside one of them) concatenated together — each page is marked <<< PAGE n (file p.m) >>>, where 'n' is a running number across the whole bundle and '(file p.m)' tells you which original file and its own page number, so you can reason about which source document a clause came from (needed to detect conflicts between documents). You always cite 'n' — the number right after PAGE — as the page value; never the 'p.m' number in parentheses. The reader relies on your output INSTEAD of reading the tender, so every item must carry everything the clause says, not a keyword and a number. You never label clauses as "high risk" or compare with market norms — reasoning must be grounded only in what the tender text says. You never assume or hallucinate standard terms not present in the text. You output only JSON matching the schema.`;

export function extractionPrompt(category, docText, windowInfo, learnedQuestions) {
  const def = CATEGORY_DEFS[category];
  const criteriaRule = isCriteriaCategory(category)
    ? "For each criterion fill criterion / threshold / unit / comparator / evidenceRequired / mandatoryStatus, plus timePeriod / measurementPeriod / applicability / exception wherever the tender states them."
    : "For clauses that are not eligibility criteria leave criterion / threshold / unit / evidenceRequired / mandatoryStatus empty and set comparator to 'n/a'; still fill timePeriod / applicability / exception when the tender states them.";
  const windowNote = windowInfo
    ? `\nNOTE: You are seeing pages ${windowInfo.from}-${windowInfo.to} of a ${windowInfo.total}-page document. Extract only from these pages.`
    : "";
  // Questions this team has actually had to ask the chatbot on past tenders
  // (pooled globally in AskedQuestion). Extraction that answers them up front
  // is the difference between a report that gets used and one that gets
  // interrogated afterwards.
  const learned = learnedQuestions?.length
    ? `
WHAT THIS TEAM ACTUALLY ASKS
On previous tenders, executives had to ask the following to get answers this report should already have contained. If this tender states anything bearing on these, make sure the relevant clause is extracted here with enough detail to answer it outright — without inventing anything not in the document, and without forcing an item this tender genuinely does not contain:
${learnedQuestions.map((q) => "- " + q).join(NEWLINE)}
`
    : "";
  const user = `TASK: Extract EVERY clause, condition, requirement or figure in this tender that belongs to the category "${def.label}".

CATEGORY DEFINITION (illustrative examples — not an exhaustive checklist; see EXTRACTION STANDARD rule G)
${def.description}

${EXTRACTION_STANDARD}

ADDITIONAL RULES
1. 'page' must be the number immediately after 'PAGE' in the nearest preceding marker (not the parenthetical p.m label).
2. If the same requirement is repeated verbatim (not conflicting) elsewhere, include it once and mention the other page(s) in requirementDescription.
3. If a clause seems to belong to another category too, still include it here if it materially affects "${def.label}".
4. ${criteriaRule}
5. Mark importance 'critical' for anything that can lead to rejection of the bid, forfeiture, or heavy penalty.${learned}
6. Return an empty items array only if the document truly contains nothing for this category.
${windowNote}

DOCUMENT
=========
${docText}
=========
Return JSON now.`;
  return { system: BASE_SYSTEM, user };
}

/**
 * Pass-2 schema: distinct from extraction because it must separate two kinds
 * of findings — a clause pass 1 missed entirely ("missing"), vs a clause pass
 * 1 found but only partially captured ("incomplete", e.g. it got the
 * threshold but dropped the recency window). Conflating these silently lets
 * partial captures slip through uncaught.
 */
export const VERIFY_SCHEMA = {
  type: "object",
  properties: {
    missing: { ...EXTRACTION_SCHEMA.properties.items, description: "Clauses pass 1 did not list at all." },
    incomplete: {
      type: "array",
      description: "Clauses pass 1 DID list, but incompletely (missing threshold/timePeriod/exception/evidence/etc.) — provide the corrected, complete item.",
      items: {
        type: "object",
        properties: {
          targetClauseRef: { type: "string", description: "clauseRef of the pass-1 item being corrected, exactly as listed below" },
          targetPage: { type: "integer", description: "the PAGE number shown in brackets for that item below (same numbering as the document's <<< PAGE n >>> markers) — NOT the p.m label" },
          whatWasMissing: { type: "string", description: "Short note: which fields/content pass 1 dropped" },
          corrected: {
            ...EXTRACTION_SCHEMA.properties.items.items,
            description: "The FULL corrected item — not a diff. Repeat every field, fixed and complete.",
          },
        },
        required: ["targetClauseRef", "targetPage", "whatWasMissing", "corrected"],
      },
    },
    notes: { type: "string", description: "Anything else worth flagging: page ranges that looked suspicious, sections likely OCR-broken, etc. Empty if none." },
  },
  required: ["missing", "incomplete", "notes"],
};

export function verificationPrompt(category, docText, found, windowInfo, toGlobal) {
  const def = CATEGORY_DEFS[category];
  // The document text below uses global PAGE markers; `found` items carry
  // local (file, page) citations, so translate back to the global number
  // the model actually sees — otherwise its 'targetPage' answers would be
  // in a numbering scheme that doesn't match the marker it's reading.
  const list = found
    .map((c) => {
      const g = toGlobal ? toGlobal(c.sourceFile, c.page) : c.page;
      return `- [PAGE ${g}${c.sourceFile ? ` — ${c.sourceFile} p.${c.page}` : ""}] ${c.clauseRef || "(no ref)"} — ${c.title}\n  requirementDescription: ${(c.requirementDescription || c.summary || "").slice(0, 220)}`;
    })
    .join("\n");
  const windowNote = windowInfo
    ? `\nNOTE: You are seeing pages ${windowInfo.from}-${windowInfo.to} of a ${windowInfo.total}-page document. Only report findings from these pages.`
    : "";
  const user = `TASK: A first pass already extracted the "${def.label}" clauses listed below from this tender. Your job is a completeness AUDIT — the first pass is NOT automatically correct or complete.

CATEGORY DEFINITION (illustrative examples — not an exhaustive checklist; see EXTRACTION STANDARD rule G)
${def.description}

${EXTRACTION_STANDARD}

ALREADY EXTRACTED BY PASS 1 (${found.length} items)
${list || "(nothing)"}

AUDIT TASK
1. Re-read the entire supplied text page by page, sweeping it the same way as the standard above.
2. For every relevant clause, check whether pass 1 captured it, and whether it captured it COMPLETELY (per the DEPTH STANDARD — figures, basis, timePeriod, exceptions, evidence, consequence).
3. Put clauses pass 1 missed ENTIRELY into 'missing' (same shape as a normal extraction item).
4. Put clauses pass 1 listed but only PARTIALLY captured into 'incomplete' — reference the exact clauseRef/page from the list above as 'targetClauseRef'/'targetPage', explain in 'whatWasMissing', and give the FULL corrected item in 'corrected' (repeat every field complete and fixed, not just the delta).
5. Do NOT duplicate an item pass 1 already captured completely and correctly.
6. Apply the CONFLICT rule (part E of the standard) even here: if you find the same term with a different number than what's listed above, that's a 'missing' item with clauseStatus='CONFLICT'.
7. If nothing was missed and nothing was incomplete, return {"missing": [], "incomplete": [], "notes": "..."}.
${windowNote}

DOCUMENT
=========
${docText}
=========
Return JSON now.`;
  return { system: BASE_SYSTEM, user };
}

/**
 * Tender Overview: the header-level facts an executive checks first (NIT
 * number, dates, EMD, tender value). Cheap — one pass, short output, run
 * once against the window containing page 1.
 */
export const OVERVIEW_SCHEMA = {
  type: "object",
  properties: {
    tenderTitle: { type: "string", description: "The tender's title as printed on the cover/NIT — one line, no commentary, no reasoning, no notes about alternatives (put those in 'notes')" },
    referenceNumber: { type: "string", description: "NIT / RFP / tender number as printed. If there are two (e.g. a portal bid number and a tender number), give both separated by ' / '" },
    issuingAuthority: { type: "string", description: "Name of the buyer / issuing organisation as printed" },
    location: { type: "string", description: "Place of work / delivery as printed" },
    scopeSummary: { type: "string", description: "1-3 sentence plain summary of what is being procured" },
    contractPeriod: { type: "string", description: "Contract / completion period as printed" },
    estimatedValue: { type: "string", description: "Estimated cost / tender value, formatted readable e.g. 'INR 12,34,56,789 (~Rs. 12.3 Crore)'" },
    tenderFee: { type: "string" },
    emdAmount: { type: "string", description: "Exact EMD amount/formula, bank details if given. Must be a complete figure/formula (e.g. 'Rs. 50,000' or '2% of estimated value'). NEVER output a bare currency symbol/prefix alone (e.g. just 'Rs.' or 'INR') with no number — if the tender doesn't state an explicit EMD amount, leave this empty and explain in 'notes' instead (e.g. 'EMD amount not explicitly printed; tied to bid value')." },
    emdExemptions: { type: "string", description: "MSE/Startup/govt exemption rules for EMD, if any" },
    preBidMeeting: { type: "string", description: "Date, time and venue combined as printed" },
    clarificationDeadline: { type: "string" },
    bidSubmissionStart: { type: "string" },
    bidSubmissionEnd: { type: "string" },
    bidOpeningDate: { type: "string" },
    citations: {
      type: "object",
      description: "Map each non-empty field above to the page number it was found on. Keys MUST be exactly one of the field names above (tenderTitle, referenceNumber, issuingAuthority, location, scopeSummary, contractPeriod, estimatedValue, tenderFee, emdAmount, emdExemptions, preBidMeeting, clarificationDeadline, bidSubmissionStart, bidSubmissionEnd, bidOpeningDate) — never invent a different key name (e.g. write 'bidOpeningDate', not 'bidOpening' or 'bidNumber'). Value is the number right after 'PAGE' in the marker, NOT the parenthetical p.m label, e.g. {\"emdAmount\": 4}",
      additionalProperties: { type: "integer" },
    },
    notes: { type: "string", description: "Anything ambiguous or contradictory in the header info. Empty if none." },
  },
  // All fields required — see the note on EXTRACTION_SCHEMA. Optional keys
  // are simply omitted by the model in non-strict mode; this was the reason
  // the overview came back with 11 of 15 fields missing while the citations
  // for those same fields were present.
  required: [
    "tenderTitle", "referenceNumber", "issuingAuthority", "location", "scopeSummary", "contractPeriod",
    "estimatedValue", "tenderFee", "emdAmount", "emdExemptions", "preBidMeeting", "clarificationDeadline",
    "bidSubmissionStart", "bidSubmissionEnd", "bidOpeningDate", "citations", "notes",
  ],
};

export function overviewPrompt(docText, priorFindings) {
  const system = `You are a senior tender analyst. You extract only the header-level facts of a tender document — never paraphrase figures, dates or names. This document may bundle several files concatenated together, marked <<< PAGE n (file p.m) >>> — always cite 'n' (the number right after PAGE), never the parenthetical p.m. You output only JSON matching the schema.`;
  const hints = priorFindings?.length
    ? `\n\nALREADY VERIFIED BY DETAILED CLAUSE-BY-CLAUSE EXTRACTION (use these — they were found and cross-checked independently, so where one directly answers a field below, transcribe it into that field instead of leaving the field blank; still prefer your own reading of the document when the two disagree, and note the discrepancy):\n${priorFindings.join("\n")}\n`
    : "";
  const user = `TASK: Extract the tender's header/overview facts — the details an executive checks in the first 30 seconds: title, reference/NIT number, issuing authority, key dates (pre-bid meeting, clarification deadline, bid submission window, bid opening), estimated value, EMD, tender fee, contract period, and a short scope summary.

RULES
1. Use only what is explicitly printed. Leave a field empty string if not found — never guess or invent.
2. Copy reference numbers, dates and amounts exactly as printed (do not reformat dates; you may add a readable parenthetical for large amounts, e.g. 'INR 12,34,56,789 (~Rs. 12.3 Crore)', but keep the original figure too).
3. NEVER output a partial/fragment value — a currency symbol alone ('Rs.', 'INR'), a unit alone, or any value that isn't a complete, usable figure. If you can't state the complete value, leave the field EMPTY and put the explanation in 'notes' instead (e.g. an amount that depends on a formula not resolved here, or is genuinely not stated).
4. Record the page number each fact came from in 'citations' — the number right after 'PAGE' in the marker, using EXACTLY the field's own name as the key (see the citations field description).
5. This is usually on the cover page, NIT, covering letter, or a "critical date sheet" — check all of those if present in the supplied pages.
6. A field you can explain in 'notes' but leave blank in its own key is a mistake — if you know the answer, put it in the field, not only in the prose.
7. Output EVERY field in the schema, every time — an unknown value is an empty string "", never a missing key. Field values are the fact only: no reasoning, no "I chose X because…", no alternatives — that commentary belongs in 'notes', and even there keep it to 2-3 sentences.
${hints}
DOCUMENT
=========
${docText}
=========
Return JSON now.`;
  return { system, user };
}

// ---------------------------------------------------------------------------
// Executive summary — the model re-reads the critical clauses (already
// extracted, already cited) and compresses each into one exec-level
// key/value line. Not a filter over the clause list: the point is to
// re-summarize, so a bid decision-maker gets "EMD: ₹10.66 L, DD/BG/online,
// MSE exempt" rather than a paragraph — and duplicates across categories
// (EMD shows up in 4 clauses) collapse into one line.
// ---------------------------------------------------------------------------

export const EXEC_SUMMARY_SCHEMA = {
  type: "object",
  properties: {
    headline: { type: "string", description: "One or two sentences: what is being procured, by whom, roughly what it's worth, and the bid deadline. The first thing a company head reads." },
    atAGlance: {
      type: "array",
      description: "6-12 headline facts a decision-maker compares across tenders: EMD, estimated/contract value, contract period, bid submission deadline, bid opening, performance security %, key turnover/experience threshold, penalty/LD rate, payment terms, anything disqualifying. Only facts actually present in the input.",
      items: {
        type: "object",
        properties: {
          label: { type: "string", description: "2-5 words, e.g. 'EMD', 'Contract period', 'Min. annual turnover'" },
          value: { type: "string", description: "The fact itself, <= 15 words — the number/date/condition, not a sentence about it" },
          file: { type: "string", description: "Source filename, copied exactly from the clause's [file p#] tag" },
          page: { type: "integer", description: "Source page, copied exactly from the clause's [file p#] tag" },
        },
        required: ["label", "value", "file", "page"],
      },
    },
    sections: {
      type: "array",
      description: "One entry per category that has critical clauses, in the order given",
      items: {
        type: "object",
        properties: {
          category: { type: "string", enum: ["commercial", "financial", "technical", "legal", "technical_qualification"] },
          points: {
            type: "array",
            description: "Every critical clause of this category, compressed. Merge clauses that state the same requirement (same EMD amount from three places = one point, cite the most authoritative page). Never drop a distinct critical requirement to save space.",
            items: {
              type: "object",
              properties: {
                label: { type: "string", description: "2-6 words naming the requirement, e.g. 'Rig capacity', 'Mobilization deadline', 'LD for delay'" },
                value: { type: "string", description: "The requirement as a fact, <= 20 words: threshold/number/date/condition. If it's a risk (disqualification, forfeiture, conflict between documents) say so in 2-3 words at the start, e.g. 'RISK — ...'" },
                file: { type: "string", description: "Copied exactly from the source clause's [file p#] tag" },
                page: { type: "integer", description: "Copied exactly from the source clause's [file p#] tag" },
              },
              required: ["label", "value", "file", "page"],
            },
          },
        },
        required: ["category", "points"],
      },
    },
    watchouts: {
      type: "array",
      description: "0-6 one-line items the head of the company must not miss before approving a bid: conflicting clauses across documents, unusual disqualification triggers, anything that makes this tender harder than a typical one. Empty if none.",
      items: { type: "string" },
    },
  },
  required: ["headline", "atAGlance", "sections", "watchouts"],
};

function execDigestLine(c) {
  const bits = [];
  if (c.criterion) bits.push(`criterion: ${c.criterion}${c.comparator && c.comparator !== "n/a" ? " " + c.comparator : ""} ${c.threshold || ""}${c.unit && c.unit !== "n/a" ? " " + c.unit : ""}`.replace(/\s+/g, " ").trim());
  if (c.amount) bits.push(`amount: ${c.amount}`);
  if (c.deadline) bits.push(`deadline: ${c.deadline}`);
  if (c.timePeriod && c.timePeriod !== "n/a") bits.push(`period: ${c.timePeriod}`);
  if (c.mandatoryStatus) bits.push(`mandatory: ${c.mandatoryStatus}`);
  if (c.exception) bits.push(`exception: ${c.exception}`);
  if (c.clauseStatus === "CONFLICT") bits.push(`⚡ CONFLICT: ${c.conflictNote}`);
  return `[${c.sourceFile} p${c.page}] (${c.category}) ${c.clauseRef ? c.clauseRef + " — " : ""}${c.title}: ${c.requirementDescription || c.summary || ""}${bits.length ? " | " + bits.join("; ") : ""}`;
}

/**
 * @param tender  lean Tender doc (.title, .overview)
 * @param clauses lean Clause docs to summarize — the caller passes only the
 *                ones that belong in an exec brief (critical + conflicts)
 */
export function executiveSummaryPrompt(tender, clauses) {
  const system = `You are the bid-desk head writing a one-page brief for the company's managing director, who will use it to decide whether to bid and to compare this tender against others on the table. The MD reads dozens of these; every line must earn its place. You output only JSON matching the schema.

RULES
1. Every value is the fact itself — a number, date, percentage, or condition — never a description of the fact. "₹10,66,000; DD/BG/online; MSE exempt" not "The bidder must submit an EMD which can be paid through various modes".
2. Merge, don't repeat: if three clauses say the same thing (EMD in the bid summary, the ITB and the annexure), output one point and cite the most authoritative page. But never merge two DIFFERENT requirements into one line, and never drop a distinct critical requirement.
3. Copy file and page exactly from the [file p#] tag in front of the source clause. Never invent a page.
4. Flag risk where it exists: a conflict between documents, a disqualification trigger, an unusually harsh penalty. Lead the value with "RISK — " so it stands out in a table.
5. Use the tender's own figures and units as printed (lakh/crore notation, INR, the exact dates). Do not convert or round unless adding a parenthetical.
6. Do not editorialize or recommend whether to bid — that's the MD's call. Present what the tender demands, clearly.`;

  const ov = tender.overview || {};
  const overviewLines = Object.entries(ov)
    .filter(([k, v]) => v && k !== "citations" && k !== "notes")
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  const byCat = {};
  for (const c of clauses) (byCat[c.category] ||= []).push(c);
  const digest = CATEGORY_KEYS.filter((k) => byCat[k]?.length)
    .map((k) => `\n## ${k} (${byCat[k].length} clauses)\n${byCat[k].map(execDigestLine).join("\n")}`)
    .join("\n");

  const user = `TENDER: ${ov.tenderTitle || tender.title}

OVERVIEW FACTS ALREADY EXTRACTED
${overviewLines || "(none)"}
${ov.notes ? "Notes: " + ov.notes : ""}

CRITICAL CLAUSES TO COMPRESS (${clauses.length} total — these are the ones flagged critical or conflicting during detailed extraction; each already carries its source tag)
${digest}

Write the brief now. Return JSON.`;
  return { system, user };
}

// ---------------------------------------------------------------------------
// Chat — answers a bid manager's question from the already-extracted clause
// data, not by re-reading the raw document. At the scale this app deals with
// (a few hundred clauses per tender) the whole clause set fits comfortably in
// one context window, so this deliberately skips embeddings/RAG chunking —
// the segregation pipeline already did the hard work of exhaustive, per-
// category extraction; chat just needs to read what it already found.
// ---------------------------------------------------------------------------

export const CHAT_SCHEMA = {
  type: "object",
  properties: {
    reply: {
      type: "string",
      description:
        "The answer, in plain text/light markdown. Cite every factual claim with the exact '[filename p#]' tag shown before that fact in the context below — copy it verbatim, never invent a tag, filename or page number.",
    },
    topic: {
      type: "string",
      description:
        "The user's question rewritten as a short, tender-agnostic information need (max 15 words) that would apply to ANY tender, e.g. 'What is the EMD amount and in what forms can it be submitted?'. Strip names, numbers and specifics of THIS tender. This is pooled across tenders so future extractions cover it up front.",
    },
    category: {
      type: "string",
      enum: ["commercial", "financial", "technical", "legal", "technical_qualification"],
      description: "Which category this question is really about — the one whose extraction should have surfaced the answer.",
    },
    answeredFromClauses: {
      type: "boolean",
      description:
        "true if the extracted clauses below actually contained the answer. false if you could NOT answer because the information is not in them — in that case say so briefly in 'reply'; the raw tender pages will then be searched and you will be asked again.",
    },
  },
  required: ["reply", "topic", "category", "answeredFromClauses"],
};

function clauseDigestLine(c) {
  const bits = [];
  if (c.criterion) bits.push(`criterion: ${c.criterion}${c.comparator && c.comparator !== "n/a" ? " " + c.comparator : ""} ${c.threshold || ""}${c.unit && c.unit !== "n/a" ? " " + c.unit : ""}`.replace(/\s+/g, " ").trim());
  if (c.mandatoryStatus) bits.push(`mandatory: ${c.mandatoryStatus}`);
  if (c.deadline) bits.push(`deadline: ${c.deadline}`);
  if (c.amount) bits.push(`amount: ${c.amount}`);
  if (c.timePeriod && c.timePeriod !== "n/a") bits.push(`period: ${c.timePeriod}`);
  if (c.applicability) bits.push(`applies to: ${c.applicability}`);
  if (c.exception) bits.push(`exception: ${c.exception}`);
  if (c.evidenceRequired) bits.push(`evidence: ${c.evidenceRequired}`);
  if (c.clauseStatus === "CONFLICT") bits.push(`⚡ CONFLICT: ${c.conflictNote}`);
  const desc = c.requirementDescription || c.summary || "";
  const tag = `[${c.sourceFile} p${c.page}]`;
  const head = `${tag} (${c.category}${c.importance === "critical" ? ", CRITICAL" : ""}) ${c.clauseRef ? c.clauseRef + " — " : ""}${c.title}`;
  return bits.length ? `${head}: ${desc} | ${bits.join("; ")}` : `${head}: ${desc}`;
}

/**
 * @param tender  lean Tender doc (needs .title, .overview)
 * @param clauses lean Clause docs for this tender (all categories)
 * @param history [{role: "user"|"assistant", text}] prior turns, oldest first
 * @param message the new question
 */
export function chatPrompt(tender, clauses, history, message, docText) {
  const system = `You are a senior tender/bid-desk analyst briefing a bid manager who is deciding whether and how to bid on this tender. Answer ONLY from the extracted clause data and overview facts given below — this data comes from an exhaustive clause-by-clause read of the full tender document (commercial, financial, technical, legal, technical-qualification), so treat it as authoritative for what the tender contains. You output only JSON matching the schema.

RULES
1. Cite every factual claim with the exact tag shown before it, e.g. "[GeM-Bidding-9851277.pdf p26]" — copy it exactly, never invent a tag, filename or page number. Each bracket holds exactly ONE file and ONE page — if two facts sit on different pages, use two separate tags back to back, e.g. "[file.pdf p57] [file.pdf p58]", never "[file.pdf p57, p58]".
2. If the answer isn't in the data provided, say so plainly ("this isn't captured in the extracted clauses — check the source PDF directly") rather than guessing or inventing a figure, date, or clause number.
3. When a topic is covered by clauses in more than one category (EMD often appears in commercial, financial AND technical-qualification), synthesize them into one clear answer instead of just repeating each one.
4. If any clause relevant to the question has CONFLICT status, say so explicitly and explain what's inconsistent — that's exactly the kind of thing a bid manager must not miss.
5. Be concise and directive, like a colleague briefing another colleague — lead with the answer, then supporting detail. Short paragraphs or a tight bullet list; don't restate the question.
6. This is a convenience layer over already-extracted data, not a replacement for reading the source clause before acting — say so plainly when something high-stakes (disqualification risk, EMD, a hard deadline) rests on a single clause.`;

  const ov = tender.overview || {};
  const overviewLines = Object.entries(ov)
    .filter(([k, v]) => v && k !== "citations" && k !== "notes")
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");

  // On escalation the full document is supplied instead, so the digest is
  // not included in the prompt — skip building it at all (it is ~35k chars).
  const digest = docText ? "" : (clauses || []).map(clauseDigestLine).join(NEWLINE);

  const historyText = history?.length
    ? `\n\nCONVERSATION SO FAR\n${history.map((h) => `${h.role === "user" ? "Bid manager" : "You"}: ${h.text}`).join("\n")}\n`
    : "";

  const user = `TENDER: ${ov.tenderTitle || tender.title}

OVERVIEW FACTS
${overviewLines || "(none extracted)"}
${ov.notes ? "Notes: " + ov.notes : ""}

${docText ? `FULL TENDER TEXT (the extracted clauses did not answer this, so the complete document follows — pages are marked <<< PAGE n (file p.m) >>>; cite as [filename p#] using the file and page from the marker)
=========
${docText}
=========

` : ""}${docText ? "" : `EXTRACTED CLAUSES (${clauses?.length || 0} total, across commercial/financial/technical/legal/technical-qualification)
${digest || "(none extracted yet — say so if asked something only the raw document would answer)"}`}
${historyText}
NEW QUESTION FROM THE BID MANAGER
${message}

Return JSON now.`;
  return { system, user };
}
