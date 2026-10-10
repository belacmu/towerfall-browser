# Online multiplayer

Online play uses **TF.EX** (DShad/Fcornaire, GPL-2.0), the FortRise netplay mod: GGRS rollback
netcode, lobbies and matchmaking on its official server, WebRTC between players. The site hosts a
pinned release (`tools/fetch-tfex.sh`, see `docs/MODS.md`); the page lists it as "Online play
(TF.EX)".

## How it fits together

- TF.EX's C# side runs unchanged under FortRise in the browser.
- Its native library, `ggrs_ffi` (Rust: GGRS + matchbox_socket), is built for
  `wasm32-unknown-emscripten` by `tools/build-netplay.sh` and linked into the app. A browser
  fixup makes FortRise's mod load context decline native libraries, so the runtime finds the
  linked-in one.
- matchbox_socket is replaced by `netplay/matchbox-browser`, which calls `netplay/tfnet.js`: the
  page's WebSocket signaling and WebRTC data channel, speaking matchbox's protocol so browser
  players can meet desktop players. Before connecting it asks the signaling server's `/turn` for
  ICE servers (cached for an hour); if that fails (any server but ours), it uses Google's STUN.
  Its offers and answers carry the candidates gathered in the first second and trickle the rest:
  waiting for gathering to complete took about 40 s whenever one STUN/TURN request went
  unanswered (UDP to port 443 is dropped on some networks, now and then on others), and TF.EX
  gives players 20 s to connect, so they sat at "waiting for other players" and were sent back
  to the menu.
- Every call into tfnet.js waits for the page's main thread, and ggrs-ffi polls many hundreds of
  times a second. So each socket (and each lobby WebSocket) shares counters in wasm memory that
  the page bumps when something arrives or changes, and polls whose counter didn't move return
  without calling the page. In an idle match that took each player from ~2,400 calls a second to
  ~700 (packet sends and reads), and the main thread from ~54 to ~42 ms busy per second.
- Lobbies use .NET's `ClientWebSocket` to TF.EX's server setting plus `/ws`. TF.EX's official
  server (`wss://tfex-server.balatro-vs-matchmaking.eu`) **turns browsers away**: since the TF.EX
  0.19.1 release (2026-10-10, ~08:00 UTC) a handshake carrying an `Origin` header gets 403 (by
  ~09:00 UTC, 400), whatever the origin, while the same request without one gets 101. Browsers
  always send Origin and desktop TF.EX never does. Earlier that day two browsers met and played
  there. We don't route around it (no Origin-stripping proxy); allowing browsers is the
  operator's call. So **the site runs its own TF.EX-compatible server** (below), and the page
  points browser players at it.

## Our server (`cloudflare/tfex-server`)

Deployed at **`wss://tfex-server.tf-bd1030ec.workers.dev`** (2026-10-10), the site's default. A
server implementing what TF.EX's client uses, written from TF.EX's GPL client source at
v0.19.1 (`src/network/TF.EX.Domain/Services/MatchmakingService.cs`, the message models in
`Models/WebSocket/`, and the menus that drive them). The official server isn't open source, so
where the client leaves room the choices below are ours. Desktop TF.EX can use it too: set TF.EX's
SERVER option (Mod options) to its `wss://` address.

- `matchmaker.js`: matchmaking at `/ws` (lobbies, join codes, quick play, end-of-match votes,
  series).
- `signal.js`: match signaling at `/room/<roomId>?peer=<peerId>` and lobby ping measurement at
  `/ping_measurement/<roomId>?peer=<peerId>`: matchbox 0.12's protocol (`IdAssigned`, `NewPeer`,
  `PeerLeft`, `Signal`; `"KeepAlive"` ignored), except that the peer id comes from the URL (the
  lobby hands them out and GGRS matches seats to them) instead of being random. Without `?peer=`
  it is random, like stock matchbox. Each room is a full mesh of up to 16 peers.
- `routes.js`: the endpoints and allowed origins. Browsers may connect from
  `https://belacmu.github.io` and from `http://localhost` / `http://127.0.0.1` on any port, plus any in
  `ALLOWED_ORIGINS` (comma-separated, `*` for any page). Connections without an Origin (desktop
  TF.EX) are always accepted. Other origins get 403; a peer id that isn't a UUID gets 400.
- `worker.js` + `wrangler.toml`: the Cloudflare deployment. A Worker routes `/ws` to one
  `MatchmakerObject` Durable Object (it holds every lobby, so join codes and quick play are
  global) and each signaling room to its own `SignalRoomObject`. Both use WebSocket hibernation:
  sockets stay open while the object sleeps, connection state rides along as socket attachments,
  and lobbies are stored (`room:<id>`) so they survive. A redeploy disconnects everyone.
