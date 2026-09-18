import mongoose from "mongoose";

/**
 * Questions tender executives have actually asked the chatbot, pooled across
 * ALL tenders (deliberately global, not per-tender). Segregation feeds these
 * into the extraction prompt so a later tender proactively captures the
 * clauses people keep having to ask about — the app learns what this team
 * cares about instead of every tender starting from the same blind spots.
 */
const AskedQuestionSchema = new mongoose.Schema(
  {
    // Normalised form used for dedupe (lowercased, punctuation/space-collapsed)
    key: { type: String, index: true, unique: true },
    text: String, // the question as last asked, verbatim
    category: { type: String, index: true }, // which category it belongs to, per the model
    asked: { type: Number, default: 1 }, // how many times it has come up
    tenderIds: [mongoose.Schema.Types.ObjectId],
    lastAskedAt: Date,
  },
  { timestamps: true }
);

export const AskedQuestion = mongoose.model("AskedQuestion", AskedQuestionSchema);

export const normaliseQuestion = (s) =>
  String(s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
