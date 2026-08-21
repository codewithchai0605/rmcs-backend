import { rateLimiter } from "./rateLimiter";

const HTTP_LIMIT = 60;
const HTTP_WINDOW_MS = 60_000;

/** Returns true if the request is allowed. */
export function allowHttpRequest(ip: string, route: string): boolean {
  return rateLimiter.allow(ip, `http:${route}`, HTTP_LIMIT, HTTP_WINDOW_MS);
}
