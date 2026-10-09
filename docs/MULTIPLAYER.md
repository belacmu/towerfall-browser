# Online multiplayer: notes

Not started; these are leads gathered so far.

- **TF.EX** (GameBanana 0.7.0, by DShad: "A Netplay (Rollback netcode) + replay mod for Towerfall")
  is a FortRise mod. Its C# side (`TF.EX.Core`, `TF.EX.Domain`, `TF.EX.Patchs` and so on) integrates
  rollback with TowerFall's game state. Its networking goes through two Rust libraries called via FFI,
  shipped as Windows-only DLLs in `TF.EX/Native/`:
  - `ggrs_ffi.dll`: [GGRS](https://github.com/gschup/ggrs), rollback netcode;
  - `matchbox_client_ffi.dll`: [matchbox](https://github.com/johanhelsing/matchbox), peer-to-peer
    networking over **WebRTC** that targets browser WebAssembly as well as native.
- So a browser route is: keep TF.EX's C# integration and build the two FFI crates for
  `wasm32-unknown-emscripten`, using matchbox's browser WebRTC backend. They would be linked into
  `dotnet.native.wasm` like the FNA libs, with the P/Invoke names TF.EX expects. Signaling needs a
  matchbox server, which is small and self-hostable.
- Rollback re-simulates frames, so CPU headroom matters. The game currently runs interpreted at
  60 fps with room to spare; ahead-of-time compilation for TowerFall.Patch.dll is the lever if needed.
- Mod sets: both players need the same mods, compared by the page's mod-set fingerprint
  (see `docs/MODS.md`).
