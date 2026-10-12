// Performance reports from the site's pages (web/wwwroot/stats.js): frame times, tick rates,
// rollbacks, packet timing and the device type, sent after online matches and every few minutes of
// solo play, for finding what's slow in real play. No names, lobby codes or addresses are kept.
//  - POST /report: one report (JSON, at most MAX_REPORT bytes), from allowed page origins only;
//    each address may send PER_ADDRESS_PER_HOUR an hour. The newest KEEP are kept.
//  - GET /reports?since=<id> (Authorization: Bearer <STATUS_KEY>): reports after that id, oldest
//    first, at most 200 per call ({ reports: [{ id, at, report }] }).
// The Worker keeps them in a SQLite-backed Durable Object (worker.js); local.mjs in memory.

export const MAX_REPORT = 24 * 1024;
export const KEEP = 5000;
export const PER_ADDRESS_PER_HOUR = 60;
export const LIST_LIMIT = 200;

// The report as it's stored (compact JSON), or null if it isn't one.
export function parseReport(text) {
	if (typeof text !== "string" || text.length > MAX_REPORT) return null;
	let value;
	try {
		value = JSON.parse(text);
	} catch {
		return null;
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	if (value.kind !== "online" && value.kind !== "solo") return null;
	return JSON.stringify(value);
}

// Reports per address in the last hour (addresses are only held in memory, for this).
export class RateLimit {
	constructor(perHour = PER_ADDRESS_PER_HOUR) {
		this.perHour = perHour;
		this.sent = new Map(); // address -> [times]
	}
	allow(address, now = Date.now()) {
		const hourAgo = now - 3600e3;
		const times = (this.sent.get(address) ?? []).filter((t) => t > hourAgo);
		if (times.length >= this.perHour) {
			this.sent.set(address, times);
			return false;
		}
		times.push(now);
		this.sent.set(address, times);
		if (this.sent.size > 10000) {
			for (const [a, t] of this.sent) if (!t.some((x) => x > hourAgo)) this.sent.delete(a);
		}
		return true;
	}
}

// In memory, for local.mjs and tests: the same interface as the Durable Object's SQLite store.
export class MemoryReports {
	constructor() {
		this.rows = [];
		this.next = 1;
	}
	add(report, at = Date.now()) {
		this.rows.push({ id: this.next++, at, report });
		if (this.rows.length > KEEP) this.rows.splice(0, this.rows.length - KEEP);
	}
	list(since = 0) {
		return this.rows.filter((r) => r.id > since).slice(0, LIST_LIMIT).map((r) => ({ id: r.id, at: r.at, report: JSON.parse(r.report) }));
	}
}
