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
}

export type AppWebSocket = WebSocket<SocketUserData>;

/** Minimal identity retained for an authenticated admin metrics socket. */
export interface AdminSocketUserData {
  adminId: string;
  ip: string;
}

export type AdminWebSocket = WebSocket<AdminSocketUserData>;
export type App = TemplatedApp;
