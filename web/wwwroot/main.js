// Boots TowerFall in the browser:
//  1. Get the player's game files into OPFS (see gamefiles.js), which .NET mounts at /libsdl.
//  2. Start the .NET runtime, load their TowerFall.exe, then tick it once per animation frame.

import { addDarkWorld, forgetGame, fromDataTransfer, fromDirectoryHandle, fromFileList, fromServer, fromZip, importedGame, importGame, importMusic, locateDarkWorld, locateGame, missingFiles, missingMusic, MUSIC, syncFortRise } from "./gamefiles.js";
import * as Mods from "./mods.js";
import { createTouchControls, saveTouchWanted, touchWanted } from "./touch.js";
import { reportFailure, startStats } from "./stats.js";

// Keep the last lines of console output (including .NET's, which is forwarded from its worker
// threads) so problems can be read back from the page: self.consoleLog.
self.consoleLog = [];
// How many of the oldest lines were dropped (serve.py --diag's reports count lines from the start).
self.consoleLogDropped = 0;
// Also handed each line while set (see showActivity).
let onConsoleLine = null;
// A .NET exception's stack getter calls back into C#, which isn't allowed on this thread and throws:
// that mustn't take the logging (and fail(), which logs the error first) down with it.
const logText = (a) => {
	if (typeof a === "string") return a;
	try {
		return a?.stack ?? String(a);
	} catch {
		return String(a?.message ?? a);
	}
};
for (const level of ["log", "info", "warn", "error", "debug"]) {
	const original = console[level].bind(console);
	console[level] = (...args) => {
		// Progress reports from .NET (see FortRiseLauncher), for showActivity only.
		if (typeof args[0] === "string" && args[0].startsWith("[progress] ")) {
			onConsoleLine?.(args[0]);
			return;
		}
		const line = `[${level}] ` + args.map(logText).join(" ");
		self.consoleLog.push(line);
		if (self.consoleLog.length > 2000) {
			self.consoleLog.splice(0, 500);
			self.consoleLogDropped += 500;
		}
		onConsoleLine?.(line);
		original(...args);
	};
}

const $ = (id) => document.getElementById(id);
const status = (text) => ($("status").textContent = text);
const detail = (text) => ($("detail").textContent = text);
const progress = (fraction) => ($("bar").firstElementChild.style.width = `${(fraction * 100).toFixed(1)}%`);

