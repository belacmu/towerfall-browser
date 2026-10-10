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

Opening the link loads nothing until the player picks "Load game (336 MB)" or "Load game without
music (127 MB)" (sizes are what's missing). The music bank (`Content/Music/Win/MusicWaveBank.xwb`,
218 MB of the game's 354) is the optional part; sound effects are separate files and always come.
Without it the game starts silent of music, and a "Load music (208 MB)" button next to Sound
downloads it and starts the music (`BrowserHost.StartMusic`). Once it's stored, later visits have
music from the start. (Starting without it needed an FNA fix: a `WaveBank` whose constructor
threw crashed the game from its finalizer; see `patches/FNA.patch`.)

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
  Safari only starts audio from inside a tap, click or key press, and SDL created its AudioContext
  after Play and resumed it from a timer (fine in Chrome), so iPhone was silent. The page now
  creates SDL's context during the Play click and resumes it on later taps when it isn't running
  (`unlockAudio` in `main.js`). With sound on it sets `navigator.audioSession.type = "playback"`
  (Safari 17+) so the silent switch doesn't mute the game; the Sound button does that. With sound
  off it's `"ambient"`, which mixes with other apps' audio: as "playback", the silently running
  game stopped music playing in other apps.

## Step 2: touch controls (virtual gamepad)

The page draws on-screen controls (`web/wwwroot/touch.js`) and the host plugs in a virtual gamepad
that they drive (`web/TouchGamepad.cs`). They're on by default on touch screens
(`(pointer: coarse)`); the Controls button next to Sound turns them on and off on any device
(mouse included), remembered per browser, and `?touch` / `?notouch` override that.

- SDL's virtual joystick driver (in the prebuilt `SDL3.a`) with the standard gamepad shape (15
  buttons, 6 axes), so SDL maps it like an Xbox controller and FNA, and the game, see an ordinary
  gamepad: analog aiming, controller prompts, rebindable in the game's options, no game patching.
- `Init()` attaches it right after constructing the game and registers it with FNA the way FNA's
  `ProgramInit` does for controllers present at launch, so the game finds it however it looks for
  controllers. Turned on later, it's plugged in before the next frame like a controller connected
  mid-game (whether the game picks that up is still to be seen); turned off, the controls let go
  of everything and hide, and the pad stays connected. The page sends the controls' state when it
  changes (`SetTouchGamepad`), and `MainLoop` applies it on the game thread before each frame.
- Layout: a stick on the left half that follows the thumb past half its radius. A faint ring
  marks where it rests, across from the buttons on the right, and a touch anywhere on the left
  half pushes it from there towards the thumb at once: tapping off centre is a press in that
  direction and tapping again presses again (stepping through the archers). Let go, it goes back
  to rest; Jump (A), Shoot (X) and
  Dodge (RB and RT both, whichever the game binds) at the bottom right, sliding between them works;
  Back (B) and Pause (Start) at the top left. A touch counts for the nearest button within reach
  (0.6 of a round button's radius past its edge, which covers the gaps between them; 14 px for the
  small ones), and a held button reaches further.
- The stick is tuned to how TowerFall reads a pad (`XGamepadInput`, after FNA's default
  independent-axes deadzone): it runs at |x| >= 0.5, ducks or looks up at |y| >= 0.8 and rounds aim
  to 45 degrees, which on a linear touch stick meant dragging ~60% of the radius to start running.
  Instead, past a small deadzone the stick sends a full push in one of 8 directions (left/right
  run, diagonals run and aim diagonally without ducking, up/down duck or look up), with FNA's
  deadzone added back so the game sees exactly level, 45 degrees or upright. That's every stick
  position the game tells apart; online, TF.EX sends the stick's exact value, and each change is a
  rollback for the opponent, so the stick sends nothing finer. A direction holds until the thumb is
  8 degrees past its edge, and the knob shows the direction being sent. Given up: the free aiming
  variant aims in 45 degree steps, and Dark World ghosts fly in 8 directions at full speed.
- The `keys` host command (`towerfallCommand("keys")`) logs connected gamepads' state too.

The controls and the page's handling of them are tested headless with multi-touch input; the game
side compiles (CI) but hasn't been tried in the game yet. To check in the game: open with `?touch` on
desktop, run `towerfallCommand("keys")`, and use the controls with the mouse; the pad should show
as `pad0`. Then on a phone: does the game take the pad as player 1, do the menus respond, and are
the default bindings right (jump/shoot/dodge)?

### Widescreen mods

There are widescreen mods for TowerFall. The controls are translucent and anchored to the screen
corners rather than to the 4:3 side bars, so they work there too, but they sit over the edges of
the play area. Things to look at with one:

- The canvas is a fixed 1536x960 (16:10) drawing buffer (`BrowserDisplayMode` in
  `patches/FNA.patch`), letterboxed to the page. A 16:9 game fits it with bars; set
  `FNA_BROWSER_DISPLAY_MODE` (or derive it from the screen's aspect ratio) to fill a phone.
- Controls over the play area may want lower opacity, or a smaller button cluster.

## Memory (iPhone)

iOS reloads a Safari tab that uses too much memory (WebKit's own limit, or jetsam). Measured in
the iOS Simulator (iOS 26.4, iPhone 17e), where the Mac can read the tab process's footprint
(`footprint <pid>` on its `com.apple.WebKit.WebContent`), 2026-10-10:

| | tab footprint |
|---|---|
| page loaded, .NET started, before Play | ~450 MB |
| vanilla, title screen | ~910 MB |
| TF.EX, title screen | ~1,150–1,230 MB → **~800 MB** (music streamed, see below) |
| TF.EX, first launch (import, FortRise patch) | ~1,600 MB |
| an instant replay | +70 MB for a moment (and ~90 MB in WebKit's GPU process) |

- **The music bank is streamed, and FAudio mixes on its own thread.** TowerFall opens its 218 MB
  music bank with XNA's in-memory `WaveBank` constructor, which put all of it in the WebAssembly
  heap (which never shrinks). In the browser FNA opens it as a streaming bank instead
  (`patches/FNA.patch`), read from the file as it plays. A first try (2026-10-10) froze Safari at
  the title screen: SDL runs FAudio's mixer on the page's main thread (in Web Audio's callback, or
  a timer while audio is suspended), so streaming made the main thread read browser storage
  (OPFS via WASMFS), and in Safari that read never completes. The main thread's stack, caught with
  `--diag`: `silence_callback → SDL_PlaybackAudioThreadIterate → FAudio_INTERNAL_MixCallback →
  FACT_INTERNAL_DefaultReadFile → … OPFSFile::read → emscripten_proxy_sync → futex wait`.
  Now FAudio mixes on its own thread in the browser (`patches/FAudio.patch`) and the main thread
  only takes finished samples. Web Audio takes 4096-frame blocks (~85 ms), so the mixer paces
  itself to have each block complete just before it's due (plus two 10 ms quanta), rather than a
  block ahead, which would delay every sound by a block. Checked with `--diag`'s gap count (blocks
  with runs of exact silence): 0 in Safari (Simulator) and Chrome, music playing, 60 fps. The
  main thread also no longer does the mixing work.
- The WebAssembly heap is 540–630 MB at the TF.EX title; WebKit adds roughly 400–600 MB on top
  (JavaScript, workers). Chrome holds the same title in about 850 MB in total.
- The jiterpreter (`?runtime=--no-jiterpreter-traces-enabled` turns it off) costs about
  150–200 MB in WebKit: its thousands of small compiled modules. Off, netplay would be much slower.
- The initial heap size (`EmccInitialHeapSize`, 512 MB) makes no difference: 128 MB measured the
  same, the heap just grows to what's used.
- Rollbacks during round results rebuild the results HUD (megabytes each, see MULTIPLAYER.md):
  spikes like that raise the heap for good.

To look inside a page that has no console you can read (Safari in the Simulator), run
`python3 tools/serve.py 8081 --diag` (or the `towerfall-diag` launch config): pages report their
WebAssembly heap, audio state, output level and gaps, and notable log lines every 5 s as `[diag]`
lines, and run JavaScript queued with `curl localhost:8081/__eval --data 'towerfallCommand("…")'`.
If the main thread spins (Emscripten waits for locks there by spinning on `performance.now()`),
it sends its JavaScript stack, with WebAssembly function names when the build keeps them
(temporarily add `--profiling-funcs` to `EmccExtraLDFlags` and `<WasmNativeStrip>false`). A
watchdog worker reports which main-thread timer is running when it stops answering (in WebKit a
worker's requests need the main thread, so this only arrives after shorter stalls). Audio in the
Simulator needs a real tap: open the page without `autoplay` and tap Play with the Simulator tool. Open the page
in the Simulator with `xcrun simctl openurl booted "http://localhost:8081/?mute&autoplay&…"`.

## Later steps

- **Zip import** for the public site: one `.zip` of the install can be picked on any phone;
  unzip it with `DecompressionStream("deflate-raw")` into the same entry list `locateGame()` takes.
- **Page**: fullscreen and a landscape lock on Android; a web app manifest for "Add to Home
  Screen" on iPhone, which has no element fullscreen. (Done: `viewport-fit=cover`, `100dvh`, and
  while the game runs no text selection, magnifier, long-press menu, scrolling or zooming from
  touches anywhere on the page: iOS Safari ignores the CSS for some of these, so `main.js` also
  cancels the touch events' defaults. Safari's own edge swipes, like back, can't be blocked from a
  page.)
- **Stick design**: the stick looks like an analog stick, but it's an 8-way switch with hysteresis
  (step 2); only the knob snapping between directions hints at that. A redesign could show how it
  works: e.g. a ring with 8 marked directions that light up as they're sent, or a d-pad look.
- **Bluetooth controllers** may already work through SDL's Gamepad API backend; if not, the same
  virtual-gamepad bridge can forward them from the page.
