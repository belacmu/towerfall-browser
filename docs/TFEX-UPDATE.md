# Updating TF.EX (online play)

TF.EX releases often, and the official server only lets the latest version play online. The Switch port
(switch-online) follows the same version. So keep the hosted TF.EX on the latest release.

## The easy case: CI does it

`.github/workflows/tfex.yml` runs `tools/update-tfex.py` every hour. A release passes when all three hold:
- it bundles the same ggrs-ffi commit that the browser builds;
- the pinned FortRise satisfies its requirement;
- its lobby protocol hasn't changed since `cloudflare/tfex-server/TFEX_PROTOCOL`.

Such a release gets a `tfex-<version>` branch in the site's preview/ and a pull request.

Before merging it:
1. Build it locally and run `tools/check-tfex-patches.sh http://localhost:<port>/` against `tools/serve.py`.
   Every browser patch of TF.EX must still find its target.
2. Play a match between two pages (below).

## When the updater says no

`python3 tools/update-tfex.py --check` says why. Each reason has a fix.

**"it bundles ggrs-ffi X, but the browser builds Y"**: the native library moved.
1. In `tools/build-netplay.sh`, set `GGRS_FFI_COMMIT` to that commit. Set `GGRS_COMMIT` to the newest commit on Fcornaire/ggrs
   `develop` from before the TF.EX release; ggrs-ffi follows that branch.
2. Rebase the patches. In a scratch clone of each repo at the new commit, run `patch -p1 < netplay/ggrs-ffi.patch` (and
   `ggrs.patch`), fix any rejects, then write the patch back with `git diff <commit>` (no `.orig` files).
   - `netplay/ggrs-ffi.patch` adds `netplay_set_pending_checksum` (`?digest=1`).
   - It computes GGRS's desync checksum only for the frames GGRS sends one for (multiples of the desync interval), not
     on every save; `netplay_set_checksum_every_frame` (`?fullchecksum=1`) restores every save. This relies on GGRS's
     `check_checksum_send_interval` reading the saved state of exactly that frame: if a new GGRS reads other frames, or
     anything else reads `GameStateCell::checksum()`, revisit it. Check with two pages and
     `cloudflare/tfex-server/local.mjs --log-checksums` (the reports sent must not change with `?fullchecksum=1`).
   - It also swaps TF.EX's UDP relay (`relay.rs`) for `relay_browser.rs`, a relay that never connects.
   - It makes the relay's WebSocket/TLS crates non-Emscripten-only.
3. Lockfile: copy `netplay/ggrs-ffi.Cargo.lock` into the scratch `core/`, then run `cargo +<toolchain> fetch` with the two
   `--config patch...` options from `build-netplay.sh`. That adds what is new without bumping the rest. Copy it back.
4. Build into a scratch folder, so `vendor/` (shared with other checkouts) stays as it is:
   `NETPLAY_SRC=<tmp> NETPLAY_OUT=~/.towerfall-browser/netplay-<name> tools/build-netplay.sh`, then
   `MSBUILD_ARGS="-p:NetplayDir=$HOME/.towerfall-browser/netplay-<name>" tools/build.sh`.
5. If TF.EX's `TF.EX.Domain/Externals/GGRSFFI.cs` changed, mirror its declarations in `web/Netplay/GgrsFfiImports.cs`.
   WebAssembly needs the P/Invoke glue for every signature at build time; a signature it lacks fails when it's called.
6. GGRS wire format: check that the `ggrs` diff keeps the message types (`src/network/messages.rs`), because the Switch's
   ggrs-switch speaks it too. Tell switch-online about any change.

**"its lobby protocol changed since X"**:
1. Run `git diff X <tag> -- src/network/TF.EX.Domain/Models/WebSocket src/network/TF.EX.Domain/Services/MatchmakingService.cs`
   in a TF.EX clone.
2. Update `cloudflare/tfex-server` for each change, additively: the Switch speaks this server too, and ignores unknown fields
   and messages (switch-online LOBBY-PROTOCOL.md).
3. Add the cases to `test.mjs`, then run `node test.mjs`.
4. Deploy with `tools/deploy-tfex-server.sh`. It waits until no match is running.
5. Set `TFEX_PROTOCOL` to the new tag.

