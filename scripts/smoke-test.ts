/* eslint-disable no-console */

const BASE = process.env.SMOKE_BASE_URL ?? "ws://localhost:8080/ws";

interface Client {
  name: string;
  ws: WebSocket;
  playerId?: string;
  sessionToken?: string;
  events: Array<{ type: string; payload: unknown }>;
  pending: Map<string, unknown[]>;
  waiters: Array<{ type: string; resolve: (payload: unknown) => void }>;
}

function connect(name: string, query = ""): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${BASE}${query}`);
    const client: Client = { name, ws, events: [], pending: new Map(), waiters: [] };

    ws.addEventListener("open", () => {
      console.log(`[${name}] connected`);
    });

    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data.toString());
      client.events.push(msg);
      console.log(`[${name}] <- ${msg.type}`, JSON.stringify(msg.payload).slice(0, 200));

      if (msg.type === "welcome") {
        client.playerId = msg.payload.playerId;
        client.sessionToken = msg.payload.sessionToken;
        resolve(client);
      }

      const waiterIndex = client.waiters.findIndex((w) => w.type === msg.type);
      if (waiterIndex !== -1) {
        const [waiter] = client.waiters.splice(waiterIndex, 1);
        waiter.resolve(msg.payload);
      } else {
        const queue = client.pending.get(msg.type) ?? [];
        queue.push(msg.payload);
        client.pending.set(msg.type, queue);
      }
    });

    ws.addEventListener("error", (err) => {
      console.error(`[${name}] error`, err);
      reject(err);
    });
  });
}

function waitFor(client: Client, type: string, timeoutMs = 8000): Promise<any> {
  const queue = client.pending.get(type);
  if (queue && queue.length > 0) {
    return Promise.resolve(queue.shift());
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`[${client.name}] timed out waiting for ${type}`)), timeoutMs);
    client.waiters.push({
      type,
      resolve: (payload) => {
        clearTimeout(timer);
        resolve(payload);
      },
    });
  });
}

function send(client: Client, type: string, payload: unknown = {}): void {
  client.ws.send(JSON.stringify({ type, payload }));
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

async function playFullMatch(clients: Client[]): Promise<void> {
  for (const c of clients) send(c, "queue_join", { name: c.name });

  console.log("\n--- waiting for match_found ---");
  await Promise.all(clients.map((c) => waitFor(c, "match_found")));

  console.log("\n--- waiting for game_starting ---");
  await Promise.all(clients.map((c) => waitFor(c, "game_starting")));

  console.log("\n--- waiting for game_started (per-player card) ---");
  const startedPayloads = await Promise.all(clients.map((c) => waitFor(c, "game_started")));
  for (const p of startedPayloads) {
    assert(typeof p.yourCard === "string", "each player should receive yourCard");
  }
  const cards = new Set(startedPayloads.map((p: any) => p.yourCard));
  assert(cards.size === 4, `expected 4 distinct roles, got ${[...cards].join(",")}`);

  // chat round trip
  send(clients[0]!, "chat_send", { text: "gg everyone!" });
  const chatPayloads = await Promise.all(clients.map((c) => waitFor(c, "chat_message")));
  assert(chatPayloads.every((p: any) => p.message.text === "gg everyone!"), "chat message should be broadcast to all");
  console.log("chat OK");

  // Find the mantri and make a guess
  const mantriId = startedPayloads[0]!.mantriPlayerId;
  const mantriClient = clients.find((c) => c.playerId === mantriId)!;
  const target = clients.find((c) => c.playerId !== mantriId)!;

  console.log(`\n--- mantri ${mantriClient.name} guessing ${target.name} ---`);
  const resultWaiters = clients.map((c) => waitFor(c, "round_result"));
  send(mantriClient, "make_guess", { guessedPlayerId: target.playerId });
  const results = await Promise.all(resultWaiters);
  assert(results.every((r: any) => r.round === 1), "round_result should report round 1");
  console.log("round_result OK", { isCorrect: results[0].isCorrect });

  // Round 2 should auto-deal (game_updated) then finish (DEFAULT_MAX_ROUNDS=2 in test env)
  console.log("\n--- waiting for game_finished ---");
  const finished = await Promise.all(clients.map((c) => waitFor(c, "game_finished", 15000)));
  assert(finished[0].totalRounds === 2, `expected 2 rounds, got ${finished[0].totalRounds}`);
  console.log("game_finished OK", finished[0]);
}

async function testPrivateRoomHostControls(): Promise<void> {
  console.log("\n=== Private room + host controls test ===");
  const host = await connect("Host");
  send(host, "private_room_create", { name: "Host", maxRounds: 2 });
  const created = await waitFor(host, "room_created");
  const roomId: string = created.roomId;
  assert(/^[A-Z0-9]{6}$/.test(roomId), `room code should be 6 chars alnum, got ${roomId}`);
  console.log("room code:", roomId);

  // REST preview before anyone else joins
  const previewRes = await fetch(`http://localhost:8080/api/rooms/${roomId}`);
  const preview = await previewRes.json();
  assert(preview.playerCount === 1, "preview should show 1 player");
  console.log("REST preview OK", preview);

  const p2 = await connect("P2");
  const p3 = await connect("P3");
  const p4 = await connect("P4");
  const p5 = await connect("P5-tobekicked");

  send(p2, "private_room_join", { roomId, name: "P2" });
  await waitFor(host, "player_joined");
  send(p3, "private_room_join", { roomId, name: "P3" });
  await waitFor(host, "player_joined");
  send(p5, "private_room_join", { roomId, name: "P5" });
  await waitFor(host, "player_joined");

  // kick p5, then bring in p4 as the real 4th player
  send(host, "room_kick", { targetPlayerId: p5.playerId });
  const kicked = await waitFor(p5, "kicked");
  assert(kicked.reason.length > 0, "kicked player should get a reason");
  console.log("kick OK");

  send(p4, "private_room_join", { roomId, name: "P4" });
  await waitFor(host, "player_joined");

  send(host, "room_start");
  await Promise.all([host, p2, p3, p4].map((c) => waitFor(c, "game_starting")));
  await Promise.all([host, p2, p3, p4].map((c) => waitFor(c, "game_started")));
  console.log("manual start OK");

  for (const c of [host, p2, p3, p4, p5]) c.ws.close();
}

