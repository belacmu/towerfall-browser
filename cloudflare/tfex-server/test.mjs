#!/usr/bin/env node
// Protocol tests for the TF.EX-compatible server, speaking to it the way TF.EX and matchbox do.
//   node test.mjs                      starts local.mjs on a free port and tests it
//   node test.mjs --url ws://127.0.0.1:8787   tests a running server (e.g. wrangler dev, or a deployment)
import { spawn } from "node:child_process";
import http from "node:http";
import https from "node:https";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
let base = args.includes("--url") ? args[args.indexOf("--url") + 1].replace(/\/+$/, "") : null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let child;

if (!base) {
	const port = 30000 + Math.floor(Math.random() * 20000);
	child = spawn(process.execPath, [fileURLToPath(new URL("./local.mjs", import.meta.url)), "--port", String(port)], { stdio: ["ignore", "pipe", "inherit"] });
	await new Promise((resolve) => child.stdout.once("data", resolve));
	base = `ws://127.0.0.1:${port}`;
}

// A client that queues what it receives, so tests can await the next message of a kind.
class Client {
	static async open(path, { binary = false } = {}) {
		const c = new Client();
		c.binary = binary;
		c.ws = new WebSocket(base + path);
		c.ws.binaryType = "arraybuffer";
		c.inbox = [];
		c.waiters = [];
		c.closed = null;
		c.ws.addEventListener("message", (e) => {
			const text = typeof e.data === "string" ? e.data : new TextDecoder().decode(e.data);
			c.inbox.push(text);
			c.flush();
		});
		c.ws.addEventListener("close", (e) => {
			c.closed = e.code;
			c.flush();
		});
		await new Promise((resolve, reject) => {
			c.ws.addEventListener("open", resolve);
			c.ws.addEventListener("error", reject);
		});
		return c;
	}

	flush() {
		for (const w of [...this.waiters]) {
			const i = this.inbox.findIndex(w.match);
			if (i >= 0) {
				this.waiters.splice(this.waiters.indexOf(w), 1);
				w.resolve(this.inbox.splice(i, 1)[0]);
			} else if (this.closed !== null) {
				this.waiters.splice(this.waiters.indexOf(w), 1);
				w.reject(new Error(`closed (${this.closed}) while waiting`));
			}
		}
	}

	// The next message whose text starts with {"tag" (TF.EX's own test), or that matches a function.
	next(tag, timeout = 3000) {
		const match = typeof tag === "function" ? tag : (t) => t.startsWith(`{"${tag}"`);
		return new Promise((resolve, reject) => {
			const w = { match, resolve: (t) => (clearTimeout(timer), resolve(JSON.parse(t))), reject };
			const timer = setTimeout(() => {
				this.waiters.splice(this.waiters.indexOf(w), 1);
				reject(new Error(`timed out waiting for ${typeof tag === "string" ? tag : "a message"}; inbox: ${this.inbox.join(" | ").slice(0, 400)}`));
			}, timeout);
			this.waiters.push(w);
			this.flush();
		});
	}

	// Nothing matching arrives within `ms`.
	async none(tag, ms = 300) {
		await sleep(ms);
		const found = this.inbox.find((t) => t.startsWith(`{"${tag}"`));
		if (found) throw new Error(`unexpected ${found.slice(0, 200)}`);
	}

	send(msg) {
		const text = typeof msg === "string" ? msg : JSON.stringify(msg);
		this.ws.send(this.binary ? new TextEncoder().encode(text) : text);
	}

	drain() {
		this.inbox.length = 0;
	}

	close() {
		this.ws.close();
	}
}

