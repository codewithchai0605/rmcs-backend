import { afterEach, describe, expect, it } from "vitest";
import { matchmakingQueue } from "../../src/matchmaking/queue.js";

// These entries are never attached to a real session (no sessionRegistry.attach
// call), which is fine: sessionRegistry.send/setInQueue both no-op safely for an
// unregistered playerId, and we never let the queue reach env.ROOM_SIZE (4) here,
// so roomManager.createRandomMatch never gets exercised in this file - that path
// is covered end-to-end with real clients in the integration suite instead.
function entry(playerId: string) {
  return { playerId, sessionToken: `tok-${playerId}`, name: playerId, avatarId: "a1", joinedAt: Date.now() };
}

describe("matchmakingQueue", () => {
  afterEach(() => {
    matchmakingQueue.clear();
  });

  it("tracks queue size across joins and removals", () => {
    expect(matchmakingQueue.size()).toBe(0);

    matchmakingQueue.join(entry("q1"));
    matchmakingQueue.join(entry("q2"));
    expect(matchmakingQueue.size()).toBe(2);

    matchmakingQueue.remove("q1");
    expect(matchmakingQueue.size()).toBe(1);
  });

  it("refuses to double-queue the same player", () => {
    matchmakingQueue.join(entry("q1"));
    expect(() => matchmakingQueue.join(entry("q1"))).toThrowError(/already queued/i);
  });

  it("remove() is a safe no-op for a player who was never queued", () => {
    expect(matchmakingQueue.remove("ghost")).toBe(false);
    expect(matchmakingQueue.size()).toBe(0);
  });

  it("remove() reports true exactly once per queued player", () => {
    matchmakingQueue.join(entry("q1"));
    expect(matchmakingQueue.remove("q1")).toBe(true);
    expect(matchmakingQueue.remove("q1")).toBe(false);
  });
});
