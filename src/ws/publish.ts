import type { App } from "./types.js";
import { encodeEvent, type ServerEvent } from "./outbound.js";

let appRef: App | null = null;

/** Called once during bootstrap, after the uWS app is constructed. */
export function bindApp(app: App): void {
  appRef = app;
}

export function roomTopic(roomId: string): string {
  return `room:${roomId}`;
}

/**
 * Broadcasts an identical payload to every socket subscribed to the room's topic
 * (including the sender, if any) via uWS's native pub/sub. Use this for events
 * where every player should see exactly the same data. For per-player payloads
 * (e.g. each player's own card), send directly through sessionRegistry instead.
 */
export function publishToRoom(roomId: string, event: ServerEvent): void {
  if (!appRef) return;
  appRef.publish(roomTopic(roomId), encodeEvent(event));
}

export function roomSubscriberCount(roomId: string): number {
  if (!appRef) return 0;
  return appRef.numSubscribers(roomTopic(roomId));
}

// ---------------------------------------------------------------------------
// Server-wide topics: the open-rooms browse list (opt-in, Home/Matchmaking
// screens) and global chat (every connected socket, auto-subscribed on open).
// ---------------------------------------------------------------------------

export const OPEN_ROOMS_TOPIC = "open_rooms";
export const GLOBAL_CHAT_TOPIC = "global_chat";

/** Broadcasts to every socket currently subscribed to the open-rooms browse list. */
export function publishOpenRooms(event: ServerEvent): void {
  if (!appRef) return;
  appRef.publish(OPEN_ROOMS_TOPIC, encodeEvent(event));
}

/** Broadcasts to every connected socket (all sockets auto-subscribe to this topic on open). */
export function publishGlobalChat(event: ServerEvent): void {
  if (!appRef) return;
  appRef.publish(GLOBAL_CHAT_TOPIC, encodeEvent(event));
}
