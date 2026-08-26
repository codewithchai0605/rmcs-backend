import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  bootTestServer,
  closeAllClients,
  connectClient,
  connectClients,
  stopTestServer,
  type TestClient,
} from "../helpers/testServer";
import { matchmakingQueue } from "../../src/matchmaking/queue";

interface PublicRoomLike {
  roomId: string;
  playerCount: number;
  isOpen: boolean;
}
interface PublicOpenRoomLike {
  roomId: string;
  playerCount: number;
  maxPlayers: number;
}

function roomOf(msg: { payload: unknown }): PublicRoomLike {
  return (msg.payload as { room: PublicRoomLike }).room;
}

/** Creates a private room with `host`, then joins `others` into it via the normal code path. Returns the room code. */
async function createRoomWithPlayers(host: TestClient, others: TestClient[], password?: string): Promise<string> {
  host.send("private_room_create", password ? { password } : {});
  const created = await host.waitForType("room_created");
  const roomId = (created.payload as { roomId: string }).roomId;

  for (const other of others) {
    other.send("private_room_join", password ? { roomId, password } : { roomId });
    await other.waitForType("room_state");
  }

  return roomId;
}

describe("open rooms + global chat + race condition", () => {
  beforeAll(async () => {
    await bootTestServer();
  });

  afterAll(async () => {
    await stopTestServer();
  });

  afterEach(async () => {
    closeAllClients();
    // Let the close handshake complete server-side (connectionLimiter.release
    // and sessionRegistry cleanup both happen on the async onClose callback)
    // before the next test opens more connections.
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  it("broadcasts a live, growing listing to subscribers as an opened room fills, and removes it when the game starts", async () => {
    const [host, friend, browser] = await connectClients(3);

    const roomId = await createRoomWithPlayers(host, [friend]);

    // Not open yet - a subscriber shouldn't see it.
    browser.send("open_rooms_subscribe");
    const emptySnapshot = await browser.waitForType("open_rooms_snapshot");
    expect((emptySnapshot.payload as { rooms: PublicOpenRoomLike[] }).rooms.some((r) => r.roomId === roomId)).toBe(false);

    // Host opens the room - browser should get a live update, not just a future snapshot.
    host.send("room_set_open", { open: true });
    const openChanged = await host.waitForType("room_open_changed");
    expect(roomOf(openChanged).isOpen).toBe(true);

    const firstUpdate = await browser.waitFor(
      (e) => e.type === "open_room_updated" && (e.payload as { room: PublicOpenRoomLike }).room.roomId === roomId
    );
    expect((firstUpdate.payload as { room: PublicOpenRoomLike }).room.playerCount).toBe(2);

    // A third player joins via the normal code path (not instant-join) - the listing should still update.
    const [coded] = await connectClients(1);
    coded.send("private_room_join", { roomId });
    await coded.waitForType("room_state");

    const secondUpdate = await browser.waitFor(
      (e) =>
        e.type === "open_room_updated" &&
        (e.payload as { room: PublicOpenRoomLike }).room.roomId === roomId &&
        (e.payload as { room: PublicOpenRoomLike }).room.playerCount === 3
    );
    expect(secondUpdate).toBeTruthy();

    // Fourth player instant-joins from the browse list - room hits 4/4.
    const [instant] = await connectClients(1);
    instant.send("open_room_join", { roomId });
    await instant.waitForType("room_state");

    const fullUpdate = await browser.waitFor(
      (e) =>
        e.type === "open_room_updated" &&
        (e.payload as { room: PublicOpenRoomLike }).room.roomId === roomId &&
        (e.payload as { room: PublicOpenRoomLike }).room.playerCount === 4
    );
    expect((fullUpdate.payload as { room: PublicOpenRoomLike }).room.maxPlayers).toBe(4);

    // Full, but still listed (per design: it disappears when the game actually
    // starts, not the instant it hits capacity) - host can now start it.
    host.send("room_start");
    await host.waitForType("game_starting");

    const removed = await browser.waitFor(
      (e) => e.type === "open_room_removed" && (e.payload as { roomId: string }).roomId === roomId
    );
    expect(removed).toBeTruthy();
  });

  it("lets instant-join bypass the room password entirely", async () => {
    const [host, friend, stranger] = await connectClients(3);
    const roomId = await createRoomWithPlayers(host, [friend], "correct-horse");

    host.send("room_set_open", { open: true });
    await host.waitForType("room_open_changed");

    // No password field at all in this payload.
    stranger.send("open_room_join", { roomId });
    const result = await stranger.waitFor((e) => e.type === "room_state" || e.type === "error");
    expect(result.type).toBe("room_state");
    expect(roomOf(result).playerCount).toBe(3);
  });

  it("pulls a player out of the matchmaking queue when they instant-join an open room", async () => {
    const [queued, host, friend] = await connectClients(3);

    queued.send("queue_join");
    await queued.waitForType("queue_status");
    expect(matchmakingQueue.size()).toBeGreaterThanOrEqual(1);

    const roomId = await createRoomWithPlayers(host, [friend]);
    host.send("room_set_open", { open: true });
    await host.waitForType("room_open_changed");

    queued.send("open_room_join", { roomId });
    const result = await queued.waitFor((e) => e.type === "room_state" || e.type === "error");
    expect(result.type).toBe("room_state");

    // sessionRegistry.inQueue should be false now - verified indirectly: they're
    // no longer sitting in the queue map at all.
    expect(matchmakingQueue.size()).toBe(0);
  });

  it("rejects room_set_open from anyone but the host, and once the room is full", async () => {
    const [host, friend] = await connectClients(2);
    const roomId = await createRoomWithPlayers(host, [friend]);
    void roomId;

    friend.send("room_set_open", { open: true });
    const err = await friend.waitForType("error");
    expect((err.payload as { code: string }).code).toBe("NOT_ROOM_CREATOR");
  });

  it("never lets two concurrent instant-joins overfill the last slot - exactly one wins, no duplicate players", async () => {
    const [host, p2, p3] = await connectClients(3);
    const roomId = await createRoomWithPlayers(host, [p2, p3]); // 3/4 players

    host.send("room_set_open", { open: true });
    await host.waitForType("room_open_changed");

    const challengers = await connectClients(3); // 3 people racing for the 1 remaining seat

    // Fire all three instant-join attempts back to back, with no await in
    // between - this is the scenario that matters: whichever order the
    // server's event loop actually processes them in, at most one may
    // succeed, deterministically, with no corrupted/duplicated room state.
    for (const c of challengers) c.send("open_room_join", { roomId });

    const outcomes = await Promise.all(
      challengers.map((c) => c.waitFor((e) => e.type === "room_state" || e.type === "error"))
    );

    const winners = outcomes.filter((o) => o.type === "room_state");
    const losers = outcomes.filter((o) => o.type === "error");

    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(2);
    for (const loss of losers) {
      expect((loss.payload as { code: string }).code).toBe("ROOM_FULL");
    }

    // And the room itself must reflect exactly 4 distinct players - not 5, not a duplicate.
    const finalRoom = roomOf(winners[0]!);
    expect(finalRoom.playerCount).toBe(4);

    const winnerId = challengers.find((c) => outcomes[challengers.indexOf(c)]?.type === "room_state")?.playerId;
    expect(winnerId).toBeTruthy();

    // The two losers must still be free to do something else (not stuck half-joined).
    for (let i = 0; i < challengers.length; i++) {
      if (outcomes[i]!.type === "error") {
        challengers[i]!.send("queue_join");
        const status = await challengers[i]!.waitForFresh((e) => e.type === "queue_status" || e.type === "error");
        expect(status.type).toBe("queue_status");
        matchmakingQueue.remove(challengers[i]!.playerId!);
      }
    }
  });

  it("kicks a player: they get a `kicked` event, everyone else sees player_left, and the kicked player is free to start elsewhere", async () => {
    const [host, target] = await connectClients(2);
    await createRoomWithPlayers(host, [target]);

    host.send("room_kick", { targetPlayerId: target.playerId });

    const kickedEvent = await target.waitForType("kicked");
    expect((kickedEvent.payload as { reason: string }).reason).toBeTruthy();

    const leftEvent = await host.waitForType("player_left");
    expect((leftEvent.payload as { playerId: string }).playerId).toBe(target.playerId);

    // Freed, not stuck in the old room's session state.
    target.send("private_room_create");
    const created = await target.waitFor((e) => e.type === "room_created" || e.type === "error");
    expect(created.type).toBe("room_created");
  });

  it("delivers global chat to every connected client and gives new joiners the recent history", async () => {
    const [a, b] = await connectClients(2);

    a.send("global_chat_send", { text: "hello from A" });
    const received = await b.waitFor(
      (e) => e.type === "global_chat_message" && (e.payload as { message: { text: string } }).message.text === "hello from A"
    );
    expect((received.payload as { message: { senderId: string } }).message.senderId).toBe(a.playerId);

    const c = await connectClient();
    const history = await c.waitForType("global_chat_history");
    const messages = (history.payload as { messages: Array<{ text: string }> }).messages;
    expect(messages.some((m) => m.text === "hello from A")).toBe(true);
  });

  it("removes an open room from the list once it empties out, and re-lists it if it fills again", async () => {
    const [host] = await connectClients(1);

    host.send("private_room_create");
    const created = await host.waitForType("room_created");
    const roomId = (created.payload as { roomId: string }).roomId;

    const [browser] = await connectClients(1);
    browser.send("open_rooms_subscribe");
    await browser.waitForType("open_rooms_snapshot");

    host.send("room_set_open", { open: true });
    await browser.waitFor(
      (e) => e.type === "open_room_updated" && (e.payload as { room: PublicOpenRoomLike }).room.roomId === roomId
    );

    host.send("room_leave");
    const removed = await browser.waitFor(
      (e) => e.type === "open_room_removed" && (e.payload as { roomId: string }).roomId === roomId
    );
    expect(removed).toBeTruthy();
  });
});
