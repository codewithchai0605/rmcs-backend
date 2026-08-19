# Protocol Reference

This backend has **no authentication**. Identity is an anonymous, per-tab
session created the moment a WebSocket connects. Everything else - matchmaking,
private rooms, chat, gameplay - happens over one WS connection to:

```
ws://<host>/ws?token=<optional>&name=<optional>&avatarId=<optional>
```

- `token` - a previously-issued `sessionToken` (see **Sessions & reconnect**
  below). Omit it on first connect.
- `name` / `avatarId` - optional initial display name / avatar. You can also
  set these later with `set_name`, or per-action (e.g. `queue_join` accepts
  its own `name`).

Every message, in both directions, is a single JSON text frame shaped like:

```json
{ "type": "some_type", "payload": { ... } }
```

---

## 1. Sessions & reconnect

The **first** message you'll always receive after connecting is `welcome`:

```json
{
  "type": "welcome",
  "payload": {
    "playerId": "uuid",
    "sessionToken": "long-random-string",
    "name": "CleverTiger36",
    "avatarId": "avatar-1",
    "resumed": false
  }
}
```

Store `sessionToken` (e.g. `sessionStorage`, since it's per-tab by design -
see note below). If the connection drops (refresh, network blip, backgrounded
tab), reconnect with `?token=<sessionToken>` and the server will:

- Restore your `playerId` (`resumed: true` in the new `welcome`).
- If you were in a room, automatically re-subscribe you and push a fresh
  `room_state`, `chat_history`, and (if a game is in progress) `game_updated`
  with your card - no need to re-request anything.

**The reconnect window is short (`DISCONNECT_GRACE_MS`, default 25s).** If you
don't reconnect within that window, you're removed from your room/queue like
a normal leave, and the token stops working. There is intentionally no
long-lived persistence - this is a casual party game, not a resumable-for-days
session.

If you were queued for a random match when you disconnected, you are dropped
from the queue immediately (no grace period) - just send `queue_join` again
after reconnecting.

> Why `sessionStorage` and not `localStorage`? Each browser tab is treated as
> a separate player by design (so you can open two tabs to test a room with
> "two players"). If you want cross-tab session persistence instead, use
> `localStorage` - it's purely a frontend choice, the backend doesn't care.

---

## 2. Client -> Server messages

| type | payload | notes |
|---|---|---|
| `set_name` | `{ name: string, avatarId?: string }` | Update display name/avatar any time. |
| `queue_join` | `{ name?: string, avatarId?: string }` | Enter random matchmaking. Errors if already in a room/queue. |
| `queue_leave` | `{}` | Leave the queue. |
| `private_room_create` | `{ name?, avatarId?, password?: string, maxRounds?: number }` | Creates a room, you become the host. `maxRounds` clamped to `[MIN_MAX_ROUNDS, MAX_MAX_ROUNDS]` (default 4-30). |
| `private_room_join` | `{ roomId: string, password?: string, name?, avatarId? }` | `roomId` is the 6-character code. |
| `room_leave` | `{}` | Leave whatever room you're currently in. |
| `room_start` | `{}` | Host-only, private rooms only. Random rooms start automatically. |
| `room_kick` | `{ targetPlayerId: string }` | Host-only, private rooms only. |
| `room_update_settings` | `{ maxRounds?: number, password?: string \| null }` | Host-only, private rooms only, waiting-room only. `password: null` removes the password. |
| `chat_send` | `{ text: string }` (max 500 chars) | Broadcast to your current room. |
| `reaction_send` | `{ emoji: string }` | Fire-and-forget emoji reaction, broadcast to the whole room including yourself. `emoji` must be one of the 8 curated options - see **Reactions** below. |
| `make_guess` | `{ guessedPlayerId: string }` | Mantri-only, during an active round. |
| `replay_request` | `{}` | Host-only, only once the game has finished. Starts a rematch vote. |
| `replay_response` | `{ accepted: boolean, requestId?: string }` | Vote on an active rematch request. |

Notes:
- You never send a `roomId` for room-scoped actions (`room_leave`,
  `chat_send`, `make_guess`, etc.) - the server already knows which room
  you're in from your session, which also means you can't spoof actions into
  a room you're not a member of.
- Unknown/malformed messages get back `{"type":"error","payload":{"code":"INVALID_MESSAGE",...}}`
  and are otherwise ignored (the connection is not closed).

---

## 3. Server -> Client events

