# TowerFall Browser

TowerFall Ascension (with Dark World) running in the browser via .NET 10 WebAssembly + FNA.

**Play: https://belacmu.github.io/towerfall-browser/** (Chrome or Edge recommended)

An unofficial fan project, not affiliated with TowerFall's developers. It contains no game code or
content: the page loads your own, unmodified `TowerFall.exe` and content (PC version: Steam, itch.io
or Humble) at runtime, from a folder you drop onto the page. Your files never leave your device.

Status: the full game runs with keyboard controls, optionally under the FortRise mod loader
(tick "Load mods" before Play). Next: Harmony-based mods and a mod catalog, then online multiplayer.

## Two modes, one build

- **Public**: the server hosts only this site. The page asks the player to drop or choose their
  TowerFall folder, copies the game files into the browser's storage (OPFS), and runs them. Nothing
  is uploaded anywhere. Suitable for GitHub Pages.
- **Private**: the server also hosts a TowerFall install under `gamefiles/` (with a `manifest.json`),
  and the page imports it automatically. `tools/stage-gamefiles.sh` sets this up for the dev server.

The page picks the mode at runtime: private if `gamefiles/manifest.json` exists, otherwise public.

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
- **FortRise** (`web/FortRise/`, `tools/fetch-fortrise.sh`, plan in `docs/FORTRISE.md`): the site
  serves a pinned FortRise release. The host runs FortRise's own patch step on the player's
  `TowerFall.exe` in the browser, cached until the game or FortRise changes; that takes about 20 s.
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

URL options: `?nointro` skips the intro, `?mute` / `?unmute`, `?uncapped` ticks on every display frame, `?autoplay` starts without the Play click (tests).

Keyboard: arrows move/aim, C jump/confirm, X shoot/cancel, Shift dodge/catch (rebindable in Options).

For reading the game's code locally, decompile your own copy into the gitignored `reference/`:
`ilspycmd -p -o reference/decompile --nested-directories -r <dir> <dir>/TowerFall.exe`.

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for the projects this builds on.
