# Browser-only lobbies run at 60 Hz (a deliberate break from TF.EX)

Since 2026-10-19 a lobby whose players all say Platform "Browser" (or "Switch") plays at **60 Hz with no
spectators**, where TF.EX runs every session at 240 Hz. This is the one place the site doesn't do what
TF.EX does. Remember it before going back to full TF.EX behaviour.

## Why
The browser runs TF.EX's game code in .NET's interpreter. Real matches (tools/reports.sh, Oct 2026)
reached only 140-175 of 240 ticks a second and slowed down 17-25% of the time; an iPhone dropped
seconds of catch-up. At 60 Hz there's a quarter of the ticks to simulate and resimulate. Switch lobbies
already ran at 60 Hz (the Switch runs the game's own rate), so the path was proven.

## What stays TF.EX's own
- Any lobby with a desktop TF.EX player (Platform Windows / Linux / macOS, or none) runs at TF.EX's 240 Hz,
  unchanged. Every player sees the same lobby, so all peers pick the same rate.
- The lobby protocol, the server, GGRS's wire format. Only the session rate (and spectators) differ.

## Where it lives
- `web/Netplay/SwitchLobby.cs`, `UpdatePlayersPostfix`: `browserLobby` (comment "BROWSER-ONLY RULE").
- `web/Netplay/TfexFps.cs`: `SetSessionRate` (converts the input delay to the new rate).

## Known costs
- A page still on an older build also says "Browser" but runs 240 Hz: for a while after a deploy, such a
  page and a new one in the same lobby run different rates and the match breaks. Reloading fixes it.
- No spectators in browser-only lobbies (a late spectator could be desktop TF.EX at 240 Hz).
- Input delay is in 60 Hz ticks (16.7 ms steps) instead of 240 Hz ones.

## To return to full TF.EX behaviour
Delete `browserLobby` from the condition in `UpdatePlayersPostfix` (leave the Switch rule), so only Switch
lobbies change the rate. Do that once the browser keeps 240 Hz comfortably (faster rollback / AOT), and
check with tools/reports.sh that browser matches reach ~240 ticks/s without slowing down.
