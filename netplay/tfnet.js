// Browser transport for ggrs-ffi (TF.EX's netplay library), as an Emscripten JS library.
//
// It implements the part of matchbox_socket 0.12 that ggrs-ffi uses (see netplay/matchbox-browser,
// which calls these functions), speaking matchbox's protocol so browser players can meet desktop
// players in the same rooms:
//  - signaling: JSON over a WebSocket to the room URL. Server -> peer: {"IdAssigned":id},
//    {"NewPeer":id} (the receiver makes the offer), {"PeerLeft":id}, {"Signal":{"sender":id,"data":S}};
//    peer -> server: {"Signal":{"receiver":id,"data":S}} and "KeepAlive" every 10 s, where S is
//    {"Offer":sdp} | {"Answer":sdp} | {"IceCandidate":json-of-RTCIceCandidateInit or "null"}.
//  - each side waits for ICE gathering to finish (at most a second) before sending its SDP, then
//    trickles any more candidates;
//  - one data channel: negotiated, id 0, unordered, no retransmits; packets are raw binary.
//  - ICE servers come from the signaling server's /turn (our server: STUN plus TURN relay
//    credentials, so players behind strict NATs can still connect); any other server: STUN only.
//
// RTCPeerConnection only exists on the page's main thread, so every function here is proxied there
// (__proxy: "sync") from whichever worker thread the game calls it on.

