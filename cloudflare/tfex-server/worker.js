// The TF.EX-compatible server on Cloudflare: a Worker routing WebSockets to Durable Objects, which
// use WebSocket hibernation so idle connections (players sitting in menus) cost nothing.
//  - /ws: one Matchmaker object holds every lobby, join code and quick play queue.
//  - /room/<id>, /ping_measurement/<id>: one SignalRoom object per room.
//  - GET /turn?room=<id>&peer=<uuid>: ICE servers (STUN, and Cloudflare TURN credentials when
//    configured) for browser pages whose peer is in that lobby.
// The logic lives in matchmaker.js and signal.js; local.mjs runs the same code under Node.

import { DurableObject } from "cloudflare:workers";
import { Matchmaker, MAX_FRAME } from "./matchmaker.js";
import { MAX_SIGNAL_FRAME, SignalRoom } from "./signal.js";
import { allowedOrigins, originAllowed, parseRoute } from "./routes.js";
import { iceServers, STUN_ONLY } from "./turn.js";

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		const route = parseRoute(url);
		if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
			if (url.pathname === "/turn") return turn(request, env);
			if (url.pathname === "/") {
				return new Response("TF.EX-compatible server (towerfall-browser). WebSocket endpoints: /ws, /room/<id>?peer=<uuid>, /ping_measurement/<id>?peer=<uuid>\n");
			}
			return new Response("Not found", { status: route ? 426 : 404 });
		}
		if (!route) return new Response("Not found", { status: 404 });
		if (route.bad) return new Response("peer must be a UUID", { status: 400 });
		if (!originAllowed(request.headers.get("Origin"), allowedOrigins(env.ALLOWED_ORIGINS))) {
			return new Response("Forbidden", { status: 403 });
		}
		const name = route.kind === "ws" ? "matchmaker" : `${route.kind}:${route.roomId}`;
		// The client's address, for per-address limits (the Durable Object only sees the Worker).
		request = new Request(request);
		request.headers.set("X-Client-IP", clientIp(request) ?? "");
		const ns = route.kind === "ws" ? env.MATCHMAKER : env.ROOMS;
		return ns.get(ns.idFromName(name)).fetch(request);
	},
};

// Only browsers ask (desktop TF.EX has its own ICE servers), and relay credentials only go to a
// page whose peer is in the lobby it names: anyone else gets STUN.
async function turn(request, env) {
	const origin = request.headers.get("Origin");
	if (!origin || !originAllowed(origin, allowedOrigins(env.ALLOWED_ORIGINS))) return new Response("Forbidden", { status: 403 });
	const headers = { "Cache-Control": "no-store", Vary: "Origin", "Access-Control-Allow-Origin": origin };
	if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...headers, "Access-Control-Allow-Methods": "GET" } });
	if (request.method !== "GET") return new Response("Method not allowed", { status: 405, headers });
	const params = new URL(request.url).searchParams;
	const room = params.get("room") ?? "";
	const peer = (params.get("peer") ?? "").toLowerCase();
	let member = false;
	if (/^[A-Za-z0-9_-]{1,64}$/.test(room) && /^[0-9a-f-]{36}$/.test(peer)) {
		const query = new URL("https://matchmaker/member");
		query.search = new URLSearchParams({ room, peer }).toString();
		member = (await env.MATCHMAKER.get(env.MATCHMAKER.idFromName("matchmaker")).fetch(query)).ok;
	}
	return Response.json({ iceServers: member ? await iceServers(env) : STUN_ONLY }, { headers });
}

const clientIp = (request) => request.headers.get("CF-Connecting-IP");
// A frame's size before decoding it.
const frameSize = (message) => (typeof message === "string" ? message.length : message.byteLength);

// Wraps hibernatable WebSockets as the core's connections. Each socket's state rides along as its
// attachment (at most 2 KB), so it survives hibernation.
class Sockets {
	constructor(ctx) {
		this.ctx = ctx;
		this.conns = new WeakMap();
	}

	wrap(ws) {
		let conn = this.conns.get(ws);
		if (conn) return conn;
		const saved = ws.deserializeAttachment() ?? {};
		conn = {
			id: saved.id ?? crypto.randomUUID(),
			state: saved.state ?? {},
			send: (text) => {
				try {
					ws.send(text);
				} catch {}
			},
			close: (code, reason) => {
				try {
					ws.close(code, reason);
				} catch {}
			},
			save: () => ws.serializeAttachment({ id: conn.id, state: conn.state }),
		};
		this.conns.set(ws, conn);
		return conn;
	}

