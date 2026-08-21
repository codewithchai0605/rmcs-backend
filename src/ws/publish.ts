import type { App } from "./types";
import { encodeEvent, type ServerEvent } from "./outbound";

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
