const BASE = "ws://localhost:8080/ws";

interface Client {
  name: string;
  ws: WebSocket;
  playerId?: string;
  sessionToken?: string;
  pending: Map<string, unknown[]>;
  waiters: Array<{ type: string; resolve: (payload: unknown) => void }>;
}

function connect(name: string, query = ""): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${BASE}${query}`);
    const client: Client = { name, ws, pending: new Map(), waiters: [] };
    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data.toString());
      console.log(`[${name}] <- ${msg.type}`, JSON.stringify(msg.payload).slice(0, 150));
      if (msg.type === "welcome") {
        client.playerId = msg.payload.playerId;
        client.sessionToken = msg.payload.sessionToken;
        resolve(client);
      }
      const wi = client.waiters.findIndex((w) => w.type === msg.type);
      if (wi !== -1) {
        const [w] = client.waiters.splice(wi, 1);
        w.resolve(msg.payload);
      } else {
        const q = client.pending.get(msg.type) ?? [];
        q.push(msg.payload);
        client.pending.set(msg.type, q);
      }
    });
    ws.addEventListener("error", reject);
  });
}

function waitFor(client: Client, type: string, timeoutMs = 8000): Promise<any> {
  const q = client.pending.get(type);
  if (q && q.length > 0) return Promise.resolve(q.shift());
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`[${client.name}] timeout waiting for ${type}`)), timeoutMs);
    client.waiters.push({ type, resolve: (p) => { clearTimeout(t); resolve(p); } });
  });
}

function send(c: Client, type: string, payload: unknown = {}) {
  c.ws.send(JSON.stringify({ type, payload }));
}

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error("ASSERTION FAILED: " + msg);
}

async function testWrongPassword() {
  console.log("\n=== Wrong password test ===");
  const host = await connect("Host2");
  send(host, "private_room_create", { name: "Host2", password: "secret123" });
  const created = await waitFor(host, "room_created");
  assert(created.hasPassword === true, "room should report hasPassword true");

  const joiner = await connect("Joiner");
  send(joiner, "private_room_join", { roomId: created.roomId, password: "wrongpass", name: "Joiner" });
  const err = await waitFor(joiner, "error");
  assert(err.code === "INVALID_PASSWORD", `expected INVALID_PASSWORD, got ${err.code}`);
  console.log("wrong password correctly rejected:", err.message);

  send(joiner, "private_room_join", { roomId: created.roomId, password: "secret123", name: "Joiner" });
  const state = await waitFor(joiner, "room_state");
  assert(state.room.roomId === created.roomId, "correct password should let joiner in");
  console.log("correct password OK");

  host.ws.close();
  joiner.ws.close();
}

async function testRandomDisbandRequeue() {
  console.log("\n=== Random match disband + auto-requeue test ===");
  const clients = await Promise.all([connect("R1"), connect("R2"), connect("R3"), connect("R4")]);
  for (const c of clients) send(c, "queue_join", { name: c.name });
  await Promise.all(clients.map((c) => waitFor(c, "match_found")));
  await Promise.all(clients.map((c) => waitFor(c, "game_starting")));
  await Promise.all(clients.map((c) => waitFor(c, "game_started")));
  console.log("match started, now R1 leaves mid-game");

  const survivors = clients.slice(1);
  const disbandWaiters = survivors.map((c) => waitFor(c, "room_disbanded"));
  const requeueStatusWaiters = survivors.map((c) => waitFor(c, "queue_status"));
  send(clients[0]!, "room_leave");

  const disbandMsgs = await Promise.all(disbandWaiters);
  assert(disbandMsgs.every((m: any) => typeof m.reason === "string"), "room_disbanded should include a reason");
  console.log("room_disbanded broadcast OK");

  await Promise.all(requeueStatusWaiters);
  console.log("survivors auto-requeued into matchmaking OK");

  for (const c of clients) c.ws.close();
}

async function main() {
  await testWrongPassword();
  await testRandomDisbandRequeue();
  console.log("\n✅ EXTRA SMOKE TESTS PASSED");
  process.exit(0);
}

main().catch((e) => {
  console.error("\n❌ EXTRA SMOKE TEST FAILED:", e);
  process.exit(1);
});
