# TowerFall Browser

TowerFall Ascension (with Dark World) running in the browser via .NET 10 WebAssembly + FNA.

**Play: https://belacmu.github.io/towerfall-browser/** (Chrome or Edge recommended)

An unofficial fan project, not affiliated with TowerFall's developers. It contains no game code or
content: the page loads your own, unmodified `TowerFall.exe` and content (PC version: Steam, itch.io
or Humble) at runtime, from a folder you drop onto the page. Your files never leave your device.

Status: the full game runs with keyboard controls. Mods: tick them on the Play screen and the page
downloads them from GameBanana and runs them under FortRise (including Harmony-based code mods).
Next: online multiplayer.

## Two modes, one build

- **Public**: the server hosts only this site. The page asks the player to drop or choose their
  TowerFall folder, copies the game files into the browser's storage (OPFS), and runs them. Nothing
  is uploaded anywhere. Suitable for GitHub Pages.
- **Private**: a server also hosts a TowerFall install under `gamefiles/` (with a `manifest.json`),
  and the page imports it automatically. `tools/stage-gamefiles.sh` sets this up for the dev server.
  `cloudflare/` is a private file host on Cloudflare (R2 + a Worker) that the public site loads
  from when opened with a `#gamefiles=<host>` link, e.g. on phones (`docs/MOBILE.md`).

The page picks the mode at runtime: private if it was given a file host or `gamefiles/manifest.json`
exists, otherwise public.

## How it works

- `web/BrowserHost.cs` mounts OPFS, links the game content to where FNA expects it, loads
  `TowerFall.exe` with `Assembly.LoadFrom`, and ticks the game once per animation frame (60 Hz cap).
  It reaches into the game only by reflection (`TowerFall.TFGame`, and the Dark World flag, which the
  game otherwise only sets when Steam reports the DLC as owned).
- `web/Steamworks.NET/` is a stand-in `Steamworks.NET` assembly the game binds to by name. Steam is
  never "running", so stats, achievements and Workshop switch themselves off.
- `patches/FNA.patch` (FNA 26.04, SDL3 backend): in the browser, the SDL2 platform name reads "Linux"
  (the game only knows Windows/Mac OS X/Linux), and fullscreen is a fixed 1536x960 window instead of
  SDL's emscripten fullscreen, which resizes the canvas behind FNA's back. The page scales the canvas.
- `web/wwwroot/gamefiles.js` finds the game inside whatever folder is supplied (the macOS app keeps
  it in `TowerFall.app/Contents/Resources`, with `DarkWorldContent/` beside the app; Windows/Linux keep
  everything side by side) and copies only what the game needs.
- Prebuilt Emscripten libs (SDL3, FNA3D, MojoShader) from
  [r58Playz/FNA-WASM-Build](https://github.com/r58Playz/FNA-WASM-Build), following
  [r58Playz/fna-wasm-threads](https://github.com/r58Playz/fna-wasm-threads). Rendering runs on a
  worker thread with an OffscreenCanvas (WebGL 2).
- FAudio is built from source (`tools/build-faudio.sh`: 26.10 + `patches/FAudio.patch`). The prebuilt
  26.04 clicked at every 10 ms mix quantum (ADPCM decode/resample bugs fixed upstream since).
- Threads need cross-origin isolation (COOP/COEP headers). `tools/serve.py` sends them; on hosts that
  can't (GitHub Pages), `coi-serviceworker.js` adds them.
- `tools/RefCheck` verifies that a given `TowerFall.exe` binds to our FNA, Steamworks stub and .NET.
- **Mods** (`docs/MODS.md`): `mods/catalog.json` lists GameBanana's TowerFall mods, with browser
  test results from `tools/smoke-mods.mjs`. The page offers the ones that work and downloads them
  from GameBanana. Mod files are never hosted here.
- **Online play** (`docs/MULTIPLAYER.md`): the TF.EX mod, its rollback library built for the
  browser (`netplay/`), and a TF.EX-compatible matchmaking and signaling server of our own
  (`cloudflare/tfex-server`: Cloudflare Durable Objects, or Node locally), since TF.EX's official
  server turns browsers away.
- **FortRise** (`web/FortRise/`, `tools/fetch-fortrise.sh`, plan in `docs/FORTRISE.md`): the site
  serves a pinned FortRise release. The host runs FortRise's own patch step on the player's
  `TowerFall.exe` in the browser, cached until the game or FortRise changes; that takes about 12 s
  on a fast Mac.
  It then applies a few browser fixups and starts the game the way FortRise's launcher does.
  `tools/FortRisePatch` runs the same patch code on desktop .NET for debugging.

## Setup

```bash
# One-time: local .NET 10 SDK + wasm-tools workload (outside the repo: Emscripten breaks on paths with spaces)
curl -sSL https://dot.net/v1/dotnet-install.sh | bash -s -- --channel 10.0 --install-dir ~/.towerfall-browser/tools/dotnet
source env.sh && dotnet workload install wasm-tools

tools/fetch-deps.sh        # FNA + native libs into vendor/ (builds FAudio)
tools/build.sh             # AOT=1 for an ahead-of-time compiled build
python3 tools/serve.py     # http://localhost:8080 (add --pages to serve like GitHub Pages)

tools/stage-gamefiles.sh          # optional: private mode with your Steam install (or pass a TowerFall dir)
tools/stage-gamefiles.sh --clear  # back to public mode
```

The published site is `web/bin/Release/net10.0/publish/wwwroot`.

**Branch previews.** GitHub Pages serves `main` at the root and one other branch at
[`preview/`](https://belacmu.github.io/towerfall-browser/preview/), for trying a branch (on a phone
too) before merging it. Pushing a branch puts it there (the last branch pushed wins; about 5
minutes), and pushes to `main` keep it. It's the same origin as the main site, so it shares its
browser storage: imported game files, the game file host link, settings and saves. Its start screen
says which branch and commit it is. A branch made before this existed needs `main` merged in first
(its pushes only start the Preview workflow if it has `.github/workflows/preview.yml`); or run the
Deploy workflow by hand with the branch name (or `none`) as `preview`.

URL options: `?intro` shows the intro and title screen (by default the game opens on the main menu), `?mute` / `?unmute`, `?uncapped` ticks on every display
frame, `?autoplay` starts without the Play click (tests), `?mods=Name,Name` sets the enabled mods,
`?allmods` also lists untested mods, `?touch` / `?notouch` override the Controls button,
`?fortrise` / `?vanilla` force FortRise on or off, `?mode=versus|quest|darkworld|trials` goes from
the title screen straight to that mode's archer select (`online` to TF.EX's netplay menu, `quickplay`
on to its quick play search), `?tfexserver=local|official|wss://…` picks the
online-play server (default: the site's own, `cloudflare/tfex-server`), and `?debug` shows
FortRise's debug log (including its Harmony patches).

Keyboard: arrows move/aim, C jump/confirm, X shoot/cancel, Shift dodge/catch (rebindable in Options).

For reading the game's code locally, decompile your own copy into the gitignored `reference/`:
`ilspycmd -p -o reference/decompile --nested-directories -r <dir> <dir>/TowerFall.exe`.

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for the projects this builds on.
