# A TowerFall decompilation: investigation

Status: investigating (2026-10-11). The question is whether a "true" decompilation (C# source that
rebuilds the game) would help the browser port, PC mods, and deeper mods on the Switch version.

## Ground rule

Decompiled source is game code, and this repository is public. It must never be committed or
hosted. That rules out the N64-decomp model (a public source repo) and leaves the model tModLoader
uses for Terraria: the project ships tools and patches, and the decompile happens on the player's
or developer's machine from their own copy. tModLoader pins the decompiler version and its
settings so the output is deterministic, requires one exact game version, and keeps its changes as
diffs against that output. Its contributor guide says plainly that it can't upload vanilla source.

## Spike: does the decompile rebuild? (yes)

`tools/decomp-rebuild.sh` decompiles your own `TowerFall.exe` (1.3.3.3, the macOS Steam build) into
the gitignored `reference/rebuild/` with ilspycmd 9.1, builds it, and compares the result with the
original method by method (`tools/ILCompare`).

- **It builds after three mechanical fixes**, all from ILSpy targeting a newer C# than .NET 4.0:
  - .NET Framework 4.0 reference assemblies;
  - C# 13, for ref locals in iterators;
  - shims for `MathF.PI`, which is how ILSpy prints the float constant π, and for `System.Index`
    (`array[^1]`).

  Those 75 errors were the only ones, across 637 files and 117k lines. No method needed hand
  fixing.
- **The rebuilt exe runs.** In the browser, in place of the original and without FortRise, it
  boots and reaches Versus archer select.
- **The original was a Debug build** (unoptimized) made by the C# 5-era Microsoft compiler. The IL
  shows it: `ceq`/`stloc`/`ldloc` before every branch, and one shared `ret`. The assembly has no
  `DebuggableAttribute` and targets .NET 4.0. Building the decompile in Debug gets much closer than
  Release:

| | Release rebuild | Debug rebuild |
|---|---|---|
| exact IL match, written methods (7,230) | 32.7% | **40.3%** |
| exact IL match, compiler-generated methods (2,580) | 27.5% | 27.8% |
| instructions, vs the original's 370,774 | 313,739 | 358,849 |
| size, vs the original's 2,095,104 bytes | 1,886,208 | 2,070,528 |

- **What's left is the compiler, not the decompile.** The differences are systematic codegen
  between the old compiler and Roslyn:
  - inverted branch tests: old `ldc.i4 0; ceq; brtrue` against Roslyn's `brfalse`;
  - `ldelema` + `ldobj` against `ldelem.any`;
  - the order of local variable slots;
  - names and layout of iterator and lambda classes.

  "Not found" methods are mostly compiler-generated (867, only 2 of them written by hand: two
  static constructors that Roslyn folded away).

## Finding: IL-hook mods break on a rebuild that doesn't match

FortRise's own patch step, run on desktop with `tools/FortRisePatch`, gives:
- on the original: patches cleanly;
- on the Debug rebuild: fails in `PatchDarkWorldControlLevelSequence`, where an `ILCursor.GotoNext`
  pattern no longer matches.

The FortRise core module has 30 such IL-pattern rules. Many of them are on coroutine state
machines (`LevelSequence`, `IntroScene.Sequence`, `QuestControl.SpawnWave`…), which is exactly
where the rebuild matches least. TF.EX, TF.State and other mods add their own IL hooks.

**So a rebuild can't replace the player's exe for the existing mod ecosystem unless it matches
the original's IL.** Otherwise each IL rule has to be ported to the source. That's possible for
mods we ship (FortRise and TF.EX are MIT and GPL), but not for every GameBanana mod.

## What a decomp buys, per goal

### Browser port
- **Speed doesn't come for free.** Rebuilt C# still compiles to IL, which Mono still interprets.
  The gains come from what source enables:
  - **Patches merged at compile time instead of runtime detours.** With TF.EX, 295 TowerFall
    methods are Harmony-patched at run time (docs/COMPILATION.md), and those patched methods run
    as interpreted `DynamicMethod`s.
  - **Rewriting hot paths at the source level**, e.g. state save and load without reflection.
  - **A clean input for ahead-of-time compilation in the player's browser** (option B in
    docs/COMPILATION.md). Compiled game code must be produced on the player's device either way.
