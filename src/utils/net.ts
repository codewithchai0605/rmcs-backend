import { env } from "../config/env";
import type { App } from "../websocket/types";

export function isOriginAllowed(origin: string | null): boolean {
  if (env.ALLOWED_ORIGINS.includes("*")) return true;
  if (!origin) return false;
  return env.ALLOWED_ORIGINS.includes(origin);
}

/**
 * Extracts the client IP.
 *
 * IMPORTANT BEHAVIOUR CHANGE from the uWS version: the old `TRUST_PROXY_HEADERS`
 * path called uWS's `getProxiedRemoteAddressAsText()`, which decodes an actual
 * PROXY protocol v1/v2 preamble sent by whatever sits in front of this server.
 * Bun.serve() has no built-in PROXY protocol support (still an open feature
 * request upstream as of Bun 1.4), so that exact behaviour can't be carried
 * over as-is.
 *
 * This reads `X-Forwarded-For` instead, which is what most HTTP-level reverse
 * proxies (nginx, most load balancers, Cloudflare) set - it is NOT equivalent
 * to PROXY protocol decoding. If whatever is in front of this server actually
 * speaks PROXY protocol (rather than terminating HTTP and adding this header),
 * this will silently fall back to the raw TCP peer address instead. Verify
 * this against your actual deployment before relying on it for rate limiting.
 */
export function getClientIp(req: Request, server: App): string {
  if (env.TRUST_PROXY_HEADERS) {
    const forwardedFor = req.headers.get("x-forwarded-for");
    const first = forwardedFor?.split(",")[0]?.trim();
    if (first) return first;
  }

  const address = server.requestIP(req);
  return address?.address ?? "unknown";
}
