import { isOriginAllowed, getClientIp } from "../utils/net";
import { logger } from "../utils/logger";
import { connectionLimiter } from "../middleware/connection.limiter";
import { roomManager } from "../game/room.manager";
import { handleRawMessage } from "../handlers/index";
import { globalChat } from "../chat/global.chat";
import { encodeEvent } from "./outbound";
import { GLOBAL_CHAT_TOPIC } from "./publish";
import { sessionRegistry } from "./session.registry";
import type { App, AppWebSocket, SocketUserData } from "./types";

/**
 * Handles the initial HTTP request for /ws and, if it checks out, upgrades
 * it to a WebSocket. Bun.serve() does the upgrade synchronously inside the
 * fetch/route handler (no separate onUpgrade callback the way uWS had one) -
 * everything here runs before `server.upgrade()`, mirroring the checks the
 * old onUpgrade did before calling uWS's `res.upgrade()`.
 */
export function handleGameUpgrade(req: Request, server: App): Response | undefined {
  const origin = req.headers.get("origin");
  if (!isOriginAllowed(origin)) {
    return new Response("Origin not allowed", { status: 403 });
  }

  const ip = getClientIp(req, server);
  if (!connectionLimiter.tryAcquire(ip)) {
    return new Response("Too many connections from this address", { status: 429 });
  }

  const url = new URL(req.url);
  const userData: SocketUserData = {
    kind: "game",
    ip,
    requestedToken: url.searchParams.get("token") || undefined,
    requestedName: url.searchParams.get("name") || undefined,
    requestedAvatarId: url.searchParams.get("avatarId") || undefined,
  };

  const upgraded = server.upgrade(req, { data: userData });
  if (!upgraded) {
    // connectionLimiter.tryAcquire() already reserved a slot for this IP above -
    // release it since no socket will ever reach onClose() to do it otherwise.
    connectionLimiter.release(ip);
    return new Response("Expected a WebSocket upgrade", { status: 426 });
  }
  return undefined;
}

export function onOpen(ws: AppWebSocket): void {
  const userData = ws.data;
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

  // Global chat is visible everywhere, so every socket auto-subscribes -
  // unlike the open-rooms browse list, which is opt-in per screen.
  try {
    ws.subscribe(GLOBAL_CHAT_TOPIC);
  } catch (error) {
    logger.warn("Failed to subscribe socket to global chat topic", { playerId: record.playerId, error: (error as Error).message });
  }
  ws.send(encodeEvent({ type: "global_chat_history", payload: { messages: globalChat.getHistory() } }));
}

export function onMessage(ws: AppWebSocket, message: string | Buffer): void {
  const userData = ws.data;
  const { playerId } = userData;
  if (!playerId) return; // open() always assigns this before message() can fire

  const text = typeof message === "string" ? message : message.toString("utf-8");

  // handleRawMessage is async now that rate-limiting can hit Redis. Bun's
  // message callback itself must stay synchronous/void, and messages for
  // one connection must still be handled in the order they arrived (an
  // async gate means two in-flight checks could otherwise resolve out of
  // order under network jitter) - so each socket keeps its own promise
  // chain and every message waits for the previous one to finish before
  // it starts, while different connections still run independently.
  userData.messageChain = (userData.messageChain ?? Promise.resolve()).then(() =>
    handleRawMessage(playerId, text).catch((error) => {
      logger.error("Unhandled error processing message", { playerId, error: (error as Error).message });
    })
  );
}

export function onClose(ws: AppWebSocket): void {
  sessionRegistry.detach(ws);
}
