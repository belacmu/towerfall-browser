#!/usr/bin/env node
// Runs the TF.EX-compatible server (matchmaker.js, signal.js) locally, with no dependencies beyond Node 18+:
//   node cloudflare/tfex-server/local.mjs [--port 3000] [--host 127.0.0.1] [--origins a,b|*]
// TF.EX's LOCAL server setting is ws://127.0.0.1:3000, the default here. Open the site with
// ?tfexserver=local to use it. The Cloudflare deployment (worker.js) runs the same core.
//
// A minimal RFC 6455 server: text and binary messages (TF.EX sends its JSON as binary frames),
// fragmentation, ping/pong, close. Messages are capped at 1 MB.

import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { Matchmaker } from "./matchmaker.js";
import { allowedOrigins, originAllowed, parseRoute } from "./routes.js";
import { iceServers } from "./turn.js";
import { SignalRoom } from "./signal.js";

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
const rooms = new Map(); // "room:<id>" | "ping:<id>" -> SignalRoom

class Connection {
	constructor(socket, onMessage, onClose) {
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
		if (opcode === 1 || opcode === 2) this.fragments = [payload];
		else if (opcode === 0 && this.fragments) this.fragments.push(payload);
		else return this.close(1002, "bad frame");
		if (this.fragments.reduce((n, f) => n + f.length, 0) > MAX_MESSAGE) return this.close(1009, "too big");
		if (!fin) return;
		const text = Buffer.concat(this.fragments).toString("utf8");
		this.fragments = null;
		try {
			this.onMessage(this, text);
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

const server = createServer(async (req, res) => {
	if (new URL(req.url, "http://localhost").pathname === "/turn") {
		// Same as the Worker's /turn; TURN_KEY_ID and TURN_KEY_API_TOKEN from the environment.
		const origin = req.headers.origin;
		if (!originAllowed(origin, origins)) return res.writeHead(403).end();
		res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store", ...(origin && { "Access-Control-Allow-Origin": origin }) });
		return res.end(JSON.stringify({ iceServers: await iceServers(process.env) }));
	}
	res.writeHead(200, { "Content-Type": "text/plain" });
	res.end("TF.EX-compatible server (towerfall-browser). WebSocket endpoints: /ws, /room/<id>?peer=<uuid>, /ping_measurement/<id>?peer=<uuid>\n");
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
		matchmaker.open(conn, Date.now());
		schedule();
		return;
	}
	const roomKey = `${route.kind}:${route.roomId}`;
	let room = rooms.get(roomKey);
	if (!room) rooms.set(roomKey, (room = new SignalRoom({ log: verbose ? console.log : () => {} })));
	const conn = new Connection(
		socket,
		(c, text) => room.message(c, text),
		(c) => {
			room.close(c);
			if (room.isEmpty()) rooms.delete(roomKey);
		},
	);
	room.open(conn, route.peer);
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
