import { describe, expect, it } from "vitest";
import * as logic from "../../src/game/logic.js";
import type { GameRole } from "../../src/game/types.js";

function makeRoomWithPlayers(count: number) {
  const room = logic.createRoomSkeleton("TEST01", "private", null, 15);
  for (let i = 0; i < count; i++) {
    const player = logic.createPlayer({ id: `p${i}`, name: `Player${i}`, avatarId: "a1", isCreator: i === 0 });
    logic.addPlayer(room, player);
  }
  return room;
}

describe("createRoomSkeleton", () => {
  it("starts closed to instant-join, not just password-protected", () => {
    const room = logic.createRoomSkeleton("ABCD12", "private", "secret", 15);
    expect(room.isOpen).toBe(false);
    expect(room.openedAt).toBeNull();
    expect(room.gameState).toBe("waiting");
  });
});

describe("addPlayer / removePlayerFromRoom", () => {
  it("tracks the creator and zeroes their score on join", () => {
    const room = makeRoomWithPlayers(1);
    expect(room.creatorId).toBe("p0");
    expect(room.scores.p0).toBe(0);
  });

  it("removes the player's score, cards, and any pending replay response", () => {
    const room = makeRoomWithPlayers(2);
    room.currentCards.p1 = "Chor";
    room.replay = {
      active: true,
      requestId: "r1",
      requestedBy: "p0",
      requestedAt: Date.now(),
      expiresAt: Date.now() + 1000,
      responses: { p1: true },
    };

    logic.removePlayerFromRoom(room, "p1");

    expect(room.players.find((p) => p.id === "p1")).toBeUndefined();
    expect(room.scores.p1).toBeUndefined();
    expect(room.currentCards.p1).toBeUndefined();
    expect(room.replay.responses.p1).toBeUndefined();
  });

  it("clears the whole replay state if the leaving player was the one who requested it", () => {
    const room = makeRoomWithPlayers(2);
    room.replay = {
      active: true,
      requestId: "r1",
      requestedBy: "p0",
      requestedAt: Date.now(),
      expiresAt: Date.now() + 1000,
      responses: {},
    };

    logic.removePlayerFromRoom(room, "p0");

    expect(room.replay.active).toBe(false);
    expect(room.replay.requestedBy).toBeNull();
  });
});

describe("distributeCards", () => {
  it("assigns each of the four roles to exactly one distinct player, every time", () => {
    const room = makeRoomWithPlayers(4);

    for (let trial = 0; trial < 50; trial++) {
      logic.distributeCards(room);

      const cards = Object.values(room.currentCards);
      expect(cards.sort()).toEqual(["Chor", "Mantri", "Raja", "Sipahi"]);
      expect(room.rajaPlayerId).not.toBeNull();
      expect(room.mantriPlayerId).not.toBeNull();
      expect(room.chorPlayerId).not.toBeNull();
      expect(room.sipahiPlayerId).not.toBeNull();

      const assignedIds = new Set([room.rajaPlayerId, room.mantriPlayerId, room.chorPlayerId, room.sipahiPlayerId]);
      expect(assignedIds.size).toBe(4);
      expect(room.roundResolved).toBe(false);
    }
  });
});

describe("resolveGuess", () => {
  function fixedDeal(room: ReturnType<typeof makeRoomWithPlayers>): void {
    room.currentCards = { p0: "Raja", p1: "Mantri", p2: "Chor", p3: "Sipahi" } as Record<string, GameRole>;
    room.rajaPlayerId = "p0";
    room.mantriPlayerId = "p1";
    room.chorPlayerId = "p2";
    room.sipahiPlayerId = "p3";
  }

  it("awards Mantri 800 and Chor 0 on a correct guess, Raja/Sipahi unaffected by correctness", () => {
    const room = makeRoomWithPlayers(4);
    fixedDeal(room);

    const result = logic.resolveGuess(room, "p2", false);

    expect(result.isCorrect).toBe(true);
    expect(result.roundScores.p0).toBe(1000); // Raja
    expect(result.roundScores.p1).toBe(800); // Mantri, correct
    expect(result.roundScores.p2).toBe(0); // Chor, caught
    expect(result.roundScores.p3).toBe(500); // Sipahi
    expect(room.scores.p1).toBe(800);
    expect(room.roundResolved).toBe(true);
  });

  it("flips Mantri/Chor's scores on a wrong guess", () => {
    const room = makeRoomWithPlayers(4);
    fixedDeal(room);

    const result = logic.resolveGuess(room, "p3", false);

    expect(result.isCorrect).toBe(false);
    expect(result.roundScores.p1).toBe(0); // Mantri, wrong guess
    expect(result.roundScores.p2).toBe(800); // Chor, got away with it
  });

  it("accumulates scores across multiple rounds rather than overwriting", () => {
    const room = makeRoomWithPlayers(4);
    fixedDeal(room);
    logic.resolveGuess(room, "p2", false); // correct: Mantri +800
    fixedDeal(room);
    logic.resolveGuess(room, "p2", false); // correct again: Mantri +800 again

    expect(room.scores.p1).toBe(1600);
  });
});

describe("resetToLobby", () => {
  it("re-zeroes scores and clears round/replay state but keeps the players", () => {
    const room = makeRoomWithPlayers(4);
    room.gameState = "finished";
    room.currentRound = 15;
    room.scores.p0 = 4200;
    room.currentCards.p0 = "Raja";
    room.replay = {
      active: true,
      requestId: "r1",
      requestedBy: "p0",
      requestedAt: Date.now(),
      expiresAt: Date.now() + 1000,
      responses: { p1: true },
    };

    logic.resetToLobby(room);

    expect(room.gameState).toBe("waiting");
    expect(room.currentRound).toBe(0);
    expect(room.scores.p0).toBe(0);
    expect(room.currentCards).toEqual({});
    expect(room.replay.active).toBe(false);
    expect(room.players).toHaveLength(4);
  });
});
