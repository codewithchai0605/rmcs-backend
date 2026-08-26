import { randomBytes, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from "node:crypto";

/**
 * Password hashing via Node's built-in scrypt (no bcrypt/argon2 dependency
 * needed - same "avoid extra deps" approach the codebase already takes for
 * .env loading, see config/env.ts). Encoded as a self-describing string so
 * cost parameters can change later without invalidating existing hashes:
 *
 *   scrypt:N:r:p:<saltHex>:<hashHex>
 */

// Hand-rolled instead of promisify(scrypt) - scrypt's overloads (with/without
// an options object) make promisify's inferred signature ambiguous.
function scrypt(password: string, salt: Buffer, keylen: number, options: ScryptOptions): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        scryptCallback(password, salt, keylen, options, (err, derivedKey) => {
            if (err) reject(err);
            else resolve(derivedKey);
        });
    });
}

const SCRYPT_N = 16384; // CPU/memory cost, must be a power of 2
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;
const SALT_BYTES = 16;

export async function hashPassword(plain: string): Promise<string> {
    const salt = randomBytes(SALT_BYTES);
    const derivedKey = await scrypt(plain.normalize("NFKC"), salt, KEY_LENGTH, {
        N: SCRYPT_N,
        r: SCRYPT_R,
        p: SCRYPT_P,
        maxmem: 128 * SCRYPT_N * SCRYPT_R * 2,
    });

    return `scrypt:${SCRYPT_N}:${SCRYPT_R}:${SCRYPT_P}:${salt.toString("hex")}:${derivedKey.toString("hex")}`;
}

export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
    const parts = stored.split(":");
    if (parts.length !== 6 || parts[0] !== "scrypt") return false;

    const [, nStr, rStr, pStr, saltHex, hashHex] = parts;
    const N = Number(nStr);
    const r = Number(rStr);
    const p = Number(pStr);
    if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;

    let salt: Buffer;
    let expected: Buffer;
    try {
        salt = Buffer.from(saltHex!, "hex");
        expected = Buffer.from(hashHex!, "hex");
    } catch {
        return false;
    }
    if (salt.length === 0 || expected.length === 0) return false;

    const derivedKey = await scrypt(plain.normalize("NFKC"), salt, expected.length, {
        N,
        r,
        p,
        maxmem: 128 * N * r * 2,
    });

    if (derivedKey.length !== expected.length) return false;
    return timingSafeEqual(derivedKey, expected);
}

/** Constant-time string compare for opaque tokens/secrets of possibly-different length. */
export function safeEqual(a: string, b: string): boolean {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) {
        // Still run a comparison of equal-length buffers so the failure path
        // takes comparable time regardless of length mismatch.
        timingSafeEqual(bufA, bufA);
        return false;
    }
    return timingSafeEqual(bufA, bufB);
}