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

### 2c. Math library: sin, cos, atan2 match; pow fixed (2026-10-13)

On the Switch, `Math.Sin`, `Cos`, `Atan2` and `Pow` are tail calls into the SDK's `sin`, `cos`,
`atan2` and `pow` (imports, found through the import table); `Math.Sqrt` is an inline `fsqrt`.

**How it was tested.**
- The probe (`tools/switch-probe`, an exlaunch module run in Ryujinx) calls those SDK functions on
  100,000 inputs each, in game-like ranges (angles −10..10, positions −500..500, `pow(0..2, 0..3)`,
  plus the arrow drag's `pow(0.98f, 0..3)`).
- The browser's `mathtest` host command computes the same inputs.
- A C++ build of the probe's input generator on the Mac agrees with desktop .NET, so the inputs
  are identical on both sides.

| | sin | cos | atan2 | pow |
|---|---|---|---|---|
| Switch (SDK, Ryujinx) | `07301656689ca354` | `5ca7e6ef1f70778b` | `c85d1691abc73032` | `d3d1af53b719d844` |
| Browser, Chrome (interpreted and warmed up) | `07301656689ca354` | `5ca7e6ef1f70778b` | `c85d1691abc73032` | `2ca2e37827dfbaea` |
| Browser, Safari (iOS 26.4 Simulator) | same as Chrome | | | |
| Desktop .NET on macOS (Apple's libm) | `6c8ab704…` | `c2a942fa…` | `1d38b607…` | `2d05de53…` |

**`sin`, `cos` and `atan2` are bit-identical** between the Switch and the browser, in every
browser engine tested.

**`pow` differs. Fix: musl's `pow` on the Switch.**
- The browser's `pow` is Emscripten's musl `pow` (Arm's optimized routines).
- Built without its FMA path and with `-ffp-contract=off` (as WebAssembly runs it), it gives
  `2ca2e37827dfbaea` on the Mac's ARM64 and **on the Switch**.
- The probe points the game's `pow` import slot (`+0x47225b0`) at it, by a plain write (lazily bound
  slots are writable data; `CodePatcher`'s code mirror crashed). The game runs normally with it.
- In gameplay, `pow` only matters for the arrow drag in slow motion, where `TimeMult` isn't 1.

### FPCR: no flush-to-zero (Ryujinx)

`FPCR=0`: round to nearest, subnormals kept (FZ=0), NaNs propagated (DN=0). That's the same as
WebAssembly. Ryujinx on Apple Silicon runs guest code on the real CPU, but the OS sets FPCR, so a
read on real hardware still has to confirm it.

### 2e. `Math.Round` differs: the Switch rounds halves up

- **The difference.** BRUTE's `Math.Round(double)` (`+0xaca0`, called from `Actor.MoveH` at `+0x95bd08`
  and `MoveV`) is `fadd d0, d0, #0.5; frintm d0, d0`, that is `floor(x + 0.5)`. .NET (desktop and
  browser) rounds ties to even. Results differ on exact halves with an even whole part: 0.5 → 0 on
  .NET but 1 on the Switch, 2.5 → 2 or 3.
- **Why it matters.** `Actor.MoveH`/`MoveV` round the sub-pixel movement counter for every player and
  arrow, so this would desync quickly.
- **Fix.** Patch that function to `frintn d0, d0; ret` (ties to even). The Switch then rounds like
  .NET, which also matches desktop PC TowerFall. It's one function shared by every caller of
  `Math.Round(double)`. The likely reason it differs: `Math.Round` is a runtime-provided method
  (an "icall") that BRUTE's runtime implements by hand, whereas ordinary library code like
  `System.Random` was converted from Mono's C# source.

### 2d. Random and the sort: left to the determinism test

- **Random.** The seed constant is present, and `System.Random` is converted from Mono's
  managed source, not hand-written like `Round`, so it should match. Step 3 checks it.
- **Sort ties.** The treasure-spot sort gets a tie-proof comparison on both sides in any case.

## 3. Determinism test: Trials, single player: pass (2026-10-13)

**Scenario.** The first Trials level (Sacred Ground I), one player, the same scripted input on both
sides. All 49 Trials level files are identical between the two versions, and Trials uses no random
numbers in its rules, so this tests physics, input handling and rounding without a seed to align.

**Result.** Player 1's position and speed (float bits) at the start of every frame are
**bit-identical on the Switch (Ryujinx) and in the browser, across all 700 frames**. The script
walks, jumps, lands, shoots, dodges diagonally and turns around (`tools/switch-probe/trial-script.txt`;
the logs are `result-switch-700.txt` and `result-browser-700.txt`). Two Switch runs are also
identical to each other.

**What it took** (each is a requirement for real cross-play, not just for the test):
- **Input at the game's level, frame-exact.**
  - Controller polls (`nn::hid`) aren't in step with game frames on the Switch: the same poll-indexed
    script landed on different frames run to run.
  - So both sides replace player 1's `InputState` right after `PlayerInputs[i].GetState()` in
    `Player.Update`:
    - Switch: an inline hook at `+0xaef934`, where the 28 bytes sit in x8/x9/x10/w11.
    - Browser: a Harmony transpiler.
  - The script is written in the game's own terms (held flags, MoveX/MoveY; pressed = held now but not
    last frame). That's also what online play exchanges, so controller mapping differences between
    platforms don't matter.
- **Fixed timestep.** Both games measure real frame time by default (Monocle's Engine turns
  `IsFixedTimeStep` off), and that jitters.
  - Switch: `Engine.Update`'s `IsFixedTimeStep` branch is forced (`+0x92d15c` → nop).
  - Browser: the game runs with `IsFixedTimeStep = true`.
- **The same timestep formula: a version difference.** In its fixed branch, PC 1.3.3.3's
  `Engine.Update` sets `TimeMult = ActualDeltaTime * 60` (0.999996 with 166,666-tick frames). The
  Switch's 1.4.1.6 sets `TimeMult = TimeRate` and `DeltaTime = TimeRate * (1/60f)`. The browser gets
  the Switch's values (a transpiler on `Engine.Update`). This is the first game-logic difference
  between the versions; the determinism test is what found it.
- **The two fixes from step 2:** musl's `pow`, and ties-to-even `Math.Round`, applied on the Switch.
- **No TF.EX in the browser for this test.** It's ticked by default in the mod list, so the test
  uses `?fortrise&mods=` (FortRise for Harmony, no mods).

**How to run it.**
- **Switch:** the probe (`tools/switch-probe`) in Ryujinx, with `menu-to-trials.txt` + `trial-script.txt`
  as `sdmc:/xplay/script.txt`. The menu part is controller input timed in polls from boot: through
  the title, main menu and Trials select, then A presses to confirm the intro screens.
- **Browser:** `?mute&autoplay&fortrise&mods=&mode=trials&command=xplay%20<script>`, where the script
  is the T lines as `frame:flags:moveX:moveY`, comma-separated. Then press confirm (C) about seven times
  to join, start and confirm the intro screens. The `[xplay] T` lines are the trajectory.

**Not covered yet:**
- **Random numbers:** a versus match, with `Calc.Random` seeded identically at round start on both
  sides.
- **Arrows' own positions,** and anything with two or more players (kills, catches, stomps).
- **Slow motion** (`TimeRate` < 1, where `pow` matters).
- **Real hardware,** for the FPCR value and timings.

## 4. Rollback snapshots on the Switch: how much memory (census, 2026-10-13)

The browser side can snapshot state by fields (TF.EX already does). The Switch build is native
code with no reflection to lean on, so the cheapest rollback there would copy raw memory: every
object the game allocates, plus the globals. This step measures that memory and how much of it
changes per frame. It only reads memory; nothing was saved or restored yet.

**Where the objects live.** The game uses the Boehm GC (bdwgc). `GC_add_to_heap` (+0x2857ed0)
records each heap section as `{start, bytes}` at `GC_arrays + 0x68e0`. The pointer to `GC_arrays`
is at +0x483b648, and the pointer to `GC_n_heap_sects` is at +0x483b6e8. Every managed object lives
in those sections. The game's statics and Boehm's own state live in the main module's
`.data`/`.bss`.

**Measured** in Trials, 120 frames into the level (Ryujinx, probe `tools/switch-probe`):

| | Size | Pages changed per frame |
|---|---|---|
| GC heap, 13 sections | 61 MB | 40–46 (160–184 KB) |
| Main module globals | 4 MB | 5–6 (20–24 KB) |

The figures for 7 frames in a row were about the same as for 1 frame: 46 pages. So the same pages
change every frame.

**What it means.**
- **The changing state is small:** about 200 KB per frame, about 1.6 MB for an 8-frame rollback
  window.
- **The total is too big to copy or scan every frame:** 65 MB is on the order of 10 ms of memory
  bandwidth on a Switch. Rollback needs to know which pages changed without reading all of them.
  The options, in order of preference:
  1. **Hot set plus guard.** Learn the set of pages that change during a match. Snapshot that set
     every frame, and check the cold pages' hashes a slice at a time across frames (or at each
     rollback) to catch anything missed.
  2. **Boehm's dirty-page tracking** (incremental mode), if this build has it compiled in.
  3. **Field snapshots, as on the browser:** native per-type save and load code for the few
     classes that matter (Player, Arrow, the level's entity lists, `Calc.Random`, the session
     scores).
