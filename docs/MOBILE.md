# Mobile

Goal: TowerFall on phones with touch controls. Step 1 is finding out whether it runs at all.

## Step 1: does it boot? (private deployment)

Phones can't pick a folder (`showDirectoryPicker` is desktop Chromium only, and mobile browsers
don't do `webkitdirectory` or folder drops), so the public site can't get the game files onto one
yet. Private mode already solves that on a dev server: the server hosts `gamefiles/manifest.json`
and the page imports from it. `cloudflare/` is the same thing on Cloudflare, reachable from a phone:

- an **R2 bucket** holds your TowerFall install (`tools/upload-gamefiles.sh`);
- a **Worker** (`cloudflare/worker.js`) serves `/gamefiles/*` from the bucket and everything else
  from the GitHub Pages build, adding the COOP/COEP headers threads need;
- **Cloudflare Access** lets only you in. The Worker also checks Access's token on every request
  and answers 403 without a valid one, so if Access is off or misconfigured nothing is exposed.

Keep it private: the public site deliberately hosts no game files.

### Setup (once)

1. **Bucket.** Cloudflare dashboard → R2 → create bucket `towerfall-gamefiles`. Then R2 → Manage
   API tokens → create a token with *Object Read & Write* on that bucket; note the access key ID,
   secret, and your account ID.
2. **Upload** from the machine with TowerFall installed (needs [rclone](https://rclone.org/install/)):
   ```bash
   R2_ACCOUNT_ID=… R2_ACCESS_KEY_ID=… R2_SECRET_ACCESS_KEY=… tools/upload-gamefiles.sh [install dir]
   ```
   The default install dir is the macOS Steam one. Re-running uploads only what changed.
3. **Worker.** `cd cloudflare && npx wrangler deploy` (logs in on first use). It's served at
   `https://towerfall-private.<your-subdomain>.workers.dev`, and refuses every request until step 4.
4. **Access.** Zero Trust → Access → Applications → add a *self-hosted* application for that
   hostname, with a policy allowing your email (one-time PIN login works on a phone). From the
   application, copy the *Application Audience (AUD) Tag*; your team domain is
   `<team>.cloudflareaccess.com` (Zero Trust → Settings). Put both in `cloudflare/wrangler.toml`
   (`ACCESS_AUD`, `ACCESS_TEAM_DOMAIN`) and deploy again.

The site comes from `SITE_URL` (the Pages build of `main`), so the deployment always runs the
latest published site. To try a branch, point `SITE_URL` at another build.

### What to try on each phone

Open the Worker URL with `?autoplay&nointro` (no Play tap needed, no audio), wait for the
game files to copy (once; later visits only check them), and see whether the title screen comes up.
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
- Layout: a floating stick wherever the left thumb lands on the left half (it follows the thumb
  past its rim, and rests across from the buttons on the right); Jump (A), Shoot (X) and Dodge (RB
  and RT both, whichever the game binds) at the bottom right, sliding between them works; Back (B)
  and Pause (Start) at the top left.
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

## Later steps

- **Zip import** for the public site: one `.zip` of the install can be picked on any phone;
  unzip it with `DecompressionStream("deflate-raw")` into the same entry list `locateGame()` takes.
- **Page**: fullscreen and a landscape lock on Android; a web app manifest for "Add to Home
  Screen" on iPhone, which has no element fullscreen. (Done: `viewport-fit=cover`, `100dvh`, and
  no scrolling, zooming, selection or long-press menu on the controls.)
- **Bluetooth controllers** may already work through SDL's Gamepad API backend; if not, the same
  virtual-gamepad bridge can forward them from the page.
