# Switch × browser online play: feasibility checks

Goal: an online mode where the eShop Switch version (under Atmosphère, modded with exlaunch) and
this browser port play each other with **rollback** netcode, limited to what both have (a shared
level, the 8 shared archers, no chalice, up to 4 players). Content parity is assumed solvable
(the Switch can load PC level files via LayeredFS); these checks are about the code.

Background (from the earlier Switch mods project, `~/Code/Towerfall Switch Mods`): the Switch build
(v1.4.1.6; PC is 1.3.3.3) is a **BRUTE** build: C# converted 1:1 to C++ and compiled to native
ARM64, names stripped, no .NET runtime. Rollback state stays local to each side, so no shared
state format is needed: only inputs and a per-frame checksum (player and arrow positions) cross
the network. What has to hold: both sides compute every frame identically, and the Switch side can
save, restore and resimulate fast enough.

## Plan

1. **Desk checks** (no Switch code)
   - 1a. Browser .NET rounds single-precision floats exactly per IEEE 754.
   - 1b. Which math functions run during gameplay updates.
   - 1c. Which order-sensitive constructs (sorts, dictionary loops) run during gameplay updates.
2. **Switch probe** (exlaunch module, Ryujinx first)
   - 2a. Hook the per-frame update: fires once per frame.
   - 2b. Log a checksum of player and arrow positions every frame.
   - 2c. Compare the bits of Nintendo's `sin`, `cos`, `atan2`, `pow` with the browser's on 100,000 inputs.
   - 2d. Compare BRUTE's `System.Random` with .NET's for a few seeds (1,000 values each).
   - 2e. Compare BRUTE's `Math.Round` (ties to even) and `List.Sort` tie order with .NET's.
3. **Determinism test (gate 1):** same level, seed and scripted inputs on both; per-frame checksums
   identical for 5 minutes, in Ryujinx and then on hardware (plus the FPCR flush-to-zero check).
4. **Rollback on the Switch (gate 2)**
   - 4a. One update without drawing is fast enough: 8 resimulated updates plus a normal frame in 16.6 ms.
   - 4b. Saving and restoring the game's memory takes under ~2 ms.
   - 4c. A rollback self-test (like TF.EX's `test`) runs for 5 minutes with matching checksums,
     with sound and effects muted during the replayed frames.
5. **Connection pieces** (after gates 1 and 2)
   - 5a. Rollback core on the Switch: a GGRS port, or our own in C++.
   - 5b. A secure WebSocket from inside the game, and the round-trip time to a browser.

## Results

### 1a. Float rounding in the browser: pass (2026-10-13)

`floattest` host command (`web/Determinism.cs`): 20,000 random input triples, including subnormals,
through add, subtract, multiply, divide, `a*b+c` (two roundings), `Math.Sqrt`, `%`, `(int)`,
`Math.Round`, `Math.Floor` and float/double conversions. The result bits are hashed.

| Run | Hash |
|---|---|
| Exact IEEE single precision (`tools/floattest-reference.mjs`, `Math.fround` per operation) | `908c33aa` |
| Desktop .NET 10 on the Mac (arm64) | `908c33aa` |
| Browser, first pass (interpreter) | `908c33aa` |
| Browser, after warm-up (jiterpreter) | `908c33aa` |

The browser rounds every float operation exactly; WebAssembly's float math is fully specified, so
this doesn't depend on the browser engine (NaN bit patterns aside). On the Switch side, the code
contains no fused multiply-add instructions (0 in 10.6 million), so it doesn't contract `a*b+c`
either; what its flush-to-zero setting does to subnormals is check 3's FPCR read.

### 1b. Math functions in gameplay updates

A name-based call graph over the PC decompile, starting at every `Update` and skipping
`Render`/`Draw`/menus: 2,848 methods are reachable. Their library math:

- **Transcendental (math library):**
  - `Math.Sin` and `Math.Cos` via `Calc.AngleToVector` (aiming, launch directions; about 30 files use it or `Calc.Angle`).
  - `Math.Atan2` via `Calc.Angle`.
  - `Math.Pow`:
    - In `Arrow.ArrowUpdate`: `Speed.X *= (float)Math.Pow(0.98, Engine.TimeMult)`. At normal speed `TimeMult` is 1 and `pow(x, 1)` is exact everywhere, but during the end-of-round slow motion it isn't.
    - Also in random level generation, which isn't used here.

  These are 2c's list.
- **Exact (pure arithmetic or well-defined):** `Lerp`, `Abs`, `Min`, `Max`, `Clamp`, `Sign`, `Floor`, `Ceiling`.
- **`Math.Round`:** in `Actor.MoveH`/`MoveV` (every movement step). .NET rounds halves to even, and BRUTE must too: 2e.

### 1c. Order-sensitive constructs in gameplay updates

- **Entity depth sort** (`Layer.Entities.Sort(CompareDepth)`): safe. `SetActualDepth` gives each
  entity a unique key (depth plus a −1e-6 step per entity), so no ties and any sort algorithm
  agrees.
- **Arrow inventory sort** (`ArrowList.Arrows.Sort`): safe. It sorts a `List<ArrowTypes>`, whose equal
  elements are identical.
- **Treasure spots** (`LevelRandomTreasure.AddRandomTreasure`, `list.Sort(CompareBigTreasureSpots)`):
  **risk**. It sorts by an integer height score, and spots at the same height tie. .NET's and BRUTE's
  sorts may order ties differently, which puts chests in different places. Fix if 2e shows a
  difference: make the comparison tie-proof (then by X) on both sides.
- **`System.Random`** (`Calc.Random`, one global instance with a settable seed): used by about 128
  update methods. The Switch code contains .NET's seed constant (161803398), so BRUTE very likely
  kept the algorithm; 2d confirms.
- **Dictionary loops** only at load time (`GameData.Load`, `DarkWorldTowerData.Load`) and in random
  level generation. Worth one look in 2e (enumeration order after load).
