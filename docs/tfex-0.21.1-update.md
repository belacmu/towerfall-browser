# TF.EX 0.19.2 → v0.21.1 (browser and tfex-server), 2026-10-17

Why: both this port and the Switch mod (switch-online) follow the latest TF.EX. 0.19.2's TF.State restores some
states wrongly after a rollback, and those are live desync sources against the Switch: an arrow's CannotHit when its
shooter is dead, a caught arrow with a full quiver, a lantern's chain, brambles, and a bolt catch.
Source of the task list: switch-online `docs/research-tfex-feature-gaps.md` sections V and B.

`tools/update-tfex.py --check` lists what blocks an update automatically. For v0.21.1 it reported two things:
- the bundled ggrs-ffi moved (v2.1.0);
- the lobby protocol changed.

## 1. Native lib (netplay/, tools/build-netplay.sh)
- ggrs-ffi cf60182 → **2fe64d9** (v2.1.0, what v0.21.1 bundles):
  - `ping_measurement_start/stats/stop` gained an `is_relay` bool;
  - `NetplayServerConfig.relay_url/relay_peers` and `NetplaySpectatorConfig.relay_url`;
  - a new transport layer (`transport.rs`) that routes per peer between WebRTC and TF.EX's relay (`relay.rs`).
- TF.EX's relay is a WebSocket control channel plus **UDP** game packets. Neither a browser nor a Worker can do UDP.
  **v0.21.1 always sets RelayUrl** (`ApplyRelay`), so `open_routed` always runs, and the native lib always connects to the relay.
  - The browser build therefore swaps `relay.rs` for a stub (`relay_browser.rs`): it never connects, never reaches a peer, and
    its connection future never ends. Every peer stays on WebRTC (or on our own `/relay/` WebSocket relay for Switch lobbies).
  - `async-tungstenite` moves to non-Emscripten targets.
- GGRS fork 12a2d47 → **c510c22**: inputs are sent in batches, and acks are piggybacked on input packets or delayed 2 frames.
  - The message types are unchanged, so the wire format stays the same. An old peer, or ggrs-switch, still understands both.
  - The spectator send window grew from 64 to 240.
- `GgrsFfiImports.cs`: the three new signatures (the WebAssembly P/Invoke glue is generated from them).
- `netplay_set_pending_checksum` (`?digest=1`) is kept.

## 2. TF.EX zip
- `tools/fetch-tfex.sh` pins v0.21.1 (pin and sha256).
- FortRise: v0.21.1 asks for 5.5.0-beta.2. We run beta.3, which satisfies that; still to confirm that it loads.

## 3. Browser patches, re-targeted
- **SwitchLobby**: seats come from `Lobby.SessionPlayers` (`MatchPlayers` when the server sends it, otherwise `Players`).
  - `ServerConf.RelayUrl` is cleared in a Switch-relay session (belt and braces: the stub ignores it anyway).
- **TfexFps, the 240/60 unit bug**: TF.EX's lobby values are in 240 Hz ticks: the published `InputDelay`, `SeriesInputDelay`,
  the advisor's `_sessionInputDelay`, and `ToFrames`. The browser rescaled only `ToFrames`.
  - Fix: TF.EX's units stay 240 Hz everywhere, and the conversion happens once, where the delay enters GGRS: the
    `GGRSConfig.InputDelay` and `MaxInputDelay` getters on a SERVER config, `ceil(v * fps / 240)`.
  - The `ToFrames` and advisor `FrameMs` rescaling goes away.
  - The published value is then correct for the Switch, and an advisor- or series-chosen delay is no longer 4× too long at 60 Hz.
- **GameplayDigest**: the hook points (`SaveGameState`, `GetEventAndUpdate`) are unchanged.
  - The DESYNC-ends-match rule is already in 0.19.2, so a one-sided digest behaves as before.
- **ReplayRecordFix**: an IL hash of `RemovePredictedRecords`. Re-check it and update it if the method changed.
- **ReplayKeyStates**: check it against TF.Replay's settings.
- **TfexPatches, TickCatchUp, AheadThreshold, StateSpeedups, DirectFields**: confirm each one still finds its targets (each logs
  a "MISSING" or "not as expected" message).
- **DLC gate**: `GameData.DarkWorldDLC` must read true. The page ships DarkWorldContent; check that.

## 4. Server (cloudflare/tfex-server), additive only
The Switch's client ignores unknown fields and messages (LOBBY-PROTOCOL.md).
- Lobby fields: `RelayedPairs` (always `[]`, since the relay can't run on Workers), `IsCheckingConnections`,
  `IsReportEnabled: false`, and `MatchPlayers` (set at StartLobby, cleared at archer select and series).
- `PeerMeasured {room_peer_id}` and the connection check before StartLobby (at most 8 s).
  - It applies only when every player can measure: the player sent `?version=` ≥ 0.20, or has already sent a PeerMeasured.
  - So 0.19.2 clients and today's Switch build are never delayed.
- `/ws?version=` is recorded per connection. **Neither UpdateRequired nor Notice is sent**: refusing clients would break the
  Switch build and cached 0.19.2 pages.
- `KickedFromLobby` is not sent: no kick action exists.
- `/ping_measurement/<room>` already exists (signal.js). Re-test it with the new ggrs-ffi.
- `TFEX_PROTOCOL` → v0.21.1.
- The switch-online patch `docs/ws-tfex-lockstep/tfex-server-v0.21.patch` (commit 6c4ef65) is the base.

## 5. Tests
- Server: `node test.mjs`, plus new cases for the fields and the connection check.
- Two headless pages against a local tfex-server:
  - lobby create and join, a match with `?netdelay=` rollbacks and `?digest=1` on both pages;
  - quick play;
  - ping measurement (lobby pings shown, PeerMeasured received).
- Then the same against the deployed server once it's deployed.
- Not testable here: the Switch, which is the coordinator's job.

## 6. Repeatable
- `tools/update-tfex.py` and `.github/workflows/tfex.yml` already adopt a release when nothing blocks it.
- New: `docs/TFEX-UPDATE.md`, the procedure for when something does block it:
  - the ggrs-ffi / GGRS bump and the patch rebase;
  - the protocol diff → the server;
  - re-checking the patches.
- New: `tools/check-tfex-patches.sh`, a headless boot that fails when a browser patch lost its TF.EX target.

## 7. Results (2026-10-17)
- **Native lib** (ggrs-ffi 2fe64d9 + GGRS c510c22 + the relay stub): builds. A relay URL is logged as ignored, and every
  peer stays on WebRTC or our relay.
- **TF.EX 0.21.1** loads on FortRise 5.5.0-beta.3 and reports Dark World installed.
  `tools/check-tfex-patches.sh` passes, after adding ReplayRecordFix's new IL hash (same source; the field tokens moved).
- **Two headless pages, local server**:
  - Quick play (`?mode=quickplay`, `digest=1`, `netdelay=40`): matched, and lobby pings shown (86 ms). The match was played
    with random input: about 5 rollbacks/s, 0 desyncs.
  - Private lobby (code join, random tower): PeerMeasured both ways, then StartLobby. About 8–10 rollbacks/s, 0 desyncs.
  - Switch rehearsal (`tfexplatform=Switch` on one page): 60 Hz over `/relay/`. GGRS got `input_delay=2 max_input_delay=20`,
    and the lobby kept TF.EX's 240 Hz values (5/80). 0 desyncs.
  - The CHECKING CONNECTIONS wait itself is covered by `test.mjs` only: real clients had measured each other before the host
    pressed start.
- **Not tested here**: against the Switch, which is switch-online's job.
