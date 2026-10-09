# Third-party notices

This project contains no TowerFall code or content; players supply their own copy.

It builds on, and in places contains code adapted from, the following projects:

- **FNA** (Ms-PL) — https://github.com/FNA-XNA/FNA — fetched at build time; `patches/FNA.patch` modifies it.
- **FAudio** (zlib) — https://github.com/FNA-XNA/FAudio — fetched at build time; `patches/FAudio.patch` modifies it.
- **SDL** (zlib), **FNA3D** (zlib), **MojoShader** (zlib) — prebuilt for Emscripten by
  https://github.com/r58Playz/FNA-WASM-Build and fetched at build time.
- **FortRise** (MIT) — https://github.com/FortRise/FortRise — the pinned release's managed
  assemblies are fetched at build time (`tools/fetch-fortrise.sh`) and served with the site:
  the launcher library, `TowerFall.FortRise.mm.dll` and its built-in modules, plus its dependencies
  **MonoMod** (MIT), **Harmony** (MIT), **Mono.Cecil** (MIT), **Pintail** (MIT) and
  **Microsoft.Extensions.\*** (MIT).
- **Patched .NET WebAssembly runtime** (MIT) — built by https://github.com/r58Playz/FNA-WASM-Build
  from https://github.com/r58playz/dotnet-runtime (a fork of dotnet/runtime), fetched at build
  time by `tools/fetch-runtime.sh` along with two small native objects for MonoMod's WebAssembly
  detours (`hot_reload_detour.o`, derived from MIT-licensed runtime code, and `liba.o`). FNA-WASM-Build
  itself carries no license file; replacing `liba.o` with our own source is on the to-do list.
- **coi-serviceworker** (MIT, Guido Zuidhof and contributors) — `web/wwwroot/coi-serviceworker.js`,
  included unmodified with its license header.
- **Steamworks.NET** (MIT) — `web/Steamworks.NET/` is an independent stand-in that mirrors the
  public API shape of Steamworks.NET; it contains no Steamworks.NET code.
- **fna-wasm-threads** (MIT) — https://github.com/r58Playz/fna-wasm-threads — the threaded
  WebAssembly setup this project follows. `web/Native/Emscripten.c`, the SDL3-CS changes in
  `patches/FNA.patch`, the Emscripten fixups in `tools/build.sh` and parts of `web/BrowserHost.cs`
  and `web/wwwroot/main.js` are adapted from it. Its license:

```
MIT License

Copyright (c) 2026 Toshit Chawda

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

The approach (loading the player's own game files, patched FNA in WebAssembly) follows
https://github.com/MercuryWorkshop/celeste-wasm.