### Identity / profile
- `welcome` - `{ playerId, sessionToken, name, avatarId, resumed }`
- `name_updated` - `{ name, avatarId }`

### Matchmaking
- `queue_status` - `{ waiting: number, needed: number }`
- `queue_left` - `{}`
- `match_found` - `{ roomId }` (fired once 4 players are matched; `room_state` follows immediately)

### Room / lobby
- `room_created` - `{ roomId, hasPassword }` (private room host only)
- `room_state` - `{ room: PublicRoom }` - full snapshot, sent on join/reconnect/create
- `room_settings_updated` - `{ room }`
- `player_joined` - `{ player, room }`
- `player_left` - `{ playerId, name, room }`
- `player_disconnected` - `{ playerId, name }` (still a member, mid reconnect-grace)
- `player_reconnected` - `{ playerId, name }`
- `creator_changed` - `{ newCreatorId, newCreatorName }` (host left, reassigned)
- `room_disbanded` - `{ reason }` (see **Random rooms are disposable**, below)
- `kicked` - `{ reason }` (sent only to the kicked player)

### Chat
- `chat_history` - `{ messages: ChatMessage[] }` (sent on join/reconnect)
- `chat_message` - `{ message: ChatMessage }`

  `ChatMessage` = `{ id, roomId, ts, senderId, senderName, senderAvatarId, text }`.
  `senderName`/`senderAvatarId` are snapshotted at send time, so chat
  history still shows the right name/avatar even if that player later
  leaves the room.

### Reactions
- `reaction` - `{ id, playerId, playerName, emoji, ts }`. Fire-and-forget:
  unlike chat, nothing is persisted or replayed on reconnect - if you weren't
  connected when it fired, you simply don't see it. The 8 allowed emoji are
  `👍 😂 😮 😢 😡 🎉 ❤️ 🔥` (see `REACTION_EMOJIS` in `src/ws/inbound.ts`);
  anything else in `reaction_send` is rejected with `INVALID_MESSAGE`.

### Gameplay
- `game_starting` - `{ countdownMs }`
- `game_started` / `game_updated` - **personalized per player**, see below
- `round_result` - `{ round, isCorrect, auto, guessedPlayerId, guessedPlayerName, chorPlayerId, chorPlayerName, roundScores, totalScores, cards }` - `cards` reveals every player's role for that round, now that it's over.
- `game_finished` - `{ rankings, winnerId, totalRounds, gameDurationMs, averageScorePerRound }`
- `game_reset` - `{ room }` (back to lobby - after a finished game auto-resets, or a mid-game player drop forces a reset)

### Replay (rematch)
- `replay_requested` / `replay_status` - `{ requestId, requestedBy, expiresAt, accepted, declined, pending, total }`
- `replay_cancelled` - `{ by }` (someone declined)
- `replay_expired` - `{}` (vote timed out)

