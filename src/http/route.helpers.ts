import type { BunRequest } from "bun";
import type { App } from "../websocket/types";
import { corsHeaders, jsonResponse } from "./http.utils";

/**
 * uWS registered each path/method combination as its own handler
 * (app.get/app.post/...), with a single global app.options("/*") for CORS
 * preflight and a single global app.any("/*") 404 catch-all beneath
 * everything else. Bun.serve()'s `routes` object matches by path only (one
 * handler per path, not per method+path), so this wrapper restores the old
 * per-method behaviour: OPTIONS always gets the preflight response, a verb
 * other than the one the route expects gets the same 404 the old catch-all
 * produced, and only a matching verb reaches the real handler.
 */
export function route<const Path extends string>(
  method: string,
  handler: (req: BunRequest<Path>, server: App) => Promise<Response> | Response
): (req: BunRequest<Path>, server: App) => Promise<Response> | Response {
  return (req, server) => {
    if (req.method === "OPTIONS") return preflightResponse(req);
    if (req.method !== method) return notFoundResponse();
    return handler(req, server);
  };
}

/** Mirrors the old global app.options("/*") handler. */
export function preflightResponse(req: Request): Response {
  const origin = req.headers.get("origin");
  return new Response(null, {
    status: 204,
    headers: {
      ...corsHeaders(origin),
      "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Session-Token, Authorization",
    },
  });
}

/** Mirrors the old global app.any("/*") 404 catch-all - deliberately has no CORS headers, same as before. */
export function notFoundResponse(): Response {
  return jsonResponse("404 Not Found", { error: "Not found" });
}
