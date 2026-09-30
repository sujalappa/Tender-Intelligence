import mongoose from "mongoose";

/**
 * A fact the team wants on EVERY executive summary, e.g. "Site visit
 * mandatory?" or "Mobilisation period". Global, not per tender: once added
 * (from the summary's "ask" box, or the Summary Keys page) every summary
 * shows a row for it — with the tender's answer, or "Not mentioned" when the
 * tender is silent, so the absence itself is visible and comparable.
 *
 * `category` also feeds the key's question into that category's extraction
 * prompt, so future extractions capture the clause that answers it.
 */
const SummaryKeySchema = new mongoose.Schema(
  {
    label: { type: String, required: true, trim: true }, // row label on the summary, 2-6 words
    question: { type: String, required: true, trim: true }, // what the model is asked for each tender
    category: String,
    createdBy: { id: mongoose.Schema.Types.ObjectId, name: String },
  },
  { timestamps: true }
);

export const SummaryKey = mongoose.model("SummaryKey", SummaryKeySchema);
