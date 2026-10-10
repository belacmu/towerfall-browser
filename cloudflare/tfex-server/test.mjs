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
	assert(listed.some((l) => l.RoomId === lobby.RoomId), "listed");
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
	constructor(mm, name) {
		this.id = `f${FakeConn.n++}`;
		this.state = {};
		this.inbox = [];
		this.mm = mm;
		this.closed = false;
		mm.open(this, clock);
		this.do({ Identify: { player_id: `local:${uuid()}`, name } });
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
		const self = c.last("LobbyUpdate")?.lobby.Players.find((p) => p.Name === (i ? `P${i}` : "ALICE")) ?? lobby.Players[0];
		c.do({ UpdatePlayer: { player: { ...self, Ready: true, ArcherIndex: i, Team: maxPlayers === 4 ? i % 2 : -1 } } });
	}
	A.do({ StartLobbyChoice: {} });
	for (const c of all) {
		const tags = c.tags();
		assert(tags.lastIndexOf("StartLobby") > tags.lastIndexOf("LobbyUpdate"), `LobbyUpdate before StartLobby (${tags.join(",")})`);
		c.take("StartLobby");
	}
	return { A, B: others[0], all, roomId: lobby.RoomId };
}

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

test("core: quick play matches two searchers and starts once both are ready", async () => {
	const mm = await core();
	const A = new FakeConn(mm, "ALICE");
	const W = new FakeConn(mm, "WIDE");
	const B = new FakeConn(mm, "BOB");
	A.do({ EnterQuickPlay: { name: "ALICE", is_wide: false } });
	eq(A.last("QuickPlayStatus"), { queued: true, searching_standard: 1, searching_wide: 0, message: "" }, "queued");
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