var LibraryTFNet = {
	// (Emscripten copies these objects into the build as source text, which turns a Map into {};
	// the postsets create them at startup instead.)
	$TFNet__postset: "TFNet.sockets = new Map();",
	$TFNet: {
		sockets: null,
		next: 1,
		iceServers: [{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }],
		ice: null, // { url, at, servers: Promise } from the last /turn request
		GATHER_WAIT_MS: 1000, // longest wait for ICE gathering before sending an offer or answer (see gathered)

		// The ICE servers for a room URL, from its server's /turn. Credentials last 6 hours; reused
		// for one.
		iceServersFor(roomUrl) {
			let url;
			try {
				const u = new URL(roomUrl);
				u.protocol = u.protocol === "wss:" ? "https:" : "http:";
				u.pathname = "/turn";
				u.search = "";
				url = u.href;
			} catch {
				return Promise.resolve(TFNet.iceServers);
			}
			if (TFNet.ice?.url === url && performance.now() - TFNet.ice.at < 3600e3) return TFNet.ice.servers;
			const abort = new AbortController();
			const timer = setTimeout(() => abort.abort(), 4000);
			const servers = fetch(url, { signal: abort.signal })
				.then((r) => (r.ok ? r.json() : null))
				.then((j) => {
					if (!Array.isArray(j?.iceServers) || !j.iceServers.length) throw new Error("no ICE servers");
					return j.iceServers;
				})
				.catch((e) => {
					console.warn(`[tfnet] ${url}: ${e.message ?? e}; using STUN only`);
					TFNet.ice = null;
					return TFNet.iceServers;
				})
				.finally(() => clearTimeout(timer));
			TFNet.ice = { url, at: performance.now(), servers };
			return servers;
		},

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
				iceServers: null, // once s.ice resolves
			};
			s.ice = TFNet.iceServersFor(url).then((servers) => (s.iceServers = servers));
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
				const pc = new RTCPeerConnection({ iceServers: s.iceServers });
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
				const started = performance.now();
				pc.onconnectionstatechange = async () => {
					if (pc.connectionState === "failed") console.warn(`[tfnet] couldn't connect to peer ${uuid}`);
					if (pc.connectionState !== "connected") return;
					// Direct or through the TURN relay, for reports of slow or failed connections.
					let path = "";
					try {
						const stats = await pc.getStats();
						stats.forEach((s) => {
							const pair = s.type === "transport" && stats.get(s.selectedCandidatePairId);
							const local = pair && stats.get(pair.localCandidateId);
							if (local) path = local.candidateType === "relay" ? ` through the relay (${local.relayProtocol})` : ` directly (${local.candidateType})`;
						});
					} catch {}
					console.log(`[tfnet] connected to peer ${uuid}${path} in ${Math.round(performance.now() - started)} ms`);
				};
				s.peers.set(uuid, peer);
				return peer;
			};
			// ICE gathering finishes, or GATHER_WAIT_MS passes, whichever is first. Usable candidates
			// arrive within a few hundred ms, but "complete" waits for every STUN/TURN request, and one
			// that's never answered (UDP to port 443 on many networks) holds it for about 40 s, past
			// TF.EX's 20 s to connect. The SDP carries what's gathered so far; trickle sends the rest.
			const gathered = (pc) =>
				pc.iceGatheringState === "complete"
					? Promise.resolve()
					: new Promise((resolve) => {
							const done = () => {
								clearTimeout(timer);
								pc.removeEventListener("icegatheringstatechange", check);
								resolve();
							};
							const check = () => pc.iceGatheringState === "complete" && done();
							const timer = setTimeout(done, TFNet.GATHER_WAIT_MS);
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
				await s.ice;
				if (s.state !== 0) return;
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
				// (Every message waits on the same promise, so they still run in arrival order.)
				await s.ice;
				if (s.state !== 0) return;
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
		globalThis.tfnetCalls ??= {};
		globalThis.tfnetCalls.tfnet_open = (globalThis.tfnetCalls.tfnet_open | 0) + 1; // calls proxied to the page (for diagnostics)
		const h = TFNet.next++;
		TFNet.sockets.set(h, TFNet.open(UTF8ToString(url, len)));
		return h;
	},

	// void tfnet_close(int h)
	tfnet_close__deps: ["$TFNet"],
	tfnet_close__proxy: "sync",
	tfnet_close__sig: "vi",
	tfnet_close: function (h) {
		globalThis.tfnetCalls ??= {};
		globalThis.tfnetCalls.tfnet_close = (globalThis.tfnetCalls.tfnet_close | 0) + 1; // calls proxied to the page (for diagnostics)
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
		globalThis.tfnetCalls ??= {};
		globalThis.tfnetCalls.tfnet_state = (globalThis.tfnetCalls.tfnet_state | 0) + 1; // calls proxied to the page (for diagnostics)
		return TFNet.sockets.get(h)?.state ?? 1;
	},

	// int tfnet_error(int h, char* buf, size_t cap): the failure message, as UTF-8.
	tfnet_error__deps: ["$TFNet"],
	tfnet_error__proxy: "sync",
	tfnet_error__sig: "iipp",
	tfnet_error: function (h, buf, cap) {
		globalThis.tfnetCalls ??= {};
		globalThis.tfnetCalls.tfnet_error = (globalThis.tfnetCalls.tfnet_error | 0) + 1; // calls proxied to the page (for diagnostics)
		return stringToUTF8(TFNet.sockets.get(h)?.error ?? "", buf, cap);
	},

	// int tfnet_id(int h, uint8_t out[16]): 1 once the signaling server assigned our id.
	tfnet_id__deps: ["$TFNet"],
	tfnet_id__proxy: "sync",
	tfnet_id__sig: "iip",
	tfnet_id: function (h, out) {
		globalThis.tfnetCalls ??= {};
		globalThis.tfnetCalls.tfnet_id = (globalThis.tfnetCalls.tfnet_id | 0) + 1; // calls proxied to the page (for diagnostics)
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
		globalThis.tfnetCalls ??= {};
		globalThis.tfnetCalls.tfnet_next_event = (globalThis.tfnetCalls.tfnet_next_event | 0) + 1; // calls proxied to the page (for diagnostics)
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
		globalThis.tfnetCalls ??= {};
		globalThis.tfnetCalls.tfnet_send = (globalThis.tfnetCalls.tfnet_send | 0) + 1; // calls proxied to the page (for diagnostics)
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
		globalThis.tfnetCalls ??= {};
		globalThis.tfnetCalls.tfnet_recv_all = (globalThis.tfnetCalls.tfnet_recv_all | 0) + 1; // calls proxied to the page (for diagnostics)
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

// Plain WebSockets for .NET's ClientWebSocket (TF.EX's lobby connection; see
// web/Netplay/PolledWebSocket.cs). .NET's own browser WebSocket delivers its events through the
// thread that owns the page's JS context, which deadlocks when a mod blocks that thread waiting
// for a connection. These are polled instead, so nothing ever calls back into .NET.
var LibraryTFWs = {
	$TFWs__postset: "TFWs.sockets = new Map();",
	$TFWs: { sockets: null, next: 1 },

	// int tfws_open(const char* url): a handle (> 0), or 0 if the URL is invalid.
	tfws_open__deps: ["$TFWs"],
	tfws_open__proxy: "sync",
	tfws_open__sig: "ip",
	tfws_open: function (url) {
		globalThis.tfnetCalls ??= {};
		globalThis.tfnetCalls.tfws_open = (globalThis.tfnetCalls.tfws_open | 0) + 1; // calls proxied to the page (for diagnostics)
		const s = { ws: null, state: 0, code: 0, reason: "", inbox: [] };
		try {
			s.ws = new WebSocket(UTF8ToString(url));
		} catch {
			return 0;
		}
		s.ws.binaryType = "arraybuffer";
		s.ws.onopen = () => (s.state = 1);
		s.ws.onmessage = (e) =>
			s.inbox.push(typeof e.data === "string" ? [1, new TextEncoder().encode(e.data)] : [2, new Uint8Array(e.data)]);
		s.ws.onclose = (e) => {
			s.state = 3;
			s.code = e.code;
			s.reason = e.reason;
		};
		const h = TFWs.next++;
		TFWs.sockets.set(h, s);
		return h;
	},

	// int tfws_state(int h): 0 connecting, 1 open, 2 closing, 3 closed (received messages may
	// still be waiting).
	tfws_state__deps: ["$TFWs"],
	tfws_state__proxy: "sync",
	tfws_state__sig: "ii",
	tfws_state: function (h) {
		globalThis.tfnetCalls ??= {};
		globalThis.tfnetCalls.tfws_state = (globalThis.tfnetCalls.tfws_state | 0) + 1; // calls proxied to the page (for diagnostics)
		const s = TFWs.sockets.get(h);
		if (!s) return 3;
		return s.state === 1 && s.ws.readyState === 2 ? 2 : s.state;
	},

	// int tfws_close_info(int h, char* reason, size_t cap): the close code (0 if not closed).
	tfws_close_info__deps: ["$TFWs"],
	tfws_close_info__proxy: "sync",
	tfws_close_info__sig: "iipp",
	tfws_close_info: function (h, reason, cap) {
		globalThis.tfnetCalls ??= {};
		globalThis.tfnetCalls.tfws_close_info = (globalThis.tfnetCalls.tfws_close_info | 0) + 1; // calls proxied to the page (for diagnostics)
		const s = TFWs.sockets.get(h);
		if (!s) return 1006;
		if (cap > 0) stringToUTF8(s.reason, reason, cap);
		return s.code;
	},

	// int tfws_send(int h, const uint8_t* data, size_t len, int text): 0 sent, -1 not open.
	tfws_send__deps: ["$TFWs"],
	tfws_send__proxy: "sync",
	tfws_send__sig: "iippi",
	tfws_send: function (h, data, len, text) {
		globalThis.tfnetCalls ??= {};
		globalThis.tfnetCalls.tfws_send = (globalThis.tfnetCalls.tfws_send | 0) + 1; // calls proxied to the page (for diagnostics)
		const s = TFWs.sockets.get(h);
		if (!s || s.ws.readyState !== 1) return -1;
		const bytes = HEAPU8.slice(data, data + len);
		s.ws.send(text ? new TextDecoder().decode(bytes) : bytes);
		return 0;
	},

	// int tfws_peek(int h, int* type): the next message's length (and type: 1 text, 2 binary),
	// or -1 if none has arrived.
	tfws_peek__deps: ["$TFWs"],
	tfws_peek__proxy: "sync",
	tfws_peek__sig: "iip",
	tfws_peek: function (h, type) {
		globalThis.tfnetCalls ??= {};
		globalThis.tfnetCalls.tfws_peek = (globalThis.tfnetCalls.tfws_peek | 0) + 1; // calls proxied to the page (for diagnostics)
		const m = TFWs.sockets.get(h)?.inbox[0];
		if (!m) return -1;
		HEAP32[type >> 2] = m[0];
		return m[1].length;
	},

	// void tfws_take(int h, uint8_t* buf): copies the next message (sized by tfws_peek) and drops it.
	tfws_take__deps: ["$TFWs"],
	tfws_take__proxy: "sync",
	tfws_take__sig: "vip",
	tfws_take: function (h, buf) {
		globalThis.tfnetCalls ??= {};
		globalThis.tfnetCalls.tfws_take = (globalThis.tfnetCalls.tfws_take | 0) + 1; // calls proxied to the page (for diagnostics)
		const m = TFWs.sockets.get(h)?.inbox.shift();
		if (m) HEAPU8.set(m[1], buf);
	},

	// void tfws_close(int h, int code, const char* reason): starts the closing handshake.
	tfws_close__deps: ["$TFWs"],
	tfws_close__proxy: "sync",
	tfws_close__sig: "viip",
	tfws_close: function (h, code, reason) {
		globalThis.tfnetCalls ??= {};
		globalThis.tfnetCalls.tfws_close = (globalThis.tfnetCalls.tfws_close | 0) + 1; // calls proxied to the page (for diagnostics)
		const s = TFWs.sockets.get(h);
		if (!s) return;
		try {
			s.ws.close(code || 1000, reason ? UTF8ToString(reason) : undefined);
		} catch {
			s.ws.close();
		}
	},

	// void tfws_free(int h)
	tfws_free__deps: ["$TFWs"],
	tfws_free__proxy: "sync",
	tfws_free__sig: "vi",
	tfws_free: function (h) {
		globalThis.tfnetCalls ??= {};
		globalThis.tfnetCalls.tfws_free = (globalThis.tfnetCalls.tfws_free | 0) + 1; // calls proxied to the page (for diagnostics)
		const s = TFWs.sockets.get(h);
		if (!s) return;
		if (s.ws.readyState < 2) s.ws.close();
		TFWs.sockets.delete(h);
	},
};

// void tfclip_write(const char* text): puts text on the system clipboard (SDL's clipboard is
// internal to the page in the browser). Pasting goes the other way through main.js.
LibraryTFWs.tfclip_write__proxy = "sync";
LibraryTFWs.tfclip_write__sig = "vp";
LibraryTFWs.tfclip_write = function (text) {
	navigator.clipboard?.writeText(UTF8ToString(text)).catch((e) => console.warn("[clipboard] couldn't copy:", e));
};

autoAddDeps(LibraryTFWs, "$TFWs");
mergeInto(LibraryManager.library, LibraryTFWs);

autoAddDeps(LibraryTFNet, "$TFNet");
mergeInto(LibraryManager.library, LibraryTFNet);