### Misc
- `session_replaced` - `{}` (sent to an old tab/connection right before it's closed, because the same session token opened a new connection)
- `error` - `{ code, message }` - see **Error codes** below

---

## 4. Card privacy - `yourCard`, not `currentCards`

`game_started` and `game_updated` are **not** broadcast identically to
everyone. Each player receives their own message containing only their own
role:

```json
{
  "type": "game_started",
  "payload": {
    "roomId": "...",
    "gameState": "playing",
    "round": 1,
    "maxRounds": 15,
    "players": [ /* public player list, no roles */ ],
    "scores": { "playerId": 0 },
    "mantriPlayerId": "the-mantri's-playerId",
    "yourCard": "Raja"
  }
}
```

Only `mantriPlayerId` is public during the round (the Mantri has to
publicly announce a guess, so there's no secret to keep there). **Raja,
Sipahi, and Chor stay hidden** until the round resolves, at which point
`round_result.cards` reveals everyone's role for that round.

This is a deliberate change from a typical naive implementation that
broadcasts the full role map to the whole room the moment cards are dealt,
which would let every player - including the Mantri - simply read off who
the Chor is instead of guessing. If your frontend design wants Raja/Sipahi
revealed immediately for flavor, that's a one-line change in
`roomManager.buildGameRoundView()`.

---

## 5. Random rooms are disposable

Private rooms tolerate players coming and going in the lobby - the code
still works, the host can wait for a replacement. Random-matched rooms
have no such recovery path (there's no code to share), so if a random
room ever drops below 4 players for any reason (leave, kick n/a for random,
disconnect timeout), the **whole room is disbanded** and every remaining
connected player is automatically dropped back into the matchmaking queue.
You'll see `room_disbanded` followed by fresh `queue_status` updates.

---

## 6. Round auto-resolve

If the Mantri doesn't guess within `ROUND_GUESS_TIMEOUT_MS` (default 45s),
the server picks a random target on their behalf and resolves the round
anyway (`round_result.auto: true`). This keeps a game from hanging forever
if the Mantri is AFK or disconnected.

---

## 7. Error codes

Sent as `{"type":"error","payload":{"code":"...","message":"human readable"}}`.

`INVALID_MESSAGE`, `RATE_LIMITED`, `NOT_AUTHENTICATED`, `ALREADY_IN_ROOM`,
`ALREADY_IN_QUEUE`, `NOT_IN_ROOM`, `NOT_IN_QUEUE`, `ROOM_NOT_FOUND`,
`ROOM_FULL`, `ROOM_LOCKED`, `INVALID_ROOM_CODE`, `INVALID_PASSWORD`,
`NOT_ROOM_CREATOR`, `GAME_ALREADY_STARTED`, `GAME_NOT_IN_PROGRESS`,
`GAME_NOT_FINISHED`, `NOT_ENOUGH_PLAYERS`, `NOT_YOUR_TURN`,
`REPLAY_NOT_ACTIVE`, `REPLAY_ALREADY_ACTIVE`, `REPLAY_ALREADY_RESPONDED`,
`INVALID_TARGET`, `SERVER_AT_CAPACITY`, `INTERNAL_ERROR`.

`ROOM_NOT_FOUND` and `INVALID_PASSWORD` intentionally share the same message
text ("Invalid room code or password") so a brute-force attempt against a
private room code can't distinguish "wrong code" from "right code, wrong
password".

---

## 8. Rate limits

Enforced server-side per player/session (see `src/middleware/rateLimiter.ts`
for the full table, easy to retune):

| action | limit |
|---|---|
| any message (flood guard) | 40 / 10s |
| `chat_send` | 8 / 8s |
| `reaction_send` | 20 / 15s |
| `private_room_create` | 5 / 60s |
| `private_room_join` | 10 / 60s |
| most other actions | 5-10 / 30s |

Plus connection-level limits: max `MAX_CONNECTIONS_PER_IP` (default 8)
concurrent WS connections per IP, and a 60 req/min limiter on the small
HTTP surface (`/health`, `/api/rooms/:code`).

---

## 9. HTTP surface

- `GET /health` - status, uptime, room/session/connection counts.
- `GET /api/rooms/:code` - lets the frontend check a private room code
  exists (and whether it needs a password) before opening a WebSocket to
  join it. Never reveals the password itself.

Both are read-only and CORS-enabled for origins in `ALLOWED_ORIGINS`.

---

## 10. Voice chat (Cloudflare Calls)

Voice audio never touches this server - it flows directly between each
client and Cloudflare's SFU over WebRTC. This server only does two things:

1. **Signaling** (over the existing WS connection) - two client->server
   message types layered onto the existing room:
   - `voice_published` - `{ sessionId, trackName }`, sent once a client has
     negotiated its Cloudflare Calls session and pushed its mic track.
     Broadcasts `voice_participant_published` - `{ playerId, sessionId, trackName }`
     - to the room so everyone else can pull that track.
   - `voice_unpublish` - `{}`, sent when leaving voice. Broadcasts
     `voice_participant_left` - `{ playerId }`.
   - `voice_mute` - `{ muted }`. Broadcasts `voice_participant_muted` -
     `{ playerId, muted }`.

   These fields also ride along on `PublicPlayer` (`voiceSessionId`,
   `voiceTrackName`, `voiceMuted`) inside every `room_state`/`player_joined`/
   `player_left`, so a newly-joined or reconnected client immediately knows
   who already has voice active without a separate "list participants" call.

2. **A thin authenticated proxy** to Cloudflare's Calls HTTPS API, since the
   App Token must stay server-side:
   - `POST /api/voice/session`
   - `POST /api/voice/session/:sessionId/tracks`
   - `PUT /api/voice/session/:sessionId/renegotiate`
   - `PUT /api/voice/session/:sessionId/tracks/close`

   Every call requires an `X-Session-Token` header matching a live WS
   session (see `sessionRegistry`), and returns `503 VOICE_NOT_CONFIGURED`
   if `CLOUDFLARE_APP_ID`/`CLOUDFLARE_APP_TOKEN` aren't set.