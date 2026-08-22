import type { HttpRequest, HttpResponse } from "uWebSockets.js";
import { getClientIp } from "../core/net.js";
import { allowHttpRequest } from "../middleware/httpRateLimiter.js";
import { connectionLimiter } from "../middleware/connectionLimiter.js";
import { roomManager } from "../game/roomManager.js";
import { sessionRegistry } from "../ws/sessionRegistry.js";
import { normalizeRoomCode } from "../core/sanitize.js";
import { AppError, toAppError } from "../core/errors.js";
import * as voiceCalls from "../voice/cloudflareCalls.js";
import type { App } from "../ws/types.js";
import { registerAdminRoutes } from "./adminRoutes.js";
import { writeCors, writeJson, drainBody, readJsonBody, statusForErrorCode } from "./httpUtils.js";

const startedAt = Date.now();

// Local alias so the rest of this file (predates the shared helper) doesn't
// need to change beyond this one line - see http/httpUtils.ts for the
// implementation, now shared with http/adminRoutes.ts.
const statusForError = (appError: AppError): string => statusForErrorCode(appError.code);

export function registerHttpRoutes(app: App): void {
  app.get("/health", (res, req) => {
    let aborted = false;
    res.onAborted(() => {
      aborted = true;
    });

    const origin = req.getHeader("origin");
    const ip = getClientIp(res, req);

    if (!allowHttpRequest(ip, "health")) {
      if (!aborted) writeJson(res, "429 Too Many Requests", { error: "Rate limited" });
      return;
    }

    const body = {
      status: "ok",
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      rooms: roomManager.getStats(),
      sessions: sessionRegistry.stats(),
      connections: { total: connectionLimiter.totalConnections() },
    };

    if (!aborted) {
      writeCors(res, origin);
      writeJson(res, "200 OK", body);
    }
  });

  // Lets the frontend check a private room code exists (and whether it needs a
  // password) before attempting to open a WebSocket connection to join it.
  app.get("/api/rooms/:code", (res, req) => {
    let aborted = false;
    res.onAborted(() => {
      aborted = true;
    });

    const origin = req.getHeader("origin");
    const ip = getClientIp(res, req);

    if (!allowHttpRequest(ip, "room-preview")) {
      if (!aborted) writeJson(res, "429 Too Many Requests", { error: "Rate limited" });
      return;
    }

    const code = normalizeRoomCode(req.getParameter("code"));
    const preview = roomManager.getRoomPreview(code);

    if (!aborted) {
      writeCors(res, origin);
      if (!preview) {
        writeJson(res, "404 Not Found", { error: "Room not found" });
      } else {
        writeJson(res, "200 OK", preview);
      }
    }
  });

  // --- Voice chat (Cloudflare Calls proxy) ---------------------------------
  // These just forward to Cloudflare's Connection API with our App Secret
  // attached server-side - the secret must never reach the client. Each
  // route requires the caller be a live, known session (checked via
  // sessionRegistry) so a random unauthenticated request can't run up our
  // Cloudflare bill; genuine gameplay auth still doesn't exist, but this at
  // least ties usage to an active connection to this server.
  const requireLiveSession = (req: HttpRequest): boolean => {
    const token = req.getHeader("x-session-token");
    return Boolean(token && sessionRegistry.getByToken(token)?.connected);
  };

  app.post("/api/voice/session", (res, req) => {
    let aborted = false;
    res.onAborted(() => {
      aborted = true;
    });

    const origin = req.getHeader("origin");
    const ip = getClientIp(res, req);
    const authorized = requireLiveSession(req);

    if (!allowHttpRequest(ip, "voice-session")) {
      if (!aborted) writeJson(res, "429 Too Many Requests", { error: "Rate limited" });
      return;
    }
    if (!authorized) {
      if (!aborted) writeJson(res, "401 Unauthorized", { error: "Missing or invalid session" });
      return;
    }

    readJsonBody(res)
      .then((body) => voiceCalls.createSession((body as { sessionDescription?: voiceCalls.SessionDescriptionInput })?.sessionDescription))
      .then((data) => {
        if (aborted) return;
        writeCors(res, origin);
        writeJson(res, "200 OK", data);
      })
      .catch((error) => {
        if (aborted) return;
        const appError = toAppError(error);
        writeJson(res, statusForError(appError), { error: appError.message, code: appError.code });
      });
  });

  app.post("/api/voice/session/:sessionId/tracks", (res, req) => {
    let aborted = false;
    res.onAborted(() => {
      aborted = true;
    });

    const origin = req.getHeader("origin");
    const ip = getClientIp(res, req);
    const authorized = requireLiveSession(req);
    const sessionId = req.getParameter("sessionId");

    if (!sessionId) {
      if (!aborted) writeJson(res, "400 Bad Request", { error: "Missing sessionId" });
      return;
    }
    if (!allowHttpRequest(ip, "voice-tracks")) {
      if (!aborted) writeJson(res, "429 Too Many Requests", { error: "Rate limited" });
      return;
    }
    if (!authorized) {
      if (!aborted) writeJson(res, "401 Unauthorized", { error: "Missing or invalid session" });
      return;
    }

    readJsonBody(res)
      .then((body) => voiceCalls.addTracks(sessionId, body))
      .then((data) => {
        if (aborted) return;
        writeCors(res, origin);
        writeJson(res, "200 OK", data);
      })
      .catch((error) => {
        if (aborted) return;
        const appError = toAppError(error);
        writeJson(res, statusForError(appError), { error: appError.message, code: appError.code });
      });
  });

  app.put("/api/voice/session/:sessionId/renegotiate", (res, req) => {
    let aborted = false;
    res.onAborted(() => {
      aborted = true;
    });

    const origin = req.getHeader("origin");
    const ip = getClientIp(res, req);
    const authorized = requireLiveSession(req);
    const sessionId = req.getParameter("sessionId");

    if (!sessionId) {
      if (!aborted) writeJson(res, "400 Bad Request", { error: "Missing sessionId" });
      return;
    }
    if (!allowHttpRequest(ip, "voice-renegotiate")) {
      if (!aborted) writeJson(res, "429 Too Many Requests", { error: "Rate limited" });
      return;
    }
    if (!authorized) {
      if (!aborted) writeJson(res, "401 Unauthorized", { error: "Missing or invalid session" });
      return;
    }

    readJsonBody(res)
      .then((body) => {
        const sd = (body as { sessionDescription?: voiceCalls.SessionDescriptionInput })?.sessionDescription;
        if (!sd) throw new AppError("INVALID_MESSAGE", "sessionDescription is required");
        return voiceCalls.renegotiate(sessionId, sd);
      })
      .then((data) => {
        if (aborted) return;
        writeCors(res, origin);
        writeJson(res, "200 OK", data);
      })
      .catch((error) => {
        if (aborted) return;
        const appError = toAppError(error);
        writeJson(res, statusForError(appError), { error: appError.message, code: appError.code });
      });
  });

  app.put("/api/voice/session/:sessionId/tracks/close", (res, req) => {
    let aborted = false;
    res.onAborted(() => {
      aborted = true;
    });

    const origin = req.getHeader("origin");
    const ip = getClientIp(res, req);
    const authorized = requireLiveSession(req);
    const sessionId = req.getParameter("sessionId");

    if (!sessionId) {
      if (!aborted) writeJson(res, "400 Bad Request", { error: "Missing sessionId" });
      return;
    }
    if (!allowHttpRequest(ip, "voice-tracks-close")) {
      if (!aborted) writeJson(res, "429 Too Many Requests", { error: "Rate limited" });
      return;
    }
    if (!authorized) {
      if (!aborted) writeJson(res, "401 Unauthorized", { error: "Missing or invalid session" });
      return;
    }

    readJsonBody(res)
      .then((body) => voiceCalls.closeTracks(sessionId, body))
      .then((data) => {
        if (aborted) return;
        writeCors(res, origin);
        writeJson(res, "200 OK", data);
      })
      .catch((error) => {
        if (aborted) return;
        const appError = toAppError(error);
        writeJson(res, statusForError(appError), { error: appError.message, code: appError.code });
      });
  });

  // All admin routes - auth (/admin/auth/*), usage analytics
  // (/admin/usage*), and general admin stats (/api/admin/*) - live in one
  // module, see http/adminRoutes.ts. Every one of them requires a JWT
  // access token from /admin/auth/login; there is no API-key fallback.
  registerAdminRoutes(app);

  app.options("/*", (res, req) => {
    const origin = req.getHeader("origin");
    res.cork(() => {
      writeCors(res, origin);
      res
        .writeHeader("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS")
        .writeHeader("Access-Control-Allow-Headers", "Content-Type, X-Session-Token, Authorization")
        .writeStatus("204 No Content")
        .end();
    });
  });

  app.any("/*", (res, _req: HttpRequest) => {
    drainBody(res);
    res.cork(() => {
      res
        .writeStatus("404 Not Found")
        .writeHeader("Content-Type", "application/json")
        .end(JSON.stringify({ error: "Not found" }));
    });
  });
}