- **Not measured yet:**
  - A versus match with four archers and arrows (more allocation).
  - What a garbage collection during the window does: it touches many pages, and a snapshot must
    include Boehm's free lists and mark bits, all in the heap and globals measured here.

## 5. Rollback restore test on the Switch: pass, with one known gap (2026-10-14)

**The test.** At the top of `TFGame.Update` (+0xb75c60, the whole frame), at the start of a window:
1. Copy the snapshot: the GC heap sections, Boehm's block headers and index tables, and the main
   module's globals.
2. Run the window.
3. Restore the copy, rewind the scripted input, and run the window again.

The 5 windows were at frames 85, 198, 236, 326 and 476. Four ran 8 frames and one ran 30. They
cover a jump, two arrow shots and a dodge in Trials. The emulator only; the save data was checked
before and after each run.

**Results:**
- **Every replayed frame matched the first pass:** 62 frames, position and speed bit for bit.
- **The trajectory still matches the runs with no rollback:** all 700 frames compared, against the
  Switch's run and the browser's (step 3).
- **Cost in Ryujinx:** a full 66 MB save took 3–15 ms, and a full restore took about 2 ms. Each
  window changed only 58–88 pages (230–350 KB). So an incremental snapshot would copy well under
  1 MB, though it still needs a way to find those pages (step 4).

