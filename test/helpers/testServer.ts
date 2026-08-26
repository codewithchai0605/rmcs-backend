import { WebSocket } from "ws";
import { startServer, type StartedServer } from "../../src/server";
import { roomManager } from "../../src/game/room.manager";
import { sessionRegistry } from "../../src/websocket/session.registry";
import { rateLimiter } from "../../src/middleware/rate.limiter";
import { matchmakingQueue } from "../../src/matchmaking/queue";
import { globalChat } from "../../src/chat/global.chat";

export interface ServerEventMsg {
  type: string;
  payload: unknown;
}

/**
 * Thin promise-based wrapper around a real `ws` client connected to the
 * real server (see bootTestServer). Buffers every event so `waitFor` can
 * resolve immediately against something that already arrived, instead of
 * only against events that arrive after the call - which matters a lot for
 * the race-condition test, where responses can land before we start
 * waiting for them.
 */
export class TestClient {
  readonly ws: WebSocket;
  readonly events: ServerEventMsg[] = [];
  playerId: string | null = null;
  sessionToken: string | null = null;

  private waiters: Array<{ predicate: (e: ServerEventMsg) => boolean; resolve: (e: ServerEventMsg) => void }> = [];

  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on("message", (data: Buffer) => {
      let msg: ServerEventMsg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      this.events.push(msg);
      if (msg.type === "welcome") {
        const payload = msg.payload as { playerId: string; sessionToken: string };
        this.playerId = payload.playerId;
        this.sessionToken = payload.sessionToken;
      }
      for (let i = this.waiters.length - 1; i >= 0; i--) {
        const waiter = this.waiters[i];
        if (waiter.predicate(msg)) {
          this.waiters.splice(i, 1);
          waiter.resolve(msg);
        }
      }
    });
  }

  send(type: string, payload: unknown = {}): void {
    this.ws.send(JSON.stringify({ type, payload }));
  }

  /** Resolves with the first already-buffered match, else the next matching message that arrives. */
  waitFor(predicate: (e: ServerEventMsg) => boolean, timeoutMs = 4000): Promise<ServerEventMsg> {
    const existing = this.events.find(predicate);
    if (existing) return Promise.resolve(existing);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.resolve !== wrappedResolve);
        reject(
          new Error(
            `Timed out after ${timeoutMs}ms waiting for a matching message. Received so far: [${this.events
              .map((e) => e.type)
              .join(", ")}]`
          )
        );
      }, timeoutMs);
      const wrappedResolve = (e: ServerEventMsg): void => {
        clearTimeout(timer);
        resolve(e);
      };
      this.waiters.push({ predicate, resolve: wrappedResolve });
    });
  }

  waitForType(type: string, timeoutMs = 4000): Promise<ServerEventMsg> {
    return this.waitFor((e) => e.type === type, timeoutMs);
  }

  /**
   * Like waitFor, but deliberately ignores anything already buffered and
   * only resolves for a message that arrives from this call onward. Use
   * this instead of waitFor when a test reuses a broad predicate (e.g.
   * "type === 'error'") on a client that may already have a matching
   * message sitting in its buffer from an earlier step in the same test -
   * waitFor's buffer-first behavior would otherwise resolve instantly with
   * that stale message instead of the new one you're actually waiting for.
   */
  waitForFresh(predicate: (e: ServerEventMsg) => boolean, timeoutMs = 4000): Promise<ServerEventMsg> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.resolve !== wrappedResolve);
        reject(new Error(`Timed out after ${timeoutMs}ms waiting for a fresh matching message.`));
      }, timeoutMs);
      const wrappedResolve = (e: ServerEventMsg): void => {
        clearTimeout(timer);
        resolve(e);
      };
      this.waiters.push({ predicate, resolve: wrappedResolve });
    });
  }

  /** All buffered messages of a type so far, in arrival order. */
  eventsOfType(type: string): ServerEventMsg[] {
    return this.events.filter((e) => e.type === type);
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      // already closed
    }
  }
}

const PORT = 18799;
const HOST = "127.0.0.1";

let started: StartedServer | null = null;
const openClients: TestClient[] = [];

export async function bootTestServer(): Promise<void> {
  if (started) return;
  started = await startServer();
}

export async function stopTestServer(): Promise<void> {
  for (const client of openClients.splice(0)) {
    client.close();
  }
  roomManager.destroy();
  sessionRegistry.destroy();
  rateLimiter.destroy();
  matchmakingQueue.clear();
  globalChat.destroy();
  started?.stop();
  started = null;
  // Let sockets actually finish closing before the process/test file exits.
  await new Promise((resolve) => setTimeout(resolve, 50));
}

/**
 * Resets all module-level singleton state between tests within the same
 * boot (rooms, sessions, queue, rate-limit buckets, global chat history) -
 * everything except the running server/listen socket itself, which stays
 * up for the whole file to avoid the port-rebind cost per test.
 */
export function resetServerState(): void {
  roomManager.destroy();
  sessionRegistry.destroy();
  rateLimiter.destroy();
  matchmakingQueue.clear();
  globalChat.destroy();
}

export function connectClient(query = ""): Promise<TestClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${HOST}:${PORT}/ws${query}`);
    const client = new TestClient(ws);
    openClients.push(client);

    ws.once("error", (err: Error) => reject(err));
    ws.once("open", () => {
      client.waitForType("welcome").then(() => resolve(client), reject);
    });
  });
}

/** Connect N clients concurrently, each already past their `welcome` handshake. */
export function connectClients(count: number): Promise<TestClient[]> {
  return Promise.all(Array.from({ length: count }, () => connectClient()));
}

/**
 * Closes every client opened via connectClient/connectClients so far and
 * forgets about them. Intended for an afterEach in integration test files -
 * without it, connections pile up across tests (each one only released
 * asynchronously, over the close handshake) and can blow past
 * MAX_CONNECTIONS_PER_IP well before the file finishes.
 */
export function closeAllClients(): void {
  for (const client of openClients.splice(0)) {
    client.close();
  }
}
