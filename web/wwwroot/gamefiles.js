// Getting the player's own TowerFall files into OPFS (mounted at /libsdl in .NET), as:
//   game/TowerFall.exe, game/Content/**, game/DarkWorldContent/** (optional)
//
// Sources, all reduced to a flat list of { path, size, open() -> Promise<Blob | Response> } (plus
// `pack` from a server that has the files in a pack, see fromServer):
//   - a folder the player picks or drops (public site: no game files are hosted), or
//   - gamefiles/manifest.json on a server that hosts the files: this one (tools/serve.py's private
//     mode) or a private file host elsewhere (cloudflare/, given as a base URL).
// Paths are relative to whatever folder was supplied; locateGame() finds the game inside it, so
// the player can hand over the Steam folder, the .app bundle, or an extracted copy.

const MARKER = ".imported.json";

// The game's music bank: most of the game's bytes (218 MB of 354), and the game runs fine without it
// (no music). Imports from a file host leave it out so the first load is quicker and a phone only
// downloads it when asked to (the page's Music button, then importMusic()).
export const MUSIC = "Content/Music/Win/MusicWaveBank.xwb";

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
		// tools/upload-gamefiles.sh also puts the game's files (all but the music) one after another
		// in a pack, so a first import is a few big range requests instead of one per file (~1,600,
		// each a round trip); copyFiles uses it, and open() for anything it can't.
		pack: f.pack ? { url: base + "gamefiles/" + f.pack, offset: f.offset } : null,
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

async function existingSize(root, path, dirs = new Map()) {
	const parts = path.split("/");
	const name = parts.pop();
	try {
		const key = parts.join("/");
		let dir = dirs.get(key);
		if (!dir) dirs.set(key, (dir = getDir(root, parts, false)));
		return (await (await (await dir).getFileHandle(name)).getFile()).size;
	} catch {
		return -1;
	}
}

