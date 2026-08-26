import { env } from "../config/env";
import { AppError } from "../utils/errors";

/**
 * Thin wrapper around the Cloudflare Realtime SFU "Connection API".
 * Docs: https://developers.cloudflare.com/realtime/sfu/https-api/
 *
 * The App Token must never reach the browser/app - every call to Cloudflare
 * goes through this server, which is exactly why the client talks to our
 * own /api/voice/* routes instead of rtc.live.cloudflare.com directly.
 */

export function isVoiceConfigured(): boolean {
    return Boolean(env.CLOUDFLARE_APP_ID && env.CLOUDFLARE_APP_TOKEN);
}

function assertConfigured(): void {
    if (!isVoiceConfigured()) {
        throw new AppError(
            "VOICE_NOT_CONFIGURED",
            "Voice chat is not configured on this server (missing CLOUDFLARE_APP_ID / CLOUDFLARE_APP_TOKEN)"
        );
    }
}

export interface SessionDescriptionInput {
    sdp: string;
    type: string;
}

// Without a bound, a hung Cloudflare API call would leave the corresponding
// player's request (session create/renegotiate/track update) pending
// indefinitely - it never resolves *or* rejects, so nothing times out
// upstream of it either.
const CALLS_API_TIMEOUT_MS = 10_000;

async function callsFetch(path: string, options: { method: string; body?: string }): Promise<Record<string, unknown>> {
    assertConfigured();

    let res: Response;
    try {
        res = await fetch(`${env.CLOUDFLARE_CALLS_API_BASE}/apps/${env.CLOUDFLARE_APP_ID}${path}`, {
            method: options.method,
            ...(options.body !== undefined ? { body: options.body } : {}),
            headers: {
                Authorization: `Bearer ${env.CLOUDFLARE_APP_TOKEN}`,
                "Content-Type": "application/json",
            },
            signal: AbortSignal.timeout(CALLS_API_TIMEOUT_MS),
        });
    } catch (error) {
        const name = error instanceof Error ? error.name : "";
        if (name === "TimeoutError" || name === "AbortError") {
            throw new AppError("VOICE_UPSTREAM_ERROR", "Cloudflare Calls API did not respond in time");
        }
        const message = error instanceof Error ? error.message : "Unknown error";
        throw new AppError("VOICE_UPSTREAM_ERROR", `Failed to reach Cloudflare Calls API: ${message}`);
    }

    const text = await res.text();
    let data: Record<string, unknown>;
    try {
        data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
        data = { raw: text };
    }

    if (!res.ok) {
        const message =
            (typeof data.errorDescription === "string" && data.errorDescription) ||
            (typeof data.error === "string" && data.error) ||
            `Cloudflare Calls API error (${res.status})`;
        throw new AppError("VOICE_UPSTREAM_ERROR", message);
    }

    return data;
}

/** Creates a brand new WebRTC session on Cloudflare's SFU - one per participant. */
export function createSession(sessionDescription?: SessionDescriptionInput): Promise<Record<string, unknown>> {
    const body = sessionDescription ? { sessionDescription } : {};
    return callsFetch("/sessions/new", { method: "POST", body: JSON.stringify(body) });
}

/** Push a local track (e.g. mic) or pull a remote track (someone else's mic) into/out of a session. */
export function addTracks(sessionId: string, body: unknown): Promise<Record<string, unknown>> {
    return callsFetch(`/sessions/${encodeURIComponent(sessionId)}/tracks/new`, {
        method: "POST",
        body: JSON.stringify(body),
    });
}

/** Completes a renegotiation started by addTracks when it responds with requiresImmediateRenegotiation: true. */
export function renegotiate(sessionId: string, sessionDescription: SessionDescriptionInput): Promise<Record<string, unknown>> {
    return callsFetch(`/sessions/${encodeURIComponent(sessionId)}/renegotiate`, {
        method: "PUT",
        body: JSON.stringify({ sessionDescription }),
    });
}

/** Closes one or more tracks (participant left, or someone stopped listening to them). */
export function closeTracks(sessionId: string, body: unknown): Promise<Record<string, unknown>> {
    return callsFetch(`/sessions/${encodeURIComponent(sessionId)}/tracks/close`, {
        method: "PUT",
        body: JSON.stringify(body),
    });
}

export function getSession(sessionId: string): Promise<Record<string, unknown>> {
    return callsFetch(`/sessions/${encodeURIComponent(sessionId)}`, { method: "GET" });
}