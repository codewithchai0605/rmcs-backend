import type { HttpRequest, HttpResponse } from "uWebSockets.js";
import { env } from "../config/env.js";
import { getClientIp, isOriginAllowed } from "../core/net.js";
import { allowHttpRequest } from "../middleware/httpRateLimiter.js";
import { connectionLimiter } from "../middleware/connectionLimiter.js";
import { roomManager } from "../game/roomManager.js";
import { sessionRegistry } from "../ws/sessionRegistry.js";
import { normalizeRoomCode } from "../core/sanitize.js";
import type { App } from "../ws/types.js";

const startedAt = Date.now();

function writeCors(res: HttpResponse, origin: string): void {
  if (isOriginAllowed(origin)) {
    res.writeHeader("Access-Control-Allow-Origin", env.ALLOWED_ORIGINS.includes("*") ? "*" : origin);
    res.writeHeader("Vary", "Origin");
  }
}

function writeJson(res: HttpResponse, status: string, body: unknown): void {
  res.cork(() => {
    res.writeStatus(status).writeHeader("Content-Type", "application/json").end(JSON.stringify(body));
  });
}

/** Reads and discards the request body (future-proofs any POST route being added later). */
function drainBody(res: HttpResponse): void {
  res.onData(() => {});
  res.onAborted(() => {});
}

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

  app.options("/*", (res, req) => {
    const origin = req.getHeader("origin");
    res.cork(() => {
      writeCors(res, origin);
      res
        .writeHeader("Access-Control-Allow-Methods", "GET, OPTIONS")
        .writeHeader("Access-Control-Allow-Headers", "Content-Type")
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
