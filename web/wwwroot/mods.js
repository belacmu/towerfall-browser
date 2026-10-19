// Mods, chosen on the page before the game starts (see docs/MODS.md).
//
// The catalog (mods/catalog.json, built from GameBanana by tools/update-catalog.py) lists every
// TowerFall mod with its pinned file, checksums and browser status. The page offers the ones that
// work, downloads enabled ones straight from GameBanana (never from us) into OPFS fortrise/ModZips/,
// and writes fortrise/mods.json; the host's ModInstaller extracts them into FortRise's Mods/ folder.
// Players can also add their own mod zips, identified by checksum.

// createWritable() where the browser lacks it (iOS before 26).
import "./opfs-write.js";

const STATE_KEY = "towerfall.mods";
// FortRise itself and its built-in modules satisfy these dependencies.
const BUILT_IN = new Set(["FortRise", "FortRise.Content"]);

export async function loadCatalog() {
	const load = async (url) => {
		try {
			const res = await fetch(url, { cache: "no-store" });
			return res.ok ? (await res.json()).mods : [];
		} catch {
			return [];
		}
	};
	// GameBanana's mods, plus the one the site hosts (TF.EX, for online play; see docs/MODS.md).
	const entries = [...(await load("hosted-mods/hosted.json")), ...(await load("mods/catalog.json"))];
	// One entry per FortRise mod (a file can hold several; they share the file). A hosted mod
	// replaces GameBanana's copy of the same mod (GameBanana's TF.EX is an old release).
	const mods = new Map();
	for (const entry of entries) {
		for (const mod of entry.mods) {
			if (!mods.has(mod.name)) mods.set(mod.name, { ...mod, entry, key: mod.name });
		}
	}
	return [...mods.values()];
}

// The mods the page offers: those known to work, and experimental ones (online play). ?allmods also
// offers untested ones (for testing). "dependency" mods only come along with the mod that needs them.
export function offered(catalog) {
	const all = new URLSearchParams(location.search).has("allmods");
	return catalog.filter((m) => m.status === "works" || m.status === "experimental" || (all && m.status === "untested"));
}

// --- What's enabled -----------------------------------------------------------------------

// { enabled: [mod name], custom: [{ name, sha256, size, file }], off, defaults }, per browser. Without a
// saved choice, online play (TF.EX) and WiderSet (TF.EX's wide lobbies and wide quick play, as on desktop;
// narrow play is unchanged until the player picks WIDER) are on. `off` turns every mod off and keeps the
// choice for later.
export const DEFAULT_ENABLED = ["TF.EX", "Teuria.WiderSet"];
// Defaults added after a choice may have been saved, by `defaults` version: each is turned on once for
// saved choices from before it (a player who turns it off afterwards keeps it off).
const ADDED_DEFAULTS = [[2, "Teuria.WiderSet"]];
const DEFAULTS_VERSION = 2;
// Defaults the game plays fine without: if GameBanana can't hand one over, the game starts without it
// (and says so) instead of waiting for the player to add the zip. Not when another enabled mod needs it.
export const SOFT_DEFAULTS = new Set(["Teuria.WiderSet"]);
export function softMods(mods) {
	const needed = new Set(mods.flatMap((m) => m.dependencies.map((d) => d.name)));
	return new Set(mods.filter((m) => SOFT_DEFAULTS.has(m.name) && !needed.has(m.name)).map((m) => m.name));
}
export function loadState() {
	try {
		const s = JSON.parse(localStorage.getItem(STATE_KEY));
		if (s && Array.isArray(s.enabled)) {
			const seen = s.defaults ?? 1;
			const enabled = [...s.enabled];
			for (const [version, name] of ADDED_DEFAULTS) if (version > seen && !enabled.includes(name)) enabled.push(name);
			return { enabled, custom: s.custom ?? [], off: s.off === true, defaults: DEFAULTS_VERSION };
		}
	} catch {}
	return { enabled: [...DEFAULT_ENABLED], custom: [], off: false, defaults: DEFAULTS_VERSION };
}

export function saveState(state) {
	try {
		localStorage.setItem(STATE_KEY, JSON.stringify(state));
	} catch {}
}

// ?mods=a,b overrides what's enabled (for tests and shareable links).
export function enabledNames(state) {
	const param = new URLSearchParams(location.search).get("mods");
	return param != null ? param.split(",").filter(Boolean) : state.off ? [] : state.enabled;
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
	try {
		await w.write(buffer);
		await w.close();
	} catch (e) {
		await w.abort().catch(() => {});
		await zips.removeEntry(sha + ".zip").catch(() => {});
		throw e.name === "QuotaExceededError" ? new StorageFullError() : e;
	}
}

// The browser won't store more for this site.
export class StorageFullError extends Error {
	constructor() {
		super("The browser has no room left to store this mod for the site. Free up space on the device (or remove other site data), then try again.");
	}
}

// Thrown when a catalog mod's file can't be downloaded; the page then asks for the zip.
export class ModDownloadError extends Error {
	constructor(mod, reason) {
		super(`Couldn't download ${mod.displayName} from GameBanana (${reason}).`);
		this.mod = mod;
	}
}

// Downloads (or reuses) each catalog mod's zip and verifies it against the catalog checksum. A mod
// in `soft` (see softMods) that can't be downloaded is left out: onSkip(error) is told.
export async function ensureFiles(mods, onProgress, soft = new Set(), onSkip = () => {}) {
	const zips = await (await fortriseDir()).getDirectoryHandle("ModZips", { create: true });
	const files = new Map(); // one per GameBanana file
	for (const m of mods) files.set(m.entry.file.sha256, m);
	let done = 0;
	const kept = [];
	for (const [sha, mod] of files) {
		if (!(await haveZip(zips, sha))) {
			let buffer;
			try {
				try {
					const res = await fetch(mod.entry.file.mirror);
					if (!res.ok) throw new Error(`HTTP ${res.status}`);
					buffer = await res.arrayBuffer();
				} catch (e) {
					throw new ModDownloadError(mod, e.message || "network error");
				}
				if ((await sha256(buffer)) !== sha) throw new ModDownloadError(mod, "the file didn't match the catalog");
			} catch (e) {
				// (A file holding several mods is only skipped when all of them are soft.)
				if (!mods.filter((m) => m.entry.file.sha256 === sha).every((m) => soft.has(m.name))) throw e;
				onSkip(e);
				onProgress?.(++done, files.size);
				continue;
			}
			await storeZip(zips, sha, buffer);
		}
		kept.push(sha);
		onProgress?.(++done, files.size);
	}
	return kept;
}

// A zip the player supplies: either a catalog file the download failed for (matched by checksum)
// or a custom mod.
export async function addZip(file) {
	const buffer = await file.arrayBuffer();
	// "PK\3\4" (or "PK\5\6", an empty zip): anything else can't be a mod, and would stop every
	// mod from installing while it stays enabled.
	const magic = new Uint8Array(buffer, 0, Math.min(4, buffer.byteLength)).join();
	if (magic !== "80,75,3,4" && magic !== "80,75,5,6") throw new Error(`${file.name} isn't a zip file.`);
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
