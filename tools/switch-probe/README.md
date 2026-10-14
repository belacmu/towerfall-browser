# Switch cross-play probe

An exlaunch module for the eShop Switch TowerFall (v1.4.1.6), for `docs/SWITCH-CROSSPLAY.md` steps 2–6.
It changes nothing visible apart from the rollback test (step 5–6: it rewinds the level a
few frames at a time, and turns gameplay sounds off); it logs `[xplay] ...` lines to the guest log (Ryujinx:
`~/Library/Logs/Ryujinx/*.log`, read with `grep -a`).

- `main.cpp`: goes at `source/program/main.cpp` of its own exlaunch checkout (the one used:
  `~/Code/tfx-crossplay-exlaunch`, copied from the Switch mods project's `tf3-exlaunch` build setup),
  with `C_FLAGS := -ffp-contract=off -Wno-error` and `CXX_FLAGS := -ffp-contract=off` in `config.mk`.
- `mathlib/`: musl's `pow` from Emscripten's copy (MIT), the browser's `Math.Pow`, built without
  the FMA path; goes at `source/program/mathlib/`.

Build `DEVKITPRO=/opt/devkitpro ./exlaunch.sh build`, copy `deploy/{subsdk9,main.npdm}` to
`Ryujinx/mods/contents/0100a1c00359c000/crossplay-probe/exefs/`, and make it the active native mod
with the Switch mods project's `tools/ryujinx-activate.sh crossplay-probe` (and back afterwards).
Run it with `run-hidden.sh <nsp> <seconds>`, which keeps Ryujinx's window hidden the whole time
(`keephidden.swift`): test runs must not pop up on the desktop. Back up the Ryujinx save data
first (`bis/user/save/0000000000000001`) and check it afterwards.
The browser side of the same tests: the `mathtest`, `floattest` and `xplay` host commands
(`web/Determinism.cs`, `web/CrossplayTest.cs`).

Determinism test files: `menu-to-trials.txt` (controller input from boot into the first Trials
level, as Ryujinx's player 1) and `trial-script.txt` (the level's script, in the game's own
InputState terms); together they're `sdmc:/xplay/script.txt`
(`~/Library/Application Support/Ryujinx/sdcard/xplay/script.txt`). `result-*-700.txt`: the
per-frame position and speed bits from both sides, identical.
