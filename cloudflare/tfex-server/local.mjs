#!/usr/bin/env node
// Runs the TF.EX-compatible server (matchmaker.js, signal.js, relay.js) locally, with no dependencies beyond Node 18+:
//   node cloudflare/tfex-server/local.mjs [--port 3000] [--host 127.0.0.1] [--origins a,b|*]
// TF.EX's LOCAL server setting is ws://127.0.0.1:3000, the default here. Open the site with
// ?tfexserver=local to use it. The Cloudflare deployment (worker.js) runs the same core.
//
// A minimal RFC 6455 server: text and binary messages (TF.EX sends its JSON as binary frames),
// fragmentation, ping/pong, close. Messages are capped at 1 MB.

import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { Matchmaker } from "./matchmaker.js";
import { allowedOrigins, lobbyFreeRelay, originAllowed, parseRoute } from "./routes.js";
import { iceServers, STUN_ONLY } from "./turn.js";
import { maxReport, MemoryReports, parseReport, RateLimit, reportSource, SWITCH_PER_ADDRESS_PER_HOUR } from "./reports.js";
import { SignalRoom } from "./signal.js";
import { RelayRoom } from "./relay.js";

const args = process.argv.slice(2);
const arg = (name, fallback) => {
	const i = args.indexOf(`--${name}`);
	return i >= 0 ? args[i + 1] : fallback;
};
const port = Number(arg("port", process.env.PORT ?? 3000));
const host = arg("host", process.env.HOST ?? "127.0.0.1");
const origins = allowedOrigins(arg("origins", process.env.ALLOWED_ORIGINS));
const verbose = args.includes("--verbose");

const MAX_MESSAGE = 1 << 20;
let nextConn = 1;

const matchmaker = new Matchmaker({ log: verbose ? console.log : () => {} });
const rooms = new Map(); // "room:<id>" | "ping:<id>" -> SignalRoom, "relay:<id>" -> RelayRoom

class Connection {
	// onMessage(conn, text), or with `binary` set onMessage(conn, data): a string for a text message,
	// the bytes (a Buffer) for a binary one.
	constructor(socket, onMessage, onClose, { binary = false } = {}) {
		this.binary = binary;
		this.id = `c${nextConn++}`;
		this.socket = socket;
		this.state = {};
		this.closed = false;
		this.onMessage = onMessage;
		this.onClose = onClose;
		this.buffer = Buffer.alloc(0);
		this.fragments = null;
		socket.setNoDelay(true);
		socket.on("data", (data) => this.receive(data));
		socket.on("close", () => this.finish());
		socket.on("error", () => this.finish());
	}

	send(text) {
		if (this.closed) return;
		this.write(1, Buffer.from(text, "utf8"));
	}

	sendBinary(bytes) {
		if (this.closed) return;
		this.write(2, Buffer.from(bytes));
	}

	save() {} // state lives in memory here (the Durable Object serializes it)

	close(code = 1000, reason = "") {
		if (this.closed) return;
		const body = Buffer.alloc(2 + Buffer.byteLength(reason));
		body.writeUInt16BE(code, 0);
		body.write(reason, 2);
		this.write(8, body);
		this.socket.end();
		this.finish();
	}

	write(opcode, payload) {
		const len = payload.length;
		const head = len < 126 ? Buffer.alloc(2) : len < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
		head[0] = 0x80 | opcode;
		if (len < 126) head[1] = len;
		else if (len < 65536) {
			head[1] = 126;
			head.writeUInt16BE(len, 2);
		} else {
			head[1] = 127;
			head.writeBigUInt64BE(BigInt(len), 2);
		}
		this.socket.write(Buffer.concat([head, payload]));
	}

