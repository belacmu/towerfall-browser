# Netplay (browser build of TF.EX's native library)

TF.EX, the netplay mod for TowerFall by Fcornaire, does its rollback and networking in a Rust
library, `ggrs_ffi` (https://github.com/Fcornaire/ggrs-ffi, GPL-2.0), built on GGRS and matchbox.
`tools/build-netplay.sh` builds it for the browser as `vendor/netplay/ggrs_ffi.a`, which is linked
into the app:

- `ggrs-ffi.patch`, `ggrs.patch`: small changes to the pinned upstream commits. Tokio is
  single-threaded on Emscripten, GGRS's clock no longer assumes wasm-bindgen, and one Rust 1.87
  API is backported for the pinned compiler.
- `matchbox-browser/`: takes the place of `matchbox_socket` 0.12 (only the API ggrs-ffi uses),
  calling into `tfnet.js`.
- `tfnet.js`: an Emscripten JS library on the page's main thread. It does matchbox's signaling
  (WebSocket, JSON) and WebRTC (one negotiated, unordered, no-retransmit data channel), matching
  matchbox so browser and desktop peers can share rooms.
- `web/Netplay/GgrsFfiImports.cs` mirrors TF.EX's P/Invoke declarations, so the build generates
  the call glue for them.

This build, and the WebAssembly module it's linked into, is distributed under GPL-2.0; see
`THIRD_PARTY_NOTICES.md`.
