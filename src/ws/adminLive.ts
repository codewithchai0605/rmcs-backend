import type { HttpRequest, HttpResponse, us_socket_context_t } from "uWebSockets.js";
import { getClientIp } from "../core/net.js";
import { getBearerToken } from "../http/httpUtils.js";
import { verifyAccessToken } from "../services/adminAuth.service.js";
import { roomManager } from "../game/roomManager.js";
import { sessionRegistry } from "./sessionRegistry.js";
import { connectionLimiter } from "../middleware/connectionLimiter.js";
import type { AdminWebSocket, AdminSocketUserData } from "./types.js";

const LIVE_STATS_INTERVAL_MS = 2_000;
const intervals = new Map<AdminWebSocket, ReturnType<typeof setInterval>>();

function snapshot() {
  return {
    sessions: sessionRegistry.stats(),
    rooms: roomManager.getStats(),
    connections: connectionLimiter.totalConnections(),
  };
}

function sendSnapshot(ws: AdminWebSocket): void {
  ws.send(JSON.stringify({ type: "stats", payload: snapshot() }));
}

/** Authenticated admin-only WebSocket used by the native dashboard. */
export function onAdminLiveUpgrade(res: HttpResponse, req: HttpRequest, context: us_socket_context_t): void {
  const token = getBearerToken(req);
  if (!token) {
    res.cork(() => res.writeStatus("401 Unauthorized").end("Missing bearer access token"));
    return;
  }

  try {
    const claims = verifyAccessToken(token);
    const key = req.getHeader("sec-websocket-key");
    const protocol = req.getHeader("sec-websocket-protocol");
    const extensions = req.getHeader("sec-websocket-extensions");
    const userData: AdminSocketUserData = { adminId: claims.sub, ip: getClientIp(res, req) };
    res.upgrade(userData, key, protocol, extensions, context);
  } catch {
    res.cork(() => res.writeStatus("401 Unauthorized").end("Invalid bearer access token"));
  }
}

export function onAdminLiveOpen(ws: AdminWebSocket): void {
  sendSnapshot(ws);
  const interval = setInterval(() => sendSnapshot(ws), LIVE_STATS_INTERVAL_MS);
  interval.unref?.();
  intervals.set(ws, interval);
}

export function onAdminLiveClose(ws: AdminWebSocket): void {
  const interval = intervals.get(ws);
  if (interval) clearInterval(interval);
  intervals.delete(ws);
}

export function onAdminLiveMessage(_ws: AdminWebSocket, _message: ArrayBuffer): void {
  // This is deliberately a server-push-only channel.
}
