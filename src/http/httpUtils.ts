import type { HttpRequest, HttpResponse } from "uWebSockets.js";
import { gzipSync } from "node:zlib";
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
    // Route handlers frequently call this after an async body/service
    // operation. uWebSockets requires every response write (including
    // headers) to be made inside a cork callback in that case.
    res.cork(() => {
        if (isOriginAllowed(origin)) {
            res.writeHeader("Access-Control-Allow-Origin", env.ALLOWED_ORIGINS.includes("*") ? "*" : origin);
            res.writeHeader("Vary", "Origin");
        }
    });
}

export function writeJson(res: HttpResponse, status: string, body: unknown): void {
    res.cork(() => {
        res.writeStatus(status).writeHeader("Content-Type", "application/json").end(JSON.stringify(body));
    });
}

// Below this size gzip's ~20-byte header/footer plus CPU cost isn't worth
// it - most admin payloads (login response, /admin/auth/me) are small and
// go through plain writeJson above. This is only used for the handful of
// admin GET routes that can return a real amount of JSON (usage series,
// live stats) - see http/adminRoutes.ts.
const GZIP_MIN_BYTES = 860;

/**
 * Like writeJson, but gzip-compresses the body when the client advertises
 * support for it via Accept-Encoding and the payload is large enough to
 * benefit. `acceptEncoding` must be read from the request synchronously by
 * the caller (req is only valid for the synchronous duration of a uWS route
 * handler - see readJsonBody's doc comment above - so it can't be read
 * again after an `await`).
 */
export function writeJsonCompressed(res: HttpResponse, status: string, body: unknown, acceptEncoding: string | null): void {
    const json = JSON.stringify(body);
    const canGzip = Boolean(acceptEncoding && /\bgzip\b/i.test(acceptEncoding)) && Buffer.byteLength(json) >= GZIP_MIN_BYTES;

    res.cork(() => {
        res.writeStatus(status).writeHeader("Content-Type", "application/json").writeHeader("Vary", "Accept-Encoding");
        if (canGzip) {
            res.writeHeader("Content-Encoding", "gzip").end(gzipSync(json));
        } else {
            res.end(json);
        }
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
        // Once the body has exceeded the cap we stop accumulating entirely -
        // further chunks are dropped instead of being Buffer.concat'd onto an
        // already-oversized buffer. Without this a slow/large body keeps
        // growing (and re-copying, an O(n^2) cost) in memory until isLast,
        // even though the outcome (reject) was already decided.
        let oversized = false;

        res.onData((chunk, isLast) => {
            if (oversized) return;

            const piece = Buffer.from(chunk);
            buffer = buffer ? Buffer.concat([buffer, piece]) : Buffer.concat([piece]);

            if (buffer.length > MAX_JSON_BODY_BYTES) {
                oversized = true;
                buffer = undefined; // release what we'd buffered so far - nothing more will be added to it
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
