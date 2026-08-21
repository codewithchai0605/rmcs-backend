import type { HttpRequest, HttpResponse } from "uWebSockets.js";
import { env } from "../config/env";

export function isOriginAllowed(origin: string): boolean {
  if (env.ALLOWED_ORIGINS.includes("*")) return true;
  if (!origin) return false;
  return env.ALLOWED_ORIGINS.includes(origin);
}

function bufferToIp(buffer: ArrayBuffer): string {
  if (buffer.byteLength === 4) {
    return new Uint8Array(buffer).join(".");
  }
  if (buffer.byteLength === 16) {
    const bytes = new Uint8Array(buffer);
    const parts: string[] = [];
    for (let i = 0; i < 16; i += 2) {
      const high = bytes[i] ?? 0;
      const low = bytes[i + 1] ?? 0;
      parts.push(((high << 8) | low).toString(16));
    }
    return parts.join(":");
  }
  return "unknown";
}

/** Extracts the client IP, honouring the PROXY protocol header when TRUST_PROXY_HEADERS is enabled. */
export function getClientIp(res: HttpResponse, _req: HttpRequest): string {
  try {
    const buffer = env.TRUST_PROXY_HEADERS ? res.getProxiedRemoteAddressAsText() : res.getRemoteAddressAsText();
    const text = Buffer.from(buffer).toString("utf-8");
    if (text) return text;
  } catch {
    // fall through to binary fallback below
  }

  try {
    const buffer = res.getRemoteAddress();
    return bufferToIp(buffer);
  } catch {
    return "unknown";
  }
}
