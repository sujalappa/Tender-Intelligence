import mongoose from "mongoose";

export const ROLES = ["superadmin", "user"];

/**
 * A tender-desk account. Deliberately small: six people on an office
 * network, no self-signup, no password reset email — super admins create
 * accounts and set/reset passwords directly.
 */
const UserSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
    name: { type: String, required: true, trim: true },
    passwordHash: { type: String, required: true },
    role: { type: String, enum: ROLES, default: "user", index: true },
    // Deactivating keeps the person's notes and chat history intact (which a
    // delete would orphan) while refusing them a new session.
    active: { type: Boolean, default: true },
    lastLoginAt: Date,
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

/** Never let a password hash reach the client, whatever the caller selects. */
UserSchema.methods.toSafe = function () {
  return {
    id: this._id,
    email: this.email,
    name: this.name,
    role: this.role,
    active: this.active,
    lastLoginAt: this.lastLoginAt,
    createdAt: this.createdAt,
  };
};

export const User = mongoose.model("User", UserSchema);
