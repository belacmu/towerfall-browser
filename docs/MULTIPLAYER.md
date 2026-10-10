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
  players can meet desktop players.
- Lobbies use .NET's `ClientWebSocket` to `wss://tfex-server.balatro-vs-matchmaking.eu/ws`.
  **Around the TF.EX 0.19.1 release (2026-10-10, ~08:00 UTC) the server began answering 403 to
  handshakes with a browser `Origin`** (identical requests without Origin: 101). Earlier that day
  it accepted them, and two browsers met and played there. Minutes later its HTTPS front end
  stopped recognizing its own hostname ("unrecognized name"), so it may have been mid-redeploy and
  the 403 transitional; check again before concluding. If the origin check stays, online play
  from the site needs the operator to allow our origins (or a server of our own); we shouldn't
  route around it. Match signaling is
  `/room/<id>?peer=<id>` with peer ids handed out by the lobby, so a generic matchbox server
  can't stand in for it. The server isn't open source.

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
    (`web/Netplay/TfexPatches.cs`).
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
- Next: start a match between two browsers, then browser against desktop.

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
- Host commands, alongside the game's own: `profile [Type::Method ...]`, `keys` (log pressed
  keys for 10 s), `menustate N` (jump the main menu to a state, e.g. TF.EX's 63 private, 64 join
  code).
- `?command=line;line` or `towerfallCommand("line")` runs dev-console commands (TF.EX: `test`
  for the sync test). `[perf]` log lines report frame rate and milliseconds per frame spent in
  the game.