	receive(data) {
		this.buffer = this.buffer.length ? Buffer.concat([this.buffer, data]) : data;
		while (!this.closed) {
			const b = this.buffer;
			if (b.length < 2) return;
			const fin = (b[0] & 0x80) !== 0;
			const opcode = b[0] & 0x0f;
			const masked = (b[1] & 0x80) !== 0;
			let len = b[1] & 0x7f;
			let offset = 2;
			if (len === 126) {
				if (b.length < 4) return;
				len = b.readUInt16BE(2);
				offset = 4;
			} else if (len === 127) {
				if (b.length < 10) return;
				const big = b.readBigUInt64BE(2);
				if (big > BigInt(MAX_MESSAGE)) return this.close(1009, "too big");
				len = Number(big);
				offset = 10;
			}
			if (len > MAX_MESSAGE) return this.close(1009, "too big");
			if (!masked) return this.close(1002, "unmasked frame");
			if (b.length < offset + 4 + len) return;
			const mask = b.subarray(offset, offset + 4);
			const payload = Buffer.from(b.subarray(offset + 4, offset + 4 + len));
			for (let i = 0; i < len; i++) payload[i] ^= mask[i & 3];
			this.buffer = b.subarray(offset + 4 + len);
			this.frame(fin, opcode, payload);
		}
	}

	frame(fin, opcode, payload) {
		if (opcode === 8) return this.close(1000);
		if (opcode === 9) return this.write(10, payload);
		if (opcode === 10) return;
		if (opcode === 1 || opcode === 2) {
			this.fragments = [payload];
			this.fragmentsBinary = opcode === 2;
		}
		else if (opcode === 0 && this.fragments) this.fragments.push(payload);
		else return this.close(1002, "bad frame");
		if (this.fragments.reduce((n, f) => n + f.length, 0) > MAX_MESSAGE) return this.close(1009, "too big");
		if (!fin) return;
		const whole = Buffer.concat(this.fragments);
		this.fragments = null;
		try {
			this.onMessage(this, this.binary && this.fragmentsBinary ? whole : whole.toString("utf8"));
		} catch (e) {
			console.error("[tfex-server] message handler failed:", e);
		}
	}

	finish() {
		if (this.closed) return;
		this.closed = true;
		this.socket.destroy();
		try {
			this.onClose(this);
		} catch (e) {
			console.error("[tfex-server] close handler failed:", e);
		}
	}
}

// Performance reports (reports.js), in memory; GET /reports needs no key here (localhost).
const reportStore = new MemoryReports();
const reportLimit = new RateLimit();
const switchReportLimit = new RateLimit(SWITCH_PER_ADDRESS_PER_HOUR);

const server = createServer(async (req, res) => {
	const url = new URL(req.url, "http://localhost");
	if (url.pathname === "/report") {
		// From a page (allowed origins), or the Switch's (no Origin; reports.js).
		const origin = req.headers.origin;
		const source = reportSource(origin);
		if (origin && !originAllowed(origin, origins)) return res.writeHead(403).end();
		const headers = { "Cache-Control": "no-store", Vary: "Origin", ...(origin ? { "Access-Control-Allow-Origin": origin } : {}) };
		if (req.method === "OPTIONS") return res.writeHead(204, { ...headers, "Access-Control-Allow-Methods": "POST", "Access-Control-Allow-Headers": "Content-Type" }).end();
		if (req.method !== "POST") return res.writeHead(405, headers).end();
		let body = "";
		for await (const chunk of req) {
			body += chunk;
			if (body.length > maxReport(source)) return res.writeHead(413, headers).end();
		}
		if (!(source === "switch" ? switchReportLimit : reportLimit).allow(req.socket.remoteAddress ?? "")) return res.writeHead(429, headers).end();
		const report = parseReport(body, source);
		if (!report) return res.writeHead(400, headers).end();
		reportStore.add(report);
		if (verbose) console.log(`[tfex-server] report: ${report.slice(0, 200)}`);
		return res.writeHead(204, headers).end();
	}
	if (url.pathname === "/reports") {
		res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
		return res.end(JSON.stringify({ reports: reportStore.list(Number(url.searchParams.get("since") ?? 0) || 0) }));
	}
	if (url.pathname === "/status") {
		// The Worker's /status, without its key (this server listens on localhost by default).
		res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
		return res.end(JSON.stringify(matchmaker.stats()));
	}
	if (url.pathname === "/turn") {
		// Same as the Worker's /turn; TURN_KEY_ID and TURN_KEY_API_TOKEN from the environment.
		const origin = req.headers.origin;
		if (!origin || !originAllowed(origin, origins)) return res.writeHead(403).end();
		const member = matchmaker.isMember(url.searchParams.get("room"), (url.searchParams.get("peer") ?? "").toLowerCase());
		res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": origin });
		return res.end(JSON.stringify({ iceServers: member ? await iceServers(process.env) : STUN_ONLY }));
	}
	res.writeHead(200, { "Content-Type": "text/plain" });
	res.end("TF.EX-compatible server (towerfall-browser). WebSocket endpoints: /ws, /room/<id>?peer=<uuid>, /ping_measurement/<id>?peer=<uuid>, /relay/<id>?peer=<uuid>\n");
});

