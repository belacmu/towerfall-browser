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
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ---- Origins and routes ----

test("origins: desktop (none) and the site are let in, other pages aren't", async () => {
	eq(await handshake("/ws"), 101, "no Origin");
	eq(await handshake("/ws", "https://belacmu.github.io"), 101, "the site");
	eq(await handshake("/ws", "http://localhost:8080"), 101, "the dev server");
	eq(await handshake("/ws", "http://127.0.0.1:8081"), 101, "another local port");
	eq(await handshake("/ws", "http://localhost.example.com"), 403, "not local");
	eq(await handshake(`/room/abc?peer=${uuid()}`, "https://belacmu.github.io"), 101, "room");
	eq(await handshake("/ws", "https://example.com"), 403, "another page");
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
	eq((await send(`group=ALICE-BOB&name=ALICE&kind=desync`, zip)).status, 204, "desktop / Switch (no Origin)");
	eq((await send(`group=ALICE-BOB&name=BOB&kind=disconnect`, zip, "https://belacmu.github.io")).status, 204, "the site's pages");
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
	const room = `/room/r${Date.now()}`;
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
	const id = `r${Date.now()}`;
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
	const c = await Client.open("/ws", { binary: true });
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
	A.send({ StartLobbyChoice: {} });
	await B.none("StartLobby"); // not everyone is ready
	B.send({ UpdatePlayer: { player: { ...bob, ArcherIndex: 1, Ready: true } } });
	await A.next("LobbyUpdate");
	await B.next("LobbyUpdate");
	B.send({ StartLobbyChoice: {} }); // only the host starts
	await A.none("StartLobby");
	A.send({ StartLobbyChoice: {} });
	await A.next("StartLobby");
	await B.next("StartLobby");
	l = (await B.next("LobbyUpdate")).LobbyUpdate.lobby;
	assert(l.InGame, "in game");
	A.close();
	B.close();
});

test("matchmaking: bad codes, full lobbies, host leaving", async () => {
	const { A, B, lobby } = await privateLobby();
	const C = await tfex("CAROL");
	C.send({ JoinPrivate: { code: "ZZZZZ", name: "CAROL", is_player: true } });
	assert(!(await C.next("PrivateJoinResult")).PrivateJoinResult.success, "unknown code refused");
	C.send({ JoinPrivate: { code: lobby.JoinCode, name: "CAROL", is_player: true } });
	assert(!(await C.next("PrivateJoinResult")).PrivateJoinResult.success, "full lobby refused");
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
	for (const c of [B, C, D]) c.close();
});

