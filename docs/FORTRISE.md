# FortRise and mods in the browser: plan

Goal: FortRise works automatically and reliably, stays current with upstream, and players can turn
mods on and off from the page. Online players can then check that they're running the same mod set.

## How FortRise 5.x works on desktop

Sources: github.com/FortRise/FortRise (MIT), the installed 5.3.5 build, and its launch log.

1. The `FortRise` launcher (self-contained .NET 10) finds `TowerFall.exe`.
2. It patches the exe statically with MonoMod (`FortRiseMonoModder`: `ReadMod(TowerFall.FortRise.mm.dll)`,
   `MapDependencies`, `AutoPatch`, `Write`) into `TowerFall.Patch.dll`, keyed on an XXHash64 of
   the mm dll. `MonoModRules` in the mm dll relink XNA to FNA on Windows, rewrite SDL2 calls to SDL3,
   strip `initonly`, and set the Steamworks/NoLauncher flags.
3. It loads `TowerFall.Patch.dll`, sets the current directory to the game dir, calls
   `RiseCore.LauncherPipe(logger, factory)`, then invokes the patched `TFGame.Main(args + --version X)`.
   That runs `RiseCore.Start()` (mods from `Internals/` and `Mods/`; each mod's `OnLoad` usually
   applies Harmony patches), ParseArgs, Steam init, then `new patch_TFGame().Run()`.
4. Mods: a folder or zip with a `meta.json` (`name`, `version`, `dll`, `dependencies` and so on). Code
   mods hook the game with Harmony (`Lib.Harmony.Thin` 2.4.0 on `MonoMod.Core` 1.3.3) and the
   FortRise registry API. Content-only mods have no dll. Mods may ship native `Unmanaged/` libs.
5. The registry is GameBanana (game 18654, about 60 mods). Updates are checked against GitHub tags or
   GameBanana's API, as declared in each mod's `meta.json` `update` field.

## What the browser needs

| Piece | Desktop | Browser plan |
|---|---|---|
| Static patch | launcher process | run the same MonoModder in the host (managed Cecil), cache `TowerFall.Patch.dll` in OPFS keyed on the hashes of TowerFall.exe and the mm dll |
| Entry | `TFGame.Main` then `Run()` | Cecil-edit the patched `Main`'s `Run()` call to hand the game to the host, which ticks it per frame |
| FNA | FortRise ships FNA 26.10 | upgrade our FNA to 26.10 (the patched game and mods reference FNA 26.6+) |
| Harmony | MonoMod.Core native detours (JIT) | MonoMod.Core built from r58Playz/MonoMod (MIT): `WasmDetourFactory` swaps method IL for a trampoline. Needs the patched Mono runtime (r58playz/dotnet-runtime `wasm-10.0.3`, MIT) for `calli 0xF0F0F0F0`, plus the C glue `liba.o` and `hot_reload_detour.o` |
| Reflection.Emit | Pintail, Harmony DMD | the Mono interpreter runs DynamicMethod IL; the fork forces the "dm" DMD generator |
| Native libs | cimgui (FortRise.ImGui), some mods | not supported; leave out FortRise.ImGui and flag mods that ship natives |
| Process restart, updater | `Process.Start`, HttpClient | replace with a page reload; mods come from our catalog |
| Files | FortRise dir + game dir | OPFS: `/libsdl/fortrise` (Mods, Saves, Logs, _RelinkerCache) and `/libsdl/game` |

## Milestones

1. **FNA 26.10.** Done. No new native entry points compared with the prebuilt Emscripten libs.
2. **FortRise boots.** Done. The host runs FortRise's own `TryPatch` in the browser (about 20 s,
   cached), then browser fixups (`FortRisePatcher.BrowserFixups`):
   - SDL platform checks are answered "Linux" for the game only;
   - `Assembly.Location` for bundled assemblies is pointed at `/bin`;
   - FortRise's self-updater is disabled.

   The host then repeats the patched `TFGame.Main` up to `Run()` (`FortRiseLauncher`).
   FortRise.ImGui is left out because it needs native cimgui.
3. **Harmony works.** Done.
   - `patches/MonoMod.patch` carries r58Playz's WebAssembly detours onto upstream MonoMod 69fdc9de,
     built by `tools/build-monomod.sh`.
   - It runs on the patched runtime pack plus the native glue from `tools/fetch-runtime.sh`.
   - Verified with Speedrun Timer: its postfix on `QuestGameOver`'s constructor fires.
4. **Mod catalog.** Done; see `docs/MODS.md`.
   - `tools/update-catalog.py` builds the catalog and `tools/smoke-mods.mjs` tests mods.
   - The page lists working mods, downloads them from GameBanana, and `ModInstaller` installs them.
5. **Staying current.** Partly done.
   - `.github/workflows/catalog.yml` refreshes the catalog daily and opens an issue for new
     FortRise releases.
   - Bumping FortRise is still a manual edit to `tools/fetch-fortrise.sh`, followed by a rerun of
     the smoke test.

## Open questions and risks

- Redistribution: the patched runtime is a build of r58playz/dotnet-runtime (MIT), but the C glue
  `liba.o` comes from FNA-WASM-Build, which has no license. Replacing it with our own source needs
  Mono's internal headers from the runtime fork (`interp-internals.h`, `class-internals.h`); the
  pack only ships the public ones.
- In-browser MonoMod patching costs time and memory (cached after the first run).
- Generic methods can only take the "overwrite" detour strategy, which fails on bodies shorter than
  the trampoline. Watch for Harmony patches on tiny generic methods.
- FortRise is on a weekly-ish cadence (5.4.1 stable, 5.5.0 beta removes the Relinker), so the pinning
  and CI smoke tests matter.
