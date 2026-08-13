# Raja Mantri Chor Sipahi - Backend

Realtime backend for the 4-player Raja/Mantri/Chor/Sipahi party game.
Rewritten from the original Express + Socket.IO + MongoDB/Firebase backend
into a single dependency-light TypeScript service on top of
[uWebSockets.js](https://github.com/uNetworking/uWebSockets.js).

**No authentication.** Players are anonymous per-tab sessions. Two ways to
play:

- **Random** - join a FIFO matchmaking queue, get matched into a room the
  instant 4 players are waiting, game auto-starts.
- **Private** - create a room, get a 6-character shareable code, friends
  join with the code (optionally password-protected). Host controls round
  count, password, kicking, and manual start.

In-room text chat is included. There is no voice chat.

For the full message-by-message contract, see **[docs/PROTOCOL.md](docs/PROTOCOL.md)**.

---

## Requirements

- Node.js >= 20 (built/tested on Node 22)
- npm

`uWebSockets.js` is installed straight from its GitHub release (it's not
published with prebuilt binaries to the public npm registry), which is
already wired up in `package.json`:

```json
"uWebSockets.js": "github:uNetworking/uWebSockets.js#v20.51.0"
```

## Getting started

```bash
npm install
cp .env.example .env     # tweak as needed - sensible defaults work out of the box
npm run dev               # tsx watch mode
# or
npm run build && npm start
```

The server listens on `PORT` (default `8080`) at path `/ws` for WebSocket
connections, plus a tiny HTTP surface (`/health`, `/api/rooms/:code`).

### Verifying it works

Two end-to-end smoke test scripts are included (they open real WebSocket
connections against a running server - start the server first):

```bash
npm run build && npm start &
npx tsx scripts/smoke-test.ts     # full random match + private room + reconnect
npx tsx scripts/smoke-test-2.ts   # wrong password + random-room disband/requeue
```

Both scripts assert on the actual protocol responses (roles dealt, scores,
rankings, error codes, etc.) rather than just "did it crash", so they double
as a live protocol reference if `docs/PROTOCOL.md` ever falls out of date.

## Type checking

```bash
npm run typecheck
```

Strict TypeScript throughout (`strict`, `noUncheckedIndexedAccess`,
`noImplicitReturns`, etc. - see `tsconfig.json`). No `any` outside a single,
commented dispatch table in `src/handlers/index.ts` where a discriminated
union is fanned out to per-type handlers.

---

## Environment variables

All of these have working defaults - copy `.env.example` and adjust only
what you need. See `src/config/env.ts` for the authoritative list.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | Listen port |
| `HOST` | `0.0.0.0` | Listen host |
| `ALLOWED_ORIGINS` | `*` | Comma-separated allow-list checked against the `Origin` header at WS upgrade and on HTTP CORS. Set this to your real frontend origin(s) in production. |
| `SSL_KEY_FILE` / `SSL_CERT_FILE` | unset | If both are set, the server listens with TLS (`SSLApp`) instead of plain `App`. Usually you'd terminate TLS at a reverse proxy instead and leave these unset. |
| `ROOM_SIZE` | `4` | Players per game. The game logic (roles, scoring) assumes exactly 4 - don't change this without also revisiting `src/game/logic.ts`. |
| `DEFAULT_MAX_ROUNDS` | `15` | Rounds per game for random matches (private rooms can configure their own via `maxRounds`). |
| `MIN_MAX_ROUNDS` / `MAX_MAX_ROUNDS` | `4` / `30` | Clamp range for a private room's configured round count. |
| `MAX_PRIVATE_ROOMS` | `500` | Simple capacity guard for `private_room_create`. |
| `ROUND_GUESS_TIMEOUT_MS` | `45000` | If the Mantri doesn't guess in time, the server auto-guesses so the game can't hang. |
| `ROUND_RESULT_DISPLAY_MS` | `4000` | Pause after a round resolves before dealing the next one. |
| `ROUND_START_COUNTDOWN_MS` | `3000` | Countdown shown before a game starts. |
| `REPLAY_TTL_MS` | `30000` | How long a rematch vote stays open before expiring. |
| `POST_GAME_AUTO_RESET_MS` | `30000` | How long a finished room sits before auto-resetting to the lobby (if no rematch vote happens). |
| `EMPTY_ROOM_SWEEP_MS` | `300000` | How often the background sweep checks for orphaned empty rooms. |
| `STALE_ROOM_MAX_AGE_MS` | `600000` | How old an empty room needs to be before the sweep deletes it. |
| `DISCONNECT_GRACE_MS` | `25000` | How long a dropped connection can reconnect (via `?token=`) and keep their seat. |
| `SESSION_SWEEP_MS` | `60000` | Background safety-net sweep interval for orphaned sessions. |
| `CHAT_HISTORY_LIMIT` | `200` | Messages kept per room, sent as `chat_history` on join/reconnect. |
| `CHAT_MESSAGE_MAX_LENGTH` | `500` | Max chat message length. |
| `MAX_CONNECTIONS_PER_IP` | `8` | Concurrent WS connections allowed per IP. |
| `WS_MAX_PAYLOAD_BYTES` | `16384` | Max inbound WS message size. |
| `WS_IDLE_TIMEOUT_S` | `60` | uWS idle timeout (pings are sent automatically). |
| `WS_MAX_BACKPRESSURE_BYTES` | `1048576` | uWS backpressure limit per socket. |
| `TRUST_PROXY_HEADERS` | `false` | Set `true` if running behind a reverse proxy that sets the PROXY protocol / forwarded headers, so client IPs (used for rate limiting) are read correctly. |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |

---

## Architecture

```
src/
  config/env.ts          Typed env loading (tiny built-in .env parser, no dotenv dependency)
  core/                   Logging, IDs, sanitization, errors, IP/origin helpers
  game/
    types.ts              Domain types (Room, Player, Role, ...)
    logic.ts               Pure game mechanics: dealing, scoring, rounds, replay state
    roomManager.ts          Orchestration: room lifecycle, timers, broadcasting
    publicView.ts            Client-safe serialization (never leaks password, internal timers, etc.)
  matchmaking/queue.ts     FIFO random-match queue
  ws/
    types.ts               Socket user-data shape
    inbound.ts               zod schemas for every client->server message
    outbound.ts               Discriminated union of every server->client event
    sessionRegistry.ts        Anonymous session tracking + reconnect/grace-period logic
    publish.ts                 uWS pub/sub topic helpers
    connection.ts               upgrade/open/message/close wiring
  handlers/                One file per feature area, dispatched from handlers/index.ts
  middleware/               Rate limiting (generic sliding window) + per-IP connection cap
  http/routes.ts           /health and /api/rooms/:code
  server.ts                Builds the uWS app
  index.ts                 Entrypoint + graceful shutdown
```

Key design choices worth knowing about:

- **Room-scoped actions never take a `roomId` from the client.** The server
  resolves "which room is this player in" from their session, both to keep
  the protocol simpler and so a client can't reference a room it isn't in.
- **Personalized round payloads.** `game_started`/`game_updated` are sent
  individually per player (not via the room-wide pub/sub topic) so each
  player only ever sees their own card - see `docs/PROTOCOL.md` §4 for why
  this matters.
- **Random rooms are disposable.** If a random match drops below 4 players,
  the room is disbanded and survivors are auto-requeued, since (unlike
  private rooms) there's no shareable code to backfill with. See
  `docs/PROTOCOL.md` §5.
- **Single-process, in-memory state.** Rooms, the matchmaking queue, and
  sessions all live in memory in this one process - no Redis, no database.
  That's intentional for this deployment target; if you outgrow one process,
  the natural next step is moving `roomManager`'s `Map`s and the matchmaking
  queue behind a shared store with pub/sub for cross-instance broadcasting,
  but that's a real architectural change, not a config flag.
- **Session tokens, not auth.** A `sessionToken` is a capability to resume
  *your own* anonymous session (see `docs/PROTOCOL.md` §1) - it identifies a
  session, it does not authenticate a person.

## What changed vs. the old backend

- Socket.IO -> uWebSockets.js.
- Removed: auth/JWT, MongoDB, Firebase, friends/online-users, room invites,
  WebRTC voice signaling, global lobby chat - none of that applies to an
  anonymous, room-scoped, text-only game anymore.
- Added: random matchmaking queue (the old backend only had explicit
  create/join), 6-character shareable private room codes, session-token
  reconnect with a grace period, host controls (kick, settings, password),
  round auto-resolve on Mantri timeout, per-player card privacy (see above),
  auto-requeue when a random match breaks, and consistent rate limiting +
  per-IP connection caps.
- Keeps the original scoring model (Raja 1000 / correct Mantri 800 / correct
  Chor evades for 800 / Sipahi 500) and overall round flow.
