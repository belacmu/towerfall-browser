// TF.EX's own match reports (TF.EX.Domain/MatchReport.cs): when a lobby says IsReportEnabled, a
// client whose match ended in a desync, a disconnect or a crash POSTs one zip (its replay, its log,
// the exception) to
//   <server>/report?group=<players, sorted, "-"-joined>&name=<its player name>&kind=desync|disconnect|crash
// That's the same path as the pages' performance reports (reports.js), which carry no such query.
// Desktop TF.EX and the Switch send no Origin; the browser's TF.EX comes from the site's pages.
// The zips are kept in an R2 bucket (worker.js; a lifecycle rule drops old ones), in memory under
// local.mjs, and read with GET /reports/match (tools/match-reports.sh).

export const MATCH_KINDS = ["desync", "disconnect", "crash"];
// A replay, up to 4 MB of log (MatchReport.MaxLogBytes) and an exception, zipped; TF.EX's server takes up to 32 MB.
export const MAX_MATCH_REPORT = 32 << 20; // MAX_REPORT_BYTES
export const MATCH_PER_ADDRESS_PER_HOUR = 30;
export const MATCH_LIST_LIMIT = 200;

// TF.EX's Sanitize keeps ASCII letters, digits and "-" (others become "_"), 48 characters a name.
const clean = (value, max) => String(value ?? "").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, max);

// { kind, group, name } when the request is one of TF.EX's match reports, else null.
export function matchReportRequest(url) {
	const kind = url.searchParams.get("kind");
	if (!MATCH_KINDS.includes(kind) || !url.searchParams.has("group")) return null;
	return { kind, group: clean(url.searchParams.get("group"), 8 * 49) || "PLAYERS", name: clean(url.searchParams.get("name"), 48) || "PLAYER" };
}

// Where a report is stored: by day, then time, so a listing is oldest first.
export function matchReportKey({ kind, group, name }, now = new Date(), random = Math.random()) {
	const iso = now.toISOString();
	const id = Math.floor(random * 0xffffff).toString(16).padStart(6, "0");
	return `match/${iso.slice(0, 10)}/${iso.slice(11, 19).replace(/:/g, "")}-${kind}-${group.slice(0, 120)}-${name}-${id}.zip`;
}

// A zip starts with a local file header ("PK\x03\x04"); an empty archive is just its end record.
export function looksLikeZip(bytes) {
	return bytes.byteLength >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 0x03 || bytes[2] === 0x05);
}

// In memory, for local.mjs: the same listing as the R2 bucket's.
export class MemoryMatchReports {
	constructor(keep = 100) {
		this.keep = keep;
		this.items = new Map(); // key -> { bytes, meta, uploaded }
	}
	put(key, bytes, meta) {
		this.items.set(key, { bytes, meta, uploaded: new Date().toISOString() });
		while (this.items.size > this.keep) this.items.delete(this.items.keys().next().value);
	}
	list() {
		return [...this.items].map(([key, v]) => ({ key, size: v.bytes.byteLength, uploaded: v.uploaded, ...v.meta }));
	}
	get(key) {
		return this.items.get(key)?.bytes ?? null;
	}
}
