// Match relay: /relay/<roomId>?peer=<peerId>, for matches with a peer that has no WebRTC (the Nintendo
// Switch build; see the browser's netplay/tfnet.js TFNet.openRelay and web/Netplay/SwitchLobby.cs).
// A plain WebSocket room of two peers: every binary message one peer sends goes to the other one,
// unchanged (one bincode'd ggrs::Message per message, no framing, no sender id: each side knows who
// the other is from the lobby). Text messages are dropped. Nothing is sent by the server itself.
//
// Who may connect is checked before the socket gets here (worker.js, local.mjs): a player (not a
// spectator) of lobby <roomId>, while that lobby is InGame; anyone for rooms named xnet-* (lobby-free
// tests, routes.js), still 2 peers. That matters: whatever reaches a peer is
// fed to its GGRS as the other player's packets, and a malformed one aborts the browser's ggrs-ffi.
//
// The same peer connecting again (a client reconnecting, or the next match of a rematch before the
// old socket has closed) replaces its old socket, from the same address or once the old one has gone
// quiet (a GGRS peer sends ~125 messages a second; a quiet socket is a dead one).
//
// A connection (`conn`) is anything with sendBinary(bytes), close(code, reason) and a `state` object
// that the platform keeps for it (save() persists it, for Durable Object hibernation).

import { isUuid } from "./signal.js";

export const MAX_RELAY_PEERS = 2;
// GGRS messages average 27-54 bytes; an Input message carries at most the prediction window's inputs.
export const MAX_RELAY_FRAME = 2048;
// Messages per connection: a bucket of BURST that refills at RATE per second. A TF.EX peer at 60 Hz
// sends about 125 a second (an Input and an InputAck per frame, quality reports, keep-alives).
export const RELAY_RATE = 500;
const BURST = 1000;
// A connection this quiet can be replaced by a new one with its peer id from another address.
const STALE_MS = 3000;

export class RelayRoom {
	constructor({ log = () => {} } = {}) {
		this.log = log;
		this.peers = new Map(); // peer id -> conn
		this.seen = new Map(); // conn -> { at, tokens }
	}

	// Rebuilds the room from connections that outlived a Durable Object hibernation.
	restore(conns, now = Date.now()) {
		for (const conn of conns) {
			if (!conn.state.peer) continue;
			this.peers.set(conn.state.peer, conn);
			this.seen.set(conn, { at: now, tokens: BURST });
		}
	}

	isEmpty() {
		return this.peers.size === 0;
	}

	// Why `requested` can't join now ({ code, reason }), or null. The platforms ask before accepting the
	// WebSocket and refuse with HTTP 409 (a socket closed while it is being accepted may never finish
	// closing on the client); open() refuses with the code.
	refusal(requested, now = Date.now(), ip = null) {
		const peer = String(requested ?? "").toLowerCase();
		if (!isUuid(peer)) return { code: 4000, reason: "peer must be a UUID" };
		const previous = this.peers.get(peer);
		if (previous) {
			const quiet = now - (this.seen.get(previous)?.at ?? 0) >= STALE_MS;
			return !quiet && (!ip || previous.state.ip !== ip) ? { code: 4003, reason: "peer already connected" } : null;
		}
		return this.peers.size >= MAX_RELAY_PEERS ? { code: 4002, reason: "room is full" } : null;
	}

	// `peer` was checked to be a player of the lobby; `ip` is the client's address, if known.
	// Returns whether the connection was taken.
	open(conn, requested, now = Date.now(), ip = null) {
		const refused = this.refusal(requested, now, ip);
		if (refused) {
			conn.close(refused.code, refused.reason);
			return false;
		}
		const peer = String(requested).toLowerCase();
		const previous = this.peers.get(peer);
		if (previous) {
			this.peers.delete(peer);
			this.seen.delete(previous);
			previous.state.peer = null;
			previous.save?.();
			previous.close(4001, "replaced by a new connection");
		}
		conn.state.peer = peer;
		conn.state.ip = ip;
		conn.save?.();
		this.peers.set(peer, conn);
		this.seen.set(conn, { at: now, tokens: BURST });
		this.log(`[relay] ${peer} joined (${this.peers.size} in room)`);
		return true;
	}

	// `data`: a string (a text message, dropped) or the bytes of a binary one.
	message(conn, data, now = Date.now()) {
		const sender = conn.state.peer;
		if (!sender || this.peers.get(sender) !== conn) return;
		const seen = this.seen.get(conn) ?? { at: now, tokens: BURST };
		seen.tokens = Math.min(BURST, seen.tokens + ((now - seen.at) / 1000) * RELAY_RATE) - 1;
		seen.at = now;
		this.seen.set(conn, seen);
		const size = typeof data === "string" ? data.length : data.byteLength;
		if (seen.tokens < 0 || size > MAX_RELAY_FRAME) {
			conn.close(4029, seen.tokens < 0 ? "too many messages" : "message too big");
			this.close(conn);
			return;
		}
		if (typeof data === "string") return;
		for (const [peer, other] of this.peers) if (peer !== sender) other.sendBinary(data);
	}

	close(conn) {
		const peer = conn.state.peer;
		if (!peer || this.peers.get(peer) !== conn) return;
		this.peers.delete(peer);
		this.seen.delete(conn);
		this.log(`[relay] ${peer} left (${this.peers.size} in room)`);
	}
}
