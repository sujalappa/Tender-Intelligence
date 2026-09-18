import mongoose from "mongoose";

/**
 * Persisted chat turns. Chat history used to live only in the browser tab and
 * died on reload; it is stored now because super admins need to see what each
 * person asked (and because a question already answered for one person is
 * worth showing the next rather than re-spending ~35k tokens on it).
 */
const ChatMessageSchema = new mongoose.Schema(
  {
    tenderId: { type: mongoose.Schema.Types.ObjectId, ref: "Tender", required: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    role: { type: String, enum: ["user", "assistant"], required: true },
    text: { type: String, required: true },
    // assistant turns only
    category: String, // which section the model judged the question to be about
    searchedFullDocument: Boolean, // true = the clauses fell short, full PDF was read
    inputTokens: Number,
    outputTokens: Number,
    durationMs: Number,
  },
  { timestamps: true }
);

ChatMessageSchema.index({ tenderId: 1, userId: 1, createdAt: 1 });

export const ChatMessage = mongoose.model("ChatMessage", ChatMessageSchema);