async function testReconnect(): Promise<void> {
  console.log("\n=== Reconnect test ===");
  const a = await connect("Reconnector");
  send(a, "private_room_create", { name: "Reconnector", maxRounds: 2 });
  const created = await waitFor(a, "room_created");
  const roomId = created.roomId;

  const token = a.sessionToken!;
  a.ws.close();
  await new Promise((r) => setTimeout(r, 300));

  const resumed = await connect("Reconnector-resumed", `?token=${token}`);
  const welcome = resumed.events.find((e) => e.type === "welcome")!.payload as any;
  assert(welcome.resumed === true, "second connection should resume the session");
  assert(welcome.playerId === a.playerId, "resumed session should keep the same playerId");

  const roomState = await waitFor(resumed, "room_state");
  assert((roomState as any).room.roomId === roomId, "resumed player should get room_state for their room");
  console.log("reconnect OK");

  resumed.ws.close();
}

async function main(): Promise<void> {
  console.log("=== Random matchmaking full-game test ===");
  const clients = await Promise.all([
    connect("Alice"),
    connect("Bob"),
    connect("Carol"),
    connect("Dave"),
  ]);
  await playFullMatch(clients);
  for (const c of clients) c.ws.close();

  await testPrivateRoomHostControls();
  await testReconnect();

  console.log("\n✅ ALL SMOKE TESTS PASSED");
  process.exit(0);
}

main().catch((error) => {
  console.error("\n❌ SMOKE TEST FAILED:", error);
  process.exit(1);
});
