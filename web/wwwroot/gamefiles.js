// Getting the player's own TowerFall files into OPFS (mounted at /libsdl in .NET), as:
//   game/TowerFall.exe, game/Content/**, game/DarkWorldContent/** (optional)
//
// Sources, all reduced to a flat list of { path, size, open() -> Promise<Blob | Response> }:
//   - a folder the player picks or drops (public site: no game files are hosted), or
//   - gamefiles/manifest.json on a server that hosts the files: this one (tools/serve.py's private
//     mode) or a private file host elsewhere (cloudflare/, given as a base URL).
// Paths are relative to whatever folder was supplied; locateGame() finds the game inside it, so
// the player can hand over the Steam folder, the .app bundle, or an extracted copy.

const MARKER = ".imported.json";

// --- Sources ---------------------------------------------------------------------------------

export async function fromServer(base = "") {
	let res;
	try {
		res = await fetch(base + "gamefiles/manifest.json", { cache: "no-store" });
	} catch {
		return null;
	}
	if (!res.ok) return null;
	const manifest = await res.json();
	return manifest.files.map((f) => ({
		path: f.path,
		size: f.size,
		open: async () => {
			const r = await fetch(base + "gamefiles/" + f.path.split("/").map(encodeURIComponent).join("/"));
			if (!r.ok) throw new Error(`Failed to fetch ${f.path}: ${r.status}`);
			return r;
		},
	}));
}

// <input type="file" webkitdirectory> results.
export function fromFileList(files) {
	return Array.from(files, (file) => ({
		path: file.webkitRelativePath || file.name,
		size: file.size,
		open: async () => file,
	}));
}

// showDirectoryPicker() result (Chromium).
export async function fromDirectoryHandle(dir) {
	const out = [];
	const walk = async (handle, prefix) => {
		for await (const [name, child] of handle.entries()) {
			if (child.kind === "directory") {
				await walk(child, prefix + name + "/");
			} else {
				const file = await child.getFile();
				out.push({ path: prefix + name, size: file.size, open: async () => file });
			}
		}
	};
	await walk(dir, dir.name + "/");
	return out;
}

// Drag and drop: DataTransferItem.webkitGetAsEntry() trees (all major browsers).
export async function fromDataTransfer(dataTransfer) {
	const roots = Array.from(dataTransfer.items, (item) => item.webkitGetAsEntry?.()).filter(Boolean);
	const out = [];
	const fileOf = (entry) => new Promise((resolve, reject) => entry.file(resolve, reject));
	const readAll = (dirEntry) =>
		new Promise((resolve, reject) => {
			const reader = dirEntry.createReader();
			const all = [];
			const next = () =>
				reader.readEntries((batch) => {
					if (batch.length === 0) return resolve(all);
					all.push(...batch);
					next();
				}, reject);
			next();
		});
	const walk = async (entry, prefix) => {
		if (entry.isDirectory) {
			for (const child of await readAll(entry)) await walk(child, prefix + entry.name + "/");
		} else {
			const file = await fileOf(entry);
			out.push({ path: prefix + entry.name, size: file.size, open: async () => file });
		}
	};
	for (const root of roots) await walk(root, "");
	return out;
}

// --- Finding the game inside whatever was supplied ------------------------------------------

