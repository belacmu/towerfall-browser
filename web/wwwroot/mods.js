// Mods, chosen on the page before the game starts (see docs/MODS.md).
//
// The catalog (mods/catalog.json, built from GameBanana by tools/update-catalog.py) lists every
// TowerFall mod with its pinned file, checksums and browser status. The page offers the ones that
// work, downloads enabled ones straight from GameBanana (never from us) into OPFS fortrise/ModZips/,
// and writes fortrise/mods.json; the host's ModInstaller extracts them into FortRise's Mods/ folder.
// Players can also add their own mod zips, identified by checksum.

const STATE_KEY = "towerfall.mods";
// FortRise itself and its built-in modules satisfy these dependencies.
const BUILT_IN = new Set(["FortRise", "FortRise.Content"]);

export async function loadCatalog() {
	const res = await fetch("mods/catalog.json", { cache: "no-store" });
	if (!res.ok) return [];
	const catalog = await res.json();
	// One entry per FortRise mod (a GameBanana file can hold several; they share the file).
	const mods = [];
	for (const entry of catalog.mods) {
		for (const mod of entry.mods) {
			mods.push({ ...mod, entry, key: mod.name });
		}
	}
	return mods;
}

// The mods the page offers: those known to work. ?allmods also offers untested ones (for testing).
export function offered(catalog) {
	const all = new URLSearchParams(location.search).has("allmods");
	return catalog.filter((m) => m.status === "works" || (all && m.status === "untested"));
}

// --- What's enabled -----------------------------------------------------------------------

// { enabled: [mod name], custom: [{ name, sha256, size, file }] }, per browser.
export function loadState() {
	try {
		const s = JSON.parse(localStorage.getItem(STATE_KEY));
		if (s && Array.isArray(s.enabled)) return { enabled: s.enabled, custom: s.custom ?? [] };
	} catch {}
	return { enabled: [], custom: [] };
}

export function saveState(state) {
	try {
		localStorage.setItem(STATE_KEY, JSON.stringify(state));
	} catch {}
}

// ?mods=a,b overrides what's enabled (for tests and shareable links).
export function enabledNames(state) {
	const param = new URLSearchParams(location.search).get("mods");
	return param != null ? param.split(",").filter(Boolean) : state.enabled;
}

// The enabled catalog mods plus everything they depend on (that's in the catalog).
export function withDependencies(catalog, names) {
	const byName = new Map(catalog.map((m) => [m.name, m]));
	const out = new Map();
	const visit = (name) => {
		if (out.has(name) || BUILT_IN.has(name)) return;
		const mod = byName.get(name);
		if (!mod) return;
		out.set(name, mod);
		for (const d of mod.dependencies) visit(d.name);
	};
	for (const n of names) visit(n);
	return [...out.values()];
}

// Missing dependencies (not in the catalog, not built in), for a warning.
export function missingDependencies(catalog, mods) {
	const known = new Set(catalog.map((m) => m.name));
	const missing = new Set();
	for (const m of mods) for (const d of m.dependencies) if (!known.has(d.name) && !BUILT_IN.has(d.name)) missing.add(d.name);
	return [...missing];
}

// A short fingerprint of a mod set, for comparing with other players later.
export async function fingerprint(files) {
	const lines = files.map((f) => `${f.name}@${f.version ?? ""}:${f.sha256}`).sort().join("\n");
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(lines));
	return [...new Uint8Array(digest)].slice(0, 4).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// --- Files ------------------------------------------------------------------------------------

async function fortriseDir() {
	const opfs = await navigator.storage.getDirectory();
	return opfs.getDirectoryHandle("fortrise", { create: true });
}

async function sha256(buffer) {
	const digest = await crypto.subtle.digest("SHA-256", buffer);
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function haveZip(zips, sha) {
	try {
		await zips.getFileHandle(sha + ".zip");
		return true;
	} catch {
		return false;
	}
}

async function storeZip(zips, sha, buffer) {
	const w = await (await zips.getFileHandle(sha + ".zip", { create: true })).createWritable();
	await w.write(buffer);
	await w.close();
}

// Thrown when a catalog mod's file can't be downloaded; the page then asks for the zip.
export class ModDownloadError extends Error {
	constructor(mod, reason) {
		super(`Couldn't download ${mod.displayName} from GameBanana (${reason}).`);
		this.mod = mod;
	}
}

// Downloads (or reuses) each catalog mod's zip and verifies it against the catalog checksum.
export async function ensureFiles(mods, onProgress) {
	const zips = await (await fortriseDir()).getDirectoryHandle("ModZips", { create: true });
	const files = new Map(); // one per GameBanana file
	for (const m of mods) files.set(m.entry.file.sha256, m);
	let done = 0;
	for (const [sha, mod] of files) {
		if (!(await haveZip(zips, sha))) {
			let buffer;
			try {
				const res = await fetch(mod.entry.file.mirror);
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				buffer = await res.arrayBuffer();
			} catch (e) {
				throw new ModDownloadError(mod, e.message || "network error");
			}
			if ((await sha256(buffer)) !== sha) throw new ModDownloadError(mod, "the file didn't match the catalog");
			await storeZip(zips, sha, buffer);
		}
		onProgress?.(++done, files.size);
	}
	return [...files.keys()];
}

// A zip the player supplies: either a catalog file the download failed for (matched by checksum)
// or a custom mod.
export async function addZip(file) {
	const buffer = await file.arrayBuffer();
	const sha = await sha256(buffer);
	const zips = await (await fortriseDir()).getDirectoryHandle("ModZips", { create: true });
	await storeZip(zips, sha, buffer);
	return { sha256: sha, size: buffer.byteLength, file: file.name };
}

// The list the host's ModInstaller reads.
export async function writeEnabled(shas) {
	const dir = await fortriseDir();
	const w = await (await dir.getFileHandle("mods.json", { create: true })).createWritable();
	await w.write(JSON.stringify(shas.map((sha) => ({ zip: `ModZips/${sha}.zip`, sha256: sha }))));
	await w.close();
}
