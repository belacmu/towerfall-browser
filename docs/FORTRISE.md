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

1. **FNA 26.10.** Check native entry points against the prebuilt Emscripten libs (26.04) and rebase `patches/FNA.patch`.
2. **FortRise boots with no third-party mods.** Fetch a pinned FortRise release at build time and ship its
   managed DLLs. Patch in the host, load, start, tick. Leave out FortRise.ImGui. Add a "Use FortRise" toggle.
3. **Harmony works.** Switch to the patched runtime and the MonoMod fork. Prove it with
   FortRise.WorkshopFixes, then Wider Set and Three Team Mode.
4. **Mod catalog.** `mods/catalog.json` lists each mod's name, version, source, sha256, license and browser
   status. CI bundles redistributable mod zips into the site (same origin, so no CORS); for the rest,
   players drop the zip themselves. The page lists mods with toggles, and the enabled set (names,
   versions, hashes) is what online play compares.
5. **Staying current.** A scheduled workflow checks FortRise releases and the catalog sources, then opens
   PRs that bump the pins. CI builds and smoke-tests what it can without game files.

## Open questions and risks

- Redistribution: the patched runtime and C glue come from repos with unclear licenses
  (FNA-WASM-Build has none). The forks themselves are MIT, so building them ourselves is the clean path.
- In-browser MonoMod patching costs time and memory (cached after the first run).
- Generic methods can only take the "overwrite" detour strategy, which fails on bodies shorter than
  the trampoline. Watch for Harmony patches on tiny generic methods.
- FortRise is on a weekly-ish cadence (5.4.1 stable, 5.5.0 beta removes the Relinker), so the pinning
  and CI smoke tests matter.
