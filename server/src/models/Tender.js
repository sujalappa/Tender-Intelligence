import mongoose from "mongoose";

// One page of one source file. `page` is local to that file (as printed);
// `file` says which SourceFileSchema entry (by name) it came from.
const PageSchema = new mongoose.Schema(
  { file: String, page: Number, text: String, links: [String] },
  { _id: false }
);

// A PDF that's part of this tender's context — either uploaded directly, or
// auto-fetched because a link inside an uploaded PDF pointed at one.
const SourceFileSchema = new mongoose.Schema(
  {
    name: String,
    filePath: String,
    kind: { type: String, enum: ["uploaded", "linked"], default: "uploaded" },
    pageCount: Number,
    sourceUrl: String, // kind === "linked" only
    fetchedFrom: { file: String, page: Number }, // kind === "linked" only: where the link was found
  },
  { _id: false }
);

const RunSchema = new mongoose.Schema(
  {
    provider: String,
    model: String,
    category: String,
    pass: { type: String, enum: ["extract", "verify", "overview"] },
    window: String, // e.g. "p1-p120"
    inputTokens: Number,
    outputTokens: Number,
    durationMs: Number,
    clausesFound: Number,
    error: String,
  },
  { _id: false }
);

// Header-level facts an executive checks first: NIT number, dates, EMD, value.
// Every field is free text (as printed) so the model never has to force a
// figure into a type it isn't sure about; `citations` maps field -> "file#page".
const OverviewSchema = new mongoose.Schema(
  {
    tenderTitle: String,
    referenceNumber: String, // NIT / RFP / tender number
    issuingAuthority: String,
    location: String,
    scopeSummary: String,
    contractPeriod: String,
    estimatedValue: String,
    tenderFee: String,
    emdAmount: String,
    emdExemptions: String,
    preBidMeeting: String, // date, time & venue combined as printed
    clarificationDeadline: String,
    bidSubmissionStart: String,
    bidSubmissionEnd: String,
    bidOpeningDate: String,
    citations: mongoose.Schema.Types.Mixed, // { fieldName: "file.pdf#12" }
    notes: String,
  },
  { _id: false }
);

const TenderSchema = new mongoose.Schema(
  {
    title: String,
    files: [SourceFileSchema], // files[0] is the primary/first uploaded document
    pageCount: Number, // total across all files (uploaded + linked)
    charCount: Number,
    estTokens: Number,
    pages: [PageSchema], // flat, across all files, in upload+link-discovery order
    status: {
      type: String,
      enum: ["uploaded", "parsing", "segregating", "done", "failed"],
      default: "uploaded",
    },
    progress: { type: String, default: "" },
    linkLog: [String], // what happened when following links found in the PDFs
    // Timestamped audit trail of every LLM attempt: started / retried (and
    // why) / aborted / lost to a restart. `runs` only records attempts that
    // came back — this is what makes the ones that didn't visible.
    events: [String],
    provider: String,
    model: String,
    runs: [RunSchema],
    error: String,
    overview: OverviewSchema,
    summary: mongoose.Schema.Types.Mixed, // per-category counts
    // Model-written one-page brief of the critical clauses (see
    // services/execSummary.js). Generated on demand, kept until regenerated.
    execSummary: mongoose.Schema.Types.Mixed,
  },
  { timestamps: true }
);

export const Tender = mongoose.model("Tender", TenderSchema);
