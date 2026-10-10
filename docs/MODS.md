# Mods: strategy

Decided with the project owner on 2026-10-09.

- **We never host copies of mods.** Mod files always come from GameBanana, downloaded by the player's
  own browser. That keeps downloads, versions and credit with the authors. (None of the 60 TowerFall
  mods' licenses allow redistribution on other sites anyway.)
  **The one exception is TF.EX** (online play, GPL-2.0, decided 2026-10-09): its current releases
  are on GitHub, whose downloads can't be fetched cross-origin, and GameBanana only has an old
  version. `tools/fetch-tfex.sh` pins a release, removes its native libraries (the browser links its
  own build of ggrs_ffi, see `netplay/`) and publishes it under `hosted-mods/`. A hosted mod
  replaces GameBanana's entry of the same name.
- **We keep the catalog.** `tools/update-catalog.py` builds `mods/catalog.json` from GameBanana:
  latest file, checksums, license, the FortRise metadata inside each zip, and whether the mod
  needs Harmony or native code. A scheduled CI job keeps it current. Our own per-mod verdicts
  (after testing) go in `mods/overrides.json`.
- **The page shows only mods that work in the browser**, as a list on the Play screen, outside the
  game: mods must be in place before FortRise starts. FortRise turns on automatically when any mod
  is enabled, and dependencies are enabled with the mods that need them. FortRise's in-game Mods
  menu still works; its changes apply after a reload.
- **Custom zips are allowed.** Players can add any FortRise mod zip; it's identified by checksum.
  For online play both players need the same set, which is handled later.
- **Mod sets.** The enabled mods (name, version, checksum each) form a mod set with a short
  fingerprint; online play will compare fingerprints and offer to fetch a friend's set.
- **Delivery.** GameBanana's `/dl/` redirect passes through a host without CORS headers, so the
  catalog records the final mirror URL (which sends `Access-Control-Allow-Origin: *`), refreshed by
  CI and verified by MD5. If a mirror has moved, the page asks the player to download the zip from
  GameBanana and drop it in. A small Cloudflare Worker proxy could replace the mirror step later.
- **Testing.** CI can't run the game (no game files). A local smoke test on a machine with the game
  boots each mod headlessly and records the result in `mods/overrides.json`.
