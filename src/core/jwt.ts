import { createHmac, randomUUID } from "node:crypto";
import { safeEqual } from "./password";

/**
 * Minimal, dependency-free HS256 JWT implementation (same rationale as
 * core/password.ts - the codebase already avoids adding packages like
 * `dotenv` for things Node's stdlib can do, see config/env.ts). Produces and
 * verifies standard-shaped JWTs (header.payload.signature, base64url), so
 * any standard JWT tooling on the frontend can still decode them - only
 * signing/verifying is hand-rolled.
 */

export interface JwtPayload {
    sub: string; // admin id
    role: string;
    type: "access" | "refresh";
    jti: string;
    iat: number;
    exp: number;
    [key: string]: unknown;
}

const HEADER = base64UrlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));

function base64UrlEncode(input: string | Buffer): string {
    return Buffer.from(input).toString("base64url");
}

function base64UrlDecode(input: string): Buffer {
    return Buffer.from(input, "base64url");
}

export class JwtError extends Error {
    readonly reason: "MALFORMED" | "BAD_SIGNATURE" | "EXPIRED";
    constructor(reason: "MALFORMED" | "BAD_SIGNATURE" | "EXPIRED", message: string) {
        super(message);
        this.name = "JwtError";
        this.reason = reason;
    }
}

export function signJwt(
    claims: Pick<JwtPayload, "sub" | "role" | "type"> & Record<string, unknown>,
    secret: string,
    expiresInSeconds: number
): { token: string; jti: string; iat: number; exp: number } {
    const iat = Math.floor(Date.now() / 1000);
    const exp = iat + expiresInSeconds;
    const jti = randomUUID();

    const payload: JwtPayload = { ...claims, jti, iat, exp };
    const encodedPayload = base64UrlEncode(JSON.stringify(payload));
    const signingInput = `${HEADER}.${encodedPayload}`;
    const signature = createHmac("sha256", secret).update(signingInput).digest("base64url");

    return { token: `${signingInput}.${signature}`, jti, iat, exp };
}

export function verifyJwt(token: string, secret: string): JwtPayload {
    if (typeof token !== "string" || token.length === 0) {
        throw new JwtError("MALFORMED", "Token is empty");
    }

    const parts = token.split(".");
    if (parts.length !== 3) {
        throw new JwtError("MALFORMED", "Token is not a valid JWT");
    }
    const [encodedHeader, encodedPayload, signature] = parts;

    const signingInput = `${encodedHeader}.${encodedPayload}`;
    const expectedSignature = createHmac("sha256", secret).update(signingInput).digest("base64url");

    if (!safeEqual(signature!, expectedSignature)) {
        throw new JwtError("BAD_SIGNATURE", "Token signature is invalid");
    }

    let payload: JwtPayload;
    try {
        payload = JSON.parse(base64UrlDecode(encodedPayload!).toString("utf-8")) as JwtPayload;
    } catch {
        throw new JwtError("MALFORMED", "Token payload is not valid JSON");
    }

    if (typeof payload.exp !== "number" || Math.floor(Date.now() / 1000) >= payload.exp) {
        throw new JwtError("EXPIRED", "Token has expired");
    }

    return payload;
}