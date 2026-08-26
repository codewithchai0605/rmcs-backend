import type { BunRequest } from "bun";
import { getClientIp } from "../utils/net";
import { allowHttpRequest } from "../middleware/http.rate.limiter";
import { connectionLimiter } from "../middleware/connection.limiter";
import { roomManager } from "../game/room.manager";
import { sessionRegistry } from "../websocket/session.registry";
import { normalizeRoomCode } from "../utils/sanitize";
import { AppError, toAppError } from "../utils/errors";
import * as voiceCalls from "../voice/cloudflare.calls";
import type { App } from "../websocket/types";
import { buildAdminRoutes } from "./admin.routes";
import { corsHeaders, jsonResponse, readJsonBody, statusForErrorCode } from "./http.utils";
import { getShowSupport } from "./support.state";
import { route, notFoundResponse } from "./route.helpers";
import { formatBytes } from "../utils/format";

export { showSupport } from "./support.state";

const startedAt = Date.now();

const statusForError = (appError: AppError): string => statusForErrorCode(appError.code);

function requireLiveSession(req: Request): boolean {
  const token = req.headers.get("x-session-token");
  return Boolean(token && sessionRegistry.getByToken(token)?.connected);
}

/** Every /api/voice/* route's error branch intentionally omits CORS headers, matching the original - see the migration notes. */
function voiceErrorResponse(appError: AppError): Response {
  return jsonResponse(statusForError(appError), { error: appError.message, code: appError.code });
}

async function handleRoot(): Promise<Response> {
  return jsonResponse("200 OK", "Hello World", corsHeaders("*"));
}

async function handleHealth(req: BunRequest<string>, server: App): Promise<Response> {
  const origin = req.headers.get("origin");
  const ip = getClientIp(req, server);

  if (!allowHttpRequest(ip, "health")) {
    return jsonResponse("429 Too Many Requests", { error: "Rate limited" });
  }

  const mem = process.memoryUsage();
  const body = {
    status: "ok",
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    rooms: roomManager.getStats(),
    sessions: sessionRegistry.stats(),
    connections: { total: connectionLimiter.totalConnections() },
    memory: {
      rss: formatBytes(mem.rss),
      heapTotal: formatBytes(mem.heapTotal),
      heapUsed: formatBytes(mem.heapUsed),
      external: formatBytes(mem.external),
      arrayBuffers: formatBytes(mem.arrayBuffers),
    },
  };

  return jsonResponse("200 OK", body, corsHeaders(origin));
}

async function handleShowSupport(req: BunRequest<string>, server: App): Promise<Response> {
  const origin = req.headers.get("origin");
  const ip = getClientIp(req, server);

  if (!allowHttpRequest(ip, "show-support")) {
    return jsonResponse("429 Too Many Requests", { error: "Rate limited" });
  }

  return jsonResponse("200 OK", { show: getShowSupport() }, corsHeaders(origin));
}

// Lets the frontend check a private room code exists (and whether it needs a
// password) before attempting to open a WebSocket connection to join it.
async function handleRoomPreview(req: BunRequest<"/api/rooms/:code">, server: App): Promise<Response> {
  const origin = req.headers.get("origin");
  const ip = getClientIp(req, server);

  if (!allowHttpRequest(ip, "room-preview")) {
    return jsonResponse("429 Too Many Requests", { error: "Rate limited" });
  }

  const code = normalizeRoomCode(req.params.code);
  const preview = roomManager.getRoomPreview(code);

  if (!preview) {
    return jsonResponse("404 Not Found", { error: "Room not found" }, corsHeaders(origin));
  }
  return jsonResponse("200 OK", preview, corsHeaders(origin));
}

// --- Voice chat (Cloudflare Calls proxy) -----------------------------------
// These just forward to Cloudflare's Connection API with our App Secret
// attached server-side - the secret must never reach the client. Each route
// requires the caller be a live, known session (checked via sessionRegistry)
// so a random unauthenticated request can't run up our Cloudflare bill;
// genuine gameplay auth still doesn't exist, but this at least ties usage to
// an active connection to this server.

async function handleVoiceSession(req: BunRequest<string>, server: App): Promise<Response> {
  const origin = req.headers.get("origin");
  const ip = getClientIp(req, server);
  const authorized = requireLiveSession(req);

  if (!allowHttpRequest(ip, "voice-session")) {
    return jsonResponse("429 Too Many Requests", { error: "Rate limited" });
  }
  if (!authorized) {
    return jsonResponse("401 Unauthorized", { error: "Missing or invalid session" });
  }

  try {
    const body = await readJsonBody(req);
    const data = await voiceCalls.createSession((body as { sessionDescription?: voiceCalls.SessionDescriptionInput })?.sessionDescription);
    return jsonResponse("200 OK", data, corsHeaders(origin));
  } catch (error) {
    return voiceErrorResponse(toAppError(error));
  }
}

