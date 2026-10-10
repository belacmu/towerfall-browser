# Compiling game code in the browser: scope

Status: scoping (2026-10-10). Option A was built and measured the same day; see "Spike A: results".

## Why

Everything managed runs in Mono's interpreter, with the jiterpreter compiling hot loop fragments to
WebAssembly. That's 10–20× slower than desktop .NET's JIT. Single-player is fine (≈1–2 ms per
frame on an M4 Pro), but online play (TF.EX rollback at 240 ticks/s) costs ≈7 ms per 60 Hz frame
on the same machine. Low-power devices (3–5× slower) would miss 60 fps. Where a real two-browser
match spends a frame (4 ticks; see docs/MULTIPLAYER.md):

| | ms/frame |
|---|---|
| TF.State saving state (`CaptureGameState`) | ≈4.0 (≈1 per tick) |
| Simulation (`Level.Update`) | ≈1.5 |
| Drawing | ≈0.5 |
| Rollback loads (only on mispredictions) | ≈1 each |

The cheap levers are spent: jiterpreter tables, runtime build flags, DynamicData (2.8× faster),
entity lookups (−35%), a bigger GC nursery. The jiterpreter's trace stats show most traces end at
a call, and TowerFall's code is mostly small calls, so it can't do much better.

## What could be compiled, and the rule that constrains it