**"it needs FortRise X"**: run `tools/fetch-fortrise.sh` (see docs/FORTRISE.md).

Then pin the release: `TFEX_VERSION` and the zip's sha256 in `tools/fetch-tfex.sh`.

## TF.EX from a fork or branch (our own change)

The site can host a TF.EX built from source instead of a release, for example a fork with a change of ours that is also
offered upstream as a pull request.
1. In `tools/fetch-tfex.sh`, set `TFEX_SOURCE=${TFEX_SOURCE-<owner/repo>@<full commit sha>}`. For a one-off build, set
   `TFEX_SOURCE=…` in the environment instead.
2. `tools/fetch-tfex.sh` then runs `tools/build-tfex.sh`, which repeats the steps of TF.EX's own `release.yml`:
   - it builds TF.State, TF.Replay, TF.InputDisplayer and TF.EX (`dotnet build -c Release -p:ModLoaderPath=<repo>/libs`);
   - it puts each one in its `DShad.*` folder;
   - it zips them without the native libs, under `DShad.TF.EX-<TFEX_VERSION>-<owner>-<sha7>.zip`. The page's "page" link
     points at the commit.
3. What the build needs:
   - git, zip, and the .NET 10 SDK (`env.sh`'s, installed by `tools/install-sdk.sh`; CI has it for the site build);
   - nuget.org: `FortRise.Configuration` 1.5.6, MessagePack, and the Microsoft.Extensions packages.
   - It does not need FortRise or the game files: TF.EX keeps stripped compile references for FortRise 5.5.0-beta.2
     (TowerFall.Patch.dll, FNA, Harmony, MonoMod.Utils) in its own `libs/`.
   - The "Could not locate Mono.Cecil" warnings show up in TF.EX's CI too.
4. While a source pin is set, the hourly `tools/update-tfex.py` checks no releases. Moving back to a release (when the
   change is merged upstream and released) means clearing `TFEX_SOURCE`.
5. The fork must keep `meta.json`'s version. It is what TF.EX sends as `/ws?version=` and shows in its menus.
6. Everything in "What to check every time" applies as for a release.

Checked on 2026-10-17: `Fcornaire/TF.EX@bcebd12` (v0.21.1) built this way has the same files as the release zip.
That build hasn't been booted in the page.

## What to check every time

- `tools/check-tfex-patches.sh` passes.
  - A patch that keys on IL bytes (`ReplayRecordFix`) logs "changed (<hash>)". Compare the method's source between the two
    tags: if only the tokens moved, add the hash.
- Read TF.EX's changelog and `git diff <old> <new> --stat` for anything that touches what the browser patches (web/Netplay):
  - `NetplayManager`: `UpdatePlayers`, spectators, `SaveGameState`, `GetEventAndUpdate`;
  - `GGRSConfig`, `NetplayPreferences.ToFrames`, `InputDelayAdvisor`;
  - `TFGamePatch`'s update clock fields;
  - TF.Replay's `ReplayService`;
  - `MainMenuPatch.AddWiderSetLobbyMod`.
- Test two pages against a local server. The tests use their own ports, and their profiles go under ~/.towerfall-browser;
  delete the profiles afterwards.
  ```bash
  node cloudflare/tfex-server/local.mjs --port 13421 --verbose
  python3 tools/serve.py 18421
  node tools/netplay-driver.mjs --url "http://localhost:18421/?mute&nointro&autoplay&mods=TF.EX&tfexserver=ws://127.0.0.1:13421&mode=quickplay&digest=1&netdelay=40" --players Q1,Q2 --port 19721
  ```
  - A new TF.EX shows its changelog first: press `c` on both pages.
  - Quick play then matches the two pages. Press `c` on both to pick archers.
  - Send random keys (arrows, `c`, `x`) to both pages for a minute. The STATS panel should show rollbacks, and no
    "DESYNC" line should appear.
  - A private lobby, with `?mode=online` and `&tfexplatform=Switch` on one page, plays the Switch's part. That page's log
    says `this page says it plays on "Switch"`, and the match runs as any other (TF.EX's 240 Hz).
- After the merge, the site deploys and every player gets the new TF.EX.