async function handleVoiceTracks(req: BunRequest<"/api/voice/session/:sessionId/tracks">, server: App): Promise<Response> {
  const origin = req.headers.get("origin");
  const ip = getClientIp(req, server);
  const authorized = requireLiveSession(req);
  const sessionId = req.params.sessionId;

  if (!sessionId) {
    return jsonResponse("400 Bad Request", { error: "Missing sessionId" });
  }
  if (!allowHttpRequest(ip, "voice-tracks")) {
    return jsonResponse("429 Too Many Requests", { error: "Rate limited" });
  }
  if (!authorized) {
    return jsonResponse("401 Unauthorized", { error: "Missing or invalid session" });
  }

  try {
    const body = await readJsonBody(req);
    const data = await voiceCalls.addTracks(sessionId, body);
    return jsonResponse("200 OK", data, corsHeaders(origin));
  } catch (error) {
    return voiceErrorResponse(toAppError(error));
  }
}

async function handleVoiceRenegotiate(req: BunRequest<"/api/voice/session/:sessionId/renegotiate">, server: App): Promise<Response> {
  const origin = req.headers.get("origin");
  const ip = getClientIp(req, server);
  const authorized = requireLiveSession(req);
  const sessionId = req.params.sessionId;

  if (!sessionId) {
    return jsonResponse("400 Bad Request", { error: "Missing sessionId" });
  }
  if (!allowHttpRequest(ip, "voice-renegotiate")) {
    return jsonResponse("429 Too Many Requests", { error: "Rate limited" });
  }
  if (!authorized) {
    return jsonResponse("401 Unauthorized", { error: "Missing or invalid session" });
  }

  try {
    const body = await readJsonBody(req);
    const sd = (body as { sessionDescription?: voiceCalls.SessionDescriptionInput })?.sessionDescription;
    if (!sd) throw new AppError("INVALID_MESSAGE", "sessionDescription is required");
    const data = await voiceCalls.renegotiate(sessionId, sd);
    return jsonResponse("200 OK", data, corsHeaders(origin));
  } catch (error) {
    return voiceErrorResponse(toAppError(error));
  }
}

async function handleVoiceTracksClose(req: BunRequest<"/api/voice/session/:sessionId/tracks/close">, server: App): Promise<Response> {
  const origin = req.headers.get("origin");
  const ip = getClientIp(req, server);
  const authorized = requireLiveSession(req);
  const sessionId = req.params.sessionId;

  if (!sessionId) {
    return jsonResponse("400 Bad Request", { error: "Missing sessionId" });
  }
  if (!allowHttpRequest(ip, "voice-tracks-close")) {
    return jsonResponse("429 Too Many Requests", { error: "Rate limited" });
  }
  if (!authorized) {
    return jsonResponse("401 Unauthorized", { error: "Missing or invalid session" });
  }

  try {
    const body = await readJsonBody(req);
    const data = await voiceCalls.closeTracks(sessionId, body);
    return jsonResponse("200 OK", data, corsHeaders(origin));
  } catch (error) {
    return voiceErrorResponse(toAppError(error));
  }
}

/**
 * Builds the route map passed into Bun.serve({ routes }). Admin routes
 * (/admin/auth/*, /admin/usage*, /api/admin/*) are merged in here too - was
 * a separate registerAdminRoutes(app) call in the uWS version, now just a
 * second object spread since there's no shared `app` to register onto.
 */
export function buildAppRoutes() {
  return {
    ...buildAdminRoutes(),
    "/": route("GET", handleRoot),
    "/health": route("GET", handleHealth),
    "/show-support": route("GET", handleShowSupport),
    "/api/rooms/:code": route("GET", handleRoomPreview),
    "/api/voice/session": route("POST", handleVoiceSession),
    "/api/voice/session/:sessionId/tracks": route("POST", handleVoiceTracks),
    "/api/voice/session/:sessionId/renegotiate": route("PUT", handleVoiceRenegotiate),
    "/api/voice/session/:sessionId/tracks/close": route("PUT", handleVoiceTracksClose),
  };
}

/** Ultimate fallback for anything not matched above - mirrors the old app.any("/*", ...) 404. */
export function notFoundFallback(): Response {
  return notFoundResponse();
}