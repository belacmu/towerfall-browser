// Boots TowerFall in the browser:
//  1. Get the player's game files into OPFS (see gamefiles.js), which .NET mounts at /libsdl.
//  2. Start the .NET runtime, load their TowerFall.exe, then tick it once per animation frame.

import { addDarkWorld, forgetGame, fromDataTransfer, fromDirectoryHandle, fromFileList, fromServer, importedGame, importGame, importMusic, locateDarkWorld, locateGame, missingMusic, MUSIC, syncFortRise } from "./gamefiles.js";
import * as Mods from "./mods.js";
import { createTouchControls, saveTouchWanted, touchWanted } from "./touch.js";

// Keep the last lines of console output (including .NET's, which is forwarded from its worker
// threads) so problems can be read back from the page: self.consoleLog.
self.consoleLog = [];
for (const level of ["log", "info", "warn", "error", "debug"]) {
	const original = console[level].bind(console);
	console[level] = (...args) => {
		self.consoleLog.push(`[${level}] ` + args.map((a) => (typeof a === "string" ? a : a?.stack ?? String(a))).join(" "));
		if (self.consoleLog.length > 2000) self.consoleLog.splice(0, 500);
		original(...args);
	};
}

const $ = (id) => document.getElementById(id);
const status = (text) => ($("status").textContent = text);
const detail = (text) => ($("detail").textContent = text);
const progress = (fraction) => ($("bar").firstElementChild.style.width = `${(fraction * 100).toFixed(1)}%`);

function fail(err) {
	console.error(err);
	status("Something went wrong");
	// ManagedError's stack getter calls back into C#, which isn't allowed on this thread.
	$("error").textContent = String(err?.message ?? err) + "\n\n(See the browser console for details.)";
	showOverlay();
}

// While the game runs (body.playing), touches only play. iOS Safari otherwise selects text, shows
// its magnifier and long-press menus, bounces the page and zooms on touch drags and taps, whatever
// the CSS says (see body.playing in index.html), unless the touch events' defaults are cancelled.
// Touches that start on a button keep their start, so a tap still clicks it. The overlay (before
// Play, or after an error) behaves normally, so the mod list scrolls and error text can be copied.
function hideOverlay() {
	$("overlay").classList.add("hidden");
	document.body.classList.add("playing");
}
function showOverlay() {
	$("overlay").classList.remove("hidden");
	document.body.classList.remove("playing");
}
const playing = () => document.body.classList.contains("playing");
document.addEventListener("touchstart", (e) => playing() && !e.target.closest?.("button") && e.preventDefault(), { passive: false });
for (const type of ["touchmove", "selectstart", "contextmenu", "gesturestart", "dblclick"]) {
	document.addEventListener(type, (e) => playing() && e.preventDefault(), { passive: false });
}

// Branch previews (deploy.yml) are served under preview/ with a preview.json saying what they are.
fetch("preview.json", { cache: "no-store" })
	.then((r) => (r.ok ? r.json() : null))
	.then((p) => {
		if (!p?.branch) return;
		$("previewNote").textContent = `Preview of branch ${p.branch} (${p.sha.slice(0, 7)}), not the main site`;
		$("previewNote").hidden = false;
		document.title = `TowerFall (preview: ${p.branch})`;
	})
	.catch(() => {});

// Mute is remembered per browser. ?mute / ?unmute in the URL override it.
const MUTE_KEY = "towerfall.muted";
let muted = (() => {
	const params = new URLSearchParams(location.search);
	if (params.has("mute")) return true;
	if (params.has("unmute")) return false;
	try {
		return localStorage.getItem(MUTE_KEY) !== "0";
	} catch {
		return true;
	}
})();

// Muting zeroes a gain node between SDL's output and the speakers instead of suspending the
// AudioContext, so the game's audio keeps running (and stays in sync) while silent.
function applyMute() {
	$("mute").textContent = muted ? "Sound: off" : "Sound: on";
	const SDL3 = self.wasm?.Module?.SDL3;
	const ctx = SDL3?.audioContext;
	const node = SDL3?.audio_playback?.scriptProcessorNode;
	if (!ctx || !node) return;
	if (!node.muteGain) {
		node.muteGain = ctx.createGain();
		node.muteGain.connect(ctx.destination);
		node.disconnect();
		node.connect(node.muteGain);
	}
	node.muteGain.gain.value = muted ? 0 : 1;
}

