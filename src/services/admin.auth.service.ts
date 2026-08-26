import { createHash, randomBytes } from "node:crypto";
import { Admin, type IAdmin, type IAdminMethods } from "../models/admin.model";
import { RefreshToken } from "../models/refresh.token.model";
import { env } from "../config/env";
import { AppError } from "../utils/errors";
import { signJwt, verifyJwt, JwtError, type JwtPayload } from "../utils/jwt";
import { logger } from "../utils/logger";
import type { HydratedDocument } from "mongoose";

/**
 * Admin auth: JWT access tokens (short-lived, stateless) + opaque refresh
 * tokens (long-lived, stored hashed, rotated on every use). See
 * models/refresh.token.model.ts for the rotation/reuse-detection rationale.
 */

export interface TokenPair {
    accessToken: string;
    accessTokenExpiresAt: Date;
    refreshToken: string;
    refreshTokenExpiresAt: Date;
}

function assertAuthConfigured(): { accessSecret: string; refreshSecret: string } {
    if (!env.JWT_ACCESS_SECRET || !env.JWT_REFRESH_SECRET) {
        throw new AppError(
            "AUTH_NOT_CONFIGURED",
            "Admin auth is not configured on this server (missing JWT_ACCESS_SECRET / JWT_REFRESH_SECRET)"
        );
    }
    return { accessSecret: env.JWT_ACCESS_SECRET, refreshSecret: env.JWT_REFRESH_SECRET };
}

function hashToken(token: string): string {
    return createHash("sha256").update(token).digest("hex");
}

function generateOpaqueToken(): string {
    return randomBytes(48).toString("base64url");
}

async function issueTokenPair(
    admin: HydratedDocument<IAdmin, IAdminMethods>,
    family: string,
    meta: { userAgent?: string; ip?: string }
): Promise<TokenPair> {
    const { accessSecret } = assertAuthConfigured();

    const access = signJwt({ sub: admin.id, role: admin.role, type: "access" }, accessSecret, env.JWT_ACCESS_TTL_SECONDS);

    const refreshToken = generateOpaqueToken();
    const refreshTokenExpiresAt = new Date(Date.now() + env.JWT_REFRESH_TTL_SECONDS * 1000);

    await RefreshToken.create({
        admin: admin._id,
        tokenHash: hashToken(refreshToken),
        family,
        expiresAt: refreshTokenExpiresAt,
        userAgent: meta.userAgent?.slice(0, 512),
        ip: meta.ip?.slice(0, 64),
    });

    return {
        accessToken: access.token,
        accessTokenExpiresAt: new Date(access.exp * 1000),
        refreshToken,
        refreshTokenExpiresAt,
    };
}

/** Verifies username/password, applies lockout, and issues a fresh token pair (new rotation family). */
export async function login(
    username: string,
    password: string,
    meta: { userAgent?: string; ip?: string }
): Promise<{ tokens: TokenPair; admin: HydratedDocument<IAdmin, IAdminMethods> }> {
    assertAuthConfigured();

    const admin = await Admin.findOne({ username: username.toLowerCase() }).select("+passwordHash");
    if (!admin) {
        // Same error as a wrong password, and pay the same scrypt cost a real
        // comparison would - otherwise a nonexistent username returns faster
        // than a wrong password for a real one, and that timing gap alone
        // leaks which usernames exist.
        await Admin.hashPassword(password);
        throw new AppError("INVALID_CREDENTIALS", "Invalid username or password");
    }

    if (admin.lockedUntil && admin.lockedUntil.getTime() > Date.now()) {
        throw new AppError("ACCOUNT_LOCKED", "Account is temporarily locked due to repeated failed login attempts");
    }

    if (!admin.isActive) {
        throw new AppError("ACCOUNT_INACTIVE", "Account is disabled");
    }

    const valid = await admin.comparePassword(password);
    if (!valid) {
        admin.failedLoginAttempts += 1;
        if (admin.failedLoginAttempts >= env.ADMIN_LOGIN_MAX_ATTEMPTS) {
            admin.lockedUntil = new Date(Date.now() + env.ADMIN_LOGIN_LOCKOUT_MS);
            admin.failedLoginAttempts = 0;
            logger.warn("Admin account locked after repeated failed logins", { adminId: admin.id });
        }
        await admin.save();
        throw new AppError("INVALID_CREDENTIALS", "Invalid username or password");
    }

    admin.failedLoginAttempts = 0;
    admin.lockedUntil = undefined;
    admin.lastLoginAt = new Date();
    await admin.save();

    const family = randomBytes(16).toString("hex");
    const tokens = await issueTokenPair(admin, family, meta);

    return { tokens, admin };
}

