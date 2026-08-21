import { env } from "../config/env";
import { logger } from "../core/logger";
import { generatePlayerId, generateSessionToken, generateGuestName } from "../core/ids";
import { sanitizeName, normalizeAvatarId } from "../core/sanitize";
import { encodeEvent, type ServerEvent } from "./outbound";
import type { AppWebSocket } from "./types";
import { roomManager } from "../game/roomManager";
import { matchmakingQueue } from "../matchmaking/queue";
import { connectionLimiter } from "../middleware/connectionLimiter";

export interface SessionRecord {
  sessionToken: string;
  playerId: string;
  name: string;
  avatarId: string;
  ip: string;
  connected: boolean;
  ws: AppWebSocket | null;
  roomId: string | null;
  inQueue: boolean;
  disconnectTimer: ReturnType<typeof setTimeout> | null;
  /** True only during the brief window where an old socket is being replaced by a resumed one. */
  replacing: boolean;
  createdAt: number;
  lastActivityAt: number;
}

interface AttachResult {
  record: SessionRecord;
  isResumed: boolean;
}

const byToken = new Map<string, SessionRecord>();
const byPlayerId = new Map<string, string>(); // playerId -> sessionToken

function send(record: SessionRecord, event: ServerEvent): void {
  if (!record.connected || !record.ws) return;
  try {
    record.ws.send(encodeEvent(event));
  } catch (error) {
    logger.warn("Failed to send to socket", { playerId: record.playerId, error: (error as Error).message });
  }
}

function attach(
  ws: AppWebSocket,
  requestedToken: string | undefined,
  requestedName: string | undefined,
  requestedAvatarId: string | undefined,
  ip: string
): AttachResult {
  const now = Date.now();

  if (requestedToken) {
    const existing = byToken.get(requestedToken);
    if (existing) {
      if (existing.disconnectTimer) {
        clearTimeout(existing.disconnectTimer);
        existing.disconnectTimer = null;
      }

      // A second connection showed up for the same token while the first is
      // still alive (e.g. a tab reload racing the old tab's close). Replace it.
      if (existing.connected && existing.ws && existing.ws !== ws) {
        existing.replacing = true;
        try {
          send(existing, { type: "session_replaced", payload: {} });
          existing.ws.end(4000, "Replaced by a new connection");
        } catch {
          // old socket may already be half-dead; nothing more to do
        }
        existing.replacing = false;
      }

      existing.ws = ws;
      existing.connected = true;
      existing.ip = ip;
      existing.lastActivityAt = now;
      return { record: existing, isResumed: true };
    }
  }

  const playerId = generatePlayerId();
  const sessionToken = generateSessionToken();
  const name = sanitizeName(requestedName) || generateGuestName();
  const avatarId = normalizeAvatarId(requestedAvatarId);

  const record: SessionRecord = {
    sessionToken,
    playerId,
    name,
    avatarId,
    ip,
    connected: true,
    ws,
    roomId: null,
    inQueue: false,
    disconnectTimer: null,
    replacing: false,
    createdAt: now,
    lastActivityAt: now,
  };

  byToken.set(sessionToken, record);
  byPlayerId.set(playerId, sessionToken);

  return { record, isResumed: false };
}

function detach(ws: AppWebSocket): void {
  const userData = ws.getUserData();
  const token = userData.sessionToken;
  if (!token) return;

  const record = byToken.get(token);
  if (!record || record.replacing) return;

  // Guard against a `close` event for a socket that's already been superseded
  // by a newer connection for the same token (defensive; should be rare).
  if (record.ws !== ws) return;

  record.connected = false;
  record.ws = null;
  connectionLimiter.release(record.ip);

  if (record.inQueue) {
    matchmakingQueue.remove(record.playerId);
    record.inQueue = false;
  }

  if (record.roomId) {
    roomManager.markPlayerDisconnected(record.roomId, record.playerId);
    record.disconnectTimer = setTimeout(() => finalizeDisconnect(record), env.DISCONNECT_GRACE_MS);
    return;
  }

  byToken.delete(token);
  byPlayerId.delete(record.playerId);
}

function finalizeDisconnect(record: SessionRecord): void {
  record.disconnectTimer = null;
  const roomId = record.roomId;

  byToken.delete(record.sessionToken);
  byPlayerId.delete(record.playerId);

  if (roomId) {
    roomManager.removePlayer(roomId, record.playerId, "disconnected");
  }
}

function getByToken(token: string): SessionRecord | undefined {
  return byToken.get(token);
}

function getByPlayerId(playerId: string): SessionRecord | undefined {
  const token = byPlayerId.get(playerId);
  return token ? byToken.get(token) : undefined;
}

function setRoom(playerId: string, roomId: string | null): void {
  const record = getByPlayerId(playerId);
  if (record) record.roomId = roomId;
}

function setInQueue(playerId: string, inQueue: boolean): void {
  const record = getByPlayerId(playerId);
  if (record) record.inQueue = inQueue;
}

function updateProfile(playerId: string, name: string, avatarId: string): void {
  const record = getByPlayerId(playerId);
  if (record) {
    record.name = name;
    record.avatarId = avatarId;
  }
}

function touch(playerId: string): void {
  const record = getByPlayerId(playerId);
  if (record) record.lastActivityAt = Date.now();
}

function sendTo(playerId: string, event: ServerEvent): void {
  const record = getByPlayerId(playerId);
  if (record) send(record, event);
}

function sendToMany(playerIds: Iterable<string>, event: ServerEvent): void {
  for (const playerId of playerIds) sendTo(playerId, event);
}

/** Safety-net sweep for records that somehow never got a grace timer scheduled or cleaned up. */
function sweepStale(): void {
  const now = Date.now();
  const maxIdleMs = env.DISCONNECT_GRACE_MS * 4;

  for (const [token, record] of byToken) {
    if (!record.connected && !record.disconnectTimer && now - record.lastActivityAt > maxIdleMs) {
      byToken.delete(token);
      byPlayerId.delete(record.playerId);
    }
  }
}

function stats() {
  let connected = 0;
  for (const record of byToken.values()) {
    if (record.connected) connected++;
  }
  return {
    totalSessions: byToken.size,
    connectedSessions: connected,
  };
}

const sweepInterval = setInterval(sweepStale, env.SESSION_SWEEP_MS);
sweepInterval.unref?.();

function destroy(): void {
  clearInterval(sweepInterval);
  for (const record of byToken.values()) {
    if (record.disconnectTimer) clearTimeout(record.disconnectTimer);
  }
}

export const sessionRegistry = {
  attach,
  detach,
  getByToken,
  getByPlayerId,
  setRoom,
  setInQueue,
  updateProfile,
  touch,
  send: sendTo,
  sendToMany,
  sweepStale,
  stats,
  destroy,
};