$("mute").addEventListener("click", () => {
	muted = !muted;
	try {
		localStorage.setItem(MUTE_KEY, muted ? "1" : "0");
	} catch {}
	applyMute();
	$("canvas").focus();
});
applyMute();

// Safari (iPhone especially) only starts audio from inside a tap, click or key press: an
// AudioContext created or resumed anywhere else stays suspended. SDL creates its own after Play and
// retries resume() from a timer, which Chrome allows and Safari doesn't, so the game was silent.
// Instead, the Play click creates SDL's context (SDL uses Module.SDL3.audioContext when it's there),
// and any later tap resumes it whenever it isn't running (iOS also suspends it on interruptions,
// such as a call).
function unlockAudio() {
	const Module = self.wasm?.Module;
	if (!Module || typeof AudioContext === "undefined") return;
	Module.SDL3 ??= {};
	try {
		Module.SDL3.audioContext ??= new AudioContext();
	} catch (e) {
		console.warn("Couldn't create an AudioContext", e);
		return;
	}
	if (Module.SDL3.audioContext.state !== "running") Module.SDL3.audioContext.resume().catch(() => {});
}
for (const type of ["pointerup", "touchend", "click", "keydown"]) {
	document.addEventListener(type, unlockAudio, { capture: true, passive: true });
}
// iPhone's silent switch mutes web audio unless the page plays like a media app; the Sound button
// is the control here.
if (navigator.audioSession) navigator.audioSession.type = "playback";

// The mouse cursor shows over the game while it moves and hides after a few seconds still (the
// game itself hides it for good; see canvas.canvas in index.html).
const CURSOR_IDLE_MS = 3000;
let cursorTimer;
function cursorMoved() {
	document.body.classList.remove("cursorIdle");
	clearTimeout(cursorTimer);
	cursorTimer = setTimeout(() => document.body.classList.add("cursorIdle"), CURSOR_IDLE_MS);
}
addEventListener("pointermove", (e) => e.pointerType === "mouse" && cursorMoved());
cursorMoved();

// On-screen controls (touch.js), driving a virtual gamepad in the host. On by default on touch
// screens; the Controls button turns them on and off (remembered per browser).
let touchOn = touchWanted();
let controls = null; // created once the game runs and they're wanted
let host = null; // exports.BrowserHost, once the game runs

async function applyTouch() {
	$("touchToggle").textContent = touchOn ? "Controls: on" : "Controls: off";
	// Before the game runs, Init() picks the setting up.
	if (!host) return;
	if (touchOn) {
		// Plugs the virtual gamepad in (once) before the next frame, like connecting a controller.
		await host.EnableTouchGamepad();
		controls ??= createTouchControls((buttons, x, y) => host.SetTouchGamepad(buttons, x, y));
	}
	controls?.setVisible(touchOn);
}

$("touchToggle").addEventListener("click", () => {
	touchOn = !touchOn;
	saveTouchWanted(touchOn);
	applyTouch().catch(console.error);
	$("canvas").focus();
});
applyTouch();

// --- Mods (see mods.js) ---------------------------------------------------------------------

let catalog = [];
let modState = Mods.loadState();

