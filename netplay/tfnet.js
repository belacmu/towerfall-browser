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
// A second transport, selected by the room URL, needs no WebRTC and no matchbox signaling: a room URL
// whose path ends in /relay/<room> (wss://host/relay/<room>?peer=<our uuid>&remote=<their uuid>) is a
// plain WebSocket relay (switch-online/tools/relay-server.mjs, relay-worker/worker.js) that hands every
// binary message a peer sends to the room's other peer, unchanged. See TFNet.openRelay and
// switch-online/BROWSER-RELAY.md. Everything else here (the signal counters, the calls) is shared.
//
// RTCPeerConnection only exists on the page's main thread, so every function here is proxied there
// (__proxy: "sync") from whichever worker thread the game calls it on. Each call waits for the main
// thread, so callers first check a socket's signal: two counters in wasm memory (their own, passed
// to tfnet_open) that the page bumps when packets arrive (0) and when anything else changes (1:
// peer events, state, id). Unchanged counters mean there's nothing to ask for.

var LibraryTFNet = {
	// (Emscripten copies these objects into the build as source text, which turns a Map into {};
	// the postsets create them at startup instead.)
	$TFNet__postset: "TFNet.sockets = new Map(); if (!ENVIRONMENT_IS_PTHREAD) { globalThis.tfnetStats = TFNet.stats; globalThis.tfnetRelayStats = TFNet.relayStats; }",
	$TFNet: {
		sockets: null,
		next: 1,
		iceServers: [{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }],
		ice: null, // { url, at, servers: Promise } from the last /turn request
		GATHER_WAIT_MS: 1000, // longest wait for ICE gathering before sending an offer or answer (see gathered)

		// The ICE servers for a room URL (.../room/<id>?peer=<uuid>), from its server's /turn, which
		// only gives relay credentials to a peer in that lobby. Credentials last 6 hours; reused for one.
		iceServersFor(roomUrl) {
			let url;
			try {
				const u = new URL(roomUrl);
				const room = u.pathname.split("/").pop();
				const peer = u.searchParams.get("peer") ?? "";
				u.protocol = u.protocol === "wss:" ? "https:" : "http:";
				u.pathname = "/turn";
				u.search = new URLSearchParams({ room, peer }).toString();
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

		// Packet timing for the page's Stats panel (stats.js reads and resets it): how long each
		// received packet waited on the page before the game took it (tfnet_recv_all). (How long the
		// browser held it before the handler ran can't be read: the event is stamped at dispatch.)
		stats: { packets: 0, wait: null, path: "", rtt: null, routes: "" },

		// The connection's path and WebRTC's own round-trip time (its connectivity checks, so the
		// network alone, without either game in it), from a peer connection's stats. Safari doesn't
		// always name the selected pair on the transport, so a succeeded nominated pair also counts.
		network: async function (pc) {
			const stats = await pc.getStats();
			let pair = null;
			stats.forEach((x) => {
				if (x.type === "transport" && x.selectedCandidatePairId) pair = stats.get(x.selectedCandidatePairId) ?? pair;
			});
			if (!pair) stats.forEach((x) => {
				if (x.type === "candidate-pair" && (x.selected || (x.nominated && x.state === "succeeded"))) pair = x;
			});
			if (!pair) return null;
			const local = stats.get(pair.localCandidateId);
			const remote = stats.get(pair.remoteCandidateId);
			const relayed = local?.candidateType === "relay" || remote?.candidateType === "relay";
			return {
				path: relayed ? `through the relay (${local?.relayProtocol ?? local?.protocol ?? "?"}, ${local?.candidateType ?? "?"} to ${remote?.candidateType ?? "?"})` : `directly (${local?.candidateType ?? "?"} to ${remote?.candidateType ?? "?"})`,
				rttMs: typeof pair.currentRoundTripTime === "number" ? pair.currentRoundTripTime * 1000 : null,
			};
		},
		// Which routes each side found and how far each kind of pair got, to tell why a connection
		// went through the relay: for example "this side srflx4 relay4; other side host-mdns relay4;
		// srflx4-relay4 succeeded, relay4-relay4 succeeded". host is a local address (mdns: hidden
		// behind a .local name), srflx the public address STUN saw (4 or 6: IPv4 or IPv6), relay the
		// TURN relay's. No addresses are kept.
		routes(stats) {
			const kind = (c) => {
				if (!c) return "?";
				const a = c.address ?? c.ip ?? "";
				return c.candidateType + (a.endsWith(".local") ? "-mdns" : a.includes(":") ? "6" : a ? "4" : "");
			};
			const sides = { "local-candidate": new Set(), "remote-candidate": new Set() };
			stats.forEach((x) => sides[x.type]?.add(kind(x)));
			const rank = { frozen: 0, waiting: 1, "in-progress": 2, failed: 3, succeeded: 4 };
			const pairs = new Map();
			stats.forEach((x) => {
				if (x.type !== "candidate-pair") return;
				const name = `${kind(stats.get(x.localCandidateId))}-${kind(stats.get(x.remoteCandidateId))}`;
				if ((rank[x.state] ?? -1) >= (rank[pairs.get(name)] ?? -1)) pairs.set(name, x.state);
			});
			const list = (set) => [...set].sort().join(" ") || "none";
			return `this side ${list(sides["local-candidate"])}; other side ${list(sides["remote-candidate"])}; ${[...pairs].map(([n, st]) => `${n} ${st}`).join(", ") || "no pairs"}`;
		},
		timing() {
			return { n: 0, sum: 0, max: 0, over4: 0, over16: 0 };
		},
		time(t, ms) {
			t.n++;
			t.sum += ms;
			if (ms > t.max) t.max = ms;
			if (ms > 4) t.over4++;
			if (ms > 16.7) t.over16++;
		},

		// ?netdelay=N[&netjitter=M], for testing online play over a slower network on one machine:
		// received packets are held N ms (plus up to M ms at random) before the game can take them.
		// Each player delays what it receives, so netdelay=40 on both makes about 80 ms of ping.
		netDelay: null,
		delay() {
			if (TFNet.netDelay === null) {
				const p = new URLSearchParams(globalThis.location?.search ?? "");
				TFNet.netDelay = { ms: Math.max(0, Number(p.get("netdelay")) || 0), jitter: Math.max(0, Number(p.get("netjitter")) || 0) };
				if (TFNet.netDelay.ms || TFNet.netDelay.jitter) console.log(`[tfnet] test: received packets held ${TFNet.netDelay.ms} ms + up to ${TFNet.netDelay.jitter} ms`);
			}
			const d = TFNet.netDelay;
			return d.ms || d.jitter ? d.ms + Math.random() * d.jitter : 0;
		},

		// Bumps one of a socket's signal counters (see the top).
		bump(s, counter) {
			if (s.signal) Atomics.add(HEAP32, (s.signal >> 2) + counter, 1);
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

		open(url, counters) {
			if (TFNet.isRelayUrl(url)) return TFNet.openRelay(url, counters);
			const s = {
				signal: counters, // address of the socket's two signal counters; 0 once closed
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
				TFNet.bump(s, 1);
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
					TFNet.bump(s, 1);
				};
				dc.onmessage = (e) => {
					if (!(e.data instanceof ArrayBuffer)) return;
					const bytes = new Uint8Array(e.data);
					const deliver = () => {
						if (s.state !== 0) return;
						TFNet.stats.packets++;
						s.inbox.push([uuid, bytes, performance.now()]);
						TFNet.bump(s, 0);
					};
					const held = TFNet.delay();
					if (held) setTimeout(deliver, held);
					else deliver();
				};
				dc.onclose = () => {
					if (peer.connected) {
						s.events.push([uuid, 2]);
						TFNet.bump(s, 1);
					}
					peer.connected = false;
				};
				const started = performance.now();
				pc.onconnectionstatechange = async () => {
					if (pc.connectionState === "failed") {
						let routes = "";
						try {
							routes = `: ${TFNet.routes(await pc.getStats())}`;
						} catch {}
						console.warn(`[tfnet] couldn't connect to peer ${uuid}${routes}`);
					}
					if (pc.connectionState !== "connected") return;
					// Direct or through the TURN relay, for reports of slow or failed connections.
					let path = "";
					try {
						const n = await TFNet.network(pc);
						if (n) path = ` ${n.path}${n.rttMs != null ? `, network round trip ${Math.round(n.rttMs)} ms` : ""}`;
					} catch {}
					console.log(`[tfnet] connected to peer ${uuid}${path} in ${Math.round(performance.now() - started)} ms`);
					TFNet.stats.path = path.trim().replace(/, network.*/, "");
					// (Pairs still being checked a moment later are mostly settled.)
					setTimeout(async () => {
						if (pc.connectionState !== "connected") return; // (closed: a ping measurement's)
						try {
							TFNet.stats.routes = TFNet.routes(await pc.getStats());
							console.log(`[tfnet] routes to peer ${uuid}: ${TFNet.stats.routes}`);
						} catch {}
					}, 3000);
					// While connected, the path (it can change) and WebRTC's round trip every 2 s, for the
					// Stats panel and reports (stats.js), next to the game's own ping.
					clearInterval(peer.sampler);
					peer.sampler = setInterval(async () => {
						if (pc.connectionState !== "connected") return clearInterval(peer.sampler);
						try {
							const n = await TFNet.network(pc);
							if (!n) return;
							TFNet.stats.path = n.path;
							if (n.rttMs != null) TFNet.time((TFNet.stats.rtt ??= TFNet.timing()), n.rttMs);
						} catch {}
					}, 2000);
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
				if (msg.IdAssigned) {
					s.id = msg.IdAssigned;
					TFNet.bump(s, 1);
				}
				else if (msg.NewPeer) offer(msg.NewPeer).catch((err) => console.error("[tfnet] offer failed:", err));
				else if (msg.PeerLeft) {
					const peer = s.peers.get(msg.PeerLeft);
					if (peer) {
						if (peer.connected) {
							s.events.push([msg.PeerLeft, 2]);
							TFNet.bump(s, 1);
						}
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

		// ---- relay transport (no WebRTC, no matchbox signaling) ----
		//
		// Room URL: <ws|wss>://host[:port]/relay/<room>?peer=<our uuid>&remote=<the other peer's uuid>[&hello=1]
		//  - peer: our PeerId (what the relay logs, and what tfnet_id reports); must be a UUID.
		//  - remote: the PeerId ggrs-ffi has for the one other peer (TF.EX's lobby list of seats). The relay
		//    does not say who sent a frame, so every frame is attributed to this id.
		//  - Every binary message is one bincode'd ggrs::Message, exactly what ggrs-ffi gives matchbox's channel
		//    (no extra framing), and one WebSocket binary message is one packet. Text messages are ignored.
		//  - The other peer counts as connected as soon as the WebSocket is open (a PeerState::Connected event
		//    at once, also when it hasn't joined the room yet: frames sent before then are lost, and ggrs's
		//    synchronization handshake retries every 200 ms). It is reported disconnected when the WebSocket
		//    closes; ggrs's own timeout (15 s without packets) ends a session whose peer just went quiet.
		//  - A 5-byte binary message "HELLO" is never given to ggrs (a ggrs::Message is never that: bincode would
		//    fail on it, and ggrs-ffi would panic). &hello=1 makes us send one every 500 ms until the first real
		//    frame from the other side arrives, so a peer that wants to wait for us can; off by default.
		// Same signal counters as the WebRTC path: 0 bumps when packets arrive, 1 for peer events and state.
		isRelayUrl(url) {
			try {
				return /\/relay\/[^/]+$/.test(new URL(url).pathname);
			} catch {
				return false;
			}
		},
		// (A string: Emscripten copies this object as JSON-ish text, which would turn a RegExp into {}.)
		UUID_PATTERN: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
		relayStats: { rx: 0, tx: 0, rxBytes: 0, txBytes: 0, dropped: 0, hello: 0, junk: 0 },
		openRelay(url, counters) {
			const s = { signal: counters, ws: null, id: null, peers: new Map(), events: [], inbox: [], state: 0, error: "", keepAlive: null, hello: null, relay: true };
			let remote, local, wantHello = false;
			try {
				const u = new URL(url);
				local = (u.searchParams.get("peer") ?? "").toLowerCase();
				remote = (u.searchParams.get("remote") ?? "").toLowerCase();
				wantHello = u.searchParams.get("hello") === "1";
			} catch {}
			const uuid = new RegExp(TFNet.UUID_PATTERN, "i");
			if (!uuid.test(local) || !uuid.test(remote)) {
				s.state = 2;
				s.error = `relay room URL needs ?peer=<uuid>&remote=<uuid> (got peer=${local || "-"} remote=${remote || "-"})`;
				return s;
			}
			s.id = local;
			const stats = TFNet.relayStats;
			let heard = false;
			let opened = false;
			const peer = {
				connected: false,
				// ggrs-ffi's tfnet_send goes through peers.get(id).dc.send, as with a data channel.
				dc: {
					send: (bytes) => {
						if (s.ws.readyState !== 1) return void stats.dropped++;
						s.ws.send(bytes);
						stats.tx++;
						stats.txBytes += bytes.length;
					},
				},
			};
			s.peers.set(remote, peer);
			const isHello = (b) => b.length === 5 && b[0] === 0x48 && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x4c && b[4] === 0x4f;
			const connected = (up) => {
				if (peer.connected === up) return;
				peer.connected = up;
				s.events.push([remote, up ? 1 : 2]);
				TFNet.bump(s, 1);
			};
			try {
				s.ws = new WebSocket(url);
			} catch (e) {
				s.state = 2;
				s.error = String(e);
				return s;
			}
			s.ws.binaryType = "arraybuffer";
			s.ws.onopen = () => {
				opened = true;
				TFNet.stats.path = "through a WebSocket relay";
				console.log(`[tfnet] relay: joined ${url.replace(/\?.*/, "")} as ${local}; other peer ${remote}${wantHello ? " (hello on)" : ""}`);
				connected(true);
				if (wantHello) {
					const hello = new Uint8Array([0x48, 0x45, 0x4c, 0x4c, 0x4f]);
					s.hello = setInterval(() => {
						if (heard || s.ws.readyState !== 1) return clearInterval(s.hello);
						s.ws.send(hello);
						stats.hello++;
					}, 500);
				}
			};
			s.ws.onmessage = (e) => {
				if (!(e.data instanceof ArrayBuffer)) return; // text: not ours
				const bytes = new Uint8Array(e.data);
				if (isHello(bytes)) {
					stats.hello++;
					return;
				}
				if (!bytes.length) return void stats.junk++;
				heard = true;
				stats.rx++;
				stats.rxBytes += bytes.length;
				TFNet.stats.packets++;
				const deliver = () => {
					if (s.state !== 0) return;
					s.inbox.push([remote, bytes, performance.now()]);
					TFNet.bump(s, 0);
				};
				const held = TFNet.delay();
				if (held) setTimeout(deliver, held);
				else deliver();
			};
			s.ws.onerror = () => {
				if (s.state === 0 && !opened) {
					s.state = 2;
					s.error = `couldn't connect to ${url.replace(/\?.*/, "")}`;
					TFNet.bump(s, 1);
					TFNet.shutdown(s);
				}
			};
			s.ws.onclose = (e) => {
				connected(false);
				if (s.state !== 0) return;
				s.state = opened ? 3 : 2;
				s.error = `relay connection closed (${e.code}${e.reason ? " " + e.reason : ""})`;
				TFNet.bump(s, 1);
				TFNet.shutdown(s);
			};
			return s;
		},

		shutdown(s) {
			clearInterval(s.keepAlive);
			clearInterval(s.hello);
			for (const peer of s.peers.values()) {
				try {
					peer.pc?.close();
				} catch {}
			}
			s.peers.clear();
			try {
				s.ws?.close();
			} catch {}
		},
	},

	// int tfnet_open(const char* url, size_t len, int32_t signal[2]): a handle (> 0). The page bumps
	// signal[0] when packets arrive and signal[1] when anything else changes, until tfnet_close.
	tfnet_open__deps: ["$TFNet"],
	tfnet_open__proxy: "sync",
	tfnet_open__sig: "ippp",
	tfnet_open: function (url, len, signal) {
		globalThis.tfnetCalls ??= {};
		globalThis.tfnetCalls.tfnet_open = (globalThis.tfnetCalls.tfnet_open | 0) + 1; // calls proxied to the page (for diagnostics)
		const h = TFNet.next++;
		TFNet.sockets.set(h, TFNet.open(UTF8ToString(url, len), signal));
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
		s.signal = 0; // the caller may free it now
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

	// void tfnet_send(int h, uint8_t* packet, size_t len): sends packet[16..len) to the peer whose
	// id is packet[0..16), if it's connected, then frees packet (malloc'd by the caller). Proxied
	// asynchronously: the caller doesn't wait for the main thread (each wait took 33-63 us on a
	// desktop, longer where the main thread is busier, ~490 times a second), so it hands over a copy
	// and gets no result; ggrs only logs failed sends anyway. Calls from one thread arrive in order.
	tfnet_send__deps: ["$TFNet", "free"],
	tfnet_send__proxy: "async",
	tfnet_send__sig: "vipp",
	tfnet_send: function (h, packet, len) {
		globalThis.tfnetCalls ??= {};
		globalThis.tfnetCalls.tfnet_send = (globalThis.tfnetCalls.tfnet_send | 0) + 1; // calls proxied to the page (for diagnostics)
		try {
			const p = TFNet.sockets.get(h)?.peers.get(TFNet.bytesToUuid(packet));
			if (p?.connected) p.dc.send(HEAPU8.slice(packet + 16, packet + len));
		} catch {
			// The channel closed in between: the packet is lost, as on any unreliable channel.
		} finally {
			_free(packet);
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
		const now = performance.now();
		while (s.inbox.length) {
			const [uuid, bytes, arrived] = s.inbox[0];
			if (at + 20 + bytes.length > cap) {
				if (at === 0) s.inbox.shift(); // can't ever fit: drop it (unreliable channel anyway)
				break;
			}
			s.inbox.shift();
			TFNet.time((TFNet.stats.wait ??= TFNet.timing()), now - arrived);
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
// for a connection. These are polled instead, so nothing ever calls back into .NET. Like the
// sockets above, each has a signal counter in wasm memory that the page bumps whenever it opens,
// gets a message or closes, so pollers only call in (and wait for the main thread) when it moved.
var LibraryTFWs = {
	$TFWs__postset:
		"TFWs.sockets = new Map();" +
		// Workers only report an error's message to the page; log the whole stack (wasm function
		// names included, unless stripped) so traps can be traced.
		"if (ENVIRONMENT_IS_PTHREAD) { self.addEventListener('error', (e) => console.error('[worker error] ' + (e.error && e.error.stack || e.message))); self.addEventListener('unhandledrejection', (e) => console.error('[worker rejection] ' + (e.reason && e.reason.stack || e.reason))); }",
	$TFWs: { sockets: null, next: 1 },

	// int tfws_open(const char* url, int32_t* signal): a handle (> 0), or 0 if the URL is invalid.
	// The page bumps *signal on every open, message and close, until tfws_free.
	tfws_open__deps: ["$TFWs"],
	tfws_open__proxy: "sync",
	tfws_open__sig: "ipp",
	tfws_open: function (url, signal) {
		globalThis.tfnetCalls ??= {};
		globalThis.tfnetCalls.tfws_open = (globalThis.tfnetCalls.tfws_open | 0) + 1; // calls proxied to the page (for diagnostics)
		const s = { ws: null, state: 0, code: 0, reason: "", inbox: [], signal };
		const bump = () => s.signal && Atomics.add(HEAP32, s.signal >> 2, 1);
		try {
			s.ws = new WebSocket(UTF8ToString(url));
		} catch {
			return 0;
		}
		s.ws.binaryType = "arraybuffer";
		s.ws.onopen = () => {
			s.state = 1;
			bump();
		};
		s.ws.onmessage = (e) => {
			s.inbox.push(typeof e.data === "string" ? [1, new TextEncoder().encode(e.data)] : [2, new Uint8Array(e.data)]);
			bump();
		};
		s.ws.onclose = (e) => {
			s.state = 3;
			s.code = e.code;
			s.reason = e.reason;
			bump();
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
		s.signal = 0; // the caller may free it now
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
