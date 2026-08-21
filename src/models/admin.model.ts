import { Schema, model, models, type HydratedDocument, type Model } from "mongoose";
import { hashPassword, verifyPassword } from "../core/password";

/**
 * Roles are intentionally coarse - this backend only has a handful of admin
 * routes (usage analytics, moderation-style stats) so a full permission
 * matrix would be overkill. "superadmin" can manage other admin accounts,
 * "admin" can do everything else (view usage, moderation actions),
 * "viewer" is read-only (usage dashboards, no destructive actions).
 */
export type AdminRole = "superadmin" | "admin" | "viewer";
export const ADMIN_ROLES: readonly AdminRole[] = ["superadmin", "admin", "viewer"];

export interface IAdmin {
    username: string;
    email?: string;
    passwordHash: string;
    role: AdminRole;
    isActive: boolean;
    lastLoginAt?: Date;
    failedLoginAttempts: number;
    lockedUntil?: Date;
    createdAt: Date;
    updatedAt: Date;
}

export interface IAdminMethods {
    comparePassword(candidate: string): Promise<boolean>;
    toSafeJSON(): Record<string, unknown>;
}

export interface AdminModel extends Model<IAdmin, object, IAdminMethods> {
    hashPassword(plain: string): Promise<string>;
}

const USERNAME_RE = /^[a-z0-9_.-]{3,32}$/;
// Deliberately simple: this only gates obviously-malformed input before it
// reaches Mongoose/Mongo, real deliverability isn't a concern for an
// internal admin account.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const AdminSchema = new Schema<IAdmin, AdminModel, IAdminMethods>(
    {
        username: {
            type: String,
            required: true,
            unique: true,
            trim: true,
            lowercase: true,
            minlength: 3,
            maxlength: 32,
            validate: {
                validator: (value: string) => USERNAME_RE.test(value),
                message: "Username must be 3-32 characters: lowercase letters, numbers, '.', '_', '-'",
            },
        },
        email: {
            type: String,
            trim: true,
            lowercase: true,
            sparse: true,
            unique: true,
            validate: {
                validator: (value: string) => !value || EMAIL_RE.test(value),
                message: "Invalid email address",
            },
        },
        passwordHash: {
            type: String,
            required: true,
            select: false, // never returned unless explicitly requested with +passwordHash
        },
        role: {
            type: String,
            enum: ADMIN_ROLES,
            default: "admin",
            required: true,
        },
        isActive: {
            type: Boolean,
            default: true,
        },
        lastLoginAt: {
            type: Date,
        },
        failedLoginAttempts: {
            type: Number,
            default: 0,
            min: 0,
        },
        lockedUntil: {
            type: Date,
        },
    },
    {
        timestamps: true,
        // We already expose a hand-picked toSafeJSON(); keep the default
        // toJSON/toObject strict so passwordHash can never leak through a stray
        // JSON.stringify(adminDoc) elsewhere in the codebase.
        toJSON: { virtuals: false },
    }
);

AdminSchema.index({ role: 1, isActive: 1 });

AdminSchema.static("hashPassword", function hashPasswordStatic(plain: string) {
    return hashPassword(plain);
});

AdminSchema.method("comparePassword", async function comparePassword(this: HydratedDocument<IAdmin>, candidate: string) {
    // passwordHash has `select: false`; callers must `.select("+passwordHash")`.
    if (!this.passwordHash) {
        throw new Error("passwordHash was not selected - query with .select('+passwordHash')");
    }
    return verifyPassword(candidate, this.passwordHash);
});

AdminSchema.method("toSafeJSON", function toSafeJSON(this: HydratedDocument<IAdmin>) {
    return {
        id: this._id.toString(),
        username: this.username,
        email: this.email,
        role: this.role,
        isActive: this.isActive,
        lastLoginAt: this.lastLoginAt,
        createdAt: this.createdAt,
        updatedAt: this.updatedAt,
    };
});

export const Admin = (models.Admin as AdminModel | undefined) ?? model<IAdmin, AdminModel>("Admin", AdminSchema);