function fail(err) {
	console.error(err);
	const step = $("status").textContent;
	status("Something went wrong");
	// ManagedError's stack getter calls back into C#, which isn't allowed on this thread.
	const message = String(err?.message ?? err);
	$("error").textContent = /out of memory/i.test(message)
		? "The browser ran out of memory for the game. Right after a reload, the previous page's memory may not be freed yet: close this tab and open the page in a new one."
		: message + "\n\n(See the browser console for details.)";
	showOverlay();
	const server = tfexServer();
	reportFailure(server.url === TFEX_SERVERS.official ? null : server.url, { step, error: message, version: new URL(import.meta.url).searchParams.get("v") ?? "" });
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
// The faint corner link on the start screen: to the branch preview, or from it back to the main site.
if (/\/preview\/$/.test(location.pathname.replace(/index\.html$/, ""))) {
	$("otherBuild").href = "../";
	$("otherBuild").title = $("otherBuild").ariaLabel = "Main site";
}

// The Sound button steps through off, effects and on, remembered per browser; ?mute, ?effects and
// ?unmute in the URL override it. "Effects" is the game's sound effects without its music, to play
// over music from another app (GameMusic.cs turns the game's music off).
const SOUND_KEY = "towerfall.sound";
const SOUNDS = ["off", "effects", "on"];
let sound = (() => {
	const params = new URLSearchParams(location.search);
	if (params.has("mute")) return "off";
	if (params.has("effects")) return "effects";
	if (params.has("unmute")) return "on";
	try {
		const saved = localStorage.getItem(SOUND_KEY);
		if (SOUNDS.includes(saved)) return saved;
		// Before "effects", the button was on/off.
		if (localStorage.getItem("towerfall.muted") === "0") return "on";
	} catch {}
	return "off";
})();

// Sound off zeroes a gain node between SDL's output and the speakers instead of suspending the
// AudioContext, so the game's audio keeps running (and stays in sync) while silent. On iPhone the
// audio session follows the setting (Safari 17+): with sound on, "playback", like a media app, so
// the silent switch doesn't mute the game (the Sound button does); otherwise "ambient", which mixes
// with other apps' audio (as "playback", the game stopped music playing in other apps, even while
// silent). Ambient sound obeys the silent switch, so "effects" is silent on a phone set to silent:
// Safari has no session type that both mixes and ignores the switch.
function applySound() {
	const button = $("mute");
	button.textContent = { off: "Sound: off", effects: "Sound: effects", on: "Sound: on" }[sound];
	button.title = {
		off: "Sound is off",
		effects: "Sound effects only, without the game's music, mixed with audio from other apps (on iPhone, the silent switch mutes them)",
		on: "Sound and music are on",
	}[sound];
	if (navigator.audioSession) navigator.audioSession.type = sound === "on" ? "playback" : "ambient";
	applyGain();
}

// The gain node part, which the frame loop also checks, since SDL creates its audio output lazily
// (cheaply: it changes nothing once the node is in place).
function applyGain() {
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
	const gain = sound === "off" ? 0 : 1;
	if (node.muteGain.gain.value !== gain) node.muteGain.gain.value = gain;
}

$("mute").addEventListener("click", () => {
	sound = SOUNDS[(SOUNDS.indexOf(sound) + 1) % SOUNDS.length];
	try {
		localStorage.setItem(SOUND_KEY, sound);
	} catch {}
	applySound();
	host?.SetGameMusic(sound !== "effects").catch(console.error);
	$("canvas").focus();
});
applySound();

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
	// Showing them plugs the virtual gamepad in (once) before the next frame, like connecting a
	// controller; while they show, the keyboard isn't a player.
	await host.ShowTouchControls(touchOn);
	if (touchOn) {
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

// AI opponents. LoaderAI (behind the AIJimmy and AINova mods) sets its computer players up with
// keys a phone doesn't have, so the AI button (shown in versus archer select) picks them instead: P2 on (to P4, or P8 with an
// 8-player mod) each none or one of its AI types, joined in versus archer select by the host
// (LoaderAi.cs). Remembered per browser.
const OPPONENTS_KEY = "towerfall.opponents";
let aiTypes = [];
let aiSlots = 4;
// From P2, up to P8.
let opponents = (() => {
	try {
		const saved = JSON.parse(localStorage.getItem(OPPONENTS_KEY));
		if (Array.isArray(saved)) return Array.from({ length: 7 }, (_, i) => (typeof saved[i] === "string" ? saved[i] : ""));
	} catch {}
	return Array(7).fill("");
})();
const aiName = (type) => (type ? type[0] + type.slice(1).toLowerCase() : "none");

function renderOpponents() {
	const shown = opponents.slice(0, aiSlots - 1);
	const count = shown.filter((t) => aiTypes.includes(t)).length;
	$("aiToggle").textContent = count ? `AI: ${count}` : "AI: off";
	const panel = $("aiPanel");
	panel.innerHTML = "";
	panel.classList.toggle("wide", shown.length > 3);
	shown.forEach((type, i) => {
		const button = document.createElement("button");
		button.textContent = `P${i + 2}: ${aiName(aiTypes.includes(type) ? type : "")}`;
		button.addEventListener("click", () => {
			const choices = ["", ...aiTypes];
			opponents[i] = choices[(choices.indexOf(aiTypes.includes(type) ? type : "") + 1) % choices.length];
			try {
				localStorage.setItem(OPPONENTS_KEY, JSON.stringify(opponents));
			} catch {}
			renderOpponents();
			sendOpponents();
		});
		panel.append(button);
	});
	const hint = document.createElement("div");
	hint.className = "hint";
	hint.textContent = "They join in Versus archer select (not online), if there are archers left for them.";
	panel.append(hint);
}

function sendOpponents() {
	host?.SetAiOpponents(["", ...opponents.slice(0, aiSlots - 1).map((t) => (aiTypes.includes(t) ? t : ""))]).catch(console.error);
}

let onArcherSelect = false;

async function fetchAiSetup() {
	const [slots, types, select] = (await host.GetAiSetup()).split("|");
	aiSlots = Math.min(8, Math.max(2, Number(slots) || 4));
	aiTypes = types ? types.split(",") : [];
	onArcherSelect = select === "1";
}

// LoaderAI's AI types register once the game has loaded; then the button shows whenever the game
// is in versus archer select (checked twice a second).
async function watchAiTypes() {
	for (let i = 0; i < 60 && !aiTypes.length; i++) {
		await fetchAiSetup();
		if (!aiTypes.length) await new Promise((resolve) => setTimeout(resolve, 1000));
	}
	if (!aiTypes.length) return;
	renderOpponents();
	sendOpponents();
	for (;;) {
		const button = $("aiToggle");
		if (button.hidden === onArcherSelect) {
			button.hidden = !onArcherSelect;
			if (onArcherSelect) renderOpponents();
			else $("aiPanel").hidden = true;
		}
		await new Promise((resolve) => setTimeout(resolve, 500));
		await fetchAiSetup().catch((e) => {
			console.error(e);
			onArcherSelect = false;
		});
	}
}

// (Opening it checks the slots again: an 8-player mode can be turned on in the game.)
$("aiToggle").addEventListener("click", async () => {
	const panel = $("aiPanel");
	panel.hidden = !panel.hidden;
	$("canvas").focus();
	if (panel.hidden) return;
	await fetchAiSetup();
	renderOpponents();
	sendOpponents();
});

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
	return enabledCatalogMods().length > 0 || enabledCustomMods().length > 0;
}

// The player's own mod zips that will be installed (none while mods are switched off).
function enabledCustomMods() {
	return modState.off ? [] : modState.custom.filter((c) => c.enabled);
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
		...enabledCustomMods().map((c) => ({ name: c.file, sha256: c.sha256 })),
	];
	$("modSummary").textContent = modState.off
		? "All off: plain TowerFall (your picks are kept)"
		: files.length
			? `${names.size + enabledCustomMods().length} on${names.has("TF.EX") ? " · online play" : ""} · mod set ${await Mods.fingerprint(files)}`
			: "None picked: plain TowerFall";
	$("modsToggle").textContent = modState.off ? "Off" : "On";
	$("modsToggle").setAttribute("aria-pressed", String(!modState.off));
	$("modsPanel").classList.toggle("off", modState.off);
	const missing = Mods.missingDependencies(catalog, enabledCatalogMods());
	$("modWarning").textContent = missing.length ? `Also needs mods that aren't available here: ${missing.join(", ")}.` : "";
	patchAhead();
}

