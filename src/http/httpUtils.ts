import type { HttpRequest, HttpResponse } from "uWebSockets.js";
import { env } from "../config/env.js";
import { isOriginAllowed } from "../core/net.js";
import { AppError, type ErrorCode } from "../core/errors.js";

/**
 * Small uWebSockets response helpers shared by every HTTP route file.
 * Pulled out of http/routes.ts (which originally defined these privately)
 * so http/adminRoutes.ts can reuse the exact same request/response handling
 * instead of duplicating it - see that file's registerAdminRoutes().
 */

export function writeCors(res: HttpResponse, origin: string): void {
    if (isOriginAllowed(origin)) {
        res.writeHeader("Access-Control-Allow-Origin", env.ALLOWED_ORIGINS.includes("*") ? "*" : origin);
        res.writeHeader("Vary", "Origin");
    }
}

export function writeJson(res: HttpResponse, status: string, body: unknown): void {
    res.cork(() => {
        res.writeStatus(status).writeHeader("Content-Type", "application/json").end(JSON.stringify(body));
    });
}

/** Reads and discards the request body (for routes that don't need it, e.g. GETs with unexpected bodies). */
export function drainBody(res: HttpResponse): void {
    res.onData(() => { });
    res.onAborted(() => { });
}

const MAX_JSON_BODY_BYTES = 1024 * 1024; // 1 MiB - generous for admin login/refresh payloads, cheap DoS guard

/**
 * Reads a full request body and parses it as JSON. Follows the standard
 * uWS pattern: each chunk's backing ArrayBuffer is only valid for the
 * duration of this synchronous callback, so it's copied into a Buffer via
 * Buffer.concat (which copies) before returning, rather than held onto
 * directly. Must be called with `res.onAborted` already registered by the
 * caller - see the routes below.
 */
export function readJsonBody(res: HttpResponse): Promise<unknown> {
    return new Promise((resolve, reject) => {
        let buffer: Buffer | undefined;

        res.onData((chunk, isLast) => {
            const piece = Buffer.from(chunk);
            buffer = buffer ? Buffer.concat([buffer, piece]) : Buffer.concat([piece]);

            if (buffer.length > MAX_JSON_BODY_BYTES) {
                reject(new AppError("VALIDATION_ERROR", "Request body too large"));
                return;
            }

            if (isLast) {
                if (buffer.length === 0) {
                    resolve({});
                    return;
                }
                try {
                    resolve(JSON.parse(buffer.toString("utf-8")));
                } catch {
                    reject(new AppError("INVALID_MESSAGE", "Request body must be valid JSON"));
                }
            }
        });
    });
}

/** Maps an AppError's code to an HTTP status line. Extend here as new ErrorCodes are added. */
export function statusForErrorCode(code: ErrorCode): string {
    switch (code) {
        case "VOICE_NOT_CONFIGURED":
        case "AUTH_NOT_CONFIGURED":
            return "503 Service Unavailable";
        case "VOICE_UPSTREAM_ERROR":
            return "502 Bad Gateway";
        case "RATE_LIMITED":
            return "429 Too Many Requests";
        case "INVALID_MESSAGE":
        case "VALIDATION_ERROR":
            return "400 Bad Request";
        case "UNAUTHORIZED":
        case "INVALID_CREDENTIALS":
        case "INVALID_TOKEN":
        case "TOKEN_EXPIRED":
        case "NOT_AUTHENTICATED":
            return "401 Unauthorized";
        case "FORBIDDEN":
        case "ACCOUNT_LOCKED":
        case "ACCOUNT_INACTIVE":
            return "403 Forbidden";
        case "NOT_FOUND":
        case "ROOM_NOT_FOUND":
            return "404 Not Found";
        case "CONFLICT":
            return "409 Conflict";
        default:
            return "500 Internal Server Error";
    }
}

/** Sends an AppError as JSON with the appropriate status - never leaks internal error details. */
export function writeAppError(res: HttpResponse, origin: string, error: AppError): void {
    writeCors(res, origin);
    writeJson(res, statusForErrorCode(error.code), { error: error.message, code: error.code });
}

export function getBearerToken(req: HttpRequest): string | null {
    const header = req.getHeader("authorization");
    if (!header || !header.toLowerCase().startsWith("bearer ")) return null;
    const token = header.slice(7).trim();
    return token.length > 0 ? token : null;
}