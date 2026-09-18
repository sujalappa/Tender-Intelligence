import mongoose from "mongoose";

/**
 * One billed LLM call, whoever triggered it.
 *
 * `Tender.runs` only ever recorded segregation passes, so chat and
 * executive-summary calls were real spend that never appeared in the usage
 * total the app showed. This collection captures every non-segregation call,
 * attributed to the user who caused it — the tender's usage total is the sum
 * of both (see GET /api/tenders/:id).
 */
const UsageEventSchema = new mongoose.Schema(
  {
    tenderId: { type: mongoose.Schema.Types.ObjectId, ref: "Tender", index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
    kind: {
      type: String,
      enum: ["chat", "chat-fulldoc", "exec-summary", "note-exec-point", "overview-refresh"],
      required: true,
      index: true,
    },
    provider: String,
    model: String,
    inputTokens: { type: Number, default: 0 },
    outputTokens: { type: Number, default: 0 },
    durationMs: Number,
  },
  { timestamps: true }
);

UsageEventSchema.index({ tenderId: 1, createdAt: -1 });

export const UsageEvent = mongoose.model("UsageEvent", UsageEventSchema);

/** Record a call. Never allowed to break the operation it is measuring. */
export async function recordUsage(doc) {
  try {
    await UsageEvent.create(doc);
  } catch (e) {
    console.warn("[usage] could not record:", e.message);
  }
}