function escapeHtml(text) {
	return String(text ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// Catalog mods that will be installed (enabled ones and their dependencies).
function enabledCatalogMods() {
	return Mods.withDependencies(catalog, Mods.enabledNames(modState));
}

// FortRise runs when any mod is enabled; ?fortrise / ?vanilla force it on or off.
function useFortRise() {
	const params = new URLSearchParams(location.search);
	if (params.has("vanilla")) return false;
	if (params.has("fortrise")) return true;
	return enabledCatalogMods().length > 0 || modState.custom.some((c) => c.enabled);
}

async function renderMods() {
	const list = $("modList");
	const names = new Set(Mods.enabledNames(modState));
	const needed = new Set(enabledCatalogMods().map((m) => m.name));
	const rows = Mods.offered(catalog).map((m) => {
		const viaDependency = needed.has(m.name) && !names.has(m.name);
		return `<label class="mod" title="${escapeHtml(m.note)}">
			<input type="checkbox" data-mod="${escapeHtml(m.name)}" ${names.has(m.name) || viaDependency ? "checked" : ""} ${viaDependency ? "disabled" : ""}>
			<span class="name">${escapeHtml(m.displayName)}</span>
			<span class="by">by ${escapeHtml(m.entry.author)}${m.status === "untested" ? " · untested" : m.status === "experimental" ? " · experimental" : ""}${viaDependency ? " · needed by another mod" : ""}</span>
			<a href="${escapeHtml(m.entry.page)}" target="_blank" rel="noopener">page</a>
		</label>`;
	});
	for (const c of modState.custom) {
		rows.push(`<label class="mod">
			<input type="checkbox" data-custom="${c.sha256}" ${c.enabled ? "checked" : ""}>
			<span class="name">${escapeHtml(c.file)}</span>
			<span class="by">your zip</span>
			<button class="link" data-remove="${c.sha256}">remove</button>
		</label>`);
	}
	list.innerHTML = rows.join("") || `<div class="hint">No mods available yet.</div>`;

	const files = [
		...enabledCatalogMods().map((m) => ({ name: m.name, version: m.version, sha256: m.entry.file.sha256 })),
		...modState.custom.filter((c) => c.enabled).map((c) => ({ name: c.file, sha256: c.sha256 })),
	];
	$("modSummary").textContent = files.length
		? `${files.length} on · mod set ${await Mods.fingerprint(files)}`
		: "off (plain TowerFall)";
	const missing = Mods.missingDependencies(catalog, enabledCatalogMods());
	$("modWarning").textContent = missing.length ? `Also needs mods that aren't available here: ${missing.join(", ")}.` : "";
}

$("modList").addEventListener("change", (e) => {
	const box = e.target;
	if (box.dataset.mod) {
		const set = new Set(modState.enabled);
		box.checked ? set.add(box.dataset.mod) : set.delete(box.dataset.mod);
		modState.enabled = [...set];
	} else if (box.dataset.custom) {
		const c = modState.custom.find((x) => x.sha256 === box.dataset.custom);
		if (c) c.enabled = box.checked;
	}
	Mods.saveState(modState);
	renderMods();
});
$("modList").addEventListener("click", (e) => {
	const sha = e.target.dataset?.remove;
	if (!sha) return;
	e.preventDefault();
	modState.custom = modState.custom.filter((c) => c.sha256 !== sha);
	Mods.saveState(modState);
	renderMods();
});
$("addMod").addEventListener("click", () => $("modFile").click());
$("modFile").addEventListener("change", async () => {
	for (const file of $("modFile").files) {
		const added = await Mods.addZip(file);
		// A zip matching a catalog file (e.g. after a failed download) just fills that in.
		if (!catalog.some((m) => m.entry.file.sha256 === added.sha256) && !modState.custom.some((c) => c.sha256 === added.sha256)) {
			modState.custom.push({ ...added, enabled: true });
		}
	}
	$("modFile").value = "";
	Mods.saveState(modState);
	renderMods();
});

// Downloads what's needed and tells the host which mod zips to install.
async function prepareMods() {
	status("Getting mods…");
	$("bar").hidden = false;
	const shas = await Mods.ensureFiles(enabledCatalogMods(), (done, total) => progress(done / total));
	shas.push(...modState.custom.filter((c) => c.enabled).map((c) => c.sha256));
	await Mods.writeEnabled(shas);
}

// "served-name|assembly-name" for each of the app's assemblies, for Cecil (see BrowserHost.MountAssemblies).
function assemblyFiles() {
	const resources = self.wasm.config.resources;
	return [...(resources.coreAssembly ?? []), ...(resources.assembly ?? [])].map((a) => `${a.name}|${a.virtualPath}`);
}

$("change").addEventListener("click", async () => {
	await forgetGame();
	location.reload();
});

function formatMB(bytes) {
	return `${(bytes / 1048576).toFixed(0)} MB`;
}

// A private file host (cloudflare/, see docs/MOBILE.md) is given once as #gamefiles=<base URL>
// and remembered per browser; #gamefiles= forgets it. In the fragment, it never reaches this
// site's server.
const HOST_KEY = "towerfall.gamefilesHost";
function gameFilesHost() {
	const given = location.hash.match(/[#&]gamefiles=([^&]*)/);
	if (given) {
		let host = decodeURIComponent(given[1]);
		if (host && !host.endsWith("/")) host += "/";
		try {
			if (host) localStorage.setItem(HOST_KEY, host);
			else localStorage.removeItem(HOST_KEY);
		} catch {}
		history.replaceState(null, "", location.pathname + location.search);
		return host;
	}
	try {
		return localStorage.getItem(HOST_KEY) ?? "";
	} catch {
		return "";
	}
}

// Servers that host the game files (a private file host, or this one in private mode) win;
// otherwise use what the player imported before, or ask them for their TowerFall folder. An
// unreachable file host falls back to the copy already imported from it.
async function ensureGameFiles() {
	status("Checking game files…");
	const server = await fromServer(gameFilesHost());
	if (server) {
		const located = locateGame(server);
		// The music waits for the Music button (see MUSIC in gamefiles.js).
		await copyIn({ ...located, content: located.content.filter((c) => c.to !== MUSIC) }, "server");
		pendingMusic = await missingMusic(located);
		return;
	}
	if (await importedGame()) {
		$("change").hidden = false;
	} else {
		await askForGame();
	}
	if (!(await importedGame()).darkWorld) offerDarkWorld();
}

// While the game runs without its music bank, the Music button stands in for the Sound button: it
// downloads the bank (showing how big it is, then how far along), has the host start the game's
// music, and gives the spot back to Sound.
let pendingMusic = null;
function offerMusic(host) {
	const button = $("music");
	button.textContent = `Load music (${formatMB(pendingMusic.from.size)})`;
	button.hidden = false;
	$("mute").hidden = true;
	button.addEventListener("click", async () => {
		if (button.disabled) return;
		button.disabled = true;
		try {
			await importMusic(pendingMusic, (done, total) => (button.textContent = `Music: ${Math.floor((100 * done) / total)}%`));
			await host.StartMusic();
			button.hidden = true;
			$("mute").hidden = false;
		} catch (e) {
			console.error("Couldn't load the music", e);
			button.textContent = "Music failed: tap to retry";
			button.disabled = false;
		}
		$("canvas").focus();
	});
}

function showProgress(done, total) {
	progress(done / total);
	detail(`${formatMB(done)} / ${formatMB(total)}`);
}

async function copyIn(located, source) {
	status("Copying game files into browser storage…");
	await importGame(located, source, showProgress);
	progress(1);
	detail("");
}

// Lets the player drop folders on the page or choose one with `button`; calls take(entries, source)
// with the files. Returns a function that stops listening.
function acceptFolders(button, take) {
	let busy = false;
	const run = async (getEntries, source) => {
		if (busy) return;
		busy = true;
		$("error").textContent = "";
		try {
			await take(await getEntries(), source);
		} catch (e) {
			if (e?.name !== "AbortError") {
				console.error(e);
				$("error").textContent = String(e?.message ?? e);
			}
		} finally {
			busy = false;
		}
	};
	button.onclick = () => {
		if (self.showDirectoryPicker) {
			run(async () => fromDirectoryHandle(await showDirectoryPicker({ id: "towerfall" })), "folder");
		} else {
			$("folder").onchange = () => {
				if ($("folder").files.length) run(async () => fromFileList($("folder").files), "folder");
			};
			$("folder").click();
		}
	};
	const onDragOver = (e) => e.preventDefault();
	const onDrop = (e) => {
		e.preventDefault();
		const dt = e.dataTransfer;
		// Read the entries now: DataTransfer items are only valid during the event.
		const entries = fromDataTransfer(dt);
		run(() => entries, "drop");
	};
	addEventListener("dragover", onDragOver);
	addEventListener("drop", onDrop);
	return () => {
		button.onclick = null;
		removeEventListener("dragover", onDragOver);
		removeEventListener("drop", onDrop);
	};
}

// Public site: the player supplies their own copy, by picking or dropping the install folder.
function askForGame() {
	const ask = () => {
		status("Choose your TowerFall folder");
		$("bar").hidden = true;
		$("pick").hidden = false;
	};
	ask();
	return new Promise((resolve) => {
		const stop = acceptFolders($("choose"), async (entries, source) => {
			let located;
			try {
				located = locateGame(entries);
			} catch (e) {
				ask();
				throw e;
			}
			stop();
			$("pick").hidden = true;
			$("bar").hidden = false;
			await copyIn(located, source);
			resolve();
		});
	});
}

// Imported without Dark World (e.g. only TowerFall.app was dropped): until the game starts,
// accept the DarkWorldContent folder on its own and add it.
let stopDarkWorldOffer = () => {};
function offerDarkWorld() {
	$("dw").hidden = false;
	stopDarkWorldOffer = acceptFolders($("dwchoose"), async (entries) => {
		const located = locateDarkWorld(entries);
		stopDarkWorldOffer();
		$("dw").hidden = true;
		status("Adding Dark World…");
		$("bar").hidden = false;
		await addDarkWorld(located, showProgress);
		progress(1);
		detail("");
		status("Ready (with Dark World)");
	});
}

// Online play (TF.EX): the matchmaking server browser players use. TF.EX's official server turns
// browsers away, so the site runs its own (cloudflare/tfex-server, docs/MULTIPLAYER.md) and TF.EX's
// OFFICIAL setting means this one in the browser (web/Netplay/TfexPatches.cs). Empty: TF.EX's own
// setting. ?tfexserver=local (ws://127.0.0.1:3000), =official, or =<wss://…> picks another.
const TFEX_SERVER = "wss://tfex-server.tf-bd1030ec.workers.dev";
const TFEX_SERVERS = { local: "ws://127.0.0.1:3000", official: "wss://tfex-server.balatro-vs-matchmaking.eu" };

function tfexServer() {
	const param = new URLSearchParams(location.search).get("tfexserver");
	if (!param) return { url: TFEX_SERVER, force: false };
	const url = TFEX_SERVERS[param.toLowerCase()] ?? param.replace(/^http/, "ws").replace(/\/+$/, "");
	return { url, force: true };
}

async function startDotnet() {
	status("Starting .NET runtime…");
	const { dotnet } = await import("./_framework/dotnet.js");
	let builder = dotnet.withConfig({});
	if (new URLSearchParams(location.search).has("debug")) builder = builder.withEnvironmentVariable("TOWERFALL_LOG", "debug");
	const server = tfexServer();
	if (server.url) builder = builder.withEnvironmentVariable("TFEX_SERVER", server.url).withEnvironmentVariable("TFEX_SERVER_FORCE", server.force ? "1" : "0");
	// ?env=NAME=value;NAME=value sets runtime environment variables (e.g. MONO_GC_PARAMS), for tuning.
	for (const pair of (new URLSearchParams(location.search).get("env") ?? "").split(";").filter(Boolean)) {
		const at = pair.indexOf("=");
		if (at > 0) builder = builder.withEnvironmentVariable(pair.slice(0, at), pair.slice(at + 1));
	}
	// The jiterpreter (the interpreter's JIT to WebAssembly) fills its default function tables
	// with the game plus FortRise mods; netplay needs all the speed it can get. ?runtime=a,b passes
	// more Mono options (e.g. --jiterpreter-stats-enabled).
	const runtimeOptions = ["--jiterpreter-table-size=32768"];
	for (const o of (new URLSearchParams(location.search).get("runtime") ?? "").split(",").filter(Boolean)) runtimeOptions.push(o);
	builder = builder.withRuntimeOptions(runtimeOptions);
	const runtime = await builder.create();
	const config = runtime.getConfig();
	const exports = await runtime.getAssemblyExports(config.mainAssemblyName);
	const canvas = $("canvas");
	dotnet.instance.Module.canvas = canvas;
	self.wasm = { Module: dotnet.instance.Module, dotnet, runtime, config, exports, canvas };

	await runtime.runMain();
	await exports.BrowserHost.PreInit();
	return exports;
}

async function main() {
	if (!self.crossOriginIsolated && navigator.serviceWorker && !navigator.serviceWorker.controller) {
		// First visit on a host without COOP/COEP: coi-serviceworker.js is installing and will
		// reload the page. Give it a moment before calling it a failure.
		status("Setting up…");
		await new Promise((resolve) => setTimeout(resolve, 5000));
	}
	if (!self.crossOriginIsolated) {
		// coi-serviceworker.js reloads the page once it's installed; if we're still not isolated,
		// the browser blocked it (e.g. private browsing) or the page isn't on https/localhost.
		throw new Error("This page needs cross-origin isolation for threads, which this browser didn't allow here. Try a regular (non-private) window over https.");
	}
	await ensureGameFiles();
	const exports = await startDotnet();

	// Audio can only start after a user gesture, so wait for a click before booting the game.
	catalog = await Mods.loadCatalog();
	await renderMods();
	const play = $("play");
	const noIntro = new URLSearchParams(location.search).has("nointro");
	let autoplay = new URLSearchParams(location.search).has("autoplay");
	for (;;) {
		status("Ready");
		$("bar").hidden = true;
		detail("");
		play.hidden = false;
		$("modsPanel").hidden = false;
		// ?autoplay skips the click (for automated tests); audio then stays suspended.
		if (!autoplay) {
			await new Promise((resolve) => play.addEventListener("click", resolve, { once: true }));
		}
		autoplay = false;
		play.hidden = true;
		$("modsPanel").hidden = true;
		$("error").textContent = "";
		if (!useFortRise()) break;
		try {
			await prepareMods();
			break;
		} catch (e) {
			if (!(e instanceof Mods.ModDownloadError)) throw e;
			$("bar").hidden = true;
			$("error").innerHTML = `${escapeHtml(e.message)} Download it from <a href="${escapeHtml(e.mod.entry.page)}" target="_blank" rel="noopener">its GameBanana page</a> and add it with "Add a mod zip", then press Play again.`;
		}
	}
	$("change").hidden = true;
	$("dw").hidden = true;
	stopDarkWorldOffer();

	// With the on-screen controls on, Init() plugs their virtual gamepad in at launch.
	if (touchOn) await exports.BrowserHost.EnableTouchGamepad();

	if (useFortRise()) {
		status("Getting FortRise…");
		$("bar").hidden = false;
		const version = await syncFortRise(showProgress);
		progress(1);
		detail("");
		// Patching TowerFall.exe takes a while the first time (it's cached afterwards).
		status(`Starting FortRise ${version}…`);
		await exports.BrowserHost.Init(noIntro, version, new URL("_framework/", location.href).href, assemblyFiles());
	} else {
		await exports.BrowserHost.Init(noIntro, null, null, null);
	}
	hideOverlay();
	$("canvas").focus();
	host = exports.BrowserHost;
	if (pendingMusic) offerMusic(host);
	await applyTouch();

	// TowerFall is a 60 Hz game. On high-refresh displays, only tick on the animation frames
	// that bring us to the next 60 Hz slot (?uncapped ticks on every animation frame).
	const uncapped = new URLSearchParams(location.search).has("uncapped");
	const TICK_MS = 1000 / 60;
	let behind = TICK_MS;
	let last = performance.now();

	// Dev console commands, for tests: towerfallCommand("test") from the console, or
	// ?command=line;line (the host runs them once the main menu is up).
	self.towerfallCommand = (line) => exports.BrowserHost.RunCommand(line);
	// Pasting (Ctrl+V) hands the text to the game's clipboard, e.g. for TF.EX lobby codes.
	document.addEventListener("paste", (e) => {
		const text = e.clipboardData?.getData("text");
		if (text) exports.BrowserHost.SetClipboardText(text);
	});
	const startMode = new URLSearchParams(location.search).get("mode");
	if (startMode) await exports.BrowserHost.SetStartMode(startMode);
	for (const line of (new URLSearchParams(location.search).get("command") ?? "").split(";").filter(Boolean)) {
		await exports.BrowserHost.RunCommand(line);
	}

	const frame = async (now) => {
		behind = Math.min(behind + (now - last), TICK_MS * 4);
		last = now;
		// Small tolerance so 60 Hz displays (whose frames jitter around 16.7 ms) tick every frame.
		if (!uncapped && behind < TICK_MS - 2) {
			requestAnimationFrame(frame);
			return;
		}
		behind = Math.max(0, behind - TICK_MS);

		let keepRunning;
		try {
			await controls?.flush();
			keepRunning = await exports.BrowserHost.MainLoop();
		} catch (e) {
			fail(e);
			return;
		}
		// SDL creates its AudioContext lazily, so keep the mute state applied.
		applyMute();
		if (keepRunning) {
			requestAnimationFrame(frame);
		} else if (await exports.BrowserHost.WantsRestart()) {
			location.reload();
		} else {
			status("TowerFall has exited. Reload to play again.");
			showOverlay();
		}
	};
	requestAnimationFrame(frame);
}

main().catch(fail);
