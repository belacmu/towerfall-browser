# Switch cross-play probe

An exlaunch module for the eShop Switch TowerFall (v1.4.1.6), for `docs/SWITCH-CROSSPLAY.md` step 2.
It changes nothing visible; it logs `[xplay] ...` lines to the guest log (Ryujinx:
`~/Library/Logs/Ryujinx/*.log`, read with `grep -a`).

- `main.cpp`: goes at `source/program/main.cpp` of its own exlaunch checkout (the one used:
  `~/Code/tfx-crossplay-exlaunch`, copied from the Switch mods project's `tf3-exlaunch` build setup),
  with `C_FLAGS := -ffp-contract=off -Wno-error` and `CXX_FLAGS := -ffp-contract=off` in `config.mk`.
- `mathlib/`: musl's `pow` from Emscripten's copy (MIT), the browser's `Math.Pow`, built without
  the FMA path; goes at `source/program/mathlib/`.

Build `DEVKITPRO=/opt/devkitpro ./exlaunch.sh build`, copy `deploy/{subsdk9,main.npdm}` to
`Ryujinx/mods/contents/0100a1c00359c000/crossplay-probe/exefs/`, and make it the active native mod
with the Switch mods project's `tools/ryujinx-activate.sh crossplay-probe` (and back afterwards).
The browser side of the same tests: the `mathtest`, `floattest` and `xplay` host commands
(`web/Determinism.cs`, `web/CrossplayTest.cs`).

Determinism test files: `menu-to-trials.txt` (controller input from boot into the first Trials
level, as Ryujinx's player 1) and `trial-script.txt` (the level's script, in the game's own
InputState terms); together they're `sdmc:/xplay/script.txt`
(`~/Library/Application Support/Ryujinx/sdcard/xplay/script.txt`). `result-*-700.txt`: the
per-frame position and speed bits from both sides, identical.
