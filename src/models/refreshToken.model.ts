import mongoose, { Schema, model, Types, type Model } from "mongoose";

/**
 * Refresh tokens are opaque, random, high-entropy strings handed to the
 * client - only their SHA-256 hash is stored here, so a database read
 * alone can never yield a usable token (same principle as password
 * hashing). Rotation: every /admin/auth/refresh call revokes the token
 * presented and issues a new one in the same `family`. If a token that is
 * already revoked gets presented again, that's a strong signal it was
 * stolen and replayed, so the whole family is revoked - forcing the
 * legitimate owner to log in again too. See services/adminAuth.service.ts.
 */

export interface IRefreshToken {
    admin: Types.ObjectId;
    tokenHash: string;
    family: string;
    revokedAt?: Date;
    replacedByTokenHash?: string;
    expiresAt: Date;
    userAgent?: string;
    ip?: string;
    createdAt: Date;
    updatedAt: Date;
}

const RefreshTokenSchema = new Schema<IRefreshToken>(
    {
        admin: {
            type: Schema.Types.ObjectId,
            ref: "Admin",
            required: true,
            index: true,
        },
        tokenHash: {
            type: String,
            required: true,
            unique: true,
        },
        family: {
            type: String,
            required: true,
            index: true,
        },
        revokedAt: {
            type: Date,
        },
        replacedByTokenHash: {
            type: String,
        },
        expiresAt: {
            type: Date,
            required: true,
        },
        userAgent: {
            type: String,
            maxlength: 512,
        },
        ip: {
            type: String,
            maxlength: 64,
        },
    },
    { timestamps: true }
);

// MongoDB TTL index: expired tokens are automatically reaped so this
// collection can't grow unbounded. A short grace period past expiresAt is
// deliberately not added - once expired the token is useless anyway.
RefreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// Fast lookup of "all live tokens in this family" during rotation/reuse checks.
RefreshTokenSchema.index({ family: 1, revokedAt: 1 });

export const RefreshToken =
    (mongoose.models.RefreshToken as Model<IRefreshToken> | undefined) ?? model<IRefreshToken>("RefreshToken", RefreshTokenSchema);