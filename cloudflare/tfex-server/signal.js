// Match signaling: matchbox's protocol (matchbox_protocol 0.12, full mesh), as TF.EX's rooms use it
// at /room/<roomId>?peer=<peerId> and /ping_measurement/<roomId>?peer=<peerId>. The one difference
// from a stock matchbox server: the peer id comes from the URL (the lobby hands them out, and
// ggrs-ffi matches lobby seats to them) instead of being random. Without ?peer= it is random.
//
//  server -> peer: {"IdAssigned":id} first, then {"NewPeer":id} (the receiver makes the WebRTC
//                  offer), {"PeerLeft":id}, {"Signal":{"sender":id,"data":S}}
//  peer -> server: {"Signal":{"receiver":id,"data":S}}, "KeepAlive" (every 10 s, ignored)
//
// The other difference: a peer id that is already connected can only be taken over by a new
// connection from the same address (a client reconnecting, e.g. for the next match before its old
// socket has closed), or once the old one has gone quiet past its keep-alives. Peer ids show in
// the lobby, and the old connection's peers would drop it.
//
// A connection (`conn`) is anything with send(text), close(code, reason) and a `state` object that
// the platform keeps for it (save() persists it, for Durable Object hibernation).

export const MAX_PEERS_PER_ROOM = 16;
// Offers, answers and ICE candidates are a few KB.
export const MAX_SIGNAL_FRAME = 64 * 1024;
// A connection this quiet (2.5 keep-alives) can be replaced by a new one with its peer id.
const STALE_MS = 25_000;
// Messages per connection: a bucket of BURST that refills at RATE per second (trickled ICE
// candidates come in bursts). Running dry closes it.
const BURST = 200;
const RATE = 20;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (s) => typeof s === "string" && UUID.test(s);

export class SignalRoom {
	constructor({ log = () => {} } = {}) {
		this.log = log;
		this.peers = new Map(); // peer id -> conn
		this.seen = new Map(); // conn -> { at, tokens } (in memory: hibernation needs quiet anyway)
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

	// `ip` is the client's address, if known.
	open(conn, requested, now = Date.now(), ip = null) {
		let peer = requested ? String(requested).toLowerCase() : crypto.randomUUID();
		if (!isUuid(peer)) return conn.close(4000, "peer must be a UUID");
		const previous = this.peers.get(peer);
		const quiet = now - (this.seen.get(previous)?.at ?? 0) >= STALE_MS;
		if (previous && !quiet && (!ip || previous.state.ip !== ip)) return conn.close(4003, "peer already connected");
		if (previous) {
			// The same peer reconnecting: drop the old connection, and tell the others it left so
			// they set up a fresh WebRTC connection on the NewPeer below.
			this.peers.delete(peer);
			this.seen.delete(previous);
			previous.state.peer = null;
			previous.save?.();
			previous.close(4001, "replaced by a new connection");
			this.broadcast({ PeerLeft: peer });
		}
		if (this.peers.size >= MAX_PEERS_PER_ROOM) return conn.close(4002, "room is full");
		conn.state.peer = peer;
		conn.state.ip = ip;
		conn.save?.();
		conn.send(JSON.stringify({ IdAssigned: peer }));
		this.broadcast({ NewPeer: peer });
		this.peers.set(peer, conn);
		this.seen.set(conn, { at: now, tokens: BURST });
		this.log(`[signal] ${peer} joined (${this.peers.size} in room)`);
	}

	message(conn, text, now = Date.now()) {
		const sender = conn.state.peer;
		if (!sender || this.peers.get(sender) !== conn) return;
		const seen = this.seen.get(conn) ?? { at: now, tokens: BURST };
		seen.tokens = Math.min(BURST, seen.tokens + ((now - seen.at) / 1000) * RATE) - 1;
		seen.at = now;
		this.seen.set(conn, seen);
		if (seen.tokens < 0 || text.length > MAX_SIGNAL_FRAME) {
			conn.close(4029, seen.tokens < 0 ? "too many messages" : "message too big");
			this.close(conn);
			return;
		}
		let msg;
		try {
			msg = JSON.parse(text);
		} catch {
			return;
		}
		if (msg === "KeepAlive" || !msg || typeof msg !== "object") return;
		const signal = msg.Signal;
		if (!signal || !isUuid(signal.receiver)) return;
		const receiver = this.peers.get(signal.receiver.toLowerCase());
		if (!receiver) return;
		receiver.send(JSON.stringify({ Signal: { sender, data: signal.data } }));
	}

	close(conn) {
		const peer = conn.state.peer;
		if (!peer || this.peers.get(peer) !== conn) return;
		this.peers.delete(peer);
		this.seen.delete(conn);
		this.broadcast({ PeerLeft: peer });
		this.log(`[signal] ${peer} left (${this.peers.size} in room)`);
	}

	broadcast(event) {
		const text = JSON.stringify(event);
		for (const conn of this.peers.values()) conn.send(text);
	}
}