- **In-browser pipeline (tModLoader-style):** the page decompiles the player's exe with a pinned
  ICSharpCode.Decompiler (MIT, ~2–3 MB), applies the site's C# patches, and compiles with Roslyn
  (~10–12 MB of assemblies, ~3–4 MB compressed). WasmSharp shows Roslyn compiling client-side on
  .NET 10.
  - Unmeasured: how long decompiling and compiling a 117k-line game takes on our interpreter.
    Probably tens of seconds or more, so the result would be cached like FortRise's patch output.
  - The decompile must be deterministic, which means a pinned decompiler, pinned settings and a
    known exe hash. The Windows build is XNA, not FNA, so it's a different assembly from the
    Mac/Linux one; each supported exe needs its own patch base, or a shared one with small
    per-build diffs.

### PC mods
- Readable code already exists for anyone with ILSpy. A shared, named, commented decompile would
  mostly help mod authors who use our patch system.
- Source-level mods can't coexist with FortRise's IL patching unless the rebuild matches (see
  above).

### Switch
- The console ports are by Sickhead Games. PS4 (2014) was MonoGame. Switch is very likely
  MonoGame plus Sickhead's BRUTE (IL→C++, closed source, under NDA); that's an inference, not
  confirmed.
  - So the Switch build is native code (an NSO) plus content, with no .NET assemblies. That's
    consistent with `gamefiles.js`: the Switch version has no `TowerFall.exe`.
  - Nobody has published a dump analysis or code mods for it.
- **A PC decomp would help here as a map.** BRUTE translates method by method, so the native
  functions should follow the C# structure. With source, functions in the NSO can be identified,
  and then hooked with exlaunch-style exefs patches on a modded console.
- Next step: a dump of the user's own Switch copy (exefs + romfs), to check for symbols, BRUTE's
  runtime metadata (type names, strings) and how closely functions follow the IL.

## Paths to a *matching* decomp

Matching (rebuilding byte-for-byte or IL-identical) is what makes a decomp checkable, and it's
also what keeps IL-hook mods working on a rebuild.
1. **Use the original compiler.** The legacy C# 5 compiler is the `csc.exe` that still ships in
   .NET Framework 4.x (`C:\Windows\Microsoft.NET\Framework\v4.0.30319`). Run it locally under Wine
   or in a Windows VM, not on a hosted CI runner, because that would upload game source.
   - ILSpy can emit C# 5 (`-lv CSharp5`).
   - The first measurement would show how much of the remaining 60% is codegen.
2. **Then hand-match the rest**, per method, with `tools/ILCompare` as the scorer, the way N64
   decomps use objdiff.
3. **Or settle for semantic equivalence instead of matching.** Normalize the known codegen
   patterns in ILCompare, then do differential testing: run the same deterministic input (the
   game's replays, or TF.EX's rollback sync test) on both builds and compare state every frame.

## Prior art and references

- tModLoader's decompile-and-patch setup: https://github.com/tModLoader/tModLoader (contributor
  guide on its wiki).
- FortRise copies `TowerFall.exe`, MonoMods it with `TowerFall.FortRise.mm.dll` into
  `TowerFall.Patch.dll`, and loads that: https://github.com/FortRise/FortRise
- Bartizan and TF-8-Player: Cecil-based patchers, no decompiled code shipped.
- Monocle, MIT (2012–2014):
  - Mirror: https://github.com/JamesMcMahon/monocle-engine
  - It's the later, Celeste-era engine. It has diverged from the one inside TowerFall
    (e.g. `Calc.cs` is 2,198 lines there against 1,651), and Monocle is only 12% of TowerFall's
    code (13.7k of 117k lines). It's useful for names and comments, but it isn't a drop-in.
- No existing TowerFall decomp or reimplementation, and no source release from the developers.
- Sickhead's ports: https://www.sickhead.com/ported-games/towerfall-dark-world/
