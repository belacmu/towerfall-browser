// FileSystemFileHandle.createWritable() for browsers that store files in OPFS but can't write them
// from a page: Safari before iOS/macOS 26, which every iPhone browser is (Chrome and Firefox there
// use Safari's engine). Without it the first file of a game import, a mod download or FortRise's
// files failed, so the game never got past "Copying game files" on iOS 17 and 18.
//
// Those browsers can write OPFS files from a worker (createSyncAccessHandle), so this stand-in hands
// the writes to one: the same write(data) / close() / abort() the callers use, with the file emptied
// when it's opened (createWritable's default) and again on abort, so a write that didn't finish
// leaves a file whose size shows it isn't complete (the importers then copy it again).
// Imported for its effect by gamefiles.js and mods.js; does nothing where createWritable exists.

const WORKER = `
const open = new Map();
let next = 1;
onmessage = async ({ data: m }) => {
	try {
		let result;
		if (m.op === "open") {
			let dir = await navigator.storage.getDirectory();
			for (const part of m.path.slice(0, -1)) dir = await dir.getDirectoryHandle(part);
			const file = await dir.getFileHandle(m.path[m.path.length - 1], { create: true });
			const handle = await file.createSyncAccessHandle();
			handle.truncate(0);
			result = next++;
			open.set(result, { handle, at: 0 });
		} else {
			const f = open.get(m.file);
			if (!f) throw new Error("file not open");
			if (m.op === "write") {
				f.at += f.handle.write(m.bytes, { at: f.at });
			} else {
				if (m.op === "abort") f.handle.truncate(0);
				f.handle.flush();
				f.handle.close();
				open.delete(m.file);
			}
		}
		postMessage({ id: m.id, result });
	} catch (e) {
		postMessage({ id: m.id, error: String(e?.message ?? e), name: e?.name ?? "Error" });
	}
};`;

if (typeof FileSystemFileHandle !== "undefined" && !("createWritable" in FileSystemFileHandle.prototype)) {
	let worker = null;
	let nextId = 1;
	const pending = new Map();
	const call = (message, transfer = []) =>
		new Promise((resolve, reject) => {
			if (!worker) {
				worker = new Worker(URL.createObjectURL(new Blob([WORKER], { type: "text/javascript" })));
				worker.onmessage = ({ data }) => {
					const p = pending.get(data.id);
					pending.delete(data.id);
					if (!p) return;
					if (data.error == null) p.resolve(data.result);
					else {
						// (A full disk keeps its name, which the importers look for.)
						const e = new Error(data.error);
						e.name = data.name;
						p.reject(e);
					}
				};
			}
			const id = nextId++;
			pending.set(id, { resolve, reject });
			worker.postMessage({ ...message, id }, transfer);
		});
	// Own copies of the bytes, so they can be moved to the worker (callers pass views into
	// bigger buffers they keep reading from).
	const bytesOf = (data) => {
		if (typeof data === "string") return new TextEncoder().encode(data);
		if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0));
		if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
		throw new TypeError("opfs-write: write() takes a string, an ArrayBuffer or a typed array");
	};
	FileSystemFileHandle.prototype.createWritable = async function () {
		const path = await (await navigator.storage.getDirectory()).resolve(this);
		if (!path) throw new Error("opfs-write: the file isn't in this site's storage");
		const file = await call({ op: "open", path });
		return {
			write: async (data) => {
				const bytes = bytesOf(data);
				await call({ op: "write", file, bytes }, [bytes.buffer]);
			},
			close: () => call({ op: "close", file }),
			abort: () => call({ op: "abort", file }),
		};
	};
	console.log("[storage] writing files through a worker (this browser has no createWritable)");
}
