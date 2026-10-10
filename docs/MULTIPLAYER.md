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
- Lobbies use .NET's `ClientWebSocket` to `wss://tfex-server.balatro-vs-matchmaking.eu/ws`. The
  server accepts browser origins (checked 2026-10-10). Match signaling is
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
- Next: a real lobby between two browsers (`tools/netplay-driver.mjs`), then browser against
  desktop.

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
- `?command=line;line` or `towerfallCommand("line")` runs dev-console commands (TF.EX: `test`
  for the sync test). `[perf]` log lines report frame rate and milliseconds per frame spent in
  the game.