- `turn.js`: `GET /turn` (CORS, same origins as above) returns `{"iceServers": [...]}` for the
  browser's peer connections: Cloudflare STUN plus TURN relay credentials valid for 6 hours,
  generated with the Cloudflare Realtime TURN key in the `TURN_KEY_ID` and `TURN_KEY_API_TOKEN`
  secrets (key `tfex-server`, created 2026-10-10; `cf realtime turn keys list`). Without them, or
  if Cloudflare's API fails, STUN only. STUN alone is enough when both players' routers allow a
  direct path (the same network always does), but not behind stricter NATs (common on mobile
  carriers and some ISPs): there both players sat at "waiting for other players" until TF.EX
  gave up with a connection failure. The relay is used only when no direct path works.
- `local.mjs`: the same code under Node (18+, no dependencies), for development or self-hosting.
- `test.mjs`: protocol tests (17) that talk to a server the way TF.EX and matchbox do, plus
  in-process tests of the timed flows with a simulated clock. `node test.mjs` starts `local.mjs`;
  `node test.mjs --url ws://127.0.0.1:8787` tests another (e.g. `wrangler dev`, or a deployment).
- `TFEX_PROTOCOL`: the TF.EX version the server was checked against. The hourly TF.EX updater
  (`tools/update-tfex.py`) won't adopt a release whose message models or `MatchmakingService.cs`
  changed since then; it opens an issue instead.

### Running it

```bash
node cloudflare/tfex-server/local.mjs        # ws://127.0.0.1:3000, TF.EX's LOCAL setting
node cloudflare/tfex-server/test.mjs         # protocol tests
cd cloudflare/tfex-server && npx wrangler dev --port 8787   # the Durable Object version, locally
```

`local.mjs` takes `--port`, `--host` (default `127.0.0.1`; `0.0.0.0` to serve a network),
`--origins a,b` (extra allowed pages) and `--verbose` (logs lobbies). Deploying:
`cd cloudflare/tfex-server && npx wrangler deploy`, then put its `wss://` address in `TFEX_SERVER`
in `web/wwwroot/main.js`.

### Choosing the server in the browser

The page passes `TFEX_SERVER` (from `main.js`) to the game, and `web/Netplay/TfexPatches.cs` makes
TF.EX's OFFICIAL setting (its default, and RESET in its options) mean that server in the browser;
the options show it as BROWSER. LOCAL and CUSTOM choices stand. `?tfexserver=local`
(`ws://127.0.0.1:3000`), `?tfexserver=official`, or `?tfexserver=wss://…` picks a server for the
visit, whatever is saved. While `TFEX_SERVER` is empty, TF.EX's own setting applies.

TF.EX checks for updates only when it uses the official server (`NetplayPreferences.IsOfficialServer`),
so with ours it goes straight to the netplay menu: no GitHub request, no "requires version" gate.
The site pins TF.EX, so browsers always match each other; a desktop player on another TF.EX
version gets TF.EX's own version-mismatch notice when joining (it compares lobby mods).

### Protocol coverage

Messages are JSON objects whose first key is the message name; TF.EX recognizes ours by that
prefix (`{"LobbyUpdate"`), and sends its own as binary frames. Lobbies use TF.EX's PascalCase
fields, messages snake_case. TF.EX parses JSON through MessagePack, so integers stay integers and
collections are never null.

