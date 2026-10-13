# Improvements we could offer TF.EX upstream

Problems found while making online play run well in the browser. They're in TF.EX's own code
(or a library it uses), so desktop players have them too. We work around each one from our host
for now; nothing here has been sent to TF.EX's author yet (decided 2026-10-13: note them, don't
draft a PR yet). Numbers are from TF.EX 0.19.2 in the browser (headless Chrome, M4 Pro) unless
noted; desktop .NET is faster, but the costs grow the same way.

## 1. Rollbacks get slower the longer a match goes on (TF.Replay)

- **What happens:** TF.Replay records every tick of a match (240 a second). On every rollback,
  `ReplayService.RemovePredictedRecords` runs `Record.RemoveAll(rec => rec.Frame > frame)`, which
  reads every tick recorded since the match began, although only the last few can match.
- **Measured:** 0.19 ms per rollback at the start of a match, 0.6 ms (up to 0.9 ms) after 3
  minutes, still growing; about 8 rollbacks a second at ~90 ms of ping.
- **Fix:** ticks are appended in frame order (rolled-back ones are re-recorded in order), so drop
  from the end: `while (count > 0 && Record[count - 1].Frame > frame) Record.RemoveAt(count - 1);`.
  Same list; 2-8 µs per rollback whatever the length. Verified order on every call in a 3-minute
  match and in TF.EX's sync test (17,800 rollbacks).
- **Ours:** `web/Netplay/ReplayRecordFix.cs` (PR #54).

## 2. Replays keep every tick's whole state in memory (TF.Replay)

- **What happens:** with SAVE STATE = FULL (the default), every recorded tick keeps a full
  serialized game state for the whole match.
- **Measured:** about 1.3 KB per tick, about 18 MB per minute of match (47 MB after 2.6 minutes),
  all live on the managed heap.
- **Options:** default to KEY (16 states a second, about 15x less, replays still work), or keep
  FULL states only in the file being written rather than in memory.
- **Ours:** browser players default to KEY once (`web/Netplay/ReplayKeyStates.cs`).

## 3. A computer that can't keep up freezes completely (TF.EX's tick loop)

- **What happens:** `TFGamePatch.TFGameUpdate_Patch` runs as many 240 Hz ticks in a frame as the
  time since the last frame calls for, with no limit. On a machine slower than 240 ticks a second,
  each frame owes more ticks than the last.
- **Measured (one player's game thread 4x slower, `?slowcpu=4`):** 5.5 frames a second, then 0.6,
  0.2, 0.1, with 10-21 s frames. With a cap of 8 ticks a frame: 13-16.5 frames a second, the match
  at about 73% speed (the other player waits for it, as GGRS does for any slow player).
- **Fix:** cap the accumulator (for example at 8 ticks' worth) and drop the excess time.
- **Ours:** `web/Netplay/TickCatchUp.cs` (PR #51).

## 4. A hitch whenever a new kind of entity first appears (MonoMod's DynamicData, used by TF.EX)

- **What happens:** TF.EX takes a `DynamicData` in many entity constructors. The first one for each
  type builds a getter and setter for every field and property and an invoker for every method.
- **Measured:** 40 ms per type on average, up to 160 ms (`Player`) under Mono's interpreter; on
  desktop .NET it's much less, but it's the same up-front work.
- **Fix:** in MonoMod (not TF.EX): resolve names up front but make each accessor on first use.
- **Ours:** `patches/MonoMod.patch` (PR #51). TF.EX could also avoid `DynamicData` in constructors.

## 5. Co-op after visiting the online menu waits for "other players" forever (TF.EX)

- **What happens:** opening TF.EX's online menu puts `MainMenu.VersusMatchSettings` in TF.EX's
  online mode (`ApplyNetplayMode`). Only the Versus Fight button (and `CleanSettingsVersus` with no
  players) clears it, so a Quest, Dark World or Trials run started afterwards still counts as
  online: `LevelLoaderXML` shows "Waiting for other players..." and the level never starts.
- **Reproduced** (headless, TF.EX 0.19.2): online menu, back, co-op button, Quest: stuck on "Waiting
  for other players..."; with the fix the level starts.
- **Fix:** clear it the way the Fight button patch does (`WiderSetMenu.IsNetplayRequested = false;
  VersusMatchSettings.ClearNetplayMode()`) on the co-op submenu's button (`CoOpModeButton`, which acts
  in `BorderButton.OnConfirm`) and `TrialsButton.MenuAction`.
- **Ours:** `TfexPatches.PatchCoOpButtons` (`web/Netplay/TfexPatches.cs`).

## Not yet measured

- TF.EX slows the whole game by 10% whenever it's even one tick (4 ms) ahead of another player
  (`IsFramesAhead`: `_framesAhead > 0`). In a ~90 ms ping match it was on 12-14% of the time. A
  higher threshold might give steadier pacing; untested.