const dirOf = (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/") + 1) : "");
const lower = (p) => p.toLowerCase();

// Returns { exe, content: [{ from, to }], darkWorld: bool } or throws with a helpful message.
export function locateGame(entries) {
	const byPath = new Map(entries.map((e) => [lower(e.path), e]));
	const has = (p) => byPath.has(lower(p));

	// TowerFall.exe with Content/ next to it: Windows/Linux installs keep both at the top level,
	// the macOS app keeps them in TowerFall.app/Contents/Resources (or Contents/MacOS).
	const exes = entries
		.filter((e) => lower(e.path).endsWith("towerfall.exe") && lower(e.path.split("/").pop()) === "towerfall.exe")
		.filter((e) => has(dirOf(e.path) + "Content/Atlas/atlas.xml"))
		.sort((a, b) => a.path.length - b.path.length);
	if (exes.length === 0) {
		const hasContent = entries.some((e) => lower(e.path).endsWith("content/atlas/atlas.xml"));
		throw new Error(
			hasContent
				? "Found TowerFall's content but not TowerFall.exe next to it. The PC version (Steam, itch.io or Humble) is required; the Switch version doesn't include it."
				: "Couldn't find TowerFall in that folder. Choose the folder TowerFall is installed in.",
		);
	}
	const exe = exes[0];
	const base = dirOf(exe.path);

	const content = [{ from: exe, to: "TowerFall.exe" }];
	for (const e of entries) {
		if (e.path.startsWith(base + "Content/")) content.push({ from: e, to: e.path.slice(base.length) });
	}
	const dw = darkWorldFiles(entries, base);
	content.push(...dw);
	return { exe: exe.path, content: withoutHidden(content), darkWorld: dw.length > 0 };
}

// Just the Dark World content, for adding it to a game imported without it (on the Steam macOS
// install it sits next to TowerFall.app, so dropping only the app leaves it out).
export function locateDarkWorld(entries) {
	const content = withoutHidden(darkWorldFiles(entries, ""));
	if (content.length === 0) {
		throw new Error("Couldn't find Dark World in that. Drop the DarkWorldContent folder.");
	}
	return { content, darkWorld: true };
}

// Dark World ships as a DarkWorldContent/ folder: next to the exe on Windows/Linux, at the top of
// the Steam folder (outside the .app) on macOS. Takes the one whose path is closest to `near`.
function darkWorldFiles(entries, near) {
	const roots = entries
		.map((e) => e.path)
		.filter((p) => lower(p).endsWith("darkworldcontent/atlas/atlas.xml"))
		.map((p) => p.slice(0, p.length - "Atlas/atlas.xml".length))
		.sort((a, b) => Math.abs(a.length - near.length) - Math.abs(b.length - near.length));
	const root = roots[0];
	if (!root) return [];
	return entries.filter((e) => e.path.startsWith(root)).map((e) => ({ from: e, to: "DarkWorldContent/" + e.path.slice(root.length) }));
}

const withoutHidden = (content) => content.filter((c) => !c.to.split("/").pop().startsWith("."));

// --- OPFS ------------------------------------------------------------------------------------

async function getDir(root, parts, create) {
	let dir = root;
	for (const part of parts) dir = await dir.getDirectoryHandle(part, { create });
	return dir;
}

async function gameRoot(create = true) {
	const opfs = await navigator.storage.getDirectory();
	return opfs.getDirectoryHandle("game", { create });
}

async function existingSize(root, path) {
	const parts = path.split("/");
	const name = parts.pop();
	try {
		const dir = await getDir(root, parts, false);
		return (await (await dir.getFileHandle(name)).getFile()).size;
	} catch {
		return -1;
	}
}

// The imported game, or null if there isn't a complete one.
export async function importedGame() {
	try {
		const root = await gameRoot(false);
		const file = await (await root.getFileHandle(MARKER)).getFile();
		return JSON.parse(await file.text());
	} catch {
		return null;
	}
}

export async function forgetGame() {
	const opfs = await navigator.storage.getDirectory();
	await opfs.removeEntry("game", { recursive: true }).catch(() => {});
}

// Copies the located game into OPFS. Files already there with the same size are kept, so a
// re-import (or a private server's re-sync) only copies what changed.
export async function importGame(located, source, onProgress) {
	const root = await gameRoot(true);
	// A stale marker would claim a half-copied game is complete.
	await root.removeEntry(MARKER).catch(() => {});
	await copyFiles(root, located.content, onProgress);
	const total = located.content.reduce((n, c) => n + c.from.size, 0);
	const info = { source, exe: located.exe, darkWorld: located.darkWorld, files: located.content.length, bytes: total, at: new Date().toISOString() };
	await writeMarker(root, info);
	return info;
}

// Adds Dark World to the already imported game.
export async function addDarkWorld(located, onProgress) {
	const info = await importedGame();
	if (!info) throw new Error("Import TowerFall first.");
	const root = await gameRoot(true);
	await copyFiles(root, located.content, onProgress);
	const added = { ...info, darkWorld: true, files: info.files + located.content.length };
	await writeMarker(root, added);
	return added;
}

async function writeMarker(root, info) {
	const marker = await (await root.getFileHandle(MARKER, { create: true })).createWritable();
	await marker.write(JSON.stringify(info));
	await marker.close();
}

async function copyFiles(root, content, onProgress) {
	const total = content.reduce((n, c) => n + c.from.size, 0);
	let done = 0;
	const todo = [];
	for (const c of content) {
		if ((await existingSize(root, c.to)) === c.from.size) done += c.from.size;
		else todo.push(c);
	}
	onProgress(done, total);

	let next = 0;
	const worker = async () => {
		while (next < todo.length) {
			const c = todo[next++];
			const parts = c.to.split("/");
			const name = parts.pop();
			const dir = await getDir(root, parts, true);
			const writable = await (await dir.getFileHandle(name, { create: true })).createWritable();
			const data = await c.from.open();
			const reader = (data.body ?? data.stream()).getReader();
			for (;;) {
				const { done: eof, value } = await reader.read();
				if (eof) break;
				await writable.write(value);
				done += value.byteLength;
				onProgress(done, total);
			}
			await writable.close();
		}
	};
	await Promise.all(Array.from({ length: 6 }, worker));
}

// --- FortRise -----------------------------------------------------------------------------

// Copies FortRise's patch module and built-in modules (served by this site under fortrise/) into
// the player's FortRise folder in OPFS, where the host also keeps Mods/, Saves/ and the generated
// TowerFall.Patch.dll. Returns the FortRise version.
export async function syncFortRise(onProgress) {
	const res = await fetch("fortrise/manifest.json", { cache: "no-store" });
	if (!res.ok) throw new Error(`Couldn't load FortRise (fortrise/manifest.json: ${res.status}).`);
	const manifest = await res.json();
	const opfs = await navigator.storage.getDirectory();
	const root = await opfs.getDirectoryHandle("fortrise", { create: true });

	// A different FortRise version: drop the old one's files (but not the player's mods or saves).
	let installed = null;
	try {
		installed = JSON.parse(await (await (await root.getFileHandle(MARKER)).getFile()).text()).version;
	} catch {}
	if (installed !== manifest.version) {
		for (const name of ["Internals", "TowerFall.FortRise.mm.dll", "TowerFall.Patch.dll", "TowerFall.Patch.dll.inputs", MARKER]) {
			await root.removeEntry(name, { recursive: true }).catch(() => {});
		}
	}

	// Internals/ belongs to FortRise: mirror the site exactly (modules can be dropped between builds).
	const published = new Set(manifest.files.map((f) => f.path));
	const prune = async (dir, prefix) => {
		for await (const [name, handle] of dir.entries()) {
			const path = prefix + name;
			if (handle.kind === "directory") {
				if (![...published].some((p) => p.startsWith(path + "/"))) await dir.removeEntry(name, { recursive: true });
				else await prune(handle, path + "/");
			} else if (!published.has(path)) {
				await dir.removeEntry(name);
			}
		}
	};
	const internals = await root.getDirectoryHandle("Internals", { create: true });
	await prune(internals, "Internals/");

	const content = manifest.files.map((f) => ({
		from: {
			path: f.path,
			size: f.size,
			open: async () => {
				const r = await fetch("fortrise/" + f.path.split("/").map(encodeURIComponent).join("/"));
				if (!r.ok) throw new Error(`Failed to fetch FortRise file ${f.path}: ${r.status}`);
				return r;
			},
		},
		to: f.path,
	}));
	await copyFiles(root, content, onProgress);
	await writeMarker(root, { version: manifest.version, at: new Date().toISOString() });
	return manifest.version;
}
