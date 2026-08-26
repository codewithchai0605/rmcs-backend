import { getClientIp } from "../utils/net";
import { getBearerToken } from "../http/http.utils";
import { verifyAccessToken } from "../services/admin.auth.service";
import { roomManager } from "../game/room.manager";
import { sessionRegistry } from "./session.registry";
import { connectionLimiter } from "../middleware/connection.limiter";
import type { App, AdminWebSocket, AdminSocketUserData } from "./types";

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
  // `false` = never compress this channel, matching the old /admin/ws
  // socket's `compression: uWS.DISABLED` (the shared game socket below
  // still gets perMessageDeflate - see server.ts).
  ws.send(JSON.stringify({ type: "stats", payload: snapshot() }), false);
}

/** Authenticated admin-only WebSocket used by the native dashboard. */
export function handleAdminUpgrade(req: Request, server: App): Response | undefined {
  const token = getBearerToken(req);
  if (!token) {
    return new Response("Missing bearer access token", { status: 401 });
  }

  try {
    const claims = verifyAccessToken(token);
    const userData: AdminSocketUserData = { kind: "admin", adminId: claims.sub, ip: getClientIp(req, server) };
    const upgraded = server.upgrade(req, { data: userData });
    if (!upgraded) {
      return new Response("Expected a WebSocket upgrade", { status: 426 });
    }
    return undefined;
  } catch {
    return new Response("Invalid bearer access token", { status: 401 });
  }
}

export function onAdminOpen(ws: AdminWebSocket): void {
  sendSnapshot(ws);
  const interval = setInterval(() => sendSnapshot(ws), LIVE_STATS_INTERVAL_MS);
  interval.unref?.();
  intervals.set(ws, interval);
}

export function onAdminClose(ws: AdminWebSocket): void {
  const interval = intervals.get(ws);
  if (interval) clearInterval(interval);
  intervals.delete(ws);
}

export function onAdminMessage(_ws: AdminWebSocket, _message: string | Buffer): void {
  // This is deliberately a server-push-only channel.
}
