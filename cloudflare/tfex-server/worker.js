// The TF.EX-compatible server on Cloudflare: a Worker routing WebSockets to Durable Objects, which
// use WebSocket hibernation so idle connections (players sitting in menus) cost nothing.
//  - /ws: one Matchmaker object holds every lobby, join code and quick play queue.
//  - /room/<id>, /ping_measurement/<id>: one SignalRoom object per room.
// The logic lives in matchmaker.js and signal.js; local.mjs runs the same code under Node.

import { DurableObject } from "cloudflare:workers";
import { Matchmaker } from "./matchmaker.js";
import { SignalRoom } from "./signal.js";
import { allowedOrigins, originAllowed, parseRoute } from "./routes.js";

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		const route = parseRoute(url);
		if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
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
		const ns = route.kind === "ws" ? env.MATCHMAKER : env.ROOMS;
		return ns.get(ns.idFromName(name)).fetch(request);
	},
};

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

const text = (message) => (typeof message === "string" ? message : new TextDecoder().decode(message));

export class MatchmakerObject extends DurableObject {
	constructor(ctx, env) {
		super(ctx, env);
		this.sockets = new Sockets(ctx);
		this.alarmAt = null;
		this.core = new Matchmaker({
			persist: {
				save: (room) => ctx.storage.put(`room:${room.lobby.RoomId}`, room),
				remove: (roomId) => ctx.storage.delete(`room:${roomId}`),
			},
		});
		ctx.blockConcurrencyWhile(async () => {
			const rooms = [...(await ctx.storage.list({ prefix: "room:" })).values()];
			this.alarmAt = await ctx.storage.getAlarm();
			this.core.restore(rooms, this.sockets.all());
		});
	}

	async fetch() {
		const { client, conn } = this.sockets.accept();
		this.core.open(conn, Date.now());
		this.schedule();
		return new Response(null, { status: 101, webSocket: client });
	}

	webSocketMessage(ws, message) {
		this.core.message(this.sockets.wrap(ws), text(message), Date.now());
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
		this.room.open(conn, new URL(request.url).searchParams.get("peer"));
		return new Response(null, { status: 101, webSocket: client });
	}

	webSocketMessage(ws, message) {
		this.room.message(this.sockets.wrap(ws), text(message));
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
