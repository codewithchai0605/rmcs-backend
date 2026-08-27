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

// --- TURN (ICE fallback for restrictive networks) --------------------------

/** Cloudflare's public STUN server - always available, no credentials needed. Used whenever TURN isn't configured, or its request fails. */
const DEFAULT_STUN_ICE_SERVERS: Array<Record<string, unknown>> = [{ urls: ["stun:stun.cloudflare.com:3478"] }];

// Cloudflare's TURN credentials endpoint returns short-lived username/password
// pairs, not a permanent secret - safe to hand straight to the client. 24h
// mirrors Cloudflare's own recommended default (longer than any single call
// should last, short enough that a leaked credential doesn't linger).
const TURN_CREDENTIAL_TTL_S = 86_400;

// --- Metered Open Relay (second, independent TURN provider) ----------------

/**
 * Builds ICE server entries for Metered's Open Relay TURN service - see the
 * METERED_TURN_* comment in config/env.ts for why this exists alongside
 * Cloudflare's TURN rather than instead of it. Each configured account
 * contributes its own username/credential against the same shared Metered
 * URLs (the URLs themselves don't vary per account); the STUN entry is
 * added once regardless of how many accounts are configured, since it
 * doesn't need credentials at all.
 */
function meteredIceServers(): Array<Record<string, unknown>> {
    const accounts: Array<{ username: string; credential: string }> = [];
    if (env.METERED_TURN_USERNAME_1 && env.METERED_TURN_CREDENTIAL_1) {
        accounts.push({ username: env.METERED_TURN_USERNAME_1, credential: env.METERED_TURN_CREDENTIAL_1 });
    }
    if (env.METERED_TURN_USERNAME_2 && env.METERED_TURN_CREDENTIAL_2) {
        accounts.push({ username: env.METERED_TURN_USERNAME_2, credential: env.METERED_TURN_CREDENTIAL_2 });
    }
    if (accounts.length === 0) return [];

    const servers: Array<Record<string, unknown>> = [{ urls: ["stun:stun.relay.metered.ca:80"] }];
    for (const { username, credential } of accounts) {
        servers.push(
            { urls: "turn:global.relay.metered.ca:80", username, credential },
            { urls: "turn:global.relay.metered.ca:80?transport=tcp", username, credential },
            { urls: "turn:global.relay.metered.ca:443", username, credential },
            { urls: "turns:global.relay.metered.ca:443?transport=tcp", username, credential }
        );
    }
    return servers;
}

/**
 * Returns the ICE server list a client should use when creating its
 * RTCPeerConnection: Cloudflare's TURN service (which itself includes STUN
 * entries) when a TURN key is configured, otherwise just the public STUN
 * server - plus, either way, Metered's Open Relay entries appended if any
 * accounts are configured (see meteredIceServers above). Never throws -
 * TURN is a NAT-traversal fallback, not a requirement, so any failure here
 * just means "fewer fallback paths for this join" rather than "voice is
 * broken".
 *
 * NOTE: this only returns Cloudflare + Metered ICE servers. Any traffic
 * that ends up relayed through Metered instead of Cloudflare is invisible
 * to the usage tracking in models/report.model.ts - that only queries
 * Cloudflare's own callsTurnUsageAdaptiveGroups dataset, which has no
 * knowledge of a different provider's relay traffic. Metered has its own
 * dashboard/usage API for that if it's ever needed.
 */
export async function getTurnIceServers(): Promise<Array<Record<string, unknown>>> {
    const extra = meteredIceServers();

    if (!env.TURN_SERVICE_ID || !env.TURN_SERVICE_TOKEN) {
        return [...DEFAULT_STUN_ICE_SERVERS, ...extra];
    }

    try {
        const res = await fetch(
            `${env.CLOUDFLARE_CALLS_API_BASE}/turn/keys/${encodeURIComponent(env.TURN_SERVICE_ID)}/credentials/generate-ice-servers`,
            {
                method: "POST",
                body: JSON.stringify({ ttl: TURN_CREDENTIAL_TTL_S }),
                headers: {
                    Authorization: `Bearer ${env.TURN_SERVICE_TOKEN}`,
                    "Content-Type": "application/json",
                },
                signal: AbortSignal.timeout(CALLS_API_TIMEOUT_MS),
            }
        );

        if (!res.ok) {
            throw new Error(`TURN credentials request failed (${res.status})`);
        }

        const data = (await res.json()) as { iceServers?: Array<Record<string, unknown>> };
        const cloudflareServers = data.iceServers && data.iceServers.length > 0 ? data.iceServers : DEFAULT_STUN_ICE_SERVERS;
        return [...cloudflareServers, ...extra];
    } catch (error) {
        console.error("Failed to fetch Cloudflare TURN credentials, falling back to STUN-only:", error);
        return [...DEFAULT_STUN_ICE_SERVERS, ...extra];
    }
}