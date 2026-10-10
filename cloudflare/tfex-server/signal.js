// Match signaling: matchbox's protocol (matchbox_protocol 0.12, full mesh), as TF.EX's rooms use it
// at /room/<roomId>?peer=<peerId> and /ping_measurement/<roomId>?peer=<peerId>. The one difference
// from a stock matchbox server: the peer id comes from the URL (the lobby hands them out, and
// ggrs-ffi matches lobby seats to them) instead of being random. Without ?peer= it is random.
//
//  server -> peer: {"IdAssigned":id} first, then {"NewPeer":id} (the receiver makes the WebRTC
//                  offer), {"PeerLeft":id}, {"Signal":{"sender":id,"data":S}}
//  peer -> server: {"Signal":{"receiver":id,"data":S}}, "KeepAlive" (every 10 s, ignored)
//
// A connection (`conn`) is anything with send(text), close(code, reason) and a `state` object that
// the platform keeps for it (save() persists it, for Durable Object hibernation).

export const MAX_PEERS_PER_ROOM = 16;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (s) => typeof s === "string" && UUID.test(s);

export class SignalRoom {
	constructor({ log = () => {} } = {}) {
		this.log = log;
		this.peers = new Map(); // peer id -> conn
	}

	// Rebuilds the room from connections that outlived a Durable Object hibernation.
	restore(conns) {
		for (const conn of conns) if (conn.state.peer) this.peers.set(conn.state.peer, conn);
	}

	isEmpty() {
		return this.peers.size === 0;
	}

	open(conn, requested) {
		let peer = requested ? String(requested).toLowerCase() : crypto.randomUUID();
		if (!isUuid(peer)) return conn.close(4000, "peer must be a UUID");
		const previous = this.peers.get(peer);
		if (previous) {
			// The same peer reconnecting: drop the old connection, and tell the others it left so
			// they set up a fresh WebRTC connection on the NewPeer below.
			this.peers.delete(peer);
			previous.state.peer = null;
			previous.save?.();
			previous.close(4001, "replaced by a new connection");
			this.broadcast({ PeerLeft: peer });
		}
		if (this.peers.size >= MAX_PEERS_PER_ROOM) return conn.close(4002, "room is full");
		conn.state.peer = peer;
		conn.save?.();
		conn.send(JSON.stringify({ IdAssigned: peer }));
		this.broadcast({ NewPeer: peer });
		this.peers.set(peer, conn);
		this.log(`[signal] ${peer} joined (${this.peers.size} in room)`);
	}

	message(conn, text) {
		const sender = conn.state.peer;
		if (!sender || this.peers.get(sender) !== conn) return;
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
		this.broadcast({ PeerLeft: peer });
		this.log(`[signal] ${peer} left (${this.peers.size} in room)`);
	}

	broadcast(event) {
		const text = JSON.stringify(event);
		for (const conn of this.peers.values()) conn.send(text);
	}
}