**What it took** (each of these crashed until fixed):
- **Boehm's block headers** (0x70 bytes each: object size, mark bits, free-block links) and its
  index tables live outside the heap sections, in 64 KB scratch chunks. Without them the restored
  allocator handed out the wrong memory. The snapshot finds them by walking
  `GC_all_bottom_indices` (+0x48e2a38).
- **The graphics layer's buffer slots must not roll back.** Managed objects hold 8-byte slots
  pointing at native GPU buffer descriptors, and the device behind those descriptors (native
  memory, not snapshotted) counts GPU frames. Restoring a slot to an older buffer trips an
  assertion. The probe hooks the allocator (+0x204d0) to learn the slots, and keeps their exact
  bytes across a restore. Keeping whole pages instead breaks neighbouring game objects.

**The gap.** With rollbacks on, the game threw an `ObjectDisposedException` about 50 seconds
later, at frame 3110, inside a virtual update called from the level's update (+0xa7c768 to
+0x992b40). With rollbacks off, the same build ran past frame 4100. Some other presentation state
holds native resources that a restore gets out of step with, most likely audio. The audio
layer's list of active sound instances (+0x4724770) is restored with everything else, while the
native voices behind it are not. Audio needs the same treatment as graphics: keep it out of the
restore (rollback netcode generally treats sound as presentation, not game state).

**Next:**
1. Find what threw, and keep audio state out of restores.
2. Run longer and with more windows.
3. Then try the 4-player versus test.

