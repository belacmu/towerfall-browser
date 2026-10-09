// Browser transport for ggrs-ffi (TF.EX's netplay library), as an Emscripten JS library.
//
// It implements the part of matchbox_socket 0.12 that ggrs-ffi uses (see netplay/matchbox-browser,
// which calls these functions), speaking matchbox's protocol so browser players can meet desktop
// players in the same rooms:
//  - signaling: JSON over a WebSocket to the room URL. Server -> peer: {"IdAssigned":id},
//    {"NewPeer":id} (the receiver makes the offer), {"PeerLeft":id}, {"Signal":{"sender":id,"data":S}};
//    peer -> server: {"Signal":{"receiver":id,"data":S}} and "KeepAlive" every 10 s, where S is
//    {"Offer":sdp} | {"Answer":sdp} | {"IceCandidate":json-of-RTCIceCandidateInit or "null"}.
//  - each side waits for ICE gathering to finish before sending its SDP, then trickles any more
//    candidates;
//  - one data channel: negotiated, id 0, unordered, no retransmits; packets are raw binary.
//
// RTCPeerConnection only exists on the page's main thread, so every function here is proxied there
// (__proxy: "sync") from whichever worker thread the game calls it on.

var LibraryTFNet = {
	$TFNet: {
		sockets: new Map(),
		next: 1,
		iceServers: [{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }],

		uuidToBytes(uuid, ptr) {
			const hex = uuid.replace(/-/g, "");
			for (let i = 0; i < 16; i++) HEAPU8[ptr + i] = parseInt(hex.substr(i * 2, 2), 16);
		},
		bytesToUuid(ptr) {
			let hex = "";
			for (let i = 0; i < 16; i++) hex += HEAPU8[ptr + i].toString(16).padStart(2, "0");
			return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
		},

		open(url) {
			const s = {
				ws: null,
				id: null,
				peers: new Map(), // uuid -> { pc, dc, connected, pending: [candidate json] }
				events: [], // [uuid, 1 = connected | 2 = disconnected]
				inbox: [], // [uuid, Uint8Array]
				state: 0, // 0 running, 1 closed, 2 connection failed, 3 disconnected
				error: "",
				keepAlive: null,
			};
			const signal = (receiver, data) => {
				if (s.ws.readyState === 1) s.ws.send(JSON.stringify({ Signal: { receiver, data } }));
			};
			const fail = (message) => {
				if (s.state !== 0) return;
				s.state = s.id ? 3 : 2;
				s.error = message;
				TFNet.shutdown(s);
			};

			const createPeer = (uuid) => {
				const pc = new RTCPeerConnection({ iceServers: TFNet.iceServers });
				const dc = pc.createDataChannel("matchbox_socket_0", { ordered: false, maxRetransmits: 0, negotiated: true, id: 0 });
				dc.binaryType = "arraybuffer";
				const peer = { pc, dc, connected: false, pending: [], remoteSet: false };
				dc.onopen = () => {
					peer.connected = true;
					s.events.push([uuid, 1]);
				};
				dc.onmessage = (e) => {
					if (e.data instanceof ArrayBuffer) s.inbox.push([uuid, new Uint8Array(e.data)]);
				};
				dc.onclose = () => {
					if (peer.connected) s.events.push([uuid, 2]);
					peer.connected = false;
				};
				s.peers.set(uuid, peer);
				return peer;
			};
			const gathered = (pc) =>
				pc.iceGatheringState === "complete"
					? Promise.resolve()
					: new Promise((resolve) => {
							const check = () => {
								if (pc.iceGatheringState === "complete") {
									pc.removeEventListener("icegatheringstatechange", check);
									resolve();
								}
							};
							pc.addEventListener("icegatheringstatechange", check);
						});
			const addCandidate = async (peer, json) => {
				let init = null;
				try {
					init = JSON.parse(json);
				} catch {
					return;
				}
				try {
					await peer.pc.addIceCandidate(init ?? undefined);
				} catch (e) {
					console.warn("[tfnet] ignoring ICE candidate:", e);
				}
			};
			const remoteSet = async (peer) => {
				peer.remoteSet = true;
				for (const c of peer.pending.splice(0)) await addCandidate(peer, c);
			};
			const trickle = (uuid, peer) => {
				peer.pc.onicecandidate = (e) => signal(uuid, { IceCandidate: e.candidate ? JSON.stringify(e.candidate.toJSON()) : "null" });
			};

			const offer = async (uuid) => {
				const peer = createPeer(uuid);
				await peer.pc.setLocalDescription(await peer.pc.createOffer());
				await gathered(peer.pc);
				signal(uuid, { Offer: peer.pc.localDescription.sdp });
				trickle(uuid, peer);
			};
			const accept = async (uuid, sdp) => {
				const peer = s.peers.get(uuid) ?? createPeer(uuid);
				await peer.pc.setRemoteDescription({ type: "offer", sdp });
				await remoteSet(peer);
				await peer.pc.setLocalDescription(await peer.pc.createAnswer());
				await gathered(peer.pc);
				signal(uuid, { Answer: peer.pc.localDescription.sdp });
				trickle(uuid, peer);
			};
			const onSignal = async (sender, data) => {
				if ("Offer" in data) {
					await accept(sender, data.Offer);
				} else if ("Answer" in data) {
					const peer = s.peers.get(sender);
					if (!peer) return;
					await peer.pc.setRemoteDescription({ type: "answer", sdp: data.Answer });
					await remoteSet(peer);
				} else if ("IceCandidate" in data) {
					const peer = s.peers.get(sender) ?? createPeer(sender);
					if (peer.remoteSet) await addCandidate(peer, data.IceCandidate);
					else peer.pending.push(data.IceCandidate);
				}
			};

			try {
				s.ws = new WebSocket(url);
			} catch (e) {
				s.state = 2;
				s.error = String(e);
				return s;
			}
			s.ws.onopen = () => {
				s.keepAlive = setInterval(() => s.ws.readyState === 1 && s.ws.send('"KeepAlive"'), 10000);
			};
			s.ws.onmessage = (e) => {
				if (typeof e.data !== "string") return;
				let msg;
				try {
					msg = JSON.parse(e.data);
				} catch {
					return;
				}
				if (msg.IdAssigned) s.id = msg.IdAssigned;
				else if (msg.NewPeer) offer(msg.NewPeer).catch((err) => console.error("[tfnet] offer failed:", err));
				else if (msg.PeerLeft) {
					const peer = s.peers.get(msg.PeerLeft);
					if (peer) {
						if (peer.connected) s.events.push([msg.PeerLeft, 2]);
						peer.connected = false;
						peer.pc.close();
						s.peers.delete(msg.PeerLeft);
					}
				} else if (msg.Signal) onSignal(msg.Signal.sender, msg.Signal.data).catch((err) => console.error("[tfnet] signal failed:", err));
			};
			s.ws.onerror = () => fail(`couldn't connect to ${url}`);
			s.ws.onclose = (e) => fail(`signaling connection closed (${e.code}${e.reason ? " " + e.reason : ""})`);
			return s;
		},

		shutdown(s) {
			clearInterval(s.keepAlive);
			for (const peer of s.peers.values()) {
				try {
					peer.pc.close();
				} catch {}
			}
			s.peers.clear();
			try {
				s.ws?.close();
			} catch {}
		},
	},

	// int tfnet_open(const char* url, size_t len): a handle (> 0).
	tfnet_open__deps: ["$TFNet"],
	tfnet_open__proxy: "sync",
	tfnet_open__sig: "ipp",
	tfnet_open: function (url, len) {
		const h = TFNet.next++;
		TFNet.sockets.set(h, TFNet.open(UTF8ToString(url, len)));
		return h;
	},

	// void tfnet_close(int h)
	tfnet_close__deps: ["$TFNet"],
	tfnet_close__proxy: "sync",
	tfnet_close__sig: "vi",
	tfnet_close: function (h) {
		const s = TFNet.sockets.get(h);
		if (!s) return;
		if (s.state === 0) s.state = 1;
		TFNet.shutdown(s);
		TFNet.sockets.delete(h);
	},

	// int tfnet_state(int h): 0 running, 1 closed, 2 connection failed, 3 disconnected.
	tfnet_state__deps: ["$TFNet"],
	tfnet_state__proxy: "sync",
	tfnet_state__sig: "ii",
	tfnet_state: function (h) {
		return TFNet.sockets.get(h)?.state ?? 1;
	},

	// int tfnet_error(int h, char* buf, size_t cap): the failure message, as UTF-8.
	tfnet_error__deps: ["$TFNet"],
	tfnet_error__proxy: "sync",
	tfnet_error__sig: "iipp",
	tfnet_error: function (h, buf, cap) {
		return stringToUTF8(TFNet.sockets.get(h)?.error ?? "", buf, cap);
	},

	// int tfnet_id(int h, uint8_t out[16]): 1 once the signaling server assigned our id.
	tfnet_id__deps: ["$TFNet"],
	tfnet_id__proxy: "sync",
	tfnet_id__sig: "iip",
	tfnet_id: function (h, out) {
		const id = TFNet.sockets.get(h)?.id;
		if (!id) return 0;
		TFNet.uuidToBytes(id, out);
		return 1;
	},

	// int tfnet_next_event(int h, uint8_t peer[16]): 0 none, 1 peer connected, 2 peer disconnected.
	tfnet_next_event__deps: ["$TFNet"],
	tfnet_next_event__proxy: "sync",
	tfnet_next_event__sig: "iip",
	tfnet_next_event: function (h, peer) {
		const e = TFNet.sockets.get(h)?.events.shift();
		if (!e) return 0;
		TFNet.uuidToBytes(e[0], peer);
		return e[1];
	},

	// int tfnet_send(int h, const uint8_t peer[16], const uint8_t* data, size_t len): 0 sent,
	// -1 peer not connected, -2 send failed.
	tfnet_send__deps: ["$TFNet"],
	tfnet_send__proxy: "sync",
	tfnet_send__sig: "iippp",
	tfnet_send: function (h, peer, data, len) {
		const p = TFNet.sockets.get(h)?.peers.get(TFNet.bytesToUuid(peer));
		if (!p || !p.connected) return -1;
		try {
			p.dc.send(HEAPU8.slice(data, data + len));
			return 0;
		} catch {
			return -2;
		}
	},

	// int tfnet_recv_all(int h, uint8_t* buf, size_t cap): packs as many received packets as fit,
	// each as [16-byte peer id][u32 little-endian length][bytes]; returns the bytes written.
	tfnet_recv_all__deps: ["$TFNet"],
	tfnet_recv_all__proxy: "sync",
	tfnet_recv_all__sig: "iipp",
	tfnet_recv_all: function (h, buf, cap) {
		const s = TFNet.sockets.get(h);
		if (!s) return 0;
		let at = 0;
		while (s.inbox.length) {
			const [uuid, bytes] = s.inbox[0];
			if (at + 20 + bytes.length > cap) {
				if (at === 0) s.inbox.shift(); // can't ever fit: drop it (unreliable channel anyway)
				break;
			}
			s.inbox.shift();
			TFNet.uuidToBytes(uuid, buf + at);
			HEAPU8[buf + at + 16] = bytes.length & 255;
			HEAPU8[buf + at + 17] = (bytes.length >> 8) & 255;
			HEAPU8[buf + at + 18] = (bytes.length >> 16) & 255;
			HEAPU8[buf + at + 19] = (bytes.length >> 24) & 255;
			HEAPU8.set(bytes, buf + at + 20);
			at += 20 + bytes.length;
		}
		return at;
	},
};

autoAddDeps(LibraryTFNet, "$TFNet");
mergeInto(LibraryManager.library, LibraryTFNet);