/**
 * Rotates a refresh token: the presented token is marked revoked and a new
 * one is issued in the same family. If the presented token was already
 * revoked (reuse of a stolen/replayed token), the entire family is revoked
 * and the caller must log in again.
 */
export async function refresh(
    presentedToken: string,
    meta: { userAgent?: string; ip?: string }
): Promise<{ tokens: TokenPair; admin: HydratedDocument<IAdmin, IAdminMethods> }> {
    assertAuthConfigured();

    const tokenHash = hashToken(presentedToken);
    const stored = await RefreshToken.findOne({ tokenHash });

    if (!stored) {
        throw new AppError("INVALID_TOKEN", "Refresh token is invalid");
    }

    if (stored.revokedAt) {
        // Reuse of a token we already rotated away from - treat as compromise.
        await RefreshToken.updateMany({ family: stored.family, revokedAt: { $exists: false } }, { $set: { revokedAt: new Date() } });
        logger.warn("Refresh token reuse detected - revoking token family", { adminId: stored.admin.toString(), family: stored.family });
        throw new AppError("INVALID_TOKEN", "Refresh token has already been used - session revoked, please log in again");
    }

    if (stored.expiresAt.getTime() <= Date.now()) {
        throw new AppError("TOKEN_EXPIRED", "Refresh token has expired");
    }

    const admin = await Admin.findById(stored.admin);
    if (!admin || !admin.isActive) {
        throw new AppError("UNAUTHORIZED", "Account is no longer active");
    }

    const newTokens = await issueTokenPair(admin, stored.family, meta);

    stored.revokedAt = new Date();
    stored.replacedByTokenHash = hashToken(newTokens.refreshToken);
    await stored.save();

    return { tokens: newTokens, admin };
}

/** Revokes one refresh token (single-device logout) or every live token for the admin (logout everywhere). */
export async function logout(presentedToken: string, everywhere: boolean): Promise<void> {
    const tokenHash = hashToken(presentedToken);
    const stored = await RefreshToken.findOne({ tokenHash });
    if (!stored) return; // already invalid/unknown - logout is idempotent

    if (everywhere) {
        await RefreshToken.updateMany({ admin: stored.admin, revokedAt: { $exists: false } }, { $set: { revokedAt: new Date() } });
    } else if (!stored.revokedAt) {
        stored.revokedAt = new Date();
        await stored.save();
    }
}

/** Verifies an access token and returns its claims. Throws AppError on any failure. */
export function verifyAccessToken(token: string): JwtPayload {
    const { accessSecret } = assertAuthConfigured();
    try {
        const payload = verifyJwt(token, accessSecret);
        if (payload.type !== "access") {
            throw new AppError("INVALID_TOKEN", "Token is not an access token");
        }
        return payload;
    } catch (error) {
        if (error instanceof AppError) throw error;
        if (error instanceof JwtError) {
            throw new AppError(error.reason === "EXPIRED" ? "TOKEN_EXPIRED" : "INVALID_TOKEN", error.message);
        }
        throw new AppError("INVALID_TOKEN", "Failed to verify token");
    }
}