| Code | Where it comes from | Can we ship compiled output? |
|---|---|---|
| .NET libraries, FNA, MonoMod/Harmony, Cecil, FortRise launcher, our host | built with the site | yes (MIT/MS-PL/our code) |
| TF.EX / TF.State / TF.Replay | hosted by the site (GPL-2.0) | in principle, but see "mods" below |
| TowerFall (`TowerFall.Patch.dll`, made in the player's browser by FortRise) | the player's own exe | **no**: anything derived from game code must be produced in the player's browser |

**Runtime patches are the big constraint.** With TF.EX enabled, mods patch **302 methods at run
time** (host command `patches`), 295 of them in TowerFall, including the hottest:

- `Level.Update` (TF.EX, TF.Replay, TF.State);
- `Player.Update` (TF.EX);
- `LevelEntity.Update` and `LevelEntity.Render`, which cover most entities (TF.State);
- `Coroutine.Update`, `Particle.Update`, `ParticleSystem.Update`, `SineWave.Update`,
  `Wiggler.Update` (TF.State);
- about 50 `Update`, 15 `Render` and 32 constructor methods in all.

Harmony replaces a patched method with a generated one (MonoMod `DynamicMethodDefinition`), which
the interpreter runs. Compiled-ahead code can't be detoured on WebAssembly (no code patching; our
`WasmDetourFactory` works by swapping a method's IL for the interpreter). So **compiling the game
as-is would leave its hottest code interpreted.** To help, a compiler has to see the patches,
either by compiling code *after* patching or by compiling the interpreter's view of it.

Two more constraints:
- **Mods load into FortRise's collectible `ModAssemblyLoadContext`**, and FortRise relinks them
  (new module bytes). Mono's ahead-of-time images bind to an exact assembly (MVID) plus its
  dependencies' MVIDs, and collectible contexts are a poor fit for them.
- **Multithreaded builds disable the jiterpreter's `jit-call` and `interp-entry` fast paths**, so
  calls between interpreted and compiled code go through slower generic transitions. Compiling
  small framework methods that interpreted game code calls millions of times could even be a net
  loss. This has to be measured, not assumed.

## Options

### A. Build-time AOT of what we ship (framework, FNA, MonoMod, host)
Turn on .NET's WebAssembly AOT (`RunAOTCompilation`) for the site's own assemblies. Game and mods
stay interpreted. Assemblies we patch at run time stay interpreted
(`System.Net.WebSockets.Client`, patched by `PolledWebSocket`).
- **Gains:**
  - collections and LINQ under TF.State's state saves;
  - FNA's drawing paths;
  - DynamicData;
  - FortRise's startup patch (≈23 s of Cecil/MonoMod work, all in our assemblies).
- **Unknowns:**
  - Does AOT work with our patched runtime pack (10.0.3-dev)? The installed cross compiler is
    10.0.12; AOT images must match the runtime. The 10.0.3 cross package is on NuGet
    (`Microsoft.NETCore.App.Runtime.AOT.osx-arm64.Cross.browser-wasm` 10.0.3), so start with
    that; r58playz's interpreter patch may still need a matching build.
  - The cost of interpreter↔AOT transitions in multithreaded builds.
  - Download size: AOT'd libraries add tens of MB to `dotnet.native.wasm`.
  - Memory on iOS.
- **Effort:** days. **Legal:** clean. **Effect on game code:** none directly.

### B. Mono AOT in the player's browser, after patching ("freeze the mod set")
After FortRise patches the game and the mods load, emit one assembly containing the patched game
plus every runtime patch baked in. MonoMod can write `DynamicMethodDefinition`s into a Cecil
module, and Harmony's replacement IL is available. Then run Mono's AOT compiler
(`mono-aot-cross` → LLVM bitcode → wasm objects), relink `dotnet.native.wasm` with wasm-ld, and
cache the result in OPFS. It's redone when the game, FortRise or the mod set changes.
- **Gains:** the most, 2–4× on compiled hot code, including the patched methods.
- **Unknowns and costs:**
  - The toolchain in the browser: LLVM/clang, wasm-ld and `mono-aot-cross` compiled to wasm.
    Comparable ports run 25–100 MB (YoWASP clang ≈25 MB gzipped; Wasmer clang ≈100 MB).
    `mono-aot-cross` has never been built for wasm.
  - Minutes of compile on first run, slower on phones.
  - Freezing changes semantics where mods patch or unpatch at run time; TF.EX's patches are
    static once loaded.
  - The AOT image must match the exact runtime build, so the toolchain is tied to our pack.
  - Nobody has shipped this.
- **Effort:** weeks to months. **Legal:** fine (the player's own code, compiled on their device).

### B′. Same as B, but compiled by a service
The player's browser sends its frozen assembly to a compile service and gets wasm back, cached on
the device. This avoids the in-browser toolchain, but means processing the player's game code on
our server, plus hosting and operating cost. Listed for completeness; it conflicts with "never
host game files" in spirit.

### C. Whole-method compilation in the jiterpreter
Extend Mono's jiterpreter (TypeScript, in the runtime) to compile entire interpreter methods to
WebAssembly, with direct calls between compiled methods, instead of loop traces that stop at
every call. It works on whatever IL the interpreter runs, **so Harmony-patched methods get compiled
too**, and re-patching just invalidates the compiled method.
- **Gains:** plausibly 1.5–3× on call-heavy code, everywhere, with no downloads and no compile step.
- **Unknowns and costs:**
  - This is novel runtime work, and there's no upstream prototype.
  - It needs our own build of the Mono runtime: today we use a prebuilt patched pack, so a
    dotnet/runtime build pipeline (hours of CI) is a prerequisite.
  - Browsers compile large wasm modules asynchronously; the game thread is a worker, which helps.
- **Effort:** months. **Legal:** clean.

### D. CoreCLR on WebAssembly
In progress for .NET 11/12. Not expected to beat Mono+jiterpreter before 2027. Revisit then.

## Recommendation

1. **Spike A first (1–3 days).** *(Done; see "Spike A: results". No gameplay speedup; not
   shipped.)* It's the only option that's cheap, legal and independent of the
   game, and it answers the questions B and C depend on:
   - Does AOT work with our multithreaded patched runtime?
   - What do interpreter↔AOT transitions cost?
   - How much download size and memory does it add?

   Measure the TF.EX sync test (bytes and calls per tick, plus timing on a quiet machine),
   FortRise's startup patch time, and the `dotnet.native.wasm` size.

   *Go* if ticks get ≥15% faster or startup is substantially faster, without breaking mods.
2. **In parallel, a small C prototype study:**
   - set up a runtime build from the r58playz fork (needed for C, and for B's exact toolchain);
   - prototype whole-method compilation for leaf methods only, to measure call-heavy speedups.
3. **Decide between B and C** with those numbers. B is the bigger win per hot method but needs the
   heavy in-browser toolchain and freezing. C is smaller per method but covers patched code
   naturally and has no player-facing cost.
4. Upstream: TF.State's results/intro-screen rollback replays the HUD from the start on every
   rollback (docs/MULTIPLAYER.md), and saves state through LINQ and reflection. Fixes there help
   desktop players as well, and would shrink what compilation has to recover.

## Spike A: results (2026-10-10)

`tools/build.sh AOT=1 PUBLISH_DIR=web/bin/aot-publish` builds it; serve it with the
`towerfall-aot` launch entry (port 8082). Build it from a path without spaces (e.g. a symlink to
the repo): the AOT compiler runs LLVM through a shell. Getting it to run took these changes:

- **The AOT compiler matching our runtime.** The 10.0.3 cross package (`MonoAotCrossCompiler`,
  swapped in by a target) loads fine with r58playz's patched 10.0.3 runtime.
- **Trimming.** The SDK requires the trimmer for AOT. Every assembly is kept whole (`TrimMode=copy`)
  and the trimmed-app feature switches are set back: DI open-generic verification off, the
  metadata updater on (MonoMod's detours), reflection JSON, nullability info.
- **Interpreted exceptions.** `System.Net.WebSockets.Client` stays interpreted, because we patch it
  at run time. IL is kept (`WasmStripILAfterAOT=false`), because Cecil and MonoMod read it.
- **A real bug in our FNA patch.** The `SDL_CreateWindow` / `SDL_GetWindowFlags` C wrappers
  (Mono interpreter bug dotnet/runtime#112262) take 32-bit flags, but the managed side declared
  the 64-bit enum. The interpreter happened to agree; AOT code trapped with "function signature
  mismatch". The managed side now declares `uint`, which is correct for both.

Measured against the regular build:

| | regular | AOT |
|---|---|---|
| `dotnet.native.wasm` | 5.3 MB (2.0 MB gzipped) | 74.8 MB (20.7 MB gzipped) |
| FortRise's first-run patch (same busy machine) | 49.9 s | **12.4 s** |
| `FieldInfo.GetValue` | 0.69 µs | 0.28 µs |
| cached DynamicData read | 0.21 µs | 0.11 µs |
| call into generated code (MonoMod fast invoker / DynamicMethod) | 0.048 / 0.033 µs | 0.111 / 0.061 µs (slower) |
| TF.EX sync test, ms per frame (best windows) | ~12.6–15.5 | ~12.4–15.4 |

**Verdict:** no gameplay speedup.
- Game and mod code, and everything Harmony or MonoMod generates, stays interpreted.
- In multithreaded builds every call from compiled into interpreted code goes through a slow
  generic transition, which eats the framework's gains.
- Startup patching is 4× faster, but it's cached after the first run.
- The download is +18.7 MB gzipped, plus ~70 MB more code in memory, which is bad for iPhone.

**So A isn't worth shipping.** AOT stays an opt-in build for experiments.

For B and C: compiled-to-interpreted transitions are expensive here, so B only pays off if
nearly all hot code, the frozen patches included, is compiled together. C keeps everything inside
the interpreter's own compiled code and avoids those transitions, which makes it the more
promising of the two.

## Option C: r58playz's runtime JIT (2026-10-10)

r58playz (who maintains the runtime fork we use) is building a JIT for Mono on WebAssembly: the
`wasm-jspi-jit-10.0.3` branch of r58playz/dotnet-runtime compiles hot methods to a WebAssembly
module each, at run time, and was last updated 2026-10-07.
- A prebuilt pack (`dotnet-jspi-jit.zip`) is in r58Playz/FNA-WASM-Build release 5ecb4294
  (2026-07-25).
- It's configured with `MONO_WASM_JIT_*` environment variables (r58Playz/ikvmcraft's
  `frontend/src/dotnet/index.ts` has a working set).
- It's Chromium-only (JSPI).

**Step 1, done: the same release's non-JIT runtime is now our default.** It has their newer
interpreter inlining and interp↔AOT transitions. It needed:
- **their Emscripten fixes** (`tools/patch-emsdk.sh` makes a patched copy that the build uses):
  async html5 callbacks, a WASMFS proxy-worker race that deadlocked FortRise's first patch, and
  faster OPFS access;
- **the runtime's own internal-call list**
  (`patches/runtime/icall-table-r58playz-wasm-10.0.3.json`). The build otherwise lists internal
  calls with the workload's upstream AOT compiler, which lacks the fork's
  `TypeBuilder.propagate_parent_native` ("runtime and class libraries are out of sync").

**Step 2, the JIT pack: parked (2026-10-10).** It's Chromium-only, and the current priority is
iPhone. The `perf/wasm-jit` branch builds it (`MSBUILD_ARGS=-p:WasmJit=true`, page `?jit`;
`tools/fetch-runtime.sh` with `RUNTIME_ZIP=dotnet-jspi-jit.zip OUT=vendor/runtime-jit`). It boots
the game and reaches the menu, but crashes as soon as the sync test starts. What it took and what's left:
- **`__stack_pointer` must stay exported.** The JIT's modules import it. Emscripten's meta-DCE
  drops exported globals at `-O3` (the pack's own link has no `-O`), so the
  `-Wl,--export=__stack_pointer` flag alone isn't enough: `patches/emsdk/4-keep-stack-pointer-export.patch`.
- **SIMD has to be off.** The JIT has no vector support, so `Vector128.IsHardwareAccelerated` is
  false in code it compiles and true in the interpreter. .NET's vectorized helpers then throw
  `PlatformNotSupportedException` when an interpreted caller reaches a JIT-compiled one (first
  hit: `string.Split` in Cecil). ikvmcraft doesn't hit this because its framework is AOT-compiled
  and the JIT only sees the rest. SIMD off makes the interpreter ~60% slower on the sync test
  (22–24 → 35–42 ms/frame), which the JIT would have to win back first.
- **Detoured methods crash it.** A detour stub ends in `calli 0xF0F0F0F0`, a token only the
  patched interpreter understands. The July JIT reads it as a signature token and asserts
  (`metadata.c:2403`, `MONO_TABLE_STANDALONESIG`). The branch adds each detoured method to
  `MONO_WASM_JIT_NO_METHOD`, but the July build matches bare method names only. Denying `Update`,
  `Render`, … would exclude most game code.
- **The fixes exist in r58playz's source, but not as a published build.** The branch has since
  added handling for detour stubs ("body override", 2026-10-04), qualified/assembly deny lists, and
  "fixes exposed by taking assemblies off AOT" (2026-09-30), our exact setup. No release has been
  made since 2026-07-25 (ikvmcraft uses the same one). Picking this up means building the runtime
  from that branch (FNA-WASM-Build's `build-dotnet.sh`, likely 1–2 h of CI per build).

## Tools for this work

- `patches` host command: the run-time patched methods and their owners.
- `profile` host command: per-method time, calls and allocated bytes (`Type::*`, `Ns.*::Prefix*`).
- `bench` host command: field-access micro-benchmarks and the cost of a call proxied to the page.
- `?runtime=` (Mono options) and `?env=` (environment, e.g. `MONO_GC_PARAMS`).
- `tools/probe-page.mjs`, `tools/netplay-driver.mjs`: headless runs. Timing needs a quiet machine;
  allocations and call counts don't.