// Patching TowerFall.exe for FortRise takes a while the first time (cached afterwards: 12 s on a
// fast Mac, much longer on a phone), and doesn't depend on the mods picked. So once FortRise will
// run, it starts in the background (BrowserHost.PrePatch) while the player is still on this
// screen, and Play only waits for what's left. Resolves to the FortRise version.
let fortRiseReady = null;
function patchAhead() {
	if (fortRiseReady || !useFortRise() || !self.wasm?.exports) return;
	fortRiseReady = syncFortRise(() => {}).then(async (version) => {
		await self.wasm.exports.BrowserHost.PrePatch(version, new URL("_framework/", location.href).href, assemblyFiles());
		return version;
	});
	fortRiseReady.catch((e) => {
		console.warn("[fortrise] Couldn't start patching ahead:", e);
		fortRiseReady = null;
	});
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
// All mods on or off at once; the picks stay for when they're turned back on.
$("modsToggle").addEventListener("click", () => {
	modState.off = !modState.off;
	Mods.saveState(modState);
	renderMods();
});
$("addMod").addEventListener("click", () => $("modFile").click());
$("modFile").addEventListener("change", async () => {
	$("error").textContent = "";
	for (const file of $("modFile").files) {
		let added;
		try {
			added = await Mods.addZip(file);
		} catch (e) {
			console.error(e);
			$("error").textContent = String(e?.message ?? e);
			continue;
		}
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
	const mods = enabledCatalogMods();
	const shas = await Mods.ensureFiles(mods, (done, total) => progress(done / total), Mods.softMods(mods), (e) => {
		console.warn(e);
		$("error").textContent = `${e.message} Playing without it this time.`;
	});
	shas.push(...enabledCustomMods().map((c) => c.sha256));
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
// Asks the browser to keep the site's storage (the imported game, mods and saves) instead of
// clearing it when space runs low, or (Safari) after a week without a visit. Browsers decide
// themselves whether to grant it; asking again changes nothing once granted.
async function keepStorage() {
	try {
		if (navigator.storage?.persist && !(await navigator.storage.persisted())) {
			console.log(`[storage] persistent: ${await navigator.storage.persist()}`);
		}
	} catch (e) {
		console.warn("[storage]", e);
	}
}

async function ensureGameFiles() {
	status("Checking game files…");
	const server = await fromServer(gameFilesHost());
	if (server) {
		const located = locateGame(server);
		// Nothing downloads until the player picks: everything, or all but the music (MUSIC in
		// gamefiles.js), which the Load music button can get later.
		const missing = await missingFiles(located.content);
		const game = located.content.filter((c) => c.to !== MUSIC);
		const missingGame = missing.filter((c) => c.to !== MUSIC);
		// A game imported before the host had checksums (or never checked) is checked once now:
		// a damaged file can have the right size (importGame gets those again).
		const imported = await importedGame();
		const unchecked = imported && !imported.verified && located.content.some((c) => c.from.sha256);
		if (missingGame.length > 0 || !imported || unchecked) {
			const all = missingGame.length > 0 ? await chooseDownload(missing, missingGame) : false;
			await copyIn({ ...located, content: all ? located.content : game }, "server");
		}
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

// Asks whether to download everything that's missing or all but the music; resolves to true for
// everything. Shows the download sizes.
function chooseDownload(missing, missingGame) {
	// ?autoplay (automated tests) loads everything without asking.
	if (new URLSearchParams(location.search).has("autoplay")) return Promise.resolve(true);
	const size = (list) => formatMB(list.reduce((n, c) => n + c.from.size, 0));
	status("Load TowerFall?");
	$("bar").hidden = true;
	$("downloadAll").textContent = `Load game (${size(missing)})`;
	$("downloadNoMusic").textContent = `Load game without music (${size(missingGame)})`;
	// (Only one choice when the music is already stored.)
	const choice = missing.length > missingGame.length;
	$("downloadNoMusic").hidden = !choice;
	$("downloadNoMusicHint").hidden = !choice;
	$("download").hidden = false;
	return new Promise((resolve) => {
		const pick = (all) => () => {
			$("download").hidden = true;
			$("bar").hidden = false;
			resolve(all);
		};
		$("downloadAll").addEventListener("click", pick(true), { once: true });
		$("downloadNoMusic").addEventListener("click", pick(false), { once: true });
	});
}

// While the game runs without its music bank, a Music button next to Sound downloads it (showing
// how big it is, then how far along), has the host start the game's music, and goes away. (Sound
// stays: it also covers the sound effects, which every import includes.)
let pendingMusic = null;
function offerMusic(host) {
	const button = $("music");
	button.textContent = `Load music (${formatMB(pendingMusic.from.size)})`;
	button.hidden = false;
	button.addEventListener("click", async () => {
		if (button.disabled) return;
		button.disabled = true;
		try {
			await importMusic(pendingMusic, (done, total) => (button.textContent = `Music: ${Math.floor((100 * done) / total)}%`));
			await host.StartMusic();
			button.hidden = true;
		} catch (e) {
			console.error("Couldn't load the music", e);
			button.textContent = "Music failed: tap to retry";
			button.disabled = false;
		}
		$("canvas").focus();
	});
}

// For steps with no telling how long they take (FortRise patching TowerFall.exe the first time,
// then loading each mod): shows the time passing and what it's doing, from its log, and how far
// patching is while it patches.
function showActivity(text) {
	const started = performance.now();
	let doing = "";
	let patched = 100;
	onConsoleLine = (line) => {
		const report = /^\[progress\] patch (\d+)$/.exec(line);
		if (report) {
			patched = Number(report[1]);
			$("bar").classList.toggle("busy", patched >= 100);
			progress(patched / 100);
			return;
		}
		const logged = /^\[log\] \[Information\]\[(?:FortRise|Mods)\] (?:\[\w+\] )?(.+)/.exec(line);
		if (logged) doing = logged[1];
	};
	const tick = () => {
		status(`${text} ${Math.floor((performance.now() - started) / 1000)} s`);
		detail(patched < 100 ? `${doing} ${patched}%` : doing);
	};
	tick();
	const timer = setInterval(tick, 250);
	$("bar").classList.add("busy");
	return () => {
		clearInterval(timer);
		onConsoleLine = null;
		$("bar").classList.remove("busy");
		detail("");
	};
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
		// A zip of the folder, dropped on its own.
		const zip = dt.files.length === 1 && /\.zip$/i.test(dt.files[0].name) ? dt.files[0] : null;
		if (zip) return run(() => fromZip(zip), "zip");
		// Read the entries now: DataTransfer items are only valid during the event.
		const entries = fromDataTransfer(dt);
		run(() => entries, "drop");
	};
	// The pick panel's other ways in: a zip file, or a link (see useLink).
	if (button === $("choose")) {
		$("chooseZip").onclick = () => {
			$("zipFile").onchange = () => {
				const zip = $("zipFile").files[0];
				$("zipFile").value = "";
				if (zip) run(() => fromZip(zip), "zip");
			};
			$("zipFile").click();
		};
		$("linkForm").onsubmit = (e) => {
			e.preventDefault();
			const link = $("linkInput").value.trim();
			if (link) run(() => useLink(link), "zip-url");
		};
	}
	addEventListener("dragover", onDragOver);
	addEventListener("drop", onDrop);
	return () => {
		button.onclick = null;
		if (button === $("choose")) $("chooseZip").onclick = $("linkForm").onsubmit = null;
		removeEventListener("dragover", onDragOver);
		removeEventListener("drop", onDrop);
	};
}

// A link pasted on the pick panel: a private file host (its base URL, or a whole page link with
// #gamefiles=), which is remembered like a #gamefiles= link and used from then on (the page reloads
// to take it), or a zip of the TowerFall folder, whose entries are returned to import.
async function useLink(link) {
	const given = link.match(/[#&]gamefiles=([^&]*)/);
	let url;
	try {
		url = new URL(given ? decodeURIComponent(given[1]) : link, location.href).href;
	} catch {
		throw new Error("That doesn't look like a link.");
	}
	if (!/\.zip$/i.test(new URL(url).pathname)) {
		const host = url.endsWith("/") ? url : url + "/";
		if (await fromServer(host)) {
			try {
				localStorage.setItem(HOST_KEY, host);
			} catch {}
			location.reload();
			return new Promise(() => {}); // (the page is going away)
		}
	}
	try {
		return await fromZip(url);
	} catch (e) {
		throw new Error(`No game files found at that link: it isn't a game-file host, and as a zip: ${e?.message ?? e}`);
	}
}

// Public site: the player supplies their own copy, by picking or dropping the install folder.
function askForGame() {
	const ask = () => {
		status("Bring your TowerFall");
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
	// The bar follows the runtime's files (the app, the framework and the WebAssembly) as they
	// arrive, then shows it's busy while the runtime compiles and starts, which takes a while on a
	// phone and can't be measured.
	$("bar").hidden = false;
	progress(0);
	const { dotnet } = await import("./_framework/dotnet.js");
	let builder = dotnet.withConfig({}).withModuleConfig({
		onDownloadResourceProgress: (loaded, total) => {
			progress(loaded / total);
			detail(`${loaded} / ${total} files`);
			if (loaded >= total) {
				$("bar").classList.add("busy");
				detail("");
			}
		},
	});
	if (new URLSearchParams(location.search).has("debug")) builder = builder.withEnvironmentVariable("TOWERFALL_LOG", "debug");
	const server = tfexServer();
	if (server.url) builder = builder.withEnvironmentVariable("TFEX_SERVER", server.url).withEnvironmentVariable("TFEX_SERVER_FORCE", server.force ? "1" : "0");
	// ?tfexfps=60 (experiment): TF.EX runs its sessions at that tick rate instead of 240 (web/Netplay/TfexFps.cs).
	const tfexFps = new URLSearchParams(location.search).get("tfexfps");
	if (tfexFps) builder = builder.withEnvironmentVariable("TOWERFALL_TFEX_FPS", tfexFps);
	// ?tfexplatform=Switch (debug): this page tells TF.EX's lobby it plays on that platform, so two browsers can
	// rehearse a lobby match against the Switch (relay, 60 Hz; web/Netplay/SwitchLobby.cs).
	const tfexPlatform = new URLSearchParams(location.search).get("tfexplatform");
	if (tfexPlatform) builder = builder.withEnvironmentVariable("TOWERFALL_TFEX_PLATFORM", tfexPlatform);
	// ?fullchecksum=1: GGRS computes a desync checksum on every state save, as TF.EX does, instead of only on the
	// frames it compares with the other players (netplay/ggrs-ffi.patch). Same checksums sent either way.
	if (new URLSearchParams(location.search).get("fullchecksum") === "1") builder = builder.withEnvironmentVariable("TOWERFALL_FULLCHECKSUM", "1");
	// A 16 MB GC nursery instead of the default 4 MB: TF.EX's rollback state saves allocate a few MB
	// per second, and each minor collection stops every thread at a cost set by the surviving
	// objects, not the nursery size, so 4x fewer of them (measured: 27 -> 7 per 5 s in the rollback
	// sync test) means fewer frame hitches for ~12 MB of memory.
	builder = builder.withEnvironmentVariable("MONO_GC_PARAMS", "nursery-size=16m");
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
	$("bar").classList.remove("busy");
	detail("");
	return exports;
}

async function main() {
	if (!self.crossOriginIsolated && navigator.serviceWorker && !navigator.serviceWorker.controller) {
		// First visit on a host without COOP/COEP: coi-serviceworker.js is installing and will
		// reload the page. Give it a moment before calling it a failure.
		status("Setting up…");
		await new Promise((resolve) => setTimeout(resolve, 5000));
	}
	// The worker can also take control of this page before it reloads it (clients.claim), and then
	// no reload comes: the page is controlled but was loaded without the headers. Reload once.
	// (Without session storage, no reload: it couldn't tell it had already tried.)
	const RELOADED = "towerfall.coiReload";
	const session = (f) => {
		try {
			return f(sessionStorage);
		} catch {
			return null;
		}
	};
	if (!self.crossOriginIsolated && navigator.serviceWorker?.controller && session((s) => s.getItem(RELOADED) !== "1" && (s.setItem(RELOADED, "1"), true))) {
		location.reload();
		return;
	}
	session((s) => s.removeItem(RELOADED));
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
	// The game opens on the main menu: no intro, and past the title screen (see startMode below).
	// ?intro starts it the way the desktop game does.
	const showIntro = new URLSearchParams(location.search).has("intro");
	const noIntro = !showIntro;
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
			$("bar").hidden = true;
			if (e instanceof Mods.StorageFullError) {
				$("error").textContent = e.message;
				continue;
			}
			if (!(e instanceof Mods.ModDownloadError)) throw e;
			$("error").innerHTML = `${escapeHtml(e.message)} Download it from <a href="${escapeHtml(e.mod.entry.page)}" target="_blank" rel="noopener">its GameBanana page</a> and add it with "Add a mod zip", then press Play again.`;
		}
	}
	$("change").hidden = true;
	$("dw").hidden = true;
	stopDarkWorldOffer();
	// (After a click: some browsers only grant it to a page the player has interacted with.)
	keepStorage();

	// With the on-screen controls on, Init() plugs their virtual gamepad in at launch; with sound
	// set to effects, the game's music stays off from the start.
	await exports.BrowserHost.ShowTouchControls(touchOn);
	await exports.BrowserHost.SetGameMusic(sound !== "effects");

	if (useFortRise()) {
		status("Getting FortRise…");
		$("bar").hidden = false;
		const version = await (fortRiseReady ?? Promise.reject()).catch(() => syncFortRise(showProgress));
		// Patching TowerFall.exe takes a while the first time (it's cached afterwards), and so does
		// loading the mods.
		const stopActivity = showActivity(`Starting FortRise ${version}…`);
		try {
			await exports.BrowserHost.Init(noIntro, version, new URL("_framework/", location.href).href, assemblyFiles());
		} finally {
			stopActivity();
		}
	} else {
		await exports.BrowserHost.Init(noIntro, null, null, null);
	}
	hideOverlay();
	$("canvas").focus();
	host = exports.BrowserHost;
	if (pendingMusic) offerMusic(host);
	await applyTouch();
	if (useFortRise()) watchAiTypes().catch(console.error);

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
	const startMode = new URLSearchParams(location.search).get("mode") ?? (showIntro ? null : "menu");
	if (startMode) await exports.BrowserHost.SetStartMode(startMode);
	// The Stats panel and performance reports (stats.js).
	const server = tfexServer();
	startStats(exports.BrowserHost, { serverUrl: server.url, official: server.url === TFEX_SERVERS.official, version: new URL(import.meta.url).searchParams.get("v") ?? "" });
	// ?slowcpu=N (or towerfallSlowCpu(N) from the console), for testing: run like an N times slower computer.
	self.towerfallSlowCpu = (factor) => exports.BrowserHost.SetSlowCpu(factor);
	const slowCpu = Number(new URLSearchParams(location.search).get("slowcpu"));
	if (slowCpu > 1) await exports.BrowserHost.SetSlowCpu(slowCpu);
	// ?statedump=N (Switch harness, local only): every Nth GGRS save's TF.State bytes (web/Netplay/StateDump.cs).
	const stateDump = new URLSearchParams(location.search).get("statedump");
	if (stateDump != null) await exports.BrowserHost.RunCommand(`statedump ${Number(stateDump) || 60}`);
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
		// SDL creates its AudioContext lazily, so keep the sound setting applied.
		applyGain();
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
