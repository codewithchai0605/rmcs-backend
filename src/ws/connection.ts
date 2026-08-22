import type { HttpRequest, HttpResponse, us_socket_context_t } from "uWebSockets.js";
import { getClientIp, isOriginAllowed } from "../core/net.js";
import { connectionLimiter } from "../middleware/connectionLimiter.js";
import { roomManager } from "../game/roomManager.js";
import { handleRawMessage } from "../handlers/index.js";
import { encodeEvent } from "./outbound.js";
import { sessionRegistry } from "./sessionRegistry.js";
import type { AppWebSocket, SocketUserData } from "./types.js";

export function onUpgrade(res: HttpResponse, req: HttpRequest, context: us_socket_context_t): void {
  const origin = req.getHeader("origin");
  if (!isOriginAllowed(origin)) {
    res.cork(() => {
      res.writeStatus("403 Forbidden").end("Origin not allowed");
    });
    return;
  }

  const ip = getClientIp(res, req);
  if (!connectionLimiter.tryAcquire(ip)) {
    res.cork(() => {
      res.writeStatus("429 Too Many Requests").end("Too many connections from this address");
    });
    return;
  }

  // Everything below is synchronous, as required for a valid upgrade - no
  // awaits, so `res` can never be aborted out from under us before res.upgrade().
  const secWebSocketKey = req.getHeader("sec-websocket-key");
  const secWebSocketProtocol = req.getHeader("sec-websocket-protocol");
  const secWebSocketExtensions = req.getHeader("sec-websocket-extensions");

  const userData: SocketUserData = {
    ip,
    requestedToken: req.getQuery("token") || undefined,
    requestedName: req.getQuery("name") || undefined,
    requestedAvatarId: req.getQuery("avatarId") || undefined,
  };

  res.upgrade(userData, secWebSocketKey, secWebSocketProtocol, secWebSocketExtensions, context);
}

export function onOpen(ws: AppWebSocket): void {
  const userData = ws.getUserData();
  const { record, isResumed } = sessionRegistry.attach(
    ws,
    userData.requestedToken,
    userData.requestedName,
    userData.requestedAvatarId,
    userData.ip
  );

  userData.sessionToken = record.sessionToken;
  userData.playerId = record.playerId;

  ws.send(
    encodeEvent({
      type: "welcome",
      payload: {
        playerId: record.playerId,
        sessionToken: record.sessionToken,
        name: record.name,
        avatarId: record.avatarId,
        resumed: isResumed,
      },
    })
  );

  if (isResumed && record.roomId) {
    roomManager.markPlayerReconnected(record.roomId, record.playerId);
  }
}

export function onMessage(ws: AppWebSocket, message: ArrayBuffer): void {
  const { playerId } = ws.getUserData();
  if (!playerId) return; // open() always assigns this before message() can fire

  let text: string;
  try {
    text = Buffer.from(message).toString("utf-8");
  } catch {
    return;
  }

  handleRawMessage(playerId, text);
}

export function onClose(ws: AppWebSocket): void {
  sessionRegistry.detach(ws);
}
