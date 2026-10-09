// Boots TowerFall in the browser:
//  1. Get the player's game files into OPFS (see gamefiles.js), which .NET mounts at /libsdl.
//  2. Start the .NET runtime, load their TowerFall.exe, then tick it once per animation frame.

import { addDarkWorld, forgetGame, fromDataTransfer, fromDirectoryHandle, fromFileList, fromServer, importedGame, importGame, locateDarkWorld, locateGame, syncFortRise } from "./gamefiles.js";
import * as Mods from "./mods.js";

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
	$("overlay").classList.remove("hidden");
}

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
			<span class="by">by ${escapeHtml(m.entry.author)}${m.status === "untested" ? " · untested" : ""}${viaDependency ? " · needed by another mod" : ""}</span>
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

// Private deployments host the game files (and the server's copy always wins); otherwise use
// what the player imported before, or ask them for their TowerFall folder.
async function ensureGameFiles() {
	status("Checking game files…");
	const server = await fromServer();
	if (server) {
		await copyIn(locateGame(server), "server");
		return;
	}
	if (await importedGame()) {
		$("change").hidden = false;
	} else {
		await askForGame();
	}
	if (!(await importedGame()).darkWorld) offerDarkWorld();
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

async function startDotnet() {
	status("Starting .NET runtime…");
	const { dotnet } = await import("./_framework/dotnet.js");
	let builder = dotnet.withConfig({});
	if (new URLSearchParams(location.search).has("debug")) builder = builder.withEnvironmentVariable("TOWERFALL_LOG", "debug");
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
	$("overlay").classList.add("hidden");
	$("canvas").focus();

	// TowerFall is a 60 Hz game. On high-refresh displays, only tick on the animation frames
	// that bring us to the next 60 Hz slot (?uncapped ticks on every animation frame).
	const uncapped = new URLSearchParams(location.search).has("uncapped");
	const TICK_MS = 1000 / 60;
	let behind = TICK_MS;
	let last = performance.now();

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
			keepRunning = await exports.BrowserHost.MainLoop();
		} catch (e) {
			fail(e);
			return;
		}
		// SDL creates its AudioContext lazily, so keep the mute state applied.
		applyMute();
		if (keepRunning) {
			requestAnimationFrame(frame);
		} else {
			status("TowerFall has exited. Reload to play again.");
			$("overlay").classList.remove("hidden");
		}
	};
	requestAnimationFrame(frame);
}

main().catch(fail);