	all() {
		return this.ctx.getWebSockets().map((ws) => this.wrap(ws));
	}

	accept() {
		const [client, server] = Object.values(new WebSocketPair());
		this.ctx.acceptWebSocket(server);
		const conn = this.wrap(server);
		conn.save();
		return { client, conn };
	}
}

const FLUSH_MS = 5000;

const text = (message) => (typeof message === "string" ? message : new TextDecoder().decode(message));

export class MatchmakerObject extends DurableObject {
	constructor(ctx, env) {
		super(ctx, env);
		this.sockets = new Sockets(ctx);
		this.alarmAt = null;
		// Lobbies change on every pick in archer select; storage gets each changed one at most every
		// few seconds (the free plan allows 100,000 row writes a day). A Durable Object only
		// hibernates after some seconds without events, so the last changes are written before.
		this.dirty = new Map(); // RoomId -> room
		this.flushTimer = null;
		this.core = new Matchmaker({
			persist: {
				save: (room) => {
					this.dirty.set(room.lobby.RoomId, room);
					this.flushTimer ??= setTimeout(() => this.flush(), FLUSH_MS);
				},
				remove: (roomId) => {
					this.dirty.delete(roomId);
					ctx.storage.delete(`room:${roomId}`);
				},
			},
		});
		ctx.blockConcurrencyWhile(async () => {
			const rooms = [...(await ctx.storage.list({ prefix: "room:" })).values()];
			this.alarmAt = await ctx.storage.getAlarm();
			this.core.restore(rooms, this.sockets.all());
		});
	}

	async fetch(request) {
		const url = new URL(request.url);
		if (url.pathname === "/member") {
			const member = this.core.isMember(url.searchParams.get("room"), url.searchParams.get("peer"));
			return new Response(null, { status: member ? 204 : 404 });
		}
		const { client, conn } = this.sockets.accept();
		this.core.open(conn, Date.now(), request.headers.get("X-Client-IP") || null);
		this.schedule();
		return new Response(null, { status: 101, webSocket: client });
	}

	flush() {
		this.flushTimer = null;
		for (const [id, room] of this.dirty) this.ctx.storage.put(`room:${id}`, room);
		this.dirty.clear();
	}

	webSocketMessage(ws, message) {
		const conn = this.sockets.wrap(ws);
		if (frameSize(message) > MAX_FRAME) {
			conn.close(1009, "message too big");
			this.core.close(conn, Date.now());
		} else this.core.message(conn, text(message), Date.now());
		this.schedule();
	}

	webSocketClose(ws, code, reason) {
		this.core.close(this.sockets.wrap(ws), Date.now());
		this.schedule();
		try {
			ws.close(code, reason);
		} catch {}
	}

	webSocketError(ws) {
		this.core.close(this.sockets.wrap(ws), Date.now());
		this.schedule();
	}

	// Keep-alives while anyone is connected, and lobby deadlines (end-of-match votes, series
	// tower picks, quick play starts).
	alarm() {
		this.alarmAt = null;
		this.core.wake(Date.now());
		this.schedule();
	}

	schedule() {
		const at = this.core.nextWake();
		if (at === null || (this.alarmAt !== null && this.alarmAt <= at)) return;
		this.alarmAt = at;
		this.ctx.storage.setAlarm(at);
	}
}

export class SignalRoomObject extends DurableObject {
	constructor(ctx, env) {
		super(ctx, env);
		this.sockets = new Sockets(ctx);
		this.room = new SignalRoom();
		this.room.restore(this.sockets.all());
	}

	async fetch(request) {
		const { client, conn } = this.sockets.accept();
		this.room.open(conn, new URL(request.url).searchParams.get("peer"), Date.now(), request.headers.get("X-Client-IP") || null);
		return new Response(null, { status: 101, webSocket: client });
	}

	webSocketMessage(ws, message) {
		const conn = this.sockets.wrap(ws);
		if (frameSize(message) > MAX_SIGNAL_FRAME) {
			conn.close(1009, "message too big");
			this.room.close(conn);
		} else this.room.message(conn, text(message), Date.now());
	}

	webSocketClose(ws, code, reason) {
		this.room.close(this.sockets.wrap(ws));
		try {
			ws.close(code, reason);
		} catch {}
	}

	webSocketError(ws) {
		this.room.close(this.sockets.wrap(ws));
	}
}
