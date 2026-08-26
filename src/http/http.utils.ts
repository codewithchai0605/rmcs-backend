import { gzipSync } from "node:zlib";
import { env } from "../config/env";
import { isOriginAllowed } from "../utils/net";
import { AppError, type ErrorCode } from "../utils/errors";

/**
 * Small Bun.serve() response helpers shared by every HTTP route file.
 *
 * This is the one part of the port that changes shape rather than just
 * renaming things: uWS required every write to happen inside `res.cork()`,
 * with body reads streamed manually via `res.onData`/`res.onAborted`. Bun's
 * `fetch(req)` handlers just return a `Response` (or `Promise<Response>`),
 * so all of that goes away - these helpers now *build and return* a
 * Response instead of writing into a mutable `res` object. Route/status
 * shapes, header names, and error bodies are kept byte-for-byte identical
 * to the previous version so existing frontend error handling doesn't need
 * to change.
 */

/** Returns the CORS headers to attach, or {} if the origin isn't allowed (matches the old writeCors: no headers = browser blocks reading the response). */
export function corsHeaders(origin: string | null): HeadersInit {
    if (!isOriginAllowed(origin)) return {};
    return {
        "Access-Control-Allow-Origin": env.ALLOWED_ORIGINS.includes("*") ? "*" : (origin as string),
        Vary: "Origin",
    };
}

function parseStatusLine(status: string): { code: number; statusText: string } {
    const spaceIndex = status.indexOf(" ");
    if (spaceIndex === -1) return { code: Number(status) || 500, statusText: "" };
    return { code: Number(status.slice(0, spaceIndex)) || 500, statusText: status.slice(spaceIndex + 1) };
}

/** status is a "CODE Reason" string (e.g. "200 OK") - kept in that shape so statusForErrorCode below didn't need to change. */
export function jsonResponse(status: string, body: unknown, extraHeaders?: HeadersInit): Response {
    const { code, statusText } = parseStatusLine(status);
    return new Response(JSON.stringify(body), {
        status: code,
        statusText,
        headers: { "Content-Type": "application/json", ...extraHeaders },
    });
}

// Below this size gzip's ~20-byte header/footer plus CPU cost isn't worth
// it - most admin payloads (login response, /admin/auth/me) are small and
// go through plain jsonResponse above. This is only used for the handful of
// admin GET routes that can return a real amount of JSON (usage series,
// live stats) - see http/admin.routes.ts.
const GZIP_MIN_BYTES = 860;

/** Like jsonResponse, but gzip-compresses the body when the client advertises support for it via Accept-Encoding and the payload is large enough to benefit. */
export function jsonResponseCompressed(status: string, body: unknown, acceptEncoding: string | null, extraHeaders?: HeadersInit): Response {
    const json = JSON.stringify(body);
    const canGzip = Boolean(acceptEncoding && /\bgzip\b/i.test(acceptEncoding)) && Buffer.byteLength(json) >= GZIP_MIN_BYTES;
    const { code, statusText } = parseStatusLine(status);

    const headers: HeadersInit = { "Content-Type": "application/json", Vary: "Accept-Encoding", ...extraHeaders };
    if (canGzip) {
        return new Response(gzipSync(json), { status: code, statusText, headers: { ...headers, "Content-Encoding": "gzip" } });
    }
    return new Response(json, { status: code, statusText, headers });
}

const MAX_JSON_BODY_BYTES = 1024 * 1024; // 1 MiB - generous for admin login/refresh payloads, cheap DoS guard

/**
 * Reads a request body and parses it as JSON, capped at MAX_JSON_BODY_BYTES.
 * Mirrors the old uWS readJsonBody's semantics exactly: empty body -> {},
 * oversized body -> AppError("VALIDATION_ERROR"), invalid JSON ->
 * AppError("INVALID_MESSAGE"). Stops accumulating chunks as soon as the cap
 * is exceeded (still drains the stream so the connection closes cleanly)
 * rather than buffering an unbounded body before rejecting it.
 */
export async function readJsonBody(req: Request): Promise<unknown> {
    if (!req.body) return {};

    const reader = req.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    let oversized = false;

    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (oversized) continue;

            total += value.byteLength;
            if (total > MAX_JSON_BODY_BYTES) {
                oversized = true;
                chunks.length = 0;
                continue;
            }
            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
    }

    if (oversized) {
        throw new AppError("VALIDATION_ERROR", "Request body too large");
    }
    if (total === 0) {
        return {};
    }

    const text = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf-8");
    try {
        return JSON.parse(text);
    } catch {
        throw new AppError("INVALID_MESSAGE", "Request body must be valid JSON");
    }
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

/** Builds an AppError response as JSON with the appropriate status - never leaks internal error details. */
export function appErrorResponse(origin: string | null, error: AppError): Response {
    return jsonResponse(statusForErrorCode(error.code), { error: error.message, code: error.code }, corsHeaders(origin));
}

export function getBearerToken(req: Request): string | null {
    const header = req.headers.get("authorization");
    if (!header || !header.toLowerCase().startsWith("bearer ")) return null;
    const token = header.slice(7).trim();
    return token.length > 0 ? token : null;
}
