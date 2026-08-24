import type { TemplatedApp, WebSocket } from "uWebSockets.js";

/**
 * Data attached to a raw uWS socket at upgrade time. Kept intentionally tiny -
 * durable player/session state lives in SessionRegistry, not here, because this
 * object dies with the TCP connection.
 */
export interface SocketUserData {
  ip: string;
  requestedToken?: string;
  requestedName?: string;
  requestedAvatarId?: string;
  /** Filled in once `open` resolves the session. */
  sessionToken?: string;
  playerId?: string;
  /**
   * Promise chain used to process this socket's messages strictly in
   * arrival order even though rate-limiting is now potentially async
   * (Redis-backed) - see onMessage in connection.ts. Without this, two
   * messages from the same client could get reordered if their rate-limit
   * checks resolve out of order (e.g. Redis network jitter).
   */
  messageChain?: Promise<void>;
}

export type AppWebSocket = WebSocket<SocketUserData>;

/** Minimal identity retained for an authenticated admin metrics socket. */
export interface AdminSocketUserData {
  adminId: string;
  ip: string;
}

export type AdminWebSocket = WebSocket<AdminSocketUserData>;
export type App = TemplatedApp;
