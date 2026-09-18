import mongoose from "mongoose";

export const CATEGORIES = [
  "commercial",
  "financial",
  "technical",
  "legal",
  "technical_qualification",
];

const ClauseSchema = new mongoose.Schema(
  {
    tenderId: { type: mongoose.Schema.Types.ObjectId, ref: "Tender", index: true },
    category: { type: String, enum: CATEGORIES, index: true },
    sourceFile: String, // original PDF filename — so a clause is a self-contained citation once exported/copied out of the app
    clauseRef: String, // "Clause 12.3", "Annexure B (ii)", ...
    title: String,
    page: Number,
    pageEnd: Number,
    verbatim: String, // exact quote from the document (incl. attached notes/provisos)
    requirementDescription: String, // complete, self-contained, actionable brief — the
    // "could the executive act on this without reopening the tender?" field.
    summary: String, // short (<=15 word) label used in lists/exports/search
    importance: { type: String, enum: ["critical", "high", "medium", "low"] },
    // structured extras
    deadline: String,
    amount: String,
    link: String, // URL directly relevant to this clause (portal, referenced document), if any
    timePeriod: String, // e.g. "last 7 years"
    measurementPeriod: String, // e.g. "one production year / consecutive 365 days"
    applicability: String, // e.g. "Lead member >= 50%, other members >= 25%"
    exception: String, // e.g. "MSE/Startup relaxation NOT applicable"
    // eligibility / financial criteria fields
    criterion: String,
    threshold: String,
    unit: String,
    comparator: String, // >=, <=, =, in, must_have, n/a
    evidenceRequired: String,
    mandatoryStatus: {
      type: String,
      enum: ["MANDATORY", "CONDITIONAL", "OPTIONAL", "NOT_SPECIFIED", ""],
      default: "",
    },
    // how clearly/consistently the tender states this clause
    clauseStatus: { type: String, enum: ["EXPLICIT", "CONDITIONAL", "CONFLICT"], default: "EXPLICIT" },
    conflictNote: String, // populated when clauseStatus === "CONFLICT": which other ref/page disagrees and how
    flags: [String], // e.g. "ambiguous", "deviation_not_allowed", "penalty", "disqualification_risk"
    source: { type: String, enum: ["extract", "verify", "manual"], default: "extract" }, // "verify" = found only in pass 2; "manual" = added by a user from chat
    correctedByVerify: { type: Boolean, default: false }, // true if pass 2 enriched/corrected this extract-pass item
    model: String,
    addedBy: String, // manual clauses only: who added it (free text for now)
    addedFrom: String, // manual clauses only: the chat question that produced it
  },
  { timestamps: true }
);

ClauseSchema.index({ tenderId: 1, category: 1, page: 1 });

export const Clause = mongoose.model("Clause", ClauseSchema);