function assert(cond, message) {
	if (!cond) throw new Error(`assertion failed: ${message}`);
}
const eq = (a, b, what) => assert(JSON.stringify(a) === JSON.stringify(b), `${what}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);

// A raw handshake, for status codes (WebSocket clients can't set Origin).
function handshake(path, origin) {
	const url = new URL(base.replace(/^ws/, "http") + path);
	const headers = { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==" };
	if (origin) headers.Origin = origin;
	return new Promise((resolve, reject) => {
		const req = (url.protocol === "https:" ? https : http).request(url, { headers });
		req.on("upgrade", (res, socket) => {
			socket.destroy();
			resolve(res.statusCode);
		});
		req.on("response", (res) => {
			res.resume();
			resolve(res.statusCode);
		});
		req.on("error", reject);
		req.end();
	});
}

const uuid = () => crypto.randomUUID();
// /ws with the TF.EX version, as TF.EX connects (MATCHMAKING_URL); without one the server refuses (426).
const WS = "/ws?version=0.22.2";
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ---- Origins and routes ----

test("origins: desktop (none) and the site are let in, other pages aren't", async () => {
	eq(await handshake(WS), 101, "no Origin");
	eq(await handshake(WS, "https://belacmu.github.io"), 101, "the site");
	eq(await handshake(WS, "http://localhost:8080"), 101, "the dev server");
	eq(await handshake(WS, "http://127.0.0.1:8081"), 101, "another local port");
	eq(await handshake(WS, "http://localhost.example.com"), 403, "not local");
	eq(await handshake(`/room/xnet-abc?peer=${uuid()}`, "https://belacmu.github.io"), 101, "a lobby-free room");
	eq(await handshake("/ws"), 426, "no TF.EX version");
	eq(await handshake(WS, "https://example.com"), 403, "another page");
	eq(await handshake("/nope"), 404, "unknown path");
});

test("turn: ICE servers for the site's pages, with CORS; not for other pages", async () => {
	const turn = (origin) => fetch(base.replace(/^ws/, "http") + "/turn", { headers: { Origin: origin } });
	const res = await turn("https://belacmu.github.io");
	eq(res.status, 200, "the site");
	eq(res.headers.get("access-control-allow-origin"), "https://belacmu.github.io", "CORS");
	const { iceServers } = await res.json();
	const urls = iceServers.flatMap((s) => [].concat(s.urls));
	eq(urls.some((u) => u.startsWith("stun:")), true, "a STUN server");
	eq(urls.some((u) => /:53(\?|$)/.test(u)), false, "no port 53");
	for (const s of iceServers) if ([].concat(s.urls).some((u) => /^turns?:/.test(u))) eq(typeof s.credential, "string", "TURN credential");
	eq((await turn("https://example.com")).status, 403, "another page");
});

test("reports: the site's pages can send one; other pages, non-reports and huge bodies can't", async () => {
	const http = base.replace(/^ws/, "http");
	const send = (origin, body) => fetch(http + "/report", { method: "POST", headers: { Origin: origin, "Content-Type": "text/plain" }, body });
	const marker = `test-${Math.random()}`;
	const res = await send("https://belacmu.github.io", JSON.stringify({ kind: "online", marker, fps: 60 }));
	eq(res.status, 204, "accepted");
	eq((await send("https://belacmu.github.io", JSON.stringify({ kind: "online", marker: marker + "2", slowDownFromTicksAhead: 2 }))).status, 204, "accepted, with its setting");
	eq(res.headers.get("access-control-allow-origin"), "https://belacmu.github.io", "CORS");
	eq((await fetch(http + "/report", { method: "OPTIONS", headers: { Origin: "https://belacmu.github.io" } })).status, 204, "preflight");
	eq((await send("https://example.com", JSON.stringify({ kind: "online" }))).status, 403, "another page");
	eq((await send("https://belacmu.github.io", "not json")).status, 400, "not JSON");
	eq((await send("https://belacmu.github.io", JSON.stringify({ kind: "other" }))).status, 400, "not a report");
	eq((await send("https://belacmu.github.io", JSON.stringify({ kind: "solo", pad: "x".repeat(30000) }))).status, 413, "too large");
	if (child) {
		// (Locally /reports needs no key.)
		const { reports } = await (await fetch(http + "/reports")).json();
		eq(reports.find((r) => r.report.marker === marker)?.report.slowDownFromTicksAhead, 1, "listed; from before the setting was reported: 1");
		eq(reports.find((r) => r.report.marker === marker + "2")?.report.slowDownFromTicksAhead, 2, "listed with its setting");
	}
});

test("match reports: TF.EX's zips (desync / disconnect / crash) are kept and listed; not-zips are refused", async () => {
	const http = base.replace(/^ws/, "http");
	// An empty zip (its end record) plus a marker, like MatchReport.Upload's body.
	const marker = `m${Math.floor(Math.random() * 1e9)}`;
	const zip = new Uint8Array([0x50, 0x4b, 0x05, 0x06, ...new Array(18).fill(0), ...new TextEncoder().encode(marker)]);
	const send = (query, body, origin) => fetch(`${http}/report?${query}`, { method: "POST", body, headers: origin ? { Origin: origin } : {} });
	eq((await send(`group=ALICE-BOB&name=ALICE&kind=desync`, zip)).status, 201, "desktop / Switch (no Origin)");
	eq((await send(`group=ALICE-BOB&name=BOB&kind=disconnect`, zip, "https://belacmu.github.io")).status, 201, "the site's pages");
	eq((await send(`group=ALICE-BOB&name=EVE&kind=crash`, zip, "https://example.com")).status, 403, "another page");
	eq((await send(`group=ALICE-BOB&name=ALICE&kind=desync`, "not a zip")).status, 400, "not a zip");
	eq((await send(`group=ALICE-BOB&name=ALICE&kind=other`, zip)).status, 400, "another kind goes to the performance reports (and isn't one)");
	if (child) {
		const { reports } = await (await fetch(http + "/reports/match")).json();
		const mine = reports.filter((r) => r.group === "ALICE-BOB");
		eq(mine.slice(-2).map((r) => [r.kind, r.name, r.from]), [["desync", "ALICE", "client"], ["disconnect", "BOB", "page"]], "listed");
		const got = new Uint8Array(await (await fetch(`${http}/reports/match/${encodeURIComponent(mine.at(-1).key)}`)).arrayBuffer());
		eq(new TextDecoder().decode(got.slice(22)), marker, "the zip comes back as sent");
	}
});

test("reports: the Switch's (kind switch, no Origin) are taken, bigger and more often; only that kind without an Origin", async () => {
	const http = base.replace(/^ws/, "http");
	const send = (body, origin) => fetch(http + "/report", { method: "POST", headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) }, body });
	const marker = `switch-${Math.random()}`;
	eq((await send(JSON.stringify({ kind: "switch", marker, pad: "x".repeat(40000) }))).status, 204, "a 40 KB Switch report");
	eq((await send(JSON.stringify({ kind: "online", marker }))).status, 400, "a page's kind without an Origin");
	eq((await send(JSON.stringify({ kind: "switch" }), "https://belacmu.github.io")).status, 400, "the Switch's kind from a page");
	eq((await send(JSON.stringify({ kind: "switch" }), "https://example.com")).status, 403, "another page");
	eq((await send(JSON.stringify({ kind: "switch", pad: "x".repeat(70000) }))).status, 413, "over 64 KB");
	if (child) {
		const { reports } = await (await fetch(http + "/reports")).json();
		eq(reports.some((r) => r.report.marker === marker && r.report.kind === "switch"), true, "listed with the others");
	}
});

test("core: Switch reports have their own limits", async () => {
	const { parseReport, RateLimit, MAX_SWITCH_REPORT, SWITCH_PER_ADDRESS_PER_HOUR, PER_ADDRESS_PER_HOUR } = await import("./reports.js");
	assert(MAX_SWITCH_REPORT >= 64 * 1024 && SWITCH_PER_ADDRESS_PER_HOUR >= 600, "limits");
	assert(parseReport(JSON.stringify({ kind: "switch", pad: "x".repeat(50000) }), "switch"), "50 KB from the Switch");
	assert(!parseReport(JSON.stringify({ kind: "solo", pad: "x".repeat(50000) }), "page"), "not from a page");
	assert(!parseReport(JSON.stringify({ kind: "solo" }), "switch") && parseReport(JSON.stringify({ kind: "solo" })), "kinds by source");
	const limit = new RateLimit(SWITCH_PER_ADDRESS_PER_HOUR);
	let n = 0;
	while (limit.allow("1.2.3.4", clock) && n < 10000) n++;
	eq(n, SWITCH_PER_ADDRESS_PER_HOUR, "per hour");
	assert(PER_ADDRESS_PER_HOUR === 60, "pages unchanged");
});

// ---- Signaling (matchbox) ----

test("signaling: ids from ?peer=, NewPeer to those already in, signals relayed, PeerLeft", async () => {
	const room = `/room/xnet-r${Date.now()}`;
	const [a, b] = [uuid(), uuid()];
	const A = await Client.open(`${room}?peer=${a}`);
	eq(await A.next("IdAssigned"), { IdAssigned: a }, "A's id");
	const B = await Client.open(`${room}?peer=${b}`);
	eq(await B.next("IdAssigned"), { IdAssigned: b }, "B's id");
	eq(await A.next("NewPeer"), { NewPeer: b }, "A hears of B");
	await B.none("NewPeer");
	A.send({ Signal: { receiver: b, data: { Offer: "sdp-a" } } });
	eq(await B.next("Signal"), { Signal: { sender: a, data: { Offer: "sdp-a" } } }, "offer relayed");
	B.send({ Signal: { receiver: a, data: { IceCandidate: "null" } } });
	eq(await A.next("Signal"), { Signal: { sender: b, data: { IceCandidate: "null" } } }, "candidate relayed");
	B.send('"KeepAlive"');
	await A.none("Signal");
	B.close();
	eq(await A.next("PeerLeft"), { PeerLeft: b }, "A hears B left");
	A.close();
});

test("signaling: ping rooms are separate from match rooms; no ?peer= gets a random id", async () => {
	const id = `xnet-r${Date.now()}`;
	const [a, b] = [uuid(), uuid()];
	const A = await Client.open(`/room/${id}?peer=${a}`);
	await A.next("IdAssigned");
	const B = await Client.open(`/ping_measurement/${id}?peer=${b}`);
	await B.next("IdAssigned");
	await A.none("NewPeer");
	const C = await Client.open(`/ping_measurement/${id}`);
	const assigned = (await C.next("IdAssigned")).IdAssigned;
	assert(/^[0-9a-f-]{36}$/.test(assigned), "random id is a UUID");
	eq(await B.next("NewPeer"), { NewPeer: assigned }, "B hears of C");
	for (const c of [A, B, C]) c.close();
});

test("signaling: only a member of the lobby gets into its rooms (TF.EX's server)", async () => {
	const { A, B, lobby, host } = await privateLobby();
	eq(await handshake(`/room/${lobby.RoomId}?peer=${uuid()}`), 404, "a stranger");
	eq(await handshake(`/ping_measurement/${lobby.RoomId}`), 404, "no peer");
	const H = await Client.open(`/room/${lobby.RoomId}?peer=${host.RoomPeerId}`);
	eq(await H.next("IdAssigned"), { IdAssigned: host.RoomPeerId }, "the host");
	for (const c of [A, B, H]) c.close();
});

test("signaling: a peer id that isn't a UUID is refused", async () => {
	eq(await handshake(`/room/x${Date.now()}?peer=not-a-uuid`), 400, "refused");
});

// ---- Matchmaking (TF.EX's /ws) ----

// What TF.EX's lobby builder sends (MainMenu.cs, LobbyBuilder confirm).
function builtLobby(name, kind = "Private") {
	return {
		Name: name, RoomId: uuid(), MaxPlayers: 2, Players: [{ Name: name, ArcherIndex: 0, ArcherAltIndex: 0, Ready: false, RoomPeerId: "", IsHost: true, Seat: 0, Team: -1, CustomArcherId: "", ArcherMods: [], CustomVariants: [], UseInstantReplay: false, HaveModifiedGameFiles: false, Platform: "Linux", InputDelay: null }],
		Spectators: [], GameData: { MapId: -1, Mode: 3, MatchLength: 2, Variants: [], Seed: 0, BestOf: 0 }, EndGameChoice: [],
		Mods: [{ Name: "TF.EX", Data: { Version: "0.19.1" } }], InGame: false, Kind: kind, JoinCode: "", Series: null, MissingVariants: [],
	};
}

async function tfex(name) {
	const c = await Client.open(WS, { binary: true });
	eq(await c.next("KeepAlive"), { KeepAlive: {} }, "KeepAlive first");
	c.send({ KeepAlive: {} });
	c.send({ Identify: { player_id: `local:${uuid()}`, name } });
	return c;
}

// A private lobby, as in the browser test: A creates, B joins with the code, both ready, A starts.
async function privateLobby() {
	const A = await tfex("ALICE");
	const sent = builtLobby("ALICE");
	A.send({ CreateLobby: { lobby: sent } });
	const created = (await A.next("CreateLobbyResponse")).CreateLobbyResponse;
	assert(created.success, "created");
	const lobby = created.lobby;
	eq(lobby.RoomId, sent.RoomId, "the client's room id is kept");
	assert(/^[A-HJ-NP-Z2-9]{5}$/.test(lobby.JoinCode), `join code ${lobby.JoinCode}`);
	const host = lobby.Players[0];
	assert(host.IsHost && /^[0-9a-f-]{36}$/.test(host.RoomPeerId), "host has a peer id");
	const B = await tfex("BOB");
	B.send({ JoinPrivate: { code: lobby.JoinCode.toLowerCase(), name: "BOB", is_player: true } });
	const joined = (await B.next("PrivateJoinResult")).PrivateJoinResult;
	assert(joined.success, "joined");
	const bob = joined.lobby.Players.find((p) => p.RoomPeerId === joined.room_peer_id);
	assert(bob && !bob.IsHost && bob.Seat === 1, "B is in the lobby at seat 1");
	const update = (await A.next("LobbyUpdate")).LobbyUpdate.lobby;
	eq(update.Players.length, 2, "A sees B");
	eq((await B.next("LobbyUpdate")).LobbyUpdate.lobby.Players.length, 2, "B gets the lobby too");
	return { A, B, lobby, host, bob, peerB: joined.room_peer_id };
}

test("matchmaking: private lobby, archer select, start", async () => {
	const { A, B, host, bob } = await privateLobby();
	B.send({ UpdatePlayer: { player: { ...bob, CustomVariants: [], UseInstantReplay: true } } });
	await A.next("LobbyUpdate");
	await B.next("LobbyUpdate");
	// Archer select: each picks and readies (RollCallElement sends UpdatePlayer).
	A.send({ UpdatePlayer: { player: { ...host, ArcherIndex: 3, Ready: true, IsHost: false, Seat: 3, RoomPeerId: "spoofed" } } });
	let l = (await B.next("LobbyUpdate")).LobbyUpdate.lobby;
	const a = l.Players.find((p) => p.Name === "ALICE");
	assert(a.Ready && a.ArcherIndex === 3, "A ready with archer 3");
	assert(a.IsHost && a.Seat === 0 && a.RoomPeerId === host.RoomPeerId, "server keeps host, seat and peer id");
	await A.next("LobbyUpdate");
	B.send({ UpdatePlayer: { player: { ...bob, ArcherIndex: 1, Ready: true } } });
	await A.next("LobbyUpdate");
	await B.next("LobbyUpdate");
	A.send({ StartLobbyChoice: {} });
	await B.none("StartLobby"); // the connection check isn't over
	B.send({ PeerMeasured: { room_peer_id: host.RoomPeerId } });
	l = (await A.next("LobbyUpdate")).LobbyUpdate.lobby;
	assert(!l.IsCheckingConnections, "checked");
	B.send({ StartLobbyChoice: {} }); // only the host starts
	await A.none("StartLobby");
	A.send({ StartLobbyChoice: {} });
	await A.next("StartLobby");
	await B.next("StartLobby");
	A.close();
	B.close();
});

test("matchmaking: bad codes, full lobbies, host leaving", async () => {
	const { A, B, lobby } = await privateLobby();
	const X = await tfex("XAVIER");
	X.send({ JoinPrivate: { code: "ZZZZZ", name: "XAVIER", is_player: true } });
	eq((await X.next("PrivateJoinResult")).PrivateJoinResult.message, "Invalid or expired code", "unknown code refused");
	const Y = await tfex("YVES");
	Y.send({ JoinPrivate: { code: lobby.JoinCode, name: "YVES", is_player: true } });
	eq((await Y.next("PrivateJoinResult")).PrivateJoinResult.message, `Lobby ${lobby.RoomId} is full`, "full lobby refused");
	const C = await tfex("CAROL");
	C.send({ JoinPrivate: { code: lobby.JoinCode, name: "CAROL", is_player: false } });
	const spect = (await C.next("PrivateJoinResult")).PrivateJoinResult;
	assert(spect.success && spect.lobby.Spectators.length === 1, "spectator joins");
	A.close(); // the host leaves
	const hostless = (t) => t.startsWith('{"LobbyUpdate"') && !JSON.parse(t).LobbyUpdate.lobby.Players.some((p) => p.IsHost);
	const l = (await B.next(hostless)).LobbyUpdate.lobby;
	eq(l.Players.length, 1, "B sees a lobby without host");
	await C.next(hostless);
	const D = await tfex("DAVE");
	D.send({ JoinPrivate: { code: lobby.JoinCode, name: "DAVE", is_player: false } });
	assert(!(await D.next("PrivateJoinResult")).PrivateJoinResult.success, "lobby is gone");
	for (const c of [B, C, D, X, Y]) c.close();
});

test("matchmaking: public lobbies are listed and joined by room id; skins relay", async () => {
	const A = await tfex("ALICE");
	const sent = builtLobby("ALICE", "Standard");
	A.send({ CreateLobby: { lobby: sent } });
	const lobby = (await A.next("CreateLobbyResponse")).CreateLobbyResponse.lobby;
	eq(lobby.JoinCode, null, "no code for public lobbies");
	const B = await tfex("BOB");
	B.send({ GetLobbies: {} });
	const listed = (await B.next("GetLobbiesResponse")).GetLobbiesResponse.lobbies;
	const entry = listed.find((l) => l.RoomId === lobby.RoomId);
	assert(entry, "listed");
	eq(entry.Players.map((p) => [p.Name, p.RoomPeerId]), [["ALICE", ""]], "listed without peer ids");
	eq(entry.Mods, lobby.Mods, "with its mods (TF.EX checks WiderSet's)");
	B.send({ JoinLobby: { room_id: lobby.RoomId, name: "BOB", is_player: true } });
	const joined = (await B.next("JoinLobbyResponse")).JoinLobbyResponse;
	assert(joined.success && joined.room_peer_id, "joined");
	await A.next("LobbyUpdate");
	await B.next("LobbyUpdate");
	const chunk = { bundle_id: "b", custom_archer_id: "x", chunk_index: 0, chunk_count: 1, data: "AAAA" };
	A.send({ SkinChunk: { chunk } });
	eq((await B.next("SkinChunk")).SkinChunk, { chunk, from: lobby.Players[0].RoomPeerId }, "skin relayed");
	eq((await A.next("SkinChunk")).SkinChunk.from, lobby.Players[0].RoomPeerId, "to the sender too");
	B.send({ LeaveLobby: {} });
	assert((await B.next("LeaveLobbyResponse")).LeaveLobbyResponse.success, "left");
	eq((await A.next("LobbyUpdate")).LobbyUpdate.lobby.Players.length, 1, "A alone again");
	A.close();
	B.close();
});

// ---- Matchmaker in-process, with simulated time (votes, series, quick play, hibernation) ----

class FakeConn {
	static n = 0;
	constructor(mm, name, ip = null, version = null) {
		this.id = `f${FakeConn.n++}`;
		this.state = {};
		this.inbox = [];
		this.mm = mm;
		this.closed = false;
		mm.open(this, clock, ip, version);
		if (!this.closed) this.do({ Identify: { player_id: `local:${uuid()}`, name } });
	}
	send(text) {
		this.inbox.push(text);
	}
	close() {
		this.closed = true;
	}
	save() {}
	do(msg) {
		this.mm.message(this, JSON.stringify(msg), clock);
	}
	// Every message of a kind received since the last take, oldest first.
	take(tag) {
		const found = this.inbox.filter((t) => t.startsWith(`{"${tag}"`)).map((t) => JSON.parse(t)[tag]);
		this.inbox = this.inbox.filter((t) => !t.startsWith(`{"${tag}"`));
		return found;
	}
	last(tag) {
		return this.take(tag).at(-1);
	}
	tags() {
		return this.inbox.map((t) => t.slice(2, t.indexOf('"', 2)));
	}
}

let clock = 1_000_000;
const tick = (mm, ms) => {
	clock += ms;
	mm.wake(clock);
};

async function core(options = {}) {
	const { Matchmaker } = await import("./matchmaker.js");
	return new Matchmaker(options);
}

const peerOf = (lobby, name) => lobby.Players.find((p) => p.Name === name).RoomPeerId;
const roomOf = (mm) => [...mm.rooms.values()].at(-1);

// Every device measures every other one (TF.EX's lobby ping measurement), so the connection check is over.
function measureAll(all) {
	const lobby = roomOf(all[0].mm).lobby;
	for (const c of all) for (const peer of new Set(lobby.Players.map((p) => p.RoomPeerId))) if (peer !== c.state.peer) c.do({ PeerMeasured: { room_peer_id: peer } });
}

// A private lobby whose players have picked and are ready, connections checked.
function readyLobby(mm, gameData = {}, maxPlayers = 2, { teams = maxPlayers === 4 } = {}) {
	const A = new FakeConn(mm, "ALICE");
	const sent = builtLobby("ALICE");
	Object.assign(sent.GameData, gameData);
	sent.MaxPlayers = maxPlayers;
	A.do({ CreateLobby: { lobby: sent } });
	const lobby = A.last("CreateLobbyResponse").lobby;
	const others = [];
	for (let i = 1; i < maxPlayers; i++) {
		const c = new FakeConn(mm, `P${i}`);
		c.do({ JoinPrivate: { code: lobby.JoinCode, name: `P${i}`, is_player: true } });
		assert(c.last("PrivateJoinResult").success, "joined");
		others.push(c);
	}
	const all = [A, ...others];
	for (const [i, c] of all.entries()) {
		const self = roomOf(mm).lobby.Players.find((p) => p.RoomPeerId === c.state.peer);
		c.do({ UpdatePlayer: { player: { ...self, Ready: true, ArcherIndex: i, Team: teams ? i % 2 : -1 } } });
	}
	measureAll(all);
	return { A, others, all, lobby };
}

// ...and started by the host.
function started(mm, gameData = {}, maxPlayers = 2, options) {
	const { A, others, lobby } = readyLobby(mm, gameData, maxPlayers, options);
	const all = [A, ...others];
	for (const c of all) c.inbox.length = 0;
	A.do({ StartLobbyChoice: {} });
	for (const c of all) assert(c.take("StartLobby").length === 1, `${c.state.name} got StartLobby`);
	return { A, B: others[0], all, roomId: lobby.RoomId };
}

const ended = (all, winner = 0, scores = [5, 2]) => {
	for (const c of all) c.do({ MatchEnded: { winner_seat: winner, frame: 1000, checksum: "ab", scores } });
};

test("core: lobby fields as TF.EX's server sends them; MatchPlayers is the match's players, cleared at archer select", async () => {
	const mm = await core();
	const { A, B, all } = started(mm);
	const l = roomOf(mm).lobby;
	eq([l.RelayedPairs, l.IsCheckingConnections, l.IsReportEnabled, l.RankedSeats, l.EndGameChoice], [[], false, true, [], []], "fields");
	assert(/^[A-HJ-NP-Z2-9]{5}$/.test(l.JoinCode), "a private lobby's code");
	assert(l.GameData.Seed >= 0 && l.GameData.Seed < 100000, "seed 0..100000");
	eq(l.MatchPlayers.map((p) => p.Name), ["ALICE", "P1"], "MatchPlayers at the start");
	ended(all);
	A.do({ RematchLobbyChoice: {} });
	B.do({ ArcherSelectChoice: {} });
	eq(B.last("LobbyUpdate").lobby.MatchPlayers, [], "cleared at archer select");
	const P = new FakeConn(mm, "PUB");
	P.do({ CreateLobby: { lobby: builtLobby("PUB", "Standard") } });
	const pub = P.last("CreateLobbyResponse").lobby;
	eq([pub.JoinCode, pub.EndGameChoice], [null, null], "no code for a public lobby; no votes before a match");
});

test("core: TF.EX 0.22's StartsWithoutHat is passed on (true / false), anything else is null", async () => {
	const mm = await core();
	const { A, others } = readyLobby(mm);
	const B = others[0];
	const own = (c) => roomOf(mm).lobby.Players.find((p) => p.RoomPeerId === c.state.peer);
	A.do({ UpdatePlayer: { player: { ...own(A), StartsWithoutHat: true } } });
	B.do({ UpdatePlayer: { player: { ...own(B), StartsWithoutHat: "yes" } } });
	eq(B.last("LobbyUpdate").lobby.Players.map((p) => p.StartsWithoutHat), [true, null], "StartsWithoutHat");
	A.do({ UpdatePlayer: { player: { ...own(A), StartsWithoutHat: false } } });
	eq(B.last("LobbyUpdate").lobby.Players[0].StartsWithoutHat, false, "false stays false");
});

test("core: the connection check runs in the lobby: each pair until one PeerMeasured either way; the host can't start meanwhile", async () => {
	const mm = await core();
	const A = new FakeConn(mm, "ALICE");
	A.do({ CreateLobby: { lobby: builtLobby("ALICE") } });
	const { JoinCode } = A.last("CreateLobbyResponse").lobby;
	const B = new FakeConn(mm, "BOB");
	B.do({ JoinPrivate: { code: JoinCode, name: "BOB", is_player: true } });
	let l = B.last("PrivateJoinResult").lobby;
	assert(l.IsCheckingConnections, "checking as soon as there's a pair");
	for (const c of [A, B]) {
		const self = roomOf(mm).lobby.Players.find((p) => p.RoomPeerId === c.state.peer);
		c.do({ UpdatePlayer: { player: { ...self, Ready: true } } });
	}
	A.inbox.length = 0;
	A.do({ StartLobbyChoice: {} });
	assert(!A.tags().includes("StartLobby"), "refused while checking");
	B.do({ PeerMeasured: { room_peer_id: "not-a-player" } });
	B.do({ PeerMeasured: { room_peer_id: peerOf(l, "ALICE") } });
	l = A.last("LobbyUpdate").lobby;
	assert(!l.IsCheckingConnections, "one direction settles the pair; everyone ready, so the lobby goes out");
	A.do({ StartLobbyChoice: {} });
	eq(A.tags(), ["StartLobby"], "StartLobby alone (no LobbyUpdate before it, as TF.EX's server)");
	assert(roomOf(mm).lobby.InGame, "in game");
});

test("core: a pair that never measures fails after 10 s and the check ends (no relay on Workers: RelayedPairs stays empty)", async () => {
	const mm = await core();
	const A = new FakeConn(mm, "ALICE");
	A.do({ CreateLobby: { lobby: builtLobby("ALICE") } });
	const B = new FakeConn(mm, "BOB");
	B.do({ JoinPrivate: { code: A.last("CreateLobbyResponse").lobby.JoinCode, name: "BOB", is_player: true } });
	assert(mm.nextWake() <= clock + 10_000, "a wake for the deadline");
	tick(mm, 9_000);
	assert(roomOf(mm).lobby.IsCheckingConnections, "still checking");
	tick(mm, 1_100);
	const l = roomOf(mm).lobby;
	eq([l.IsCheckingConnections, l.RelayedPairs], [false, []], "check over, nothing relayed");
	A.inbox.length = 0;
	A.do({ StartLobbyChoice: {} });
	assert(A.tags().includes("StartLobby"), "the host can start");
});

test("core: the server leaves the ready check to the client; only the host starts", async () => {
	const mm = await core();
	const A = new FakeConn(mm, "ALICE");
	A.do({ CreateLobby: { lobby: builtLobby("ALICE") } });
	const B = new FakeConn(mm, "BOB");
	B.do({ JoinPrivate: { code: A.last("CreateLobbyResponse").lobby.JoinCode, name: "BOB", is_player: true } });
	measureAll([A, B]);
	B.inbox.length = 0;
	B.do({ StartLobbyChoice: {} });
	assert(!B.tags().includes("StartLobby"), "not the host");
	A.do({ StartLobbyChoice: {} });
	assert(B.tags().includes("StartLobby"), "the host's start goes through (TF.EX's AreAllPlayersReady is the client's)");
});

test("core: everyone votes rematch -> everyone un-ready, a new seed, MatchPlayers again; LobbyUpdate, RematchLobby", async () => {
	let n = 0;
	const mm = await core({ random: () => ((n += 0.137) % 1) });
	const { A, B, all } = started(mm);
	const seed = roomOf(mm).lobby.GameData.Seed;
	ended(all);
	A.do({ RematchLobbyChoice: {} });
	const vote = B.last("LobbyUpdate").lobby;
	eq(vote.EndGameChoice.map((v) => [v.RoomPeerId, v.Choice]), [[A.state.peer, "Rematch"]], "A's vote shows");
	for (const c of all) c.inbox.length = 0;
	B.do({ RematchLobbyChoice: {} });
	for (const c of all) eq(c.tags(), ["LobbyUpdate", "RematchLobby", "LobbyUpdate"], "order");
	const l = A.last("LobbyUpdate").lobby;
	assert(l.InGame && l.Players.every((p) => !p.Ready), "in game, everyone un-ready (TF.EX's server resets the lobby)");
	assert(l.GameData.Seed !== seed && l.EndGameChoice.length === 0, "new seed, votes cleared");
	eq(l.MatchPlayers.map((p) => p.Ready), [false, false], "MatchPlayers taken again");
});

test("core: an archer-select vote, or the 30 s window running out, returns to archer select", async () => {
	const mm = await core();
	let { A, B, all } = started(mm);
	ended(all);
	A.do({ RematchLobbyChoice: {} });
	for (const c of all) c.inbox.length = 0;
	B.do({ ArcherSelectChoice: {} });
	eq(B.tags(), ["LobbyUpdate", "ArcherSelectLobby", "LobbyUpdate"], "the lobby before ArcherSelectLobby");
	const l = B.last("LobbyUpdate").lobby;
	assert(!l.InGame && l.Players.every((p) => !p.Ready), "back in the lobby, unready");

	({ A, B, all } = started(await core()));
	const mm2 = A.mm;
	A.do({ RematchLobbyChoice: {} });
	tick(mm2, 40_000);
	assert(!B.tags().includes("ArcherSelectLobby"), "no window before a MatchEnded");
	A.do({ MatchEnded: { winner_seat: 1, frame: 1, checksum: null, scores: [0, 5] } });
	tick(mm2, 25_000);
	assert(!B.tags().includes("ArcherSelectLobby"), "not yet");
	tick(mm2, 6_000);
	assert(B.tags().includes("ArcherSelectLobby"), "timed out to archer select");
	assert(mm2.nextWake() - clock <= 30_000, "only keep-alives left");
});

test("core: a player leaving mid-match doesn't start the vote; the window from MatchEnded decides", async () => {
	const mm = await core();
	const { A, all } = started(mm, { Mode: 3 }, 3);
	mm.close(all[2], clock);
	for (const c of all) c.inbox.length = 0;
	tick(mm, 40_000);
	assert(!A.tags().includes("ArcherSelectLobby"), "nothing without a MatchEnded");
	ended(all.slice(0, 2));
	for (const c of all.slice(0, 2)) c.do({ RematchLobbyChoice: {} });
	assert(A.tags().includes("RematchLobby"), "the two left rematch");
});

test("core: match results wait for every device and are compared; winner_seat is a lobby seat", async () => {
	const mm = await core();
	// Seats 0 and 2 (a seat in between left): a 1v1 series between them.
	const A = new FakeConn(mm, "ALICE");
	const sent = builtLobby("ALICE");
	Object.assign(sent, { MaxPlayers: 3 });
	sent.GameData.BestOf = 3;
	A.do({ CreateLobby: { lobby: sent } });
	const { JoinCode } = A.last("CreateLobbyResponse").lobby;
	const [B, C] = ["BOB", "CAROL"].map((name) => {
		const c = new FakeConn(mm, name);
		c.do({ JoinPrivate: { code: JoinCode, name, is_player: true } });
		return c;
	});
	B.do({ LeaveLobby: {} });
	eq(roomOf(mm).lobby.Players.map((p) => p.Seat), [0, 2], "seats 0 and 2");
	measureAll([A, C]);
	A.do({ StartLobbyChoice: {} });
	const series = () => roomOf(mm).lobby.Series;
	eq(series().Sides, [[0], [2]], "sides by seat");
	A.do({ MatchEnded: { winner_seat: 2, frame: 900, checksum: "x", scores: [1, 0, 5] } });
	eq(series().Games.length, 0, "one device's report isn't enough");
	C.do({ MatchEnded: { winner_seat: 2, frame: 900, checksum: "x", scores: [1, 0, 5] } });
	eq([series().Games[0].WinnerSide, series().PickerSide], [1, 0], "seat 2 won: side 1; side 0 picks");
});

test("core: match results that disagree abort the series (RESULT MISMATCH), then archer select", async () => {
	const mm = await core();
	const { A, B, all } = started(mm, { BestOf: 3 });
	A.do({ MatchEnded: { winner_seat: 0, frame: 900, checksum: "x", scores: [5, 2] } });
	B.do({ MatchEnded: { winner_seat: 1, frame: 900, checksum: "y", scores: [2, 5] } });
	eq([roomOf(mm).lobby.Series.Status, roomOf(mm).lobby.Series.AbortReason], ["Aborted", "RESULT MISMATCH"], "aborted");
	for (const c of all) c.do({ SeriesContinueChoice: {} });
	assert(A.tags().includes("ArcherSelectLobby"), "an aborted series goes back to archer select");
});

test("core: a best-of-3 series (result, loser picks, auto start, finish, restart)", async () => {
	const mm = await core();
	const { A, B, all } = started(mm, { BestOf: 3 });
	let l = roomOf(mm).lobby;
	const first = l.GameData.MapId;
	assert(first >= 0 && first < 16 && l.Series.AwaitingResult, "first tower drawn");
	ended(all, 0, [5, 2]);
	for (const c of all) c.do({ SeriesContinueChoice: {} });
	assert(A.tags().includes("SeriesLobby"), "series screen");
	l = A.last("LobbyUpdate").lobby;
	eq([l.Series.Games.length, l.Series.PickerSide, l.InGame], [1, 1, false], "game 1 to side 0; side 1 picks");
	A.do({ SeriesPickMap: { map_id: (first + 1) % 16 } });
	assert(roomOf(mm).lobby.Series.Picks.length === 0, "not A's pick");
	B.do({ SeriesPickMap: { map_id: first } });
	assert(roomOf(mm).lobby.Series.NextMapId === null, "a played tower is refused");
	B.do({ SeriesPickMap: { map_id: (first + 1) % 16 } });
	eq(roomOf(mm).lobby.Series.NextMapId, (first + 1) % 16, "B's pick is next");
	for (const c of all) c.inbox.length = 0;
	for (const c of all) c.do({ UpdatePlayer: { player: { ...roomOf(mm).lobby.Players.find((p) => p.RoomPeerId === c.state.peer), Ready: true } } });
	for (const c of all) assert(c.tags().includes("StartLobby"), "starts by itself once everyone is ready");
	ended(all, 0, [5, 3]);
	for (const c of all) c.do({ SeriesContinueChoice: {} });
	l = A.last("LobbyUpdate").lobby;
	eq([l.Series.Status, l.Series.WinnerSide], ["Finished", 0], "won 2-0");
	for (const c of all) c.inbox.length = 0;
	for (const c of all) c.do({ UpdatePlayer: { player: { ...roomOf(mm).lobby.Players.find((p) => p.RoomPeerId === c.state.peer), Ready: true } } });
	assert(A.tags().includes("StartLobby") && roomOf(mm).lobby.Series.Games.length === 0, "a finished series restarts when everyone is ready");
});

test("core: a series is a 1v1 or a 2v2 team deathmatch", async () => {
	const mm = await core();
	const ffa = readyLobby(mm, { BestOf: 3, Mode: 3 }, 3);
	ffa.A.inbox.length = 0;
	ffa.A.do({ StartLobbyChoice: {} });
	assert(!ffa.A.tags().includes("StartLobby"), "a 3-player series is refused");
	const teams = started(await core(), { BestOf: 3, Mode: 5 }, 4);
	eq(roomOf(teams.A.mm).lobby.Series.Sides, [[0, 2], [1, 3]], "2v2 sides by team");
});

test("core: the series screen starts by itself after 60 s; a player leaving aborts the series", async () => {
	const mm = await core();
	const { A, B, all } = started(mm, { BestOf: 3 });
	ended(all);
	for (const c of all) c.do({ SeriesContinueChoice: {} });
	for (const c of all) c.inbox.length = 0;
	tick(mm, 61_000);
	assert(A.tags().includes("StartLobby"), "started after 60 s");
	const series = roomOf(mm).lobby.Series;
	assert(series.AwaitingResult && series.Games.length === 1, "game 2 on a drawn tower");
	mm.close(B, clock);
	eq([roomOf(mm).lobby.Series.Status, roomOf(mm).lobby.Series.AbortReason], ["Aborted", "PLAYER LEFT"], "aborted");
});

test("core: settings changes un-ready everyone, clear the series, keep the seed; MaxPlayers 2..4 and never under the players", async () => {
	const mm = await core();
	const { A, all } = readyLobby(mm, {}, 3);
	const seed = roomOf(mm).lobby.GameData.Seed;
	roomOf(mm).lobby.Series = { Status: "Finished" };
	A.do({ UpdateLobbySettings: { max_players: 1, game_data: { MapId: 3, Mode: 5, MatchLength: 1, Variants: ["V"], Seed: 1, BestOf: 3 }, mods: [] } });
	const l = A.last("LobbyUpdate").lobby;
	eq([l.MaxPlayers, l.GameData.MapId, l.GameData.Seed, l.GameData.BestOf, l.Series], [3, 3, seed, 3, null], "applied (BestOf can change)");
	assert(l.Players.every((p) => !p.Ready), "everyone un-ready");
	all[1].do({ UpdateLobbySettings: { max_players: 4, game_data: l.GameData, mods: [] } });
	eq(roomOf(mm).lobby.MaxPlayers, 3, "only the host");
	eq(new Set(l.Players.map((p) => p.Seat)).size, 3, "seats unique");
});

test("core: guests (local_players, TF.EX v0.28.0): seated after their device, UpdatePlayer by seat, one device counts once", async () => {
	const mm = await core();
	const A = new FakeConn(mm, "ALICE");
	const sent = builtLobby("ALICE");
	sent.MaxPlayers = 4;
	A.do({ CreateLobby: { lobby: { ...sent, RoomId: "r4" }, local_players: 4 } });
	eq(A.last("CreateLobbyResponse").message, "Invalid local player count", "at most 3 per device");
	A.do({ CreateLobby: { lobby: { ...sent, RoomId: "r2", MaxPlayers: 2 }, local_players: 2 } });
	eq(A.last("CreateLobbyResponse").message, "No room left for another player", "room for another device");
	A.do({ CreateLobby: { lobby: sent, local_players: 2 } });
	let l = A.last("CreateLobbyResponse").lobby;
	const { JoinCode } = l;
	eq(l.Players.map((p) => [p.Name, p.Seat, p.IsHost, p.LocalIndex, p.RoomPeerId === A.state.peer]), [["ALICE", 0, true, 0, true], ["ALICE 2", 1, false, 1, true]], "the guest on A's device");
	A.do({ StartLobbyChoice: {} });
	assert(!roomOf(mm).lobby.InGame, "one device can't start");
	A.do({ UpdateLobbySettings: { max_players: 2, game_data: l.GameData, mods: [] } });
	eq(roomOf(mm).lobby.MaxPlayers, 3, "room for another device kept");
	const C = new FakeConn(mm, "CARL");
	C.do({ JoinPrivate: { code: JoinCode, name: "CARL", is_player: true, local_players: 2 } });
	eq(C.last("PrivateJoinResult").message, `Lobby ${roomOf(mm).lobby.RoomId} is full`, "a seat per local player");
	A.do({ UpdateLobbySettings: { max_players: 4, game_data: l.GameData, mods: [] } });
	const B = new FakeConn(mm, "BOB");
	clock += 3_000;
	B.do({ JoinPrivate: { code: JoinCode, name: "BOB", is_player: true } });
	eq(B.last("PrivateJoinResult").lobby.Players.at(-1).Seat, 2, "B after them");
	A.do({ PeerMeasured: { room_peer_id: B.state.peer } });
	assert(!roomOf(mm).lobby.IsCheckingConnections, "one measurement between the two devices settles it");
	A.do({ UpdatePlayer: { player: { ...roomOf(mm).lobby.Players[1], Name: "SPOOF", IsHost: true, ArcherIndex: 4, Ready: true } } });
	l = A.last("LobbyUpdate").lobby;
	eq([l.Players[0].ArcherIndex, l.Players[1].ArcherIndex, l.Players[1].Name, l.Players[1].IsHost, l.Players[1].LocalIndex], [0, 4, "ALICE 2", false, 1], "UpdatePlayer goes to the sent seat; a guest keeps its name");
	A.do({ StartLobbyChoice: {} });
	A.do({ MatchEnded: { winner_seat: 2, frame: 1, checksum: null, scores: [0, 0, 5] } });
	B.do({ MatchEnded: { winner_seat: 2, frame: 1, checksum: null, scores: [0, 0, 5] } });
	assert(roomOf(mm).reports === null, "two devices, two reports: compared");
	for (const c of [A, B]) c.do({ ArcherSelectChoice: {} });
	B.do({ LeaveLobby: {} });
	mm.close(A, clock);
	eq(mm.rooms.size, 0, "the device leaving takes its guests along");
});

test("core: quick play pairs devices whose seats fit; the host is never a guest", async () => {
	const mm = await core();
	const T = new FakeConn(mm, "TRIO");
	T.do({ EnterQuickPlay: { name: "TRIO", is_wide: false, local_players: 3 } });
	const D = new FakeConn(mm, "DUO");
	D.do({ EnterQuickPlay: { name: "DUO", is_wide: false, local_players: 2 } });
	assert(!D.take("QuickPlayMatchFound").length, "3 + 2 doesn't fit");
	const S = new FakeConn(mm, "SOLO");
	S.do({ EnterQuickPlay: { name: "SOLO", is_wide: false } });
	const l = S.last("QuickPlayMatchFound").lobby;
	eq(l.Players.map((p) => [p.Name, p.LocalIndex, p.IsHost]), [["TRIO", 0, true], ["TRIO 2", 1, false], ["TRIO 3", 2, false], ["SOLO", 0, false]], "the trio and the solo");
	mm.close(T, clock);
	eq(roomOf(mm).lobby.Players.map((p) => [p.Name, p.IsHost]), [["SOLO", true], ["DUO", false], ["DUO 2", false]], "the trio left with its guests; the waiting duo fits now");
});

test("core: spectators join mid-match (SpectatorJoined to the host only); host leaving closes the lobby", async () => {
	const mm = await core();
	const { A, B, roomId } = started(mm);
	const code = roomOf(mm).lobby.JoinCode;
	const S = new FakeConn(mm, "SPEC");
	S.do({ JoinPrivate: { code, name: "SPEC", is_player: false } });
	const result = S.last("PrivateJoinResult");
	assert(result.success && result.lobby.Spectators.length === 1 && result.lobby.InGame, "spectator joined an InGame lobby");
	eq(A.last("SpectatorJoined"), { room_peer_id: result.room_peer_id }, "host told");
	assert(!B.take("SpectatorJoined").length, "only the host");
	const P = new FakeConn(mm, "LATE");
	clock += 3_000;
	P.do({ JoinPrivate: { code, name: "LATE", is_player: true } });
	eq(P.last("PrivateJoinResult").message, `Lobby ${roomId} is full`, "no joining as a player");
	mm.close(A, clock);
	assert(!B.last("LobbyUpdate").lobby.Players.some((p) => p.IsHost), "hostless lobby sent");
	assert(!mm.rooms.has(roomId) && !B.state.roomId && !S.state.roomId, "lobby gone, members detached");
});

test("core: joining: messages as TF.EX's server words them; one private-code try every 3 s", async () => {
	const mm = await core();
	const A = new FakeConn(mm, "ALICE");
	A.do({ CreateLobby: { lobby: builtLobby("ALICE") } });
	const lobby = A.last("CreateLobbyResponse").lobby;
	const G = new FakeConn(mm, "GUESS");
	G.do({ JoinPrivate: { code: "ZZZZZ", name: "G", is_player: true } });
	eq(G.last("PrivateJoinResult").message, "Invalid or expired code", "bad code");
	G.do({ JoinPrivate: { code: lobby.JoinCode, name: "G", is_player: true } });
	eq(G.last("PrivateJoinResult").message, "Too many attempts, wait a moment", "within 3 s");
	clock += 3_000;
	G.do({ JoinPrivate: { code: ` ${lobby.JoinCode.toLowerCase()} `, name: "G", is_player: true } });
	assert(G.last("PrivateJoinResult").success, "a sloppy code later");
	const H = new FakeConn(mm, "H");
	H.do({ JoinPrivate: { code: lobby.JoinCode, name: "H", is_player: true } });
	eq(H.last("PrivateJoinResult").message, `Lobby ${lobby.RoomId} is full`, "full");
	H.do({ JoinLobby: { room_id: "nope", name: "H", is_player: true } });
	eq(H.last("JoinLobbyResponse").message, "Lobby nope not found", "unknown room");
	H.do({ JoinLobby: { room_id: lobby.RoomId, name: "H", is_player: false } });
	assert(H.last("JoinLobbyResponse").success, "a private lobby can be joined by room id too (as TF.EX's server allows)");
	A.do({ CreateLobby: { lobby: { ...builtLobby("X"), Kind: "Ranked" } } });
	eq(A.last("CreateLobbyResponse").message, "Ranked lobbies are automated", "no ranked lobbies by hand");
});

test("core: the lobby list: open Standard lobbies, running matches (quick play too), never private; peer ids hidden", async () => {
	const mm = await core();
	const open = new FakeConn(mm, "OPEN");
	open.do({ CreateLobby: { lobby: builtLobby("OPEN", "Standard") } });
	const full = started(mm, {}, 2);
	const priv = roomOf(mm).lobby.RoomId;
	const F = new FakeConn(mm, "FULL");
	const fullLobby = { ...builtLobby("FULL", "Standard"), MaxPlayers: 2 };
	F.do({ CreateLobby: { lobby: fullLobby } });
	const G = new FakeConn(mm, "G2");
	G.do({ JoinLobby: { room_id: fullLobby.RoomId, name: "G2", is_player: true } });
	const [q1, q2] = [new FakeConn(mm, "Q1"), new FakeConn(mm, "Q2")];
	q1.do({ EnterQuickPlay: { name: "Q1", is_wide: false } });
	q2.do({ EnterQuickPlay: { name: "Q2", is_wide: false } });
	const L = new FakeConn(mm, "LIST");
	L.do({ GetLobbies: {} });
	let names = L.last("GetLobbiesResponse").lobbies.map((l) => l.Name);
	eq(names, ["OPEN"], "the open one only (full, private and waiting quick play aren't listed)");
	for (const q of [q1, q2]) q.do({ UpdatePlayer: { player: { ...roomOf(mm).lobby.Players.find((p) => p.RoomPeerId === q.state.peer), Ready: true } } });
	measureAll([q1, q2]);
	tick(mm, 6_000);
	L.do({ GetLobbies: {} });
	const listed = L.last("GetLobbiesResponse").lobbies;
	eq(listed.map((l) => l.Name), ["OPEN", "QUICK PLAY"], "a running quick play match is listed (to spectate), last");
	assert(listed.every((l) => l.Players.every((p) => p.RoomPeerId === "")), "without peer ids");
	assert(!listed.some((l) => l.RoomId === priv), "private never");
	void full;
});

test("core: quick play: pairs the first two, seats the next into the open lobby (4 seats), starts once full or after 5 s of everyone ready", async () => {
	const mm = await core();
	const [A, B, C] = ["ALICE", "BOB", "CAROL"].map((n) => new FakeConn(mm, n));
	A.do({ EnterQuickPlay: { name: "ALICE", is_wide: false } });
	eq(A.last("QuickPlayStatus"), { queued: true, searching_standard: 1, searching_wide: 0, message: "" }, "queued");
	B.do({ EnterQuickPlay: { name: "BOB", is_wide: false } });
	const found = A.last("QuickPlayMatchFound");
	eq([found.lobby.Name, found.lobby.MaxPlayers, found.lobby.Kind, found.lobby.Mods], ["QUICK PLAY", 4, "QuickPlay", []], "a 4-seat lobby");
	eq(found.lobby.Players.map((p) => [p.Name, p.Seat, p.IsHost]), [["ALICE", 0, true], ["BOB", 1, false]], "the first searcher hosts");
	C.do({ EnterQuickPlay: { name: "CAROL", is_wide: false } });
	eq(C.last("QuickPlayMatchFound").lobby.Players.length, 3, "seated into the open lobby");
	const all = [A, B, C];
	measureAll(all);
	for (const c of all) c.do({ UpdatePlayer: { player: { ...roomOf(mm).lobby.Players.find((p) => p.RoomPeerId === c.state.peer), Ready: true } } });
	for (const c of all) c.inbox.length = 0;
	tick(mm, 4_000);
	assert(!A.tags().includes("StartLobby"), "not before 5 s");
	tick(mm, 1_100);
	for (const c of all) eq(c.tags(), ["StartLobby"], "started by itself");
	assert(mm.nextWake() - clock <= 30_000, "nothing left but keep-alives");
	const W = new FakeConn(mm, "WAIT");
	W.do({ EnterQuickPlay: { name: "WAIT", is_wide: false } });
	assert(W.state.quickPlay, "a match running: W waits");
	W.do({ ExitQuickPlay: {} });
	eq(W.last("QuickPlayStatus"), { queued: false, searching_standard: 0, searching_wide: 0, message: "" }, "ExitQuickPlay is answered");
});

test("core: quick play: the host leaving passes the lobby on; a seat freed in the lobby goes to the next searcher", async () => {
	const mm = await core();
	const [A, B] = ["ALICE", "BOB"].map((n) => new FakeConn(mm, n));
	A.do({ EnterQuickPlay: { name: "ALICE", is_wide: false } });
	B.do({ EnterQuickPlay: { name: "BOB", is_wide: false } });
	const roomId = B.last("QuickPlayMatchFound").lobby.RoomId;
	A.do({ LeaveLobby: {} });
	const l = B.last("LobbyUpdate").lobby;
	eq(l.Players.map((p) => [p.Name, p.IsHost]), [["BOB", true]], "B hosts now");
	const C = new FakeConn(mm, "CAROL");
	C.do({ EnterQuickPlay: { name: "CAROL", is_wide: false } });
	eq(C.last("QuickPlayMatchFound").lobby.RoomId, roomId, "C seated with B");
});

test("core: quick play: wide searchers only meet wide ones, in a lobby with WiderSet's IsWide", async () => {
	const mm = await core();
	const [A, B, C] = ["ALICE", "BOB", "CAROL"].map((n) => new FakeConn(mm, n));
	A.do({ EnterQuickPlay: { name: "ALICE", is_wide: true } });
	B.do({ EnterQuickPlay: { name: "BOB", is_wide: false } });
	eq(B.last("QuickPlayStatus"), { queued: true, searching_standard: 1, searching_wide: 1, message: "" }, "not matched");
	C.do({ EnterQuickPlay: { name: "CAROL", is_wide: true } });
	eq(C.last("QuickPlayMatchFound").lobby.Mods, [{ Name: "Teuria.WiderSet", Data: { IsWide: "True" } }], "the wide lobby");
	assert(B.state.quickPlay, "B still searching");
});

test("core: version gate, Identify's player id, and the answers of a server without ranking", async () => {
	const { versionRefusal } = await import("./matchmaker.js");
	eq(versionRefusal(null), { status: 426 }, "no version: 426");
	eq(versionRefusal("v0.22"), { status: 426 }, "not a version: 426");
	eq(versionRefusal("0.21.1", "0.22.0"), { updateRequired: "0.22.0" }, "older: UpdateRequired");
	eq([versionRefusal("0.22.0", "0.22.0"), versionRefusal("0.23.0.1", "0.22.0"), versionRefusal("0.22.2")], [null, null, null], "same or newer");
	const mm = await core();
	const A = new FakeConn(mm, "ALICE");
	A.do({ Identify: { player_id: "evil:1", name: "EVE" } });
	eq(A.state.name, "ALICE", "an Identify with another prefix is ignored");
	A.do({ EnterRanked: { name: "ALICE", is_wide: false } });
	eq(A.last("RankedStatus"), { queued: false, searching_standard: 0, searching_wide: 0, message: "RANKED IS NOT AVAILABLE ON THIS SERVER" }, "no ranked");
	A.do({ GetLeaderboard: {} });
	A.do({ GetLeaderboard: {} });
	eq(A.take("Leaderboard"), [{ entries: [], own: null, around: [], total: 0 }], "an empty leaderboard, once per 2 s");
	A.do({ GetPlayerProfile: { rank: 3 } });
	eq(A.last("PlayerProfile"), { rank: 3, profile: null }, "no profile");
});

test("core: skin chunks go to the whole lobby, the sender included; oversized ones are dropped", async () => {
	const mm = await core();
	const { A, others } = readyLobby(mm);
	const chunk = { bundle_id: "b", custom_archer_id: "x", chunk_index: 0, chunk_count: 1, data: "AAAA" };
	A.do({ SkinChunk: { chunk } });
	eq([A.last("SkinChunk"), others[0].last("SkinChunk")], [{ chunk, from: A.state.peer }, { chunk, from: A.state.peer }], "both");
	A.do({ SkinChunk: { chunk: { ...chunk, chunk_count: 33 } } });
	assert(!others[0].take("SkinChunk").length, "too many chunks");
});

test("core: lobbies survive hibernation; members whose sockets closed are removed", async () => {
	const { Matchmaker } = await import("./matchmaker.js");
	const saved = new Map();
	const persist = { save: (room) => saved.set(room.lobby.RoomId, structuredClone(room)), remove: (id) => saved.delete(id) };
	const mm = new Matchmaker({ persist });
	const { A, B, all } = started(mm);
	const C = new FakeConn(mm, "SPEC");
	C.do({ JoinPrivate: { code: [...saved.values()][0].lobby.JoinCode, name: "SPEC", is_player: false } });
	// Wake up with A and B still connected, the spectator's socket gone.
	const woke = new Matchmaker({ persist });
	woke.restore([...saved.values()].map((r) => structuredClone(r)), [A, B]);
	for (const c of [A, B]) c.mm = woke;
	const l = [...woke.rooms.values()][0].lobby;
	eq([l.Players.length, l.Spectators.length], [2, 0], "spectator dropped, players kept");
	ended(all);
	for (const c of all) c.do({ ArcherSelectChoice: {} });
	assert(B.tags().includes("ArcherSelectLobby"), "lobby still works");
});

test("core: silent connections are dropped after the keep-alive window", async () => {
	const mm = await core();
	const A = new FakeConn(mm, "ALICE");
	const B = new FakeConn(mm, "BOB");
	for (let t = 0; t < 4; t++) {
		tick(mm, 30_000);
		B.do({ KeepAlive: {} });
	}
	assert(A.closed && !B.closed, "A dropped, B kept");
});

test("core: a full match room's peers can't be taken over from elsewhere", async () => {
	const { SignalRoom } = await import("./signal.js");
	const room = new SignalRoom();
	const conn = (name) => ({ name, state: {}, inbox: [], closed: null, send(t) { this.inbox.push(JSON.parse(t)); }, close(code) { this.closed = code; }, save() {} });
	const host = uuid();
	const A = conn("A");
	room.open(A, host, clock, "1.1.1.1");
	const B = conn("B");
	room.open(B, uuid(), clock, "2.2.2.2");
	const X = conn("X");
	room.open(X, host, clock + 5000, "6.6.6.6");
	eq([X.closed, A.closed], [4003, null], "another address can't take a live peer id");
	assert(!B.inbox.some((m) => m.PeerLeft), "nobody hears the host left");
	const A2 = conn("A2");
	room.open(A2, host, clock + 6000, "1.1.1.1");
	eq([A2.closed, A.closed], [null, 4001], "the same address reconnects");
	assert(B.inbox.some((m) => m.PeerLeft === host) && B.inbox.at(-1).NewPeer === host, "B reconnects to it");
	const Y = conn("Y");
	room.open(Y, host, clock + 6000 + 26_000, "6.6.6.6");
	eq(Y.closed, null, "a peer quiet past its keep-alives can be replaced");
	const C = conn("C");
	room.open(C, uuid(), clock, "3.3.3.3");
	room.message(C, "x".repeat(70 * 1024), clock);
	eq(C.closed, 4029, "too big");
	const D = conn("D");
	room.open(D, uuid(), clock, "4.4.4.4");
	for (let i = 0; i < 250 && D.closed === null; i++) room.message(D, '"KeepAlive"', clock);
	eq(D.closed, 4029, "too many at once");
	const E = conn("E");
	room.open(E, uuid(), clock, "5.5.5.5");
	for (let i = 0; i < 1000; i++) room.message(E, '"KeepAlive"', clock + i * 100);
	eq(E.closed, null, "10 a second is fine");
});

test("core: per-address and per-connection limits; spectators and lobby size are capped", async () => {
	const mm = await core();
	const conns = Array.from({ length: 16 }, (_, i) => new FakeConn(mm, `P${i}`, "9.9.9.9"));
	assert(conns.every((c) => !c.closed), "16 from one address");
	const extra = new FakeConn(mm, "EXTRA", "9.9.9.9");
	assert(extra.closed, "the 17th is refused");
	extra.do({ EnterQuickPlay: { name: "EXTRA", is_wide: false } });
	assert(!extra.state.quickPlay, "and ignored");
	assert(!new FakeConn(mm, "OTHER", "8.8.8.8").closed, "other addresses aren't");
	const F = conns[0];
	for (let i = 0; i < 150 && !F.closed; i++) F.do({ KeepAlive: {} });
	assert(F.closed, "a flood closes the connection");
	const G = conns[1];
	for (let i = 0; i < 300; i++) {
		clock += 100;
		G.do({ KeepAlive: {} });
	}
	assert(!G.closed, "10 a second is fine");
	const A = new FakeConn(mm, "ALICE", "1.1.1.1");
	A.do({ CreateLobby: { lobby: builtLobby("ALICE") } });
	const lobby = A.last("CreateLobbyResponse").lobby;
	const S = Array.from({ length: 8 }, (_, i) => new FakeConn(mm, `S${i}`, `3.3.3.${i}`));
	for (const c of S) c.do({ JoinPrivate: { code: lobby.JoinCode, name: c.id, is_player: false } });
	assert(S.every((c) => c.last("PrivateJoinResult").success), "8 spectators");
	const S9 = new FakeConn(mm, "S9", "3.3.4.4");
	S9.do({ JoinPrivate: { code: lobby.JoinCode, name: "S9", is_player: false } });
	eq(S9.last("PrivateJoinResult").message, `Lobby ${lobby.RoomId} is full`, "a 9th spectator");
	const big = builtLobby("BIG");
	big.Mods = Array.from({ length: 16 }, (_, i) => ({ Name: `M${i}`, Data: Object.fromEntries(Array.from({ length: 32 }, (_, k) => [`k${k}`, "v".repeat(256)])) }));
	const H = new FakeConn(mm, "BIG");
	H.do({ CreateLobby: { lobby: big } });
	eq(H.last("CreateLobbyResponse").message, "Lobby too big", "oversized lobby refused");
	assert(mm.isMember(lobby.RoomId, lobby.Players[0].RoomPeerId) && !mm.isMember(lobby.RoomId, uuid()), "isMember (signaling, /turn)");
});

test("core: stats count connections, lobbies and matches (for safe redeploys)", async () => {
	const mm = await core();
	eq(mm.stats(), { connections: 0, lobbies: 0, matches: 0, playersInMatches: 0, searching: 0 }, "empty");
	started(mm);
	const S = new FakeConn(mm, "SEARCH");
	S.do({ EnterQuickPlay: { name: "SEARCH", is_wide: false } });
	eq(mm.stats(), { connections: 3, lobbies: 1, matches: 1, playersInMatches: 2, searching: 1 }, "one match, one searching");
});

// ---- Match relay (/relay/<id>, relay.js) ----

// A relay peer: binary messages in and out, as the browser's tfnet.js relay transport and the Switch use it.
class RelayPeer {
	static async open(path) {
		const p = new RelayPeer();
		p.ws = new WebSocket(base + path);
		p.ws.binaryType = "arraybuffer";
		p.got = [];
		p.texts = 0;
		p.closed = null;
		p.ws.addEventListener("message", (e) => (typeof e.data === "string" ? p.texts++ : p.got.push([...new Uint8Array(e.data)])));
		p.ws.addEventListener("close", (e) => (p.closed = e.code));
		await new Promise((resolve, reject) => {
			p.ws.addEventListener("open", resolve);
			p.ws.addEventListener("error", reject);
		});
		return p;
	}

	send(bytes) {
		this.ws.send(typeof bytes === "string" ? bytes : new Uint8Array(bytes));
	}

	async until(cond, what, ms = 2000) {
		for (let t = 0; t < ms && !cond(); t += 20) await sleep(20);
		assert(cond(), what);
	}

	close() {
		this.ws.close();
	}
}

const allReady = (t) => t.startsWith('{"LobbyUpdate"') && JSON.parse(t).LobbyUpdate.lobby.Players.every((p) => p.Ready);

// A two-player lobby (both ready) and its match started.
async function startedMatch() {
	const m = await privateLobby();
	m.A.send({ UpdatePlayer: { player: { ...m.host, Ready: true } } });
	m.B.send({ UpdatePlayer: { player: { ...m.bob, Ready: true, Platform: "Switch" } } });
	await m.A.next(allReady);
	m.B.send({ PeerMeasured: { room_peer_id: m.host.RoomPeerId } });
	await m.A.next((t) => t.startsWith('{"LobbyUpdate"') && !JSON.parse(t).LobbyUpdate.lobby.IsCheckingConnections);
	m.A.send({ StartLobbyChoice: {} });
	await m.B.next("StartLobby");
	return m;
}

test("relay: only the players of a lobby whose match is on get in; peer is required", async () => {
	const m = await privateLobby();
	const room = m.lobby.RoomId;
	eq(await handshake(`/relay/${room}`), 400, "no peer");
	eq(await handshake(`/relay/${room}?peer=not-a-uuid`), 400, "peer not a UUID");
	eq(await handshake(`/relay/${room}?peer=${m.host.RoomPeerId}`), 403, "a player, before the match");
	const C = await tfex("CAROL");
	C.send({ JoinPrivate: { code: m.lobby.JoinCode, name: "CAROL", is_player: false } });
	const spectator = (await C.next("PrivateJoinResult")).PrivateJoinResult.room_peer_id;
	m.A.send({ UpdatePlayer: { player: { ...m.host, Ready: true } } });
	m.B.send({ UpdatePlayer: { player: { ...m.bob, Ready: true } } });
	await m.A.next(allReady);
	m.B.send({ PeerMeasured: { room_peer_id: m.host.RoomPeerId } });
	await m.A.next((t) => t.startsWith('{"LobbyUpdate"') && !JSON.parse(t).LobbyUpdate.lobby.IsCheckingConnections);
	m.A.send({ StartLobbyChoice: {} });
	await m.B.next("StartLobby");
	eq(await handshake(`/relay/${room}?peer=${spectator}`), 403, "a spectator");
	eq(await handshake(`/relay/${room}?peer=${uuid()}`), 403, "a stranger");
	eq(await handshake(`/relay/r${Date.now()}?peer=${m.host.RoomPeerId}`), 403, "another room");
	eq(await handshake(`/relay/${room}?peer=${m.host.RoomPeerId}`), 101, "a player, in the match");
	eq(await handshake(`/relay/${room}?peer=${m.peerB}`, "http://localhost:18080"), 101, "the other player, from a local page");
	eq(await handshake(`/relay/${room}?peer=${m.peerB}`, "https://evil.example"), 403, "other pages");
	for (const c of [m.A, m.B, C]) c.close();
});

test("relay: binary frames go to the other peer unchanged, text is dropped, reconnects replace", async () => {
	const m = await startedMatch();
	const room = `/relay/${m.lobby.RoomId}`;
	const H = await RelayPeer.open(`${room}?peer=${m.host.RoomPeerId}`);
	const S = await RelayPeer.open(`${room}?peer=${m.peerB}`);
	const frame = Array.from({ length: 64 }, (_, i) => (i * 37) & 255);
	H.send(frame);
	await S.until(() => S.got.length === 1, "S gets H's frame");
	eq(S.got[0], frame, "unchanged");
	S.send([0x48, 0x45, 0x4c, 0x4c, 0x4f]);
	S.send('{"not":"forwarded"}');
	for (let i = 0; i < 300; i++) S.send([i & 255, 1, 2, 3]);
	await H.until(() => H.got.length === 301, "H gets all of S's 301 binary frames, in order");
	eq(H.got[0], [0x48, 0x45, 0x4c, 0x4c, 0x4f], "first");
	assert(H.got.slice(1).every((f, i) => f[0] === (i & 255)), "in order");
	eq([H.texts, S.texts, S.got.length], [0, 0, 1], "no text either way, nothing echoed");
	// The same peer reconnecting (same address): the new socket replaces the old one.
	const S2 = await RelayPeer.open(`${room}?peer=${m.peerB}`);
	await S.until(() => S.closed === 4001, "old socket closed as replaced");
	H.send([9, 9]);
	await S2.until(() => S2.got.length === 1, "the new socket gets frames");
	S2.send([7]);
	await H.until(() => H.got.length === 302, "and its frames get through");
	// Size cap.
	S2.send(new Array(2049).fill(1));
	await S2.until(() => S2.closed === 4029, "a frame over 2 KB closes the socket");
	for (const c of [H, m.A, m.B]) c.close();
});

test("relay: xnet-* rooms need no lobby (lobby-free tests), still 2 peers; no lobby can take such a name", async () => {
	const room = `/relay/xnet-${Date.now()}`;
	const [a, b] = [uuid(), uuid()];
	const A = await RelayPeer.open(`${room}?peer=${a}`);
	const B = await RelayPeer.open(`${room}?peer=${b}`);
	A.send([1, 2, 3]);
	await B.until(() => B.got.length === 1, "B gets A's frame");
	eq(await handshake(`${room}?peer=${uuid()}`), 409, "a third peer is refused");
	eq(await handshake(`${room}?peer=${a}`, "http://localhost:1"), 101, "the same peer, same address: replaces");
	const H = await tfex("HOST");
	const lobby = builtLobby("HOST");
	lobby.RoomId = `xnet-${Date.now()}`;
	H.send({ CreateLobby: { lobby } });
	eq((await H.next("CreateLobbyResponse")).CreateLobbyResponse.message, "Bad room id", "no lobby named xnet-*");
	for (const c of [A, B, H]) c.close();
});

test("core: relay rooms hold 2 peers, cap rate and size, and keep live peers from being taken over", async () => {
	const { RelayRoom, MAX_RELAY_FRAME, RELAY_RATE } = await import("./relay.js");
	assert(RELAY_RATE >= 400 && MAX_RELAY_FRAME <= 2048, "limits");
	const room = new RelayRoom();
	const conn = (name) => ({ name, state: {}, got: [], closed: null, sendBinary(b) { this.got.push(b); }, close(code) { this.closed = code; }, save() {} });
	const [a, b] = [uuid(), uuid()];
	const A = conn("A");
	const B = conn("B");
	assert(room.open(A, a, clock, "1.1.1.1") && room.open(B, b.toUpperCase(), clock, "2.2.2.2"), "two peers");
	const C = conn("C");
	assert(!room.open(C, uuid(), clock, "3.3.3.3") && C.closed === 4002, "a third is refused");
	const X = conn("X");
	assert(!room.open(X, a, clock + 1000, "6.6.6.6") && X.closed === 4003 && A.closed === null, "a live peer id can't be taken from another address");
	// 60 Hz GGRS traffic (~125/s) and more: fine for a minute.
	let t = clock;
	for (let i = 0; i < 60 * 400; i++) room.message(A, new Uint8Array([1]), (t += 2.5));
	eq([A.closed, B.got.length], [null, 60 * 400], "400 messages a second for a minute");
	room.message(B, "text", t);
	eq(A.got.length, 0, "text dropped");
	for (let i = 0; i < 5000 && B.closed === null; i++) room.message(B, new Uint8Array([1]), t);
	eq(B.closed, 4029, "a flood closes it");
	assert(room.open(conn("B2"), b, t, "9.9.9.9"), "its slot is free again");
	room.message(A, new Uint8Array(MAX_RELAY_FRAME + 1), t);
	eq(A.closed, 4029, "too big");
});

test("core: a stale relay peer can be replaced from another address", async () => {
	const { RelayRoom } = await import("./relay.js");
	const room = new RelayRoom();
	const conn = () => ({ state: {}, got: [], closed: null, sendBinary(b) { this.got.push(b); }, close(code) { this.closed = code; }, save() {} });
	const a = uuid();
	const A = conn();
	room.open(A, a, clock, "1.1.1.1");
	const A2 = conn();
	assert(room.open(A2, a, clock + 10_000, "5.5.5.5"), "quiet for 10 s: replaced");
	eq(A.closed, 4001, "old one closed");
	room.message(A, new Uint8Array([1]), clock + 10_001);
	const B = conn();
	room.open(B, uuid(), clock + 10_001, "2.2.2.2");
	room.message(A2, new Uint8Array([2]), clock + 10_002);
	eq(B.got.map((x) => [...x]), [[2]], "only the new socket's frames get through");
});

// ---- run ----

let failed = 0;
for (const t of tests) {
	try {
		await Promise.race([t.fn(), sleep(20_000).then(() => { throw new Error("timed out (20 s)"); })]);
		console.log(`ok   ${t.name}`);
	} catch (e) {
		failed++;
		console.log(`FAIL ${t.name}\n     ${String(e?.stack ?? e?.message ?? e).split("\n").slice(0, 3).join("\n     ")}`);
	}
}
console.log(failed ? `${failed} of ${tests.length} failed` : `all ${tests.length} passed`);
child?.kill();
process.exit(failed ? 1 : 0);
