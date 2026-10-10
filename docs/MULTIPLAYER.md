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
- The rollback sync test (`?command=test`) runs, but **too slowly**. TF.EX runs online sessions
  at a fixed 240 ticks/s (`Constants.NETPLAY_FPS`, the same for every player, so the browser
  can't lower it). That leaves 4.17 ms per tick. In the browser's interpreter:
  - one simulation tick (instant-replay rebuilds: 210 ticks in 500–650 ms) costs ~2.6 ms;
  - sync test (save, load and two resimulations per tick) costs ~6 ms per tick, about 23 ms per
    60 Hz frame.

  TF.EX catches up on missed ticks against the real-time clock. When ticks cost more than real
  time, every frame owes more ticks than the last (a spiral of death): the game keeps
  simulating but frames stop finishing. Real matches roll back less than the sync test, but
  with ~3 ms per tick before state saves and rollbacks there's no headroom.
- Measured on a machine also running heavy antivirus scans, so the numbers are rough; still,
  the gap is about 2×, not 10%.
- Not yet tried: a real lobby between two browsers (`tools/netplay-driver.mjs` drives two
  headless players), or browser against desktop.

## Ways to get the speed

1. **Profile TF.EX's per-tick work** in the interpreter: reflection (`DynamicData`), state capture
   and serialization, logging. These may cost more in the browser than on desktop and could be
   cut down with browser-side patches.
2. **Tune the jiterpreter** (the interpreter's JIT to WebAssembly). The larger table size made no
   difference; trace stats would show what isn't being compiled. `?runtime=` passes Mono
   options.
3. **Ahead-of-time compilation**, the big lever (several times faster). The public site can't
   ship it for game code, since the patched game is built in the player's browser. A private
   build that hosts the game files could, but runtime patches by Harmony mods don't apply to
   AOT-compiled methods. TF.EX itself uses Harmony.
4. **A lower tick rate for browser-only matches.** This would need TF.EX changes and wouldn't
   interoperate with desktop players.

## Testing tools

- `tools/probe-page.mjs`: one headless browser; streams the in-page log.
- `tools/netplay-driver.mjs`: several headless browsers (separate profiles), controlled over HTTP
  (keys, screenshots, log, eval), for lobby tests.
- `?command=line;line` or `towerfallCommand("line")` runs dev-console commands (TF.EX: `test`
  for the sync test). `[perf]` log lines report frame rate and milliseconds per frame spent in
  the game.
