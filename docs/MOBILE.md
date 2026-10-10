# Mobile

Goal: TowerFall on phones with touch controls. Step 1 is finding out whether it runs at all.

## Step 1: does it boot? (private file host)

Phones can't pick a folder (`showDirectoryPicker` is desktop Chromium only, and mobile browsers
don't do `webkitdirectory` or folder drops), so a phone can't import the game files itself yet.
Instead the public site loads them from a private file host you run, `cloudflare/`:

- an **R2 bucket** holds your TowerFall install (`tools/upload-gamefiles.sh`), laid out like
  `tools/serve.py`'s private mode: `gamefiles/manifest.json` plus the files;
- a **Worker** (`cloudflare/worker.js`) serves it under `/<KEY>/gamefiles/*`, cross-origin (CORS),
  where `KEY` is a long random secret. Every other path is a 404 that never touches the bucket;
- the **site** is told about the host once, by opening it with
  `#gamefiles=https://towerfall-private.<subdomain>.workers.dev/<KEY>/`. It remembers the host in
  that browser and imports from it, like private mode: the first visit copies the game into the
  browser's storage, later ones only check the manifest. `#gamefiles=` forgets it.

The link is the only thing keeping the files private (it sits in the URL fragment, so it never
reaches GitHub's servers): share it with no one. To revoke it, set a new `KEY`. The public site
itself still hosts no game files.

### Setup (once)

1. **Bucket.** Cloudflare dashboard → R2 → create bucket `towerfall-gamefiles`, and an R2 API
   token with *Object Read & Write* on it; note the access key ID, secret, and your account ID.
2. **Upload** from the machine with TowerFall installed (needs [rclone](https://rclone.org/install/)):
   ```bash
   R2_ACCOUNT_ID=… R2_ACCESS_KEY_ID=… R2_SECRET_ACCESS_KEY=… tools/upload-gamefiles.sh [install dir]
   ```
   The default install dir is the macOS Steam one. Re-running uploads only what changed.
3. **Worker.** From `cloudflare/`: `npx wrangler deploy`, then `openssl rand -hex 24 | npx wrangler
   secret put KEY`. Without `KEY` it answers 404 to everything.
4. **Link.** On each device, open
   `https://belacmu.github.io/towerfall-browser/#gamefiles=https://towerfall-private.<subdomain>.workers.dev/<KEY>/`.

Costs: this fits Cloudflare's free tiers for one player. A first import on a device is about 1,600
R2 reads and Worker requests, a later visit one of each (R2: 10M reads/month free; Workers free plan:
100k requests/day).

### What to try on each phone

Open the link with `?autoplay&nointro` before the `#` (no Play tap needed, no audio), wait for the
game files to copy, and see whether the title screen comes up.
Check iPhone (Safari) and Android (Chrome). Things that may fail, most likely first:

- **iPhone memory.** The runtime asks for a 512 MB shared heap (`EmccInitialHeapSize` in
  `web/TowerFallBrowser.csproj`) plus WebGL textures; iOS kills tabs well below desktop limits, and
  has refused large shared WebAssembly memories before. If the tab reloads or dies, try a smaller
  initial heap.
- **iOS versions.** Threads need SharedArrayBuffer (Safari 15.2+, via COOP/COEP); rendering needs
  WebGL 2 in an OffscreenCanvas on a worker (Safari 17+).
- **Speed.** The game's simulation costs about 0.9 ms per tick on desktop in the interpreter (see
  MULTIPLAYER.md) and rendering runs on its own thread, so even a much slower phone should hold
  60 Hz. FortRise's first patch run (about 20 s on desktop) will take longer. Watch `[perf]` lines
  in the console (`self.consoleLog`, or remote devtools).
- **Audio.** SDL feeds a ScriptProcessorNode on the page's busier main thread; it may crackle.
  iPhone's silent switch mutes web audio.

## Later steps

- **Touch controls**: a virtual gamepad. The page draws the stick and buttons (in the side bars a
  4:3 game leaves on a landscape phone) and passes their state to the host each frame; the host
  applies it on the game thread with SDL's virtual joystick (`SDL_AttachVirtualJoystick`, built
  into the prebuilt `SDL3.a`; FNA's SDL3-CS binds it), so the game sees an ordinary controller:
  analog aiming, controller prompts, no game patching. Bluetooth controllers may already work
  through SDL's Gamepad API backend; if not, the same bridge can forward them.
- **Zip import** for the public site: one `.zip` of the install can be picked on any phone;
  unzip it with `DecompressionStream("deflate-raw")` into the same entry list `locateGame()` takes.
- **Page**: `viewport-fit=cover`, `100dvh`, `touch-action: none`, no selection or long-press menu;
  fullscreen and a landscape lock on Android; a web app manifest for "Add to Home Screen" on
  iPhone, which has no element fullscreen.
