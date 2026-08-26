import type { Server, ServerWebSocket } from "bun";

/**
 * Data attached to a Bun socket at upgrade time (via `server.upgrade(req, { data })`).
 * Kept intentionally tiny - durable player/session state lives in SessionRegistry,
 * not here, because this object dies with the TCP connection.
 *
 * Bun.serve() only accepts a single `websocket` handler set per server, so both
 * the game socket (/ws) and the admin live-stats socket (/admin/ws) are served
 * off the same `open`/`message`/`close` callbacks (see server.ts). `kind`
 * discriminates which one a given connection is, so connection.ts / admin.live.ts
 * can keep their previous, separate onOpen/onMessage/onClose behaviour.
 */
export interface SocketUserData {
  kind: "game";
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

export type AppWebSocket = ServerWebSocket<SocketUserData>;

/** Minimal identity retained for an authenticated admin metrics socket. */
export interface AdminSocketUserData {
  kind: "admin";
  adminId: string;
  ip: string;
}

export type AdminWebSocket = ServerWebSocket<AdminSocketUserData>;

/** The union stored in `ws.data` for every socket the server accepts - see the `kind` note above. */
export type AnySocketData = SocketUserData | AdminSocketUserData;
export type AnyAppWebSocket = ServerWebSocket<AnySocketData>;

export type App = Server<AnySocketData>;