// The entries of content whose file in browser storage doesn't have the right size (missing or
// cut short), looking up many at once and each folder once.
async function notStored(root, content) {
	const dirs = new Map();
	const sizes = new Array(content.length);
	let next = 0;
	const worker = async () => {
		while (next < content.length) {
			const i = next++;
			sizes[i] = await existingSize(root, content[i].to, dirs);
		}
	};
	await Promise.all(Array.from({ length: 32 }, worker));
	return content.filter((c, i) => sizes[i] !== c.from.size);
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

// The entries of content that aren't (completely) in browser storage yet.
export async function missingFiles(content) {
	return notStored(await gameRoot(true), content);
}

// The located music bank if it isn't (completely) in browser storage yet, else null.
export async function missingMusic(located) {
	const music = located.content.find((c) => c.to === MUSIC);
	if (!music) return null;
	return (await existingSize(await gameRoot(true), MUSIC)) === music.from.size ? null : music;
}

export async function importMusic(music, onProgress) {
	await copyFiles(await gameRoot(true), [music], onProgress);
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
	const todo = await notStored(root, content);
	let done = total - todo.reduce((n, c) => n + c.from.size, 0);
	onProgress(done, total);
	const progress = (bytes) => onProgress((done += bytes), total);
	const dirs = new Map();
	const create = async (c) => {
		const parts = c.to.split("/");
		const name = parts.pop();
		const key = parts.join("/");
		let dir = dirs.get(key);
		if (!dir) dirs.set(key, (dir = getDir(root, parts, true)));
		return (await (await dir).getFileHandle(name, { create: true })).createWritable();
	};

	// Packed files: a few range requests, each split into the files it holds. Whatever a range
	// couldn't deliver goes file by file below.
	const [failed] = await Promise.all([
		copyPacked(todo.filter((c) => c.from.pack), create, progress),
		copyLoose(todo.filter((c) => !c.from.pack), create, progress),
	]);
	await copyLoose(failed, create, progress);
}

// One file at a time per connection, biggest first: the music bank alone is most of the bytes, so it
// starts right away while the many small files share the other connections. Over the network each
// file costs a round trip (~0.2 s to the private host), so keep plenty in flight.
async function copyLoose(todo, create, progress) {
	todo.sort((a, b) => b.from.size - a.from.size);
	let next = 0;
	const worker = async () => {
		while (next < todo.length) {
			const c = todo[next++];
			if (c.copied) continue;
			c.copied = true;
			const writable = await create(c);
			const data = await c.from.open();
			const reader = (data.body ?? data.stream()).getReader();
			for (;;) {
				const { done: eof, value } = await reader.read();
				if (eof) break;
				await writable.write(value);
				progress(value.byteLength);
			}
			await writable.close();
		}
	};
	await Promise.all(Array.from({ length: 16 }, worker));
}

// Packed files grouped into runs of neighbours (bridging small gaps of files already stored or not
// needed), each run one range request, a few in flight. Resolves to the files left to copy on their
// own (a pack the server no longer has, or that came back without a range).
const RUN_BYTES = 16 << 20;
const RUN_GAP = 256 << 10;
async function copyPacked(todo, create, progress) {
	const runs = [];
	const byPack = new Map();
	for (const c of todo) byPack.set(c.from.pack.url, [...(byPack.get(c.from.pack.url) ?? []), c]);
	for (const [url, files] of byPack) {
		files.sort((a, b) => a.from.pack.offset - b.from.pack.offset);
		let run = null;
		for (const c of files) {
			const start = c.from.pack.offset;
			const end = start + c.from.size;
			if (run && start - run.end <= RUN_GAP && end - run.start <= RUN_BYTES) {
				run.files.push(c);
				run.end = end;
			} else runs.push((run = { url, start, end, files: [c] }));
		}
	}
	const failed = [];
	let next = 0;
	const worker = async () => {
		while (next < runs.length) {
			const run = runs[next++];
			try {
				await copyRun(run, create, progress);
			} catch (e) {
				console.warn(`[import] ${run.url} ${run.start}-${run.end}: ${e.message ?? e}; getting those files one by one`);
				failed.push(...run.files.filter((c) => !c.copied));
			}
		}
	};
	await Promise.all(Array.from({ length: 6 }, worker));
	return failed;
}

async function copyRun(run, create, progress) {
	const res = await fetch(run.url, { headers: { Range: `bytes=${run.start}-${run.end - 1}` } });
	if (res.status !== 206) {
		res.body?.cancel();
		throw new Error(`HTTP ${res.status}, not a range`);
	}
	const reader = res.body.getReader();
	let at = run.start; // pack offset of the next byte from the reader
	let i = 0; // the file being written, or the next one
	let writable = null;
	let written = 0;
	try {
		for (;;) {
			const { done: eof, value } = await reader.read();
			if (eof) break;
			let chunk = value;
			while (chunk.byteLength > 0 && i < run.files.length) {
				const c = run.files[i];
				const start = c.from.pack.offset;
				if (at < start) {
					// A gap: bytes of files that aren't wanted.
					const skip = Math.min(start - at, chunk.byteLength);
					chunk = chunk.subarray(skip);
					at += skip;
					continue;
				}
				writable ??= await create(c);
				const take = Math.min(start + c.from.size - at, chunk.byteLength);
				await writable.write(chunk.subarray(0, take));
				chunk = chunk.subarray(take);
				at += take;
				written += take;
				progress(take);
				if (at === start + c.from.size) {
					await writable.close();
					writable = null;
					c.copied = true;
					i++;
				}
			}
		}
		// Empty files at the end of the run.
		for (; i < run.files.length && run.files[i].from.size === 0 && at === run.files[i].from.pack.offset; i++) {
			await (await create(run.files[i])).close();
			run.files[i].copied = true;
		}
		if (i < run.files.length) throw new Error("the range ended early");
	} catch (e) {
		await writable?.abort().catch(() => {});
		// Take back what this run counted for files that will be copied again.
		progress(-run.files.filter((c) => !c.copied).reduce((n, c) => n + Math.max(0, Math.min(c.from.size, at - c.from.pack.offset)), 0));
		throw e;
	}
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
