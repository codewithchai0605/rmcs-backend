import type { HttpRequest } from "uWebSockets.js";
import { AppError } from "../core/errors";
import { getBearerToken } from "../http/httpUtils";
import { verifyAccessToken } from "../services/adminAuth.service";
import type { AdminRole } from "../models/admin.model";

/**
 * uWS has no Express-style middleware chain, so - matching the existing
 * `requireLiveSession` / `requireAdmin` pattern already used inline in
 * http/routes.ts - this is a plain function each protected route calls at
 * the top of its handler, before doing any work or touching the DB.
 */

export interface AdminAuthContext {
    adminId: string;
    role: AdminRole;
}

/** Throws AppError("UNAUTHORIZED"/"INVALID_TOKEN"/"TOKEN_EXPIRED") if the request isn't a valid admin access token. */
export function authenticateAdmin(req: HttpRequest): AdminAuthContext {
    const token = getBearerToken(req);
    if (!token) {
        throw new AppError("UNAUTHORIZED", "Missing bearer access token");
    }

    const payload = verifyAccessToken(token);
    return { adminId: payload.sub, role: payload.role as AdminRole };
}

/** Throws AppError("FORBIDDEN") if the authenticated admin's role isn't in `allowed`. */
export function requireRole(context: AdminAuthContext, allowed: readonly AdminRole[]): void {
    if (!allowed.includes(context.role)) {
        throw new AppError("FORBIDDEN", `This action requires one of the following roles: ${allowed.join(", ")}`);
    }
}