| Client message | Server |
|---|---|
| (connect) | `KeepAlive` at once, then every 30 s (TF.EX echoes it); silent for 100 s: dropped |
| `Identify` | remembers the name; no reply (none expected) |
| `CreateLobby` | keeps TF.EX's own room id (the host already uses it for its room URL); host gets a UUID peer id, seat 0; new seed; private lobbies get a 5-character code (TF.EX's alphabet: A–Z without I/O, 2–9). `CreateLobbyResponse` |
| `JoinPrivate` / `JoinLobby` | the joiner is added first (lowest free seat, or as a spectator), then `PrivateJoinResult` / `JoinLobbyResponse`, then `LobbyUpdate` to everyone. Players can't join a running match or series; spectators can, and the host gets `SpectatorJoined`. `JoinLobby` only reaches public lobbies |
| `GetLobbies` | public (Standard) lobbies, including running ones (shown as spectate-only) |
| `UpdatePlayer` | takes archer, ready, team, mods, input delay…; keeps peer id, seat, host and name. Always answered with `LobbyUpdate` (TF.EX locks its controllers until then) |
| `UpdateLobbySettings` | host only, not in a match or series; keeps seed and series length; never below the current players (3+ for team deathmatch); un-readies everyone |
| `StartLobbyChoice` | host only, everyone ready (two real teams in team deathmatch): new seed, `InGame`, then `LobbyUpdate` and `StartLobby` |
| `MatchEnded` | opens the 30 s vote; in a series, the first report is the result |
| `RematchLobbyChoice` / `ArcherSelectChoice` / `SeriesContinueChoice` | votes (`Rematch` / `ArcherSelect` / `Continue` in `EndGameChoice`). When all have voted, or after 33 s: all rematch → `LobbyUpdate` (new seed) then `RematchLobby`; a series → `SeriesLobby`; otherwise `ArcherSelectLobby` (un-ready, back to archer select, as TF.EX 0.19.1's changelog says for players who don't choose) |
| `SeriesPickMap` | the side that lost the last game picks an unplayed tower (refused picks get the lobby back). The next game starts by itself once everyone is ready and the tower is set, or after 60 s with a random unplayed tower; a finished series restarts when everyone readies again. The server picks game 1's tower, since `MatchEnded` doesn't say which was played. A player leaving aborts the series (`PLAYER LEFT`) |
| `EnterQuickPlay` / `ExitQuickPlay` | `QuickPlayStatus` counts to everyone searching; the first two with the same screen width (WiderSet) are matched into a `QuickPlay` lobby (`QuickPlayMatchFound`); it starts by itself 1.5 s after both have picked |
| `SkinChunk` | relayed to the rest of the lobby with `from` = the sender's peer id |
| `LeaveLobby` / disconnect | removed; `LeaveLobbyResponse`. When the host leaves, the others get one hostless lobby (TF.EX's cue that the host left) and the lobby closes: no host migration, since the host's GGRS role is fixed |

Not done: quick play for more than two players, a timeout for quick-play players who never pick
an archer, checking that both players report the same result. Tested end to end in browsers: a
private lobby (create, join by code, ping measurement, archer select, start, a running match), on
both `local.mjs` and `wrangler dev`. End-of-match votes, series and quick play are covered by the
protocol tests only.

### Costs (Cloudflare free plan)

SQLite-backed Durable Objects are on the free plan: per day, 100,000 requests (incoming WebSocket
messages count 1/20 each), 13,000 GB-s of duration and 100,000 rows written (one per lobby
change). Past a limit, requests fail until 00:00 UTC; the free plan never bills. Hibernation means idle lobby connections cost nothing; the 30 s keep-alive wakes the
matchmaker briefly. Match signaling is busy only while peers connect (the match itself is
peer-to-peer), but matchbox clients send a keep-alive every 10 s, which keeps a room's object
awake for the match: about 75 GB-s for a 10-minute match, so roughly 170 such matches a day fit.

TURN relaying is billed per GB sent from Cloudflare to players, at $0.05/GB past 1,000 GB a month
free (shared with the Realtime SFU, which we don't use). A relayed 10-minute two-player match
moves tens of MB, and only matches without a direct path use it, so it stays free. The $1 budget
alert on the account covers surprises; `/turn` hands credentials to anyone who asks (an Origin
header is easy to fake), so a key can be deleted and replaced if they're ever abused.

## Status (2026-10-10)

- TF.EX 0.19.0 (with TF.State, TF.Replay, TF.InputDisplayer) loads under FortRise 5.5.0-beta.3,
  and the title screen runs at 60 fps.
- The rollback sync test (`?command=profile;test`) runs. TF.EX runs online sessions at a fixed
  240 ticks/s (`Constants.NETPLAY_FPS`, the same for every player), so there are 4.17 ms per tick.
  The profiler (Harmony timers; `profile` command) shows where the time goes in the browser:

  | per call | ms |
  |---|---|
  | `Level.Update` (one simulation tick) | 0.26 |
  | `TfStateApi.CaptureGameState` (save; `GetState` 0.48 of it, MessagePack + LZ4 the rest) | 0.64 |
  | `TfStateApi.RestoreGameStateBytes` (rollback load; `LoadState` 0.86 of it) | 1.05 |
  | `Level.Render` (once per 60 Hz frame) | 0.6 |

  The simulation is cheap; TF.State's state copying dominates. A real match saves state every tick
  and rolls back only on mispredicted input: about 0.9 ms per tick plus about 1 ms plus 0.9 ms per
  resimulated tick per rollback, which fits. The sync test rolls back every tick (about 3 ms per
  tick). It mostly holds 40–45 fps but falls into long catch-up frames after hitches (TF.EX
  catches up missed ticks against the real-time clock).
- (Early estimates of 2.6 ms per tick came from instant-replay rebuild timings, which include a
  state load and save per frame.)
- Measured on a machine also running heavy antivirus scans.
- **Two browsers meet on the official server** (2026-10-10). Browser A created a private lobby
  and browser B joined it with the code. TF.EX's ping measurement then connected the two peers
  directly over WebRTC (through `netplay/tfnet.js`). A match itself hasn't been started yet.
- Getting there took these browser fixes:
  - TF.EX's update check reads GitHub's API (its release redirect can't be read cross-origin, and
    the official server needs the check to pass); its self-update is turned off
    (`web/Netplay/TfexPatches.cs`). (With our server there's no update check.)
  - Emscripten 3.1.56 hands page events (keys, mouse) to SDL's thread, our game thread,
    *synchronously*. TF.EX blocks the game thread while it connects to the server or to peers,
    so the page froze at the next key-up. `_emscripten_run_callback_on_thread` is replaced with
    an asynchronous version (`web/Native/Emscripten.c`), as in later Emscripten. That also fixes
    a leak of every event's data.
  - .NET's browser WebSocket completes on the thread owning the page's JS context (the game
    thread), so a blocked game thread could never see its connection open. ClientWebSocket now
    runs over a polled page WebSocket (`web/Netplay/PolledWebSocket.cs`, `tfws_*` in tfnet.js).
  - Emscripten copies JS library objects into the build as source text, which turned
    `new Map()` into `{}` and broke tfnet.js; the maps are now created at startup.
  - SDL's clipboard is internal to the page, so lobby codes TF.EX copies also go on the system
    clipboard, and pasting on the page feeds SDL's clipboard.
- **Two browsers played a match through our own server** (2026-10-10, after the official server
  began refusing browsers): private lobby, join by code, archer select, start, "Netplay session
  etablished" on both, with `local.mjs` and with the Durable Object version under `wrangler dev`.
- The server is deployed (Cloudflare) and the site uses it by default.
- Next: browser against desktop on it; end-of-match votes, series and quick play in real browsers.

## Ways to get more speed

1. **TF.State's `GetState`/`LoadState`.** Browser-side patches could copy state with less
   reflection and fewer allocations. Saved states stay local (GGRS only exchanges inputs), but
   any checksums compared between players must stay identical.
2. **Jiterpreter tuning.** A larger table made no difference. Trace stats
   (`?runtime=--jiterpreter-stats-enabled`) would show what isn't being compiled. Its `jit-call`
   and `interp-entry` features are unavailable in multithreaded builds.
3. **Compiling game code in the player's browser** (research, 2026-10-10). Two options:
   - Mono's AOT compiler plus LLVM/wasm-ld running in the browser, relinking the runtime with the
     game's code: 2–4× on hot code, 40–100 MB of toolchain, nobody has done it. Harmony-patched
     methods would have to stay interpreted.
   - Extending the jiterpreter to whole methods: novel compiler work.

   Dead ends: NativeAOT-LLVM (can't share Mono's heap or detour); decompiling and recompiling
   (still interpreted); CheerpX. CoreCLR on wasm won't be ready before .NET 12 (late 2027).
   Comparable ports (celeste-wasm, terraria-wasm) stayed on the interpreter plus jiterpreter to
   keep mods. Not needed while real matches fit the budget.

## Testing tools

- `tools/probe-page.mjs`: one headless browser; streams the in-page log.
- `tools/netplay-driver.mjs`: several headless browsers (separate profiles), controlled over HTTP
  (keys, screenshots, log, eval), for lobby tests.
- Lobby codes containing X can't be typed with the driver's `type` (X is also the menu's back
  key): put the code on the game's clipboard with
  `wasm.exports.BrowserHost.SetClipboardText("CODE")` (driver `eval`), then press `ShiftLeft`
  (paste) and `c` on the join screen.
- Host commands, alongside the game's own: `profile [Type::Method ...]`, `keys` (log pressed
  keys for 10 s), `menustate N` (jump the main menu to a state, e.g. TF.EX's 63 private, 64 join
  code).
- `?command=line;line` or `towerfallCommand("line")` runs dev-console commands (TF.EX: `test`
  for the sync test). `[perf]` log lines report frame rate and milliseconds per frame spent in
  the game.