test("matchmaking: public lobbies are listed and joined by room id; skins relay", async () => {
	const A = await tfex("ALICE");
	const sent = builtLobby("ALICE", "Standard");
	A.send({ CreateLobby: { lobby: sent } });
	const lobby = (await A.next("CreateLobbyResponse")).CreateLobbyResponse.lobby;
	eq(lobby.JoinCode, "", "no code for public lobbies");
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

async function core() {
	const { Matchmaker } = await import("./matchmaker.js");
	return new Matchmaker();
}

// A two-player private lobby, both ready, started.
function started(mm, gameData = {}, maxPlayers = 2) {
	const { A, others, lobby } = readyLobby(mm, gameData, maxPlayers);
	const all = [A, ...others];
	A.do({ StartLobbyChoice: {} });
	for (const c of all) {
		const tags = c.tags();
		assert(tags.lastIndexOf("StartLobby") > tags.lastIndexOf("LobbyUpdate"), `LobbyUpdate before StartLobby (${tags.join(",")})`);
		c.take("StartLobby");
	}
	return { A, B: others[0], all, roomId: lobby.RoomId };
}

// A private lobby whose players are all ready (version: their TF.EX's, from /ws?version=).
function readyLobby(mm, gameData = {}, maxPlayers = 2, version = null) {
	const A = new FakeConn(mm, "ALICE", null, version);
	const sent = builtLobby("ALICE");
	Object.assign(sent.GameData, gameData);
	sent.MaxPlayers = maxPlayers;
	A.do({ CreateLobby: { lobby: sent } });
	const lobby = A.last("CreateLobbyResponse").lobby;
	const others = [];
	for (let i = 1; i < maxPlayers; i++) {
		const c = new FakeConn(mm, `P${i}`, null, version);
		c.do({ JoinPrivate: { code: lobby.JoinCode, name: `P${i}`, is_player: true } });
		assert(c.last("PrivateJoinResult").success, "joined");
		others.push(c);
	}
	const all = [A, ...others];
	for (const [i, c] of all.entries()) {
		const self = c.last("LobbyUpdate")?.lobby.Players.find((p) => p.Name === (i ? `P${i}` : "ALICE")) ?? lobby.Players[0];
		c.do({ UpdatePlayer: { player: { ...self, Ready: true, ArcherIndex: i, Team: maxPlayers === 4 ? i % 2 : -1 } } });
	}
	return { A, others, all, lobby };
}

test("core: TF.EX 0.21 lobby fields; MatchPlayers is the match's players, cleared at archer select", async () => {
	const mm = await core();
	const { A, B, all } = started(mm);
	const l = A.last("LobbyUpdate").lobby;
	eq([l.RelayedPairs, l.IsCheckingConnections, l.IsReportEnabled], [[], false, true], "0.21 fields (match reports on)");
	eq(l.MatchPlayers.map((p) => p.Name), ["ALICE", "P1"], "MatchPlayers at the start");
	for (const c of all) c.do({ MatchEnded: { winner_seat: 0, frame: 1000, checksum: null, scores: [5, 2] } });
	A.do({ RematchLobbyChoice: {} });
	B.do({ ArcherSelectChoice: {} });
	eq(B.last("LobbyUpdate").lobby.MatchPlayers, [], "cleared at archer select");
});

test("core: TF.EX 0.22's StartsWithoutHat is passed on (true / false), anything else is null", async () => {
	const mm = await core();
	const { A, others } = readyLobby(mm);
	const B = others[0];
	const own = (c, name) => c.last("LobbyUpdate").lobby.Players.find((p) => p.Name === name);
	A.do({ UpdatePlayer: { player: { ...own(A, "ALICE"), StartsWithoutHat: true } } });
	B.do({ UpdatePlayer: { player: { ...own(B, "P1"), StartsWithoutHat: "yes" } } });
	const players = B.last("LobbyUpdate").lobby.Players;
	eq(players.map((p) => p.StartsWithoutHat), [true, null], "StartsWithoutHat");
	A.do({ UpdatePlayer: { player: { ...own(A, "ALICE"), StartsWithoutHat: false } } });
	eq(B.last("LobbyUpdate").lobby.Players[0].StartsWithoutHat, false, "false stays false");
});

test("core: players without ping measurement (0.19, the Switch build) start at once; PeerMeasured makes one count", async () => {
	const mm = await core();
	const { A, all } = readyLobby(mm, {}, 2, null);
	A.do({ StartLobbyChoice: {} });
	for (const c of all) assert(c.tags().includes("StartLobby"), "started at once");
	// A mixed lobby (one 0.21.1, one without ?version=) starts at once too.
	const mixed = readyLobby(mm, {}, 2, null);
	mixed.A.state.version = "0.21.1";
	mixed.A.do({ StartLobbyChoice: {} });
	for (const c of mixed.all) assert(c.tags().includes("StartLobby"), "mixed lobby started at once");
});

test("core: TF.EX 0.20+ players: CHECKING CONNECTIONS until each pair is measured both ways, then StartLobby", async () => {
	const mm = await core();
	const { A, others, all } = readyLobby(mm, {}, 2, "0.21.1");
	const [B] = others;
	const players = B.last("LobbyUpdate").lobby.Players;
	const [pa, pb] = ["ALICE", "P1"].map((name) => players.find((p) => p.Name === name).RoomPeerId);
	A.do({ StartLobbyChoice: {} });
	assert(!A.tags().includes("StartLobby"), "not started yet");
	assert(A.last("LobbyUpdate").lobby.IsCheckingConnections, "IsCheckingConnections");
	A.do({ PeerMeasured: { room_peer_id: pb } });
	assert(!A.tags().includes("StartLobby"), "one direction isn't enough");
	B.do({ PeerMeasured: { room_peer_id: "not-a-player" } });
	B.do({ PeerMeasured: { room_peer_id: pa } });
	for (const c of all) assert(c.tags().includes("StartLobby"), "started once measured both ways");
	const l = A.last("LobbyUpdate").lobby;
	eq([l.IsCheckingConnections, l.RelayedPairs, l.InGame], [false, [], true], "check over, nothing relayed");
});

test("core: an unfinished connection check starts the match after 8 s anyway (no relay on Workers: RelayedPairs stays empty)", async () => {
	const mm = await core();
	const { A, all } = readyLobby(mm, {}, 2, "v0.20.1");
	A.do({ StartLobbyChoice: {} });
	assert(!A.tags().includes("StartLobby"), "checking");
	tick(mm, 8_100);
	for (const c of all) assert(c.tags().includes("StartLobby"), "started after the timeout");
	const l = A.last("LobbyUpdate").lobby;
	eq([l.IsCheckingConnections, l.RelayedPairs], [false, []], "nothing relayed");
});

test("core: everyone votes rematch -> LobbyUpdate (new seed) then RematchLobby", async () => {
	const mm = await core();
	const { A, B, all } = started(mm);
	const seed = A.last("LobbyUpdate").lobby.GameData.Seed;
	for (const c of all) c.do({ MatchEnded: { winner_seat: 0, frame: 1000, checksum: null, scores: [5, 2] } });
	A.do({ RematchLobbyChoice: {} });
	const vote = B.last("LobbyUpdate").lobby;
	eq(vote.EndGameChoice.length, 1, "A's vote shows");
	eq(vote.EndGameChoice[0].Choice, "Rematch", "as Rematch");
	B.do({ RematchLobbyChoice: {} });
	for (const c of all) {
		const tags = c.tags();
		assert(tags.at(-1) === "RematchLobby" && tags.at(-2) === "LobbyUpdate", `order ${tags.join(",")}`);
	}
	const l = A.last("LobbyUpdate").lobby;
	assert(l.InGame && l.Players.every((p) => p.Ready), "still in game and ready");
	assert(l.GameData.Seed !== seed && l.EndGameChoice.length === 0, "new seed, votes cleared");
});

test("core: an archer-select vote, or nobody voting in 30 s, returns to archer select", async () => {
	const mm = await core();
	let { A, B } = started(mm);
	A.do({ RematchLobbyChoice: {} });
	B.do({ ArcherSelectChoice: {} });
	let tags = B.tags();
	assert(tags.at(-2) === "ArcherSelectLobby" && tags.at(-1) === "LobbyUpdate", `order ${tags.join(",")}`);
	let l = B.last("LobbyUpdate").lobby;
	assert(!l.InGame && l.Players.every((p) => !p.Ready), "back in the lobby, unready");

	({ A, B } = started(new (await import("./matchmaker.js")).Matchmaker()));
	const mm2 = A.mm;
	A.do({ MatchEnded: { winner_seat: 1, frame: 1, checksum: null, scores: [0, 5] } });
	A.do({ RematchLobbyChoice: {} });
	tick(mm2, 20_000);
	assert(!B.tags().includes("ArcherSelectLobby"), "not yet");
	tick(mm2, 15_000);
	assert(B.tags().includes("ArcherSelectLobby"), "timed out to archer select");
	assert(mm2.nextWake() - clock <= 30_000, "only keep-alives left");
});

test("core: spectators join mid-match (SpectatorJoined, InGame lobby); host leaving closes the lobby", async () => {
	const mm = await core();
	const { A, B, roomId } = started(mm);
	const code = [...mm.rooms.values()][0].lobby.JoinCode;
	const S = new FakeConn(mm, "SPEC");
	S.do({ JoinPrivate: { code, name: "SPEC", is_player: false } });
	const result = S.last("PrivateJoinResult");
	assert(result.success && result.lobby.Spectators.length === 1, "spectator joined");
	assert(S.last("LobbyUpdate").lobby.InGame, "spectator sees InGame");
	eq(A.last("SpectatorJoined"), { room_peer_id: result.room_peer_id }, "host told");
	const P = new FakeConn(mm, "LATE");
	P.do({ JoinPrivate: { code, name: "LATE", is_player: true } });
	assert(!P.last("PrivateJoinResult").success, "no joining as a player mid-match");
	mm.close(A, clock);
	assert(!B.last("LobbyUpdate").lobby.Players.some((p) => p.IsHost), "hostless lobby sent");
	assert(!mm.rooms.has(roomId), "lobby gone");
	assert(!B.state.roomId && !S.state.roomId, "members detached");
});

test("core: settings changes un-ready everyone; seats stay unique", async () => {
	const mm = await core();
	const A = new FakeConn(mm, "ALICE");
	const sent = builtLobby("ALICE");
	sent.MaxPlayers = 4;
	A.do({ CreateLobby: { lobby: sent } });
	const { lobby } = A.last("CreateLobbyResponse");
	const joiners = ["B", "C", "D"].map((n) => {
		const c = new FakeConn(mm, n);
		c.do({ JoinPrivate: { code: lobby.JoinCode, name: n, is_player: true } });
		return c;
	});
	joiners[0].do({ LeaveLobby: {} });
	const E = new FakeConn(mm, "E");
	E.do({ JoinPrivate: { code: lobby.JoinCode, name: "E", is_player: true } });
	const seats = E.last("PrivateJoinResult").lobby.Players.map((p) => p.Seat).sort();
	eq(seats, [0, 1, 2, 3], "freed seat reused");
	A.do({ UpdatePlayer: { player: { ...lobby.Players[0], Ready: true } } });
	A.do({ UpdateLobbySettings: { max_players: 2, game_data: { ...lobby.GameData, Mode: 4, Seed: 1, BestOf: 7 }, mods: [] } });
	const l = E.last("LobbyUpdate").lobby;
	eq(l.MaxPlayers, 4, "can't shrink below the players");
	eq(l.GameData.Mode, 4, "mode changed");
	eq([l.GameData.Seed, l.GameData.BestOf], [lobby.GameData.Seed, 0], "seed and series kept");
	assert(l.Players.every((p) => !p.Ready), "everyone un-readied");
	joiners[1].do({ UpdateLobbySettings: { max_players: 4, game_data: { ...lobby.GameData, Mode: 3 }, mods: [] } });
	eq(E.last("LobbyUpdate"), undefined, "only the host changes settings");
});

test("core: local players (AddLocalPlayer): a seat after the device's first, UpdatePlayer by seat, one device leaving removes them all", async () => {
	const mm = await core();
	const A = new FakeConn(mm, "ALICE");
	const sent = builtLobby("ALICE");
	sent.MaxPlayers = 3;
	A.do({ CreateLobby: { lobby: sent } });
	const { lobby } = A.last("CreateLobbyResponse");
	const B = new FakeConn(mm, "BOB");
	B.do({ JoinPrivate: { code: lobby.JoinCode, name: "BOB", is_player: true } });
	const bob = B.last("PrivateJoinResult").lobby.Players.find((p) => p.Name === "BOB");
	B.do({ AddLocalPlayer: { player: { Name: "BOB 2", IsHost: true, Seat: 0 } } });
	let l = A.last("LobbyUpdate").lobby;
	const guest = l.Players.find((p) => p.Name === "BOB 2");
	assert(guest && guest.RoomPeerId === bob.RoomPeerId && guest.Seat === 2 && !guest.IsHost, "BOB 2 shares BOB's peer id, at seat 2");
	A.do({ AddLocalPlayer: { player: { Name: "ALICE 2" } } });
	eq(A.last("LobbyUpdate").lobby.Players.length, 3, "a full lobby takes no one");
	B.do({ UpdatePlayer: { player: { ...guest, ArcherIndex: 5, Ready: true } } });
	l = A.last("LobbyUpdate").lobby;
	assert(l.Players.find((p) => p.Seat === 2).Ready && !l.Players.find((p) => p.Seat === 1).Ready, "UpdatePlayer with seat 2 updates BOB 2 only");
	B.do({ UpdatePlayer: { player: { ...bob, Seat: 0, Ready: true } } });
	l = A.last("LobbyUpdate").lobby;
	assert(l.Players.find((p) => p.Seat === 1).Ready && l.Players.find((p) => p.Seat === 0).Ready === false, "a seat that isn't the device's falls back to its first player");
	B.do({ RemoveLocalPlayer: { seat: 1 } });
	eq(A.last("LobbyUpdate"), undefined, "the device's first player can't be removed that way");
	eq(B.last("LobbyUpdate").lobby.Players.length, 3, "(the sender gets the lobby back)");
	B.do({ RemoveLocalPlayer: { seat: 2 } });
	eq(A.last("LobbyUpdate").lobby.Players.map((p) => p.Seat), [0, 1], "BOB 2 removed");
	B.do({ AddLocalPlayer: { player: { Name: "BOB 2" } } });
	eq(A.last("LobbyUpdate").lobby.Players.length, 3, "BOB 2 back");
	B.do({ LeaveLobby: {} });
	eq(A.last("LobbyUpdate").lobby.Players.map((p) => p.Name), ["ALICE"], "BOB leaving takes BOB 2 along");
	A.do({ AddLocalPlayer: { player: { Name: "ALICE 2" } } });
	for (const p of A.last("LobbyUpdate").lobby.Players) A.do({ UpdatePlayer: { player: { ...p, Ready: true } } });
	A.do({ StartLobbyChoice: {} });
	eq(A.take("StartLobby").length, 0, "one device alone (with its local player) can't start");
});

test("core: a best-of-3 series (result, loser picks, auto start, finish)", async () => {
	const mm = await core();
	const { A, B, all } = started(mm, { BestOf: 3 });
	let l = A.last("LobbyUpdate").lobby;
	const s0 = l.Series;
	assert(s0 && s0.Status === "InProgress" && s0.AwaitingResult, "series started");
	eq(s0.Sides, [[0], [1]], "sides");
	assert(l.GameData.MapId >= 0 && l.GameData.MapId < 16, "server picked the tower");
	const firstMap = l.GameData.MapId;
	// Game 1: seat 0 wins 5-3. Both report; only one result counts.
	for (const c of all) c.do({ MatchEnded: { winner_seat: 0, frame: 1, checksum: null, scores: [5, 3] } });
	l = B.last("LobbyUpdate").lobby;
	eq(l.Series.Games, [{ MapId: firstMap, WinnerSide: 0, Scores: [5, 3] }], "game recorded once");
	eq(l.Series.PickerSide, 1, "loser picks");
	for (const c of all) c.do({ SeriesContinueChoice: {} });
	let tags = A.tags();
	assert(tags.includes("SeriesLobby"), `series lobby (${tags.join(",")})`);
	l = A.last("LobbyUpdate").lobby;
	assert(!l.InGame && l.Players.every((p) => !p.Ready), "on the series screen, unready");
	A.do({ SeriesPickMap: { map_id: firstMap === 4 ? 5 : 4 } });
	eq(A.last("LobbyUpdate").lobby.Series.Picks, [], "only the picker side picks");
	B.do({ SeriesPickMap: { map_id: firstMap } });
	eq(B.last("LobbyUpdate").lobby.Series.Picks, [], "no replaying a tower");
	const pick = firstMap === 4 ? 5 : 4;
	B.do({ SeriesPickMap: { map_id: pick } });
	l = B.last("LobbyUpdate").lobby;
	eq([l.Series.Picks, l.Series.NextMapId], [[{ Seat: 1, MapId: pick }], pick], "pick echoed");
	for (const [i, c] of all.entries()) c.do({ UpdatePlayer: { player: { ...l.Players[i], Ready: true } } });
	tags = A.tags();
	assert(tags.at(-1) === "StartLobby", `auto start (${tags.join(",")})`);
	l = A.last("LobbyUpdate").lobby;
	assert(l.InGame && l.GameData.MapId === pick && l.Series.AwaitingResult, "game 2 on the picked tower");
	A.take("StartLobby");
	// Game 2: seat 0 wins again: series over.
	A.do({ MatchEnded: { winner_seat: 0, frame: 1, checksum: null, scores: [5, 1] } });
	l = A.last("LobbyUpdate").lobby;
	eq([l.Series.Status, l.Series.WinnerSide], ["Finished", 0], "series won");
	// Nobody continues: after the vote window, the series screen anyway.
	tick(mm, 34_000);
	assert(B.tags().includes("SeriesLobby"), "series screen after timeout");
});

test("core: series screen starts by itself after 60 s; a player leaving aborts the series", async () => {
	const mm = await core();
	const { A, B, all } = started(mm, { BestOf: 5 });
	A.do({ MatchEnded: { winner_seat: 1, frame: 1, checksum: null, scores: [0, 5] } });
	for (const c of all) c.do({ SeriesContinueChoice: {} });
	for (const c of all) c.inbox.length = 0;
	tick(mm, 63_000);
	assert(A.tags().includes("StartLobby"), "forced start");
	const l = A.last("LobbyUpdate").lobby;
	assert(l.GameData.MapId !== l.Series.Games[0].MapId, "a tower not yet played");
	mm.close(B, clock);
	const after = A.last("LobbyUpdate").lobby;
	eq([after.Series.Status, after.Series.AbortReason], ["Aborted", "PLAYER LEFT"], "aborted");
});

test("core: quick play with local players: devices match if their players fit, a device's players share its peer id", async () => {
	const mm = await core();
	const A = new FakeConn(mm, "ALICE");
	const B = new FakeConn(mm, "BOB");
	const C = new FakeConn(mm, "CAROL");
	A.do({ EnterQuickPlay: { name: "ALICE", is_wide: false, local_players: 3 } });
	eq(A.last("QuickPlayStatus").local_players, 3, "the status echoes the device's players");
	B.do({ EnterQuickPlay: { name: "BOB", is_wide: false, local_players: 2 } });
	eq(B.last("QuickPlayMatchFound"), undefined, "3 + 2 players don't fit in 4");
	B.do({ EnterQuickPlay: { name: "BOB", is_wide: false, local_players: 3 } });
	eq(B.last("QuickPlayMatchFound"), undefined, "nor 3 + 3");
	C.do({ EnterQuickPlay: { name: "CAROL", is_wide: false } });
	const a = A.last("QuickPlayMatchFound");
	const c = C.last("QuickPlayMatchFound");
	assert(a && c && a.lobby.RoomId === c.lobby.RoomId, "ALICE (3) and CAROL (1) matched, the first that fit");
	const l = a.lobby;
	eq(l.MaxPlayers, 4, "4 seats");
	eq(l.Players.map((p) => p.Seat), [0, 1, 2, 3], "seats");
	eq(new Set(l.Players.filter((p) => p.RoomPeerId === a.room_peer_id).map((p) => p.Seat)).size, 3, "ALICE's 3 players share her peer id");
	eq(l.Players.filter((p) => p.IsHost).length, 1, "one host");
	assert(B.state.quickPlay, "BOB still searching");
	B.do({ ExitQuickPlay: {} });
});

test("core: quick play matches two searchers and starts once both are ready", async () => {
	const mm = await core();
	const A = new FakeConn(mm, "ALICE");
	const W = new FakeConn(mm, "WIDE");
	const B = new FakeConn(mm, "BOB");
	A.do({ EnterQuickPlay: { name: "ALICE", is_wide: false } });
	eq(A.last("QuickPlayStatus"), { queued: true, searching_standard: 1, searching_wide: 0, message: "", local_players: 1 }, "queued");
	W.do({ EnterQuickPlay: { name: "WIDE", is_wide: true } });
	eq(W.last("QuickPlayStatus").searching_wide, 1, "wide counted apart");
	B.do({ EnterQuickPlay: { name: "BOB", is_wide: false } });
	const a = A.last("QuickPlayMatchFound");
	const b = B.last("QuickPlayMatchFound");
	assert(a && b && a.lobby.RoomId === b.lobby.RoomId, "matched together");
	eq(a.lobby.Kind, "QuickPlay", "kind");
	eq(a.lobby.Players.filter((p) => p.IsHost).length, 1, "one host");
	eq(W.last("QuickPlayStatus").searching_standard, 0, "queue counts updated");
	A.do({ StartLobbyChoice: {} });
	eq(A.take("StartLobby").length, 0, "nobody starts quick play by hand");
	A.do({ UpdatePlayer: { player: { ...a.lobby.Players[0], Ready: true } } });
	B.do({ UpdatePlayer: { player: { ...b.lobby.Players[1], Ready: true } } });
	tick(mm, 1000);
	eq(B.take("StartLobby").length, 0, "short pause first");
	tick(mm, 600);
	eq(B.take("StartLobby").length, 1, "started");
	W.do({ ExitQuickPlay: {} });
	assert(!W.state.quickPlay, "left the queue");
});

test("core: lobbies survive hibernation; members whose sockets closed are removed", async () => {
	const { Matchmaker } = await import("./matchmaker.js");
	const saved = new Map();
	const persist = { save: (room) => saved.set(room.lobby.RoomId, structuredClone(room)), remove: (id) => saved.delete(id) };
	const mm = new Matchmaker({ persist });
	const { A, B } = started(mm);
	const C = new FakeConn(mm, "SPEC");
	C.do({ JoinPrivate: { code: [...saved.values()][0].lobby.JoinCode, name: "SPEC", is_player: false } });
	// Wake up with A and B still connected, the spectator's socket gone.
	const woke = new Matchmaker({ persist });
	woke.restore([...saved.values()].map((r) => structuredClone(r)), [A, B]);
	for (const c of [A, B]) c.mm = woke;
	const l = [...woke.rooms.values()][0].lobby;
	eq([l.Players.length, l.Spectators.length], [2, 0], "spectator dropped, players kept");
	A.do({ MatchEnded: { winner_seat: 0, frame: 1, checksum: null, scores: [1, 0] } });
	for (const c of [A, B]) c.do({ ArcherSelectChoice: {} });
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
	// Rate and size limits.
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

test("core: per-address and per-connection limits", async () => {
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
});

test("core: guessing join codes runs out of tries; spectators and lobby size are capped", async () => {
	const mm = await core();
	const A = new FakeConn(mm, "ALICE", "1.1.1.1");
	A.do({ CreateLobby: { lobby: builtLobby("ALICE") } });
	const lobby = A.last("CreateLobbyResponse").lobby;
	const S = Array.from({ length: 8 }, (_, i) => new FakeConn(mm, `S${i}`, `3.3.3.${i}`));
	for (const c of S) c.do({ JoinPrivate: { code: lobby.JoinCode, name: c.id, is_player: false } });
	assert(S.every((c) => c.last("PrivateJoinResult").success), "8 spectators");
	const S9 = new FakeConn(mm, "S9", "3.3.4.4");
	S9.do({ JoinPrivate: { code: lobby.JoinCode, name: "S9", is_player: false } });
	eq(S9.last("PrivateJoinResult").message, "LOBBY FULL", "a 9th spectator");
	const G = new FakeConn(mm, "GUESS", "2.2.2.2");
	for (let i = 0; i < 20; i++) G.do({ JoinPrivate: { code: "ZZZZZ", name: "G", is_player: true } });
	G.take("PrivateJoinResult");
	G.do({ JoinPrivate: { code: lobby.JoinCode, name: "G", is_player: true } });
	eq(G.last("PrivateJoinResult").message, "TOO MANY TRIES", "locked out after 20 wrong codes");
	clock += 11 * 60_000;
	G.do({ JoinPrivate: { code: lobby.JoinCode, name: "G", is_player: true } });
	assert(G.last("PrivateJoinResult").success, "until a while later");
	const big = builtLobby("BIG");
	big.Mods = Array.from({ length: 16 }, (_, i) => ({ Name: `M${i}`, Data: Object.fromEntries(Array.from({ length: 32 }, (_, k) => [`k${k}`, "v".repeat(256)])) }));
	const H = new FakeConn(mm, "BIG");
	H.do({ CreateLobby: { lobby: big } });
	eq(H.last("CreateLobbyResponse").message, "LOBBY TOO BIG", "oversized lobby refused");
	assert(mm.isMember(lobby.RoomId, lobby.Players[0].RoomPeerId) && !mm.isMember(lobby.RoomId, uuid()), "isMember (for /turn)");
});

test("core: a player leaving mid-match still gets the lobby back to archer select", async () => {
	const mm = await core();
	const { A, all } = started(mm, { Mode: 3 }, 3);
	mm.close(all[2], clock);
	for (const c of all) c.inbox.length = 0;
	tick(mm, 34_000);
	assert(A.tags().includes("ArcherSelectLobby"), "back to archer select");
	assert(!A.last("LobbyUpdate").lobby.InGame, "not in game");
});

test("core: stats count connections, lobbies and matches (for safe redeploys)", async () => {
	const mm = await core();
	eq(mm.stats(), { connections: 0, lobbies: 0, matches: 0, playersInMatches: 0, searching: 0 }, "empty");
	started(mm);
	const S = new FakeConn(mm, "SEARCH");
	S.do({ EnterQuickPlay: { name: "SEARCH", is_wide: false } });
	eq(mm.stats(), { connections: 3, lobbies: 1, matches: 1, playersInMatches: 2, searching: 1 }, "one match, one searching");
});

test("core: quick play lobbies close when a player leaves before the match", async () => {
	const mm = await core();
	const A = new FakeConn(mm, "ALICE");
	const B = new FakeConn(mm, "BOB");
	A.do({ EnterQuickPlay: { name: "ALICE", is_wide: false } });
	B.do({ EnterQuickPlay: { name: "BOB", is_wide: false } });
	const roomId = A.last("QuickPlayMatchFound").lobby.RoomId;
	B.do({ LeaveLobby: {} });
	eq(A.last("LobbyUpdate").lobby.Players, [], "A gets a lobby without a host (TF.EX leaves it)");
	assert(!mm.rooms.has(roomId) && !A.state.roomId, "closed");
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
	eq((await H.next("CreateLobbyResponse")).CreateLobbyResponse.message, "BAD ROOM ID", "no lobby named xnet-*");
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
		await t.fn();
		console.log(`ok   ${t.name}`);
	} catch (e) {
		failed++;
		console.log(`FAIL ${t.name}\n     ${e.stack.split("\n").slice(0, 3).join("\n     ")}`);
	}
}
console.log(failed ? `${failed} of ${tests.length} failed` : `all ${tests.length} passed`);
child?.kill();
process.exit(failed ? 1 : 0);