server.on("upgrade", (req, socket) => {
	const reject = (status, text) => {
		socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
	};
	const url = new URL(req.url, "http://localhost");
	const route = parseRoute(url);
	if (!route) return reject(404, "Not Found");
	if (route.bad) return reject(400, "Bad Request");
	if (!originAllowed(req.headers.origin, origins)) {
		if (verbose) console.log(`[tfex-server] refused origin ${req.headers.origin}`);
		return reject(403, "Forbidden");
	}
	// The match relay is only for the players of a lobby whose match is on (relay.js), except xnet-* rooms.
	if (route.kind === "relay" && !lobbyFreeRelay(route.roomId) && !matchmaker.isPlayingIn(route.roomId, route.peer)) {
		if (verbose) console.log(`[tfex-server] refused relay ${route.roomId} for ${route.peer}`);
		return reject(403, "Forbidden");
	}
	if (route.kind === "relay") {
		const refused = rooms.get(`relay:${route.roomId}`)?.refusal(route.peer, Date.now(), req.socket.remoteAddress ?? null);
		if (refused) return reject(409, "Conflict");
	}
	const key = req.headers["sec-websocket-key"];
	if (!key || (req.headers.upgrade ?? "").toLowerCase() !== "websocket") return reject(400, "Bad Request");
	const accept = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
	socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);

	if (route.kind === "ws") {
		const conn = new Connection(
			socket,
			(c, text) => {
				matchmaker.message(c, text, Date.now());
				schedule();
			},
			(c) => {
				matchmaker.close(c, Date.now());
				schedule();
			},
		);
		matchmaker.open(conn, Date.now(), req.socket.remoteAddress ?? null, url.searchParams.get("version"));
		schedule();
		return;
	}
	const roomKey = `${route.kind}:${route.roomId}`;
	const relay = route.kind === "relay";
	let room = rooms.get(roomKey);
	if (!room) rooms.set(roomKey, (room = new (relay ? RelayRoom : SignalRoom)({ log: verbose ? console.log : () => {} })));
	const conn = new Connection(
		socket,
		(c, data) => room.message(c, data, Date.now()),
		(c) => {
			room.close(c);
			if (room.isEmpty() && rooms.get(roomKey) === room) rooms.delete(roomKey);
		},
		{ binary: relay },
	);
	room.open(conn, route.peer, Date.now(), req.socket.remoteAddress ?? null);
	if (room.isEmpty() && rooms.get(roomKey) === room) rooms.delete(roomKey);
});

// One timer for the matchmaker's keep-alives and lobby deadlines.
let timer = null;
let timerAt = null;
function schedule() {
	const at = matchmaker.nextWake();
	if (at === timerAt) return;
	clearTimeout(timer);
	timerAt = at;
	if (at === null) return;
	timer = setTimeout(() => {
		timerAt = null;
		matchmaker.wake(Date.now());
		schedule();
	}, Math.max(0, at - Date.now()));
}

server.listen(port, host, () => {
	console.log(`[tfex-server] listening on ws://${host}:${port} (origins: ${origins.join(", ")})`);
});
