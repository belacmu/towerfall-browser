// Matchmaking at /ws, behaving as TF.EX's own server does: Fcornaire/tf-ex-matchmaking-server (Rust, open source since
// 2026-10-25; checked against 980e86c). Function names here follow its (state/*.rs) where they do the same thing. Local players are
// its guests (d30fe19, TF.EX v0.28.0): `local_players` on create / join / quick play seats the device's guests after it
// (LocalIndex > 0, its room peer id); a device counts once for starting, the connection check, votes and match reports. The
// differences, each needed:
//  - Workers can't take UDP, so TF.EX's relay doesn't exist: RelayedPairs stays empty and an unreachable pair is left to try
//    directly (the real server without its relay does the same).
//  - Cost (the Workers free plan): KeepAlive every 30 s instead of 3, and QuickPlayStatus when the queue changes and with each
//    keep-alive instead of every second. Durable Object alarms are requests.
//  - Limits for a server anyone can reach (message rate and size, connections per address, lobby size, spectators).
//  - GetLobbies leaves out peer ids (the lobby list doesn't use them).
//  - No GeoIP: every player is the same distance, as on the real server without a MaxMind key.
//  - No ranking: the real server's NoRanking answers (empty leaderboard, no profile, ranked unavailable).
//
// Messages are JSON objects with one key, the message name. TF.EX sends them as binary frames and recognizes ours by their
// first characters ({"Name"), so the name always comes first. Lobby objects use TF.EX's field names (PascalCase); message
// fields are snake_case.
//
// A connection (`conn`) is anything with an `id`, send(text), close(code, reason) and a `state` object that save() persists
// (a Durable Object keeps it with the socket through hibernation). Lobbies are kept as records ("rooms") { lobby, ... } and
// handed to `persist` when they change.

export const KEEPALIVE_MS = 30_000;
// Connections that send nothing for this long are dropped (TF.EX echoes every KeepAlive).
const IDLE_MS = 3 * KEEPALIVE_MS + 10_000;
const END_GAME_CHOICE_MS = 30_000; // END_GAME_CHOICE_SECONDS
const SERIES_READY_MS = 60_000; // SERIES_READY_SECONDS
const QUICK_PLAY_AUTO_START_GRACE_MS = 5_000; // QUICK_PLAY_AUTO_START_GRACE_SECS
const CONNECTION_CHECK_MS = 10_000; // CONNECTION_CHECK_SECS
const PRIVATE_JOIN_COOLDOWN_MS = 3_000; // PRIVATE_JOIN_COOLDOWN_SECS
const STALE_REPORTS_MS = 300_000; // STALE_REPORTS_SECS
const LEADERBOARD_COOLDOWN_MS = 2_000;
const PROFILE_COOLDOWN_MS = 250;
const RANKED_UNAVAILABLE_MESSAGE = "RANKED IS NOT AVAILABLE ON THIS SERVER";
export const WIDER_SET_MOD_NAME = "Teuria.WiderSet";

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I/O/0/1
const CODE_LENGTH = 5;
const MAX_NAME = 10; // NetplayPreferences.MaxNameLength
const MAX_PLAYERS = 4;
const MAX_LOCAL_PLAYERS = 3;
const SERIES_TOWER_COUNT = 16;
const SERIES_TEAM_SIZE = 2;
const TEAM_DEATHMATCH = 5; // TowerFall.Modes
const MAX_SKIN_CHUNK_DATA = 400_000;
const MAX_SKIN_CHUNKS = 32;

// Limits for a server anyone can reach. TF.EX stays well inside them: its biggest message is a skin chunk.
export const MAX_FRAME = MAX_SKIN_CHUNK_DATA + 16 * 1024;
const MAX_LOBBY_JSON = 64 * 1024; // a lobby, serialized (it goes out with every update and listing)
const MAX_SPECTATORS = 8;
const MAX_CONNS_PER_IP = 16;
// Messages per connection: a bucket of BURST that refills at RATE per second. Running dry closes it.
const BURST = 100;
const RATE = 20;

const clean = (s, max) => String(s ?? "").slice(0, max);
const int = (v, fallback = 0) => (Number.isInteger(v) ? v : fallback);
const strings = (list, n, max) => (Array.isArray(list) ? list.slice(0, n).map((s) => clean(s, max)) : []);
const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
const unique = (list) => [...new Set(list)];
// local_players as sent (default 1), or null when out of range (is_valid_local_players)
const localPlayers = (v) => (v === undefined || v === null ? 1 : Number.isInteger(v) && v >= 1 && v <= MAX_LOCAL_PLAYERS ? v : null);
const isGuest = (p) => p.LocalIndex > 0;

// "0.21.1" -> [0, 21, 1] (a fourth part is ignored), else null (ExVersion::parse).
export function parseVersion(value) {
	const parts = String(value ?? "").trim().split(".");
	if (parts.length < 3 || !parts.slice(0, 3).every((p) => /^\d+$/.test(p))) return null;
	return parts.slice(0, 3).map(Number);
}

// Whether a client may connect (check_version): null when it may, { status: 426 } without a version, { updateRequired } when older.
export function versionRefusal(version, minimum = "0.0.0") {
	const required = parseVersion(minimum) ?? [0, 0, 0];
	const v = parseVersion(version);
	if (!v) return { status: 426 };
	for (let i = 0; i < 3; i++) {
		if (v[i] !== required[i]) return v[i] < required[i] ? { updateRequired: required.join(".") } : null;
	}
	return null;
}

export class Matchmaker {
	constructor({ persist = null, log = () => {}, random = Math.random, reportsEnabled = true, fixedSeed = null } = {}) {
		this.persist = persist;
		this.log = log;
		this.random = random;
		this.reportsEnabled = reportsEnabled;
		this.fixedSeed = Number.isInteger(fixedSeed) ? fixedSeed : null; // tests with scripted inputs (a known level)
		this.rooms = new Map(); // RoomId -> room
		this.conns = new Map(); // conn.id -> conn
		this.keepAliveAt = 0;
	}

	// After a Durable Object wakes up: its lobbies from storage and the sockets still connected. Members whose connection is
	// gone are removed (everyone, after a redeploy).
	restore(rooms, conns) {
		for (const conn of conns) if (!conn.state.refused) this.conns.set(conn.id, conn);
		for (const room of rooms) {
			if (!room.connectivity || !("RankedSeats" in room.lobby)) continue; // (stored before this version: dropped)
			this.rooms.set(room.lobby.RoomId, room);
		}
		const now = Date.now();
		for (const room of [...this.rooms.values()]) {
			const live = new Set(this.members(room).map((c) => c.state.peer));
			for (const peer of unique([...room.lobby.Players, ...room.lobby.Spectators].map((m) => m.RoomPeerId))) {
				if (!live.has(peer) && this.rooms.has(room.lobby.RoomId)) this.removeFromLobby(room, peer, now);
			}
		}
	}

	// `ip` is the client's address (for per-address limits), if known. The version was checked before (versionRefusal).
	open(conn, now = Date.now(), ip = null, version = null) {
		const refused = !!ip && [...this.conns.values()].filter((c) => c.state.ip === ip).length >= MAX_CONNS_PER_IP;
		conn.state = { seen: now, ip, tokens: BURST, refused, version: version ? clean(version, 32) : null };
		conn.save?.();
		if (refused) return conn.close(4029, "too many connections");
		this.conns.set(conn.id, conn);
		if (this.keepAliveAt < now) this.keepAliveAt = now + KEEPALIVE_MS;
		this.send(conn, "KeepAlive", {});
	}

	close(conn, now = Date.now()) {
		if (!this.conns.has(conn.id)) return;
		this.exitQuickPlay(conn);
		this.leave(conn, now);
		this.conns.delete(conn.id);
	}

	message(conn, text, now = Date.now()) {
		if (conn.state.refused) return;
		if (!this.conns.has(conn.id)) this.conns.set(conn.id, conn);
		const s = conn.state;
		s.tokens = Math.min(BURST, (s.tokens ?? BURST) + ((now - (s.seen ?? now)) / 1000) * RATE) - 1;
		s.seen = now;
		if (s.tokens < 0 || text.length > MAX_FRAME) {
			conn.close(4029, s.tokens < 0 ? "too many messages" : "message too big");
			this.close(conn, now);
			return;
		}
		let msg;
		try {
			msg = JSON.parse(text);
		} catch {
			return;
		}
		if (!msg || typeof msg !== "object" || Array.isArray(msg)) return;
		const [name] = Object.keys(msg);
		const body = msg[name] && typeof msg[name] === "object" ? msg[name] : {};
		if (Object.hasOwn(handlers, name)) handlers[name].call(this, conn, body, now);
		conn.save?.();
	}

	// Runs what is due: keep-alives (dropping silent connections), the lobbies' deadlines.
	wake(now = Date.now()) {
		if (now >= this.keepAliveAt) {
			this.keepAliveAt = now + KEEPALIVE_MS;
			for (const conn of [...this.conns.values()]) {
				if (now - (conn.state.seen ?? now) > IDLE_MS) {
					conn.close(4008, "no keep-alive");
					this.close(conn, now);
				} else this.send(conn, "KeepAlive", {});
			}
			this.pushQueueStatus();
		}
		for (const room of [...this.rooms.values()]) {
			if (!this.rooms.has(room.lobby.RoomId)) continue;
			const t = room.timers;
			if (t.endGame !== null && now >= t.endGame) this.resolveEndGame(room, true, now);
			if (!this.rooms.has(room.lobby.RoomId)) continue;
			if (t.seriesReady !== null && now >= t.seriesReady) this.expireSeriesWait(room, now);
			if (room.reports && now - room.reports.createdAt >= STALE_REPORTS_MS) room.reports = null;
			this.connectivityTick(room, now);
		}
		this.autoStartQuickPlayLobbies(now);
	}

	// When wake() should run next (null: nothing to do until a message arrives).
	nextWake() {
		let next = this.conns.size ? this.keepAliveAt || Date.now() : null;
		const consider = (t) => {
			if (t !== null && t !== undefined && (next === null || t < next)) next = t;
		};
		for (const room of this.rooms.values()) {
			consider(room.timers.endGame);
			consider(room.timers.seriesReady);
			if (room.reports) consider(room.reports.createdAt + STALE_REPORTS_MS);
			if (!room.lobby.InGame) for (const link of Object.values(room.connectivity)) if (link.since !== undefined) consider(link.since + CONNECTION_CHECK_MS);
			consider(this.autoStartAt(room));
		}
		return next;
	}

	// ---- connections and lobbies ----

	send(conn, name, body) {
		conn.send(`{"${name}":${JSON.stringify(body)}}`);
	}

	members(room) {
		const id = room.lobby.RoomId;
		const conns = [];
		for (const conn of this.conns.values()) if (conn.state.roomId === id) conns.push(conn);
		return conns;
	}

	connOfPeer(peer) {
		for (const conn of this.conns.values()) if (conn.state.peer === peer) return conn;
		return null;
	}

	sendToLobby(room, name, body = {}) {
		for (const conn of this.members(room)) this.send(conn, name, body);
	}

	// Stores the lobby and sends it to every member (send_lobby_update).
	sendLobbyUpdate(room) {
		this.persist?.save(room);
		this.sendToLobby(room, "LobbyUpdate", { lobby: room.lobby });
	}

	roomOf(conn) {
		return conn.state.roomId ? this.rooms.get(conn.state.roomId) ?? null : null;
	}

	// The room in which the connection is a player (a device's players share its peer id).
	playingRoomOf(conn) {
		const room = this.roomOf(conn);
		return room && room.lobby.Players.some((p) => p.RoomPeerId === conn.state.peer) ? room : null;
	}

	playerOf(room, conn) {
		return room.lobby.Players.find((p) => p.RoomPeerId === conn.state.peer && !isGuest(p)) ?? null;
	}

	isHost(room, conn) {
		return room.lobby.Players.some((p) => p.RoomPeerId === conn.state.peer && p.IsHost);
	}

	attach(conn, room, peer) {
		conn.state.roomId = room ? room.lobby.RoomId : null;
		conn.state.peer = peer;
		conn.save?.();
	}

	newSeed() {
		return this.fixedSeed ?? Math.floor(this.random() * 100000);
	}

	newCode() {
		const used = new Set([...this.rooms.values()].map((r) => r.lobby.JoinCode));
		for (;;) {
			let code = "";
			for (let i = 0; i < CODE_LENGTH; i++) code += CODE_CHARS[Math.floor(this.random() * CODE_CHARS.length)];
			if (!used.has(code)) return code;
		}
	}

	newRoom(lobby, now) {
		return { lobby, timers: { endGame: null, seriesReady: null }, connectivity: {}, membershipChangedAt: now, allReadySince: null, inGameSince: null, reports: null };
	}

	maxPlayers(lobby) {
		return Math.min(MAX_PLAYERS, Math.max(2, lobby.MaxPlayers));
	}

	isFull(lobby) {
		return lobby.Players.length >= this.maxPlayers(lobby);
	}

	freeSeats(lobby) {
		return Math.max(0, this.maxPlayers(lobby) - lobby.Players.length);
	}

	// The smallest MaxPlayers the lobby can take: its players, room for another device beside the largest one, 2 (min_max_players).
	minMaxPlayers(lobby) {
		const largestDevice = Math.max(1, ...lobby.Players.map((p) => p.LocalIndex + 1));
		return Math.max(lobby.Players.length, largestDevice + 1, 2);
	}

	// A device's guests after its owner, "<name> 2", "<name> 3", with the owner's custom variants (add_guests, guest_from).
	addGuests(lobby, owner, count) {
		for (let localIndex = 1; localIndex < count; localIndex++) {
			const guest = this.newMember(`${owner.Name} ${localIndex + 1}`, owner.RoomPeerId, false, this.firstFreeSeat(lobby));
			guest.Name = `${owner.Name} ${localIndex + 1}`; // (not cut to MAX_NAME, as guest_from)
			guest.LocalIndex = localIndex;
			guest.CustomVariants = [...owner.CustomVariants];
			lobby.Players.push(guest);
		}
	}

	firstFreeSeat(lobby) {
		for (let seat = 0; seat < MAX_PLAYERS; seat++) if (!lobby.Players.some((p) => p.Seat === seat)) return seat;
		return lobby.Players.length;
	}

	seriesInProgress(lobby) {
		return lobby.Series?.Status === "InProgress";
	}

	allPlayersReady(lobby) {
		return lobby.Players.length > 0 && lobby.Players.every((p) => p.Ready);
	}

	// One per device: guests share their device's room peer id.
	playerPeers(lobby) {
		return unique(lobby.Players.map((p) => p.RoomPeerId));
	}

	peerCount(lobby) {
		return this.playerPeers(lobby).length;
	}

	tooBig(lobby) {
		return JSON.stringify(lobby).length > MAX_LOBBY_JSON;
	}

	setInGame(room, inGame, now) {
		const lobby = room.lobby;
		room.inGameSince = inGame ? now : null;
		lobby.InGame = inGame;
		lobby.MatchPlayers = inGame ? structuredClone(lobby.Players) : [];
	}

	// Ready flags changed: when everyone became ready (secs_since_all_ready).
	refreshReady(room, now) {
		if (!this.allPlayersReady(room.lobby)) room.allReadySince = null;
		else room.allReadySince ??= now;
	}

	membershipChanged(room, now) {
		room.membershipChangedAt = now;
		this.refreshReady(room, now);
		this.updateDirect(room, now);
		this.refreshCheckingConnections(room);
	}

	// A Player as TF.EX sends it, with the fields the server owns.
	player(sent, own) {
		const p = sent && typeof sent === "object" ? sent : {};
		const team = int(p.Team, -1);
		return {
			Name: own.LocalIndex > 0 ? own.Name : clean(p.Name, MAX_NAME) || own.Name,
			ArcherIndex: int(p.ArcherIndex),
			ArcherAltIndex: int(p.ArcherAltIndex),
			Ready: p.Ready === true,
			RoomPeerId: own.RoomPeerId,
			IsHost: own.IsHost,
			Seat: own.Seat,
			Team: team >= -1 && team <= 1 ? team : -1,
			CustomArcherId: clean(p.CustomArcherId, 256),
			ArcherMods: strings(p.ArcherMods, 64, 128),
			StartsWithoutHat: typeof p.StartsWithoutHat === "boolean" ? p.StartsWithoutHat : null,
			CustomVariants: strings(p.CustomVariants, 256, 128),
			UseInstantReplay: p.UseInstantReplay === true,
			HaveModifiedGameFiles: p.HaveModifiedGameFiles === true,
			Platform: clean(p.Platform, 32),
			InputDelay: Number.isInteger(p.InputDelay) ? p.InputDelay : null,
			LocalIndex: own.LocalIndex ?? 0,
		};
	}

	newMember(name, peer, isHost, seat) {
		return this.player({ Name: name }, { Name: clean(name, MAX_NAME) || "PLAYER", RoomPeerId: peer, IsHost: isHost, Seat: seat });
	}

	gameData(sent, seed) {
		const g = sent && typeof sent === "object" ? sent : {};
		return {
			MapId: int(g.MapId, -1),
			Mode: int(g.Mode, 3),
			MatchLength: int(g.MatchLength, 2),
			Variants: strings(g.Variants, 256, 128),
			Seed: seed,
			BestOf: int(g.BestOf, 0),
		};
	}

	mods(list) {
		if (!Array.isArray(list)) return [];
		return list.slice(0, 64).map((m) => {
			const data = {};
			for (const [k, v] of Object.entries(m?.Data && typeof m.Data === "object" ? m.Data : {}).slice(0, 32)) data[clean(k, 64)] = clean(v, 256);
			return { Name: clean(m?.Name, 128), Data: data };
		});
	}

	// WiderSet changes level geometry, so wide and standard players never meet in quick play.
	lobbyIsWide(lobby) {
		return lobby.Mods.some((m) => m.Name === WIDER_SET_MOD_NAME && String(m.Data?.IsWide ?? "").toLowerCase() === "true");
	}

	newLobby({ name, roomId, maxPlayers, players, gameData, mods, kind, joinCode }) {
		return {
			Name: name,
			RoomId: roomId,
			MaxPlayers: Math.min(MAX_PLAYERS, Math.max(2, maxPlayers)),
			Players: players,
			Spectators: [],
			GameData: gameData,
			EndGameChoice: null,
			InGame: false,
			MatchPlayers: [],
			Mods: mods,
			Kind: kind,
			JoinCode: joinCode,
			Series: null,
			RankedSeats: [],
			RelayedPairs: [],
			IsCheckingConnections: false,
			IsReportEnabled: this.reportsEnabled,
		};
	}

	// ---- leaving (remove_from_lobbies, purge_lobby_async) ----

	// Leaves whatever lobby the connection is in. Returns whether it was in one.
	leave(conn, now) {
		const room = this.roomOf(conn);
		const peer = conn.state.peer;
		this.attach(conn, null, null);
		if (!room) return false;
		this.removeFromLobby(room, peer, now);
		return true;
	}

	removeFromLobby(room, peer, now) {
		const lobby = room.lobby;
		const seatedBefore = lobby.Players.length;
		lobby.Players = lobby.Players.filter((p) => p.RoomPeerId !== peer);
		lobby.Spectators = lobby.Spectators.filter((p) => p.RoomPeerId !== peer);
		if (lobby.Players.length !== seatedBefore) {
			if (this.seriesInProgress(lobby)) this.abortSeries(room, "PLAYER LEFT");
			this.membershipChanged(room, now);
		} else room.membershipChangedAt = now;
		this.promoteHostIfNeeded(lobby);
		this.sendLobbyUpdate(room);
		this.purge(room);
		if (this.rooms.has(lobby.RoomId) && lobby.Kind === "QuickPlay") this.drainQueueIntoOpenLobbies(now);
	}

	promoteHostIfNeeded(lobby) {
		if (!["QuickPlay", "Ranked"].includes(lobby.Kind) || lobby.Players.length === 0 || lobby.Players.some((p) => p.IsHost)) return;
		const owners = lobby.Players.filter((p) => !isGuest(p));
		if (!owners.length) return;
		const lowest = owners.reduce((a, b) => (b.Seat < a.Seat ? b : a));
		lowest.IsHost = true;
	}

	// An empty lobby, or one without a host (its host left a Standard or Private lobby; TF.EX leaves those: "Host left the
	// game"), goes away.
	purge(room) {
		const lobby = room.lobby;
		if (lobby.Players.length > 0 && lobby.Players.some((p) => p.IsHost)) return;
		for (const conn of this.members(room)) this.attach(conn, null, null);
		this.rooms.delete(lobby.RoomId);
		this.persist?.remove(lobby.RoomId);
		this.log(`[lobby] ${lobby.RoomId} closed`);
	}

	// ---- joining (seat_member) ----

	seatMember(conn, room, name, isPlayer, now, local = 1) {
		const lobby = room.lobby;
		if (isPlayer) {
			if (local === null) return { error: "Invalid local player count" };
			if (this.freeSeats(lobby) < local) return { error: `Lobby ${lobby.RoomId} is full` };
			if (lobby.InGame) return { error: `Lobby ${lobby.RoomId} already started` };
			if (this.seriesInProgress(lobby)) return { error: `Lobby ${lobby.RoomId} has a series running` };
		} else if (lobby.Spectators.length >= MAX_SPECTATORS) return { error: `Lobby ${lobby.RoomId} is full` };
		const peer = crypto.randomUUID();
		const member = this.newMember(name || conn.state.name, peer, false, -1);
		conn.state.name = member.Name;
		this.attach(conn, room, peer);
		if (isPlayer) {
			member.Seat = this.firstFreeSeat(lobby);
			lobby.Players.push(member);
			this.addGuests(lobby, member, local);
			this.membershipChanged(room, now);
		} else lobby.Spectators.push(member);
		this.log(`[lobby] ${member.Name} joined ${lobby.RoomId} as ${isPlayer ? "player" : "spectator"}`);
		return { peer };
	}

	// A spectator arriving mid-match: the host adds it to the running GGRS session.
	notifyHostOfLateSpectator(room, peer) {
		if (!room.lobby.InGame) return;
		const host = room.lobby.Players.find((p) => p.IsHost);
		const conn = host && this.connOfPeer(host.RoomPeerId);
		if (conn) this.send(conn, "SpectatorJoined", { room_peer_id: peer });
	}

	// ---- the connection check (connectivity.rs; no relay on Workers) ----

	// Every pair of devices among the players gets CONNECTION_CHECK_MS from when it appears; a PeerMeasured either way settles
	// it, otherwise it fails (and, with no relay, TF.EX tries it directly anyway).
	updateDirect(room, now) {
		const peers = this.playerPeers(room.lobby);
		const current = new Set();
		for (let i = 0; i < peers.length; i++) for (let j = i + 1; j < peers.length; j++) current.add(pairKey(peers[i], peers[j]));
		for (const key of Object.keys(room.connectivity)) if (!current.has(key)) delete room.connectivity[key];
		for (const key of current) {
			const link = (room.connectivity[key] ??= { since: now });
			if (link.since !== undefined && now - link.since >= CONNECTION_CHECK_MS) {
				room.connectivity[key] = { failed: true };
				this.log(`[lobby] ${room.lobby.RoomId}: ${key} could not connect`);
			}
		}
	}

	isCheckingConnections(room) {
		const peers = this.playerPeers(room.lobby);
		for (let i = 0; i < peers.length; i++)
			for (let j = i + 1; j < peers.length; j++) {
				const link = room.connectivity[pairKey(peers[i], peers[j])];
				if (!link || link.since !== undefined) return true;
			}
		return false;
	}

	// Returns whether IsCheckingConnections flipped.
	refreshCheckingConnections(room) {
		const checking = this.isCheckingConnections(room);
		const changed = checking !== room.lobby.IsCheckingConnections;
		room.lobby.IsCheckingConnections = checking;
		return changed;
	}

	connectivityTick(room, now) {
		if (room.lobby.InGame) return;
		this.updateDirect(room, now);
		const changed = this.refreshCheckingConnections(room);
		if (changed && this.allPlayersReady(room.lobby)) this.sendLobbyUpdate(room);
		if (changed && !room.lobby.IsCheckingConnections && room.lobby.Series) this.tryStartSeriesGame(room, now);
	}

	recordPeerMeasured(conn, peer, now) {
		const room = this.playingRoomOf(conn);
		const own = conn.state.peer;
		if (!room || room.lobby.InGame || own === peer || !room.lobby.Players.some((p) => p.RoomPeerId === peer)) return;
		const key = pairKey(own, peer);
		if (!room.connectivity[key]?.failed) room.connectivity[key] = { reached: true };
		if (!this.refreshCheckingConnections(room)) return;
		if (this.allPlayersReady(room.lobby)) this.sendLobbyUpdate(room);
		if (room.lobby.Series) this.tryStartSeriesGame(room, now);
	}

	// ---- starting (start_lobby) ----

	// Returns why it was refused, or null.
	startLobby(conn, now) {
		const room = this.playingRoomOf(conn);
		if (!room) return "Lobby not found";
		const lobby = room.lobby;
		if (lobby.Kind === "Ranked") return "Ranked matches start automatically";
		if (!this.isHost(room, conn)) return "Only the host can start the lobby";
		if (lobby.InGame) return "Lobby already started";
		if (lobby.IsCheckingConnections) return "Connections are still being checked";
		if (this.peerCount(lobby) < 2) return "Waiting for another player";
		let seriesStarted = false;
		if (lobby.GameData.BestOf > 0) {
			if (this.seriesInProgress(lobby)) return "Series already running";
			const error = this.startSeries(room);
			if (error) return error;
			if (!this.beginSeriesGame(room)) return "No tower available for the series";
			seriesStarted = true;
		}
		lobby.EndGameChoice ??= [];
		this.setInGame(room, true, now);
		this.log(`[lobby] ${lobby.RoomId} started (${lobby.Players.map((p) => p.Name).join(" vs ")})`);
		if (seriesStarted) this.sendLobbyUpdate(room);
		else this.persist?.save(room);
		this.sendToLobby(room, "StartLobby", {});
		return null;
	}

	// ---- match results (match_report.rs) ----

	// One report per device; once every device has sent one they are compared, and a series records the result.
	handleMatchReport(conn, report, now) {
		const room = this.playingRoomOf(conn);
		if (!room || room.lobby.Players.filter((p) => !isGuest(p)).length < 2) return;
		const devices = this.playerPeers(room.lobby).length;
		room.reports ??= { createdAt: now, byDevice: {} };
		if (room.reports.byDevice[conn.state.peer]) return;
		room.reports.byDevice[conn.state.peer] = report;
		const reports = Object.values(room.reports.byDevice);
		if (reports.length < devices) return;
		room.reports = null;
		const [first, ...others] = reports;
		const sameChecksum = others.every((o) => !(first.frame !== null && first.frame === o.frame) || first.checksum === null || o.checksum === null || first.checksum === o.checksum);
		const sameWinner = others.every((o) => o.winner_seat === first.winner_seat);
		const sameScores = others.every((o) => first.scores === null || o.scores === null || JSON.stringify(first.scores) === JSON.stringify(o.scores));
		if (!(sameWinner && sameScores) || !sameChecksum) {
			this.log(`[lobby] ${room.lobby.RoomId}: match reports differ (winner ${sameWinner}, scores ${sameScores}, checksum ${sameChecksum}): ${reports.map((r) => `seat ${r.winner_seat} scores ${JSON.stringify(r.scores)} at frame ${r.frame}`).join(", ")}`);
		}
		this.recordSeriesResult(room, sameWinner && sameScores, first.winner_seat, first.scores ?? []);
	}

	// ---- end of match (end_game.rs) ----

	startEndGameCountdown(room, now) {
		if (room.timers.endGame !== null) return;
		room.timers.endGame = now + END_GAME_CHOICE_MS;
		room.inGameSince = null;
		this.log(`[lobby] ${room.lobby.RoomId}: end game choice window open (${END_GAME_CHOICE_MS / 1000} s)`);
	}

	recordChoice(conn, choice) {
		const room = this.playingRoomOf(conn);
		if (!room) return null;
		const lobby = room.lobby;
		if (lobby.EndGameChoice === null) return room; // (the game isn't over, or already over)
		const vote = lobby.EndGameChoice.find((v) => v.RoomPeerId === conn.state.peer);
		if (vote) vote.Choice = choice;
		else lobby.EndGameChoice.push({ RoomPeerId: conn.state.peer, Choice: choice });
		return room;
	}

	// Everyone voted, or the window ran out (force): a rematch if all voted for one, the series in a series lobby, archer select
	// otherwise; everyone un-ready and a new seed either way.
	resolveEndGame(room, force, now) {
		const lobby = room.lobby;
		if (force && room.timers.endGame === null) return;
		if (lobby.EndGameChoice === null) return;
		const devices = this.playerPeers(lobby);
		const votes = lobby.EndGameChoice.filter((v) => devices.includes(v.RoomPeerId));
		const undecided = devices.filter((peer) => !votes.some((v) => v.RoomPeerId === peer));
		if (undecided.length && !force) return;
		const rematch = undecided.length === 0 && votes.length > 0 && votes.every((v) => v.Choice === "Rematch");
		const seriesLobby = lobby.Series !== null;
		if (lobby.Players.length) {
			for (const p of lobby.Players) p.Ready = false;
			lobby.EndGameChoice = [];
			lobby.GameData.Seed = this.newSeed();
			this.refreshReady(room, now);
			if (seriesLobby) {
				if (lobby.Series.AwaitingResult) this.abortSeries(room, "MISSING RESULT");
				this.setInGame(room, false, now);
			} else this.setInGame(room, rematch, now);
		}
		room.timers.endGame = null;
		room.reports = null;
		if (!lobby.Players.length) return this.purge(room);
		if (undecided.length) this.log(`[lobby] ${lobby.RoomId}: end game: ${undecided.length} device(s) undecided -> archer select`);
		this.sendLobbyUpdate(room);
		if (seriesLobby) return this.continueSeries(room, now);
		this.sendToLobby(room, rematch ? "RematchLobby" : "ArcherSelectLobby", {});
		if (!rematch && lobby.Kind === "QuickPlay") this.drainQueueIntoOpenLobbies(now);
	}

	// ---- series (series.rs) ----

	seriesSides(lobby) {
		const seats = lobby.Players.map((p) => p.Seat).sort((a, b) => a - b);
		if (seats.length === 2) return { sides: seats.map((s) => [s]) };
		if (lobby.GameData.Mode !== TEAM_DEATHMATCH || seats.length !== 2 * SERIES_TEAM_SIZE) return { error: "A series needs a 1v1 or a 2v2 team deathmatch" };
		const sides = [0, 1].map((team) => lobby.Players.filter((p) => p.Team === team).map((p) => p.Seat).sort((a, b) => a - b));
		if (sides.some((side) => side.length !== SERIES_TEAM_SIZE)) return { error: "A 2v2 series needs two full teams" };
		return { sides };
	}

	// Returns why it can't start, or null.
	startSeries(room) {
		const { sides, error } = this.seriesSides(room.lobby);
		if (error) return error;
		const series = { BestOf: room.lobby.GameData.BestOf, Sides: sides, Games: [], Status: "InProgress", WinnerSide: null, PickerSide: null, NextMapId: null, AbortReason: null, AwaitingResult: false, Picks: [], ForfeitSide: null };
		series.NextMapId = this.randomUnplayedMap(series);
		room.lobby.Series = series;
		return null;
	}

	randomUnplayedMap(series) {
		const open = [...Array(SERIES_TOWER_COUNT).keys()].filter((m) => this.isMapAvailable(series, m));
		return open.length ? open[Math.floor(this.random() * open.length)] : null;
	}

	isMapAvailable(series, map) {
		return Number.isInteger(map) && map >= 0 && map < SERIES_TOWER_COUNT && !series.Games.some((g) => g.MapId === map);
	}

	sideOfSeat(series, seat) {
		const side = series.Sides.findIndex((seats) => seats.includes(seat));
		return side >= 0 ? side : null;
	}

	beginSeriesGame(room) {
		const series = room.lobby.Series;
		if (!series || series.NextMapId === null) return false;
		room.lobby.GameData.MapId = series.NextMapId;
		series.NextMapId = null;
		series.AwaitingResult = true;
		series.Picks = [];
		return true;
	}

	abortSeries(room, reason) {
		const series = room.lobby.Series;
		if (!series || series.Status !== "InProgress") return;
		Object.assign(series, { Status: "Aborted", AbortReason: reason, PickerSide: null, NextMapId: null, Picks: [], AwaitingResult: false });
		room.timers.seriesReady = null;
		this.log(`[lobby] ${room.lobby.RoomId}: series aborted (${reason})`);
	}

	// winner_seat is a lobby seat (TF.EX's game player index is the seat).
	recordSeriesResult(room, agreed, winnerSeat, scores) {
		const series = room.lobby.Series;
		if (!series || series.Status !== "InProgress") return;
		if (!agreed) return this.abortSeries(room, "RESULT MISMATCH");
		if (!Number.isInteger(winnerSeat) || winnerSeat < 0) return this.abortSeries(room, "NO WINNER");
		const side = this.sideOfSeat(series, winnerSeat);
		if (side === null) return this.abortSeries(room, "BAD RESULT");
		series.Games.push({ MapId: room.lobby.GameData.MapId, WinnerSide: side, Scores: scores.map((s) => int(s)) });
		series.AwaitingResult = false;
		series.NextMapId = null;
		series.Picks = [];
		if (series.Games.filter((g) => g.WinnerSide === side).length >= Math.floor(series.BestOf / 2) + 1) {
			Object.assign(series, { Status: "Finished", WinnerSide: side, PickerSide: null });
		} else {
			series.PickerSide = series.Sides.findIndex((_, i) => i !== side);
		}
	}

	// Returns why the pick was refused, or null.
	pickSeriesMap(room, seat, map) {
		const series = room.lobby.Series;
		if (!series) return "No series in this lobby";
		if (series.Status !== "InProgress") return "Series is not in progress";
		if (series.AwaitingResult) return "A game is still running";
		if (this.sideOfSeat(series, seat) !== series.PickerSide) return "Not your pick";
		if (!this.isMapAvailable(series, map)) return `Tower ${map} already played or unknown`;
		const pick = series.Picks.find((p) => p.Seat === seat);
		if (pick) pick.MapId = map;
		else series.Picks.push({ Seat: seat, MapId: map });
		// Every seat of the picker side has picked: their tower if they agree, a draw between their picks otherwise.
		series.NextMapId = series.Picks.length < series.Sides[series.PickerSide].length ? null : this.drawAmongPicks(series);
		return null;
	}

	drawAmongPicks(series) {
		const choices = unique(series.Picks.map((p) => p.MapId)).sort((a, b) => a - b);
		return choices.length ? choices[Math.floor(this.random() * choices.length)] : null;
	}

	continueSeries(room, now) {
		const series = room.lobby.Series;
		if (series.Status === "Aborted") return this.sendToLobby(room, room.lobby.Kind === "Ranked" ? "SeriesLobby" : "ArcherSelectLobby", {});
		this.sendToLobby(room, "SeriesLobby", {});
		if (series.Status === "InProgress") room.timers.seriesReady = now + SERIES_READY_MS;
	}

	tryStartSeriesGame(room, now) {
		const lobby = room.lobby;
		const series = lobby.Series;
		if (!series || lobby.InGame || !this.allPlayersReady(lobby) || lobby.IsCheckingConnections || this.peerCount(lobby) < 2) return;
		if (series.Status === "InProgress") {
			if (series.AwaitingResult || series.NextMapId === null) return;
		} else if (series.Status === "Finished") {
			if (lobby.Kind === "Ranked" || this.startSeries(room)) return;
		} else return;
		if (!this.beginSeriesGame(room)) return;
		lobby.EndGameChoice ??= [];
		this.setInGame(room, true, now);
		room.timers.seriesReady = null;
		this.log(`[lobby] ${lobby.RoomId} started (${lobby.Players.map((p) => p.Name).join(" vs ")}), series game ${series.Games.length + 1} on tower ${lobby.GameData.MapId}`);
		this.sendLobbyUpdate(room);
		this.sendToLobby(room, "StartLobby", {});
	}

	expireSeriesWait(room, now) {
		room.timers.seriesReady = null;
		const lobby = room.lobby;
		if (lobby.InGame || !this.seriesInProgress(lobby)) return;
		const series = lobby.Series;
		if (series.NextMapId === null) series.NextMapId = this.drawAmongPicks(series) ?? this.randomUnplayedMap(series);
		const forced = lobby.Players.filter((p) => !p.Ready).length;
		for (const p of lobby.Players) p.Ready = true;
		this.refreshReady(room, now);
		if (forced) this.log(`[lobby] ${lobby.RoomId}: series ready window over, ${forced} player(s) readied`);
		this.sendLobbyUpdate(room);
		this.tryStartSeriesGame(room, now);
	}

	// ---- quick play (quickplay.rs) ----

	queued() {
		return [...this.conns.values()].filter((c) => c.state.quickPlay).sort((a, b) => a.state.quickPlay.since - b.state.quickPlay.since);
	}

	queueCounts() {
		const queue = this.queued();
		const wide = queue.filter((c) => c.state.quickPlay.wide).length;
		return { standard: queue.length - wide, wide };
	}

	exitQuickPlay(conn) {
		if (!conn.state.quickPlay) return;
		conn.state.quickPlay = null;
		conn.save?.();
		this.pushQueueStatus();
	}

	pushQueueStatus() {
		const counts = this.queueCounts();
		for (const conn of this.queued()) this.send(conn, "QuickPlayStatus", { queued: true, searching_standard: counts.standard, searching_wide: counts.wide, message: "" });
	}

	nearestOpenQuickPlay(wide, local) {
		for (const room of this.rooms.values()) {
			const l = room.lobby;
			if (l.Kind === "QuickPlay" && !l.InGame && this.freeSeats(l) >= local && this.lobbyIsWide(l) === wide && l.Players.some((p) => p.IsHost)) return room;
		}
		return null;
	}

	// A seat in an open quick play lobby, else a new lobby with the oldest searcher of the same width, else the queue.
	enterQuickPlay(conn, name, wide, now, local = 1) {
		conn.state.quickPlay = null;
		if (local === null) return this.send(conn, "QuickPlayStatus", { queued: false, searching_standard: 0, searching_wide: 0, message: "Invalid local player count" });
		const open = this.nearestOpenQuickPlay(wide, local);
		if (open) {
			const seated = this.seatMember(conn, open, name, true, now, local);
			if (seated.error) return this.send(conn, "QuickPlayStatus", { queued: false, searching_standard: 0, searching_wide: 0, message: seated.error });
			this.send(conn, "QuickPlayMatchFound", { lobby: open.lobby, room_peer_id: seated.peer });
			this.sendLobbyUpdate(open);
			this.pushQueueStatus();
			return;
		}
		const partner = this.queued().find((c) => c !== conn && c.state.quickPlay.wide === wide && (c.state.quickPlay.local ?? 1) + local <= MAX_PLAYERS);
		if (partner) {
			const partnerName = partner.state.quickPlay.name;
			const partnerLocal = partner.state.quickPlay.local ?? 1;
			partner.state.quickPlay = null;
			const partnerPeer = crypto.randomUUID();
			const callerPeer = crypto.randomUUID();
			const host = this.newMember(partnerName, partnerPeer, true, 0);
			const lobby = this.newLobby({
				name: "QUICK PLAY",
				roomId: crypto.randomUUID(),
				maxPlayers: MAX_PLAYERS,
				players: [host],
				gameData: { MapId: -1, Mode: 3, MatchLength: 2, Variants: [], Seed: this.newSeed(), BestOf: 0 },
				mods: wide ? [{ Name: WIDER_SET_MOD_NAME, Data: { IsWide: "True" } }] : [],
				kind: "QuickPlay",
				joinCode: null,
			});
			this.addGuests(lobby, host, partnerLocal);
			const room = this.newRoom(lobby, now);
			this.rooms.set(lobby.RoomId, room);
			partner.state.name = host.Name;
			this.attach(partner, room, partnerPeer);
			const caller = this.newMember(name || conn.state.name, callerPeer, false, this.firstFreeSeat(lobby));
			conn.state.name = caller.Name;
			lobby.Players.push(caller);
			this.addGuests(lobby, caller, local);
			this.attach(conn, room, callerPeer);
			this.membershipChanged(room, now);
			this.persist?.save(room);
			this.log(`[quickplay] matched ${lobby.Players.map((p) => p.Name).join(" vs ")}`);
			this.send(conn, "QuickPlayMatchFound", { lobby, room_peer_id: callerPeer });
			this.send(partner, "QuickPlayMatchFound", { lobby, room_peer_id: partnerPeer });
			this.pushQueueStatus();
			return;
		}
		conn.state.quickPlay = { wide, name: name || conn.state.name || "PLAYER", since: now, local };
		conn.save?.();
		this.pushQueueStatus();
	}

	// Waiting players into quick play lobbies that have a seat open (drain_queue_into_open_lobbies).
	drainQueueIntoOpenLobbies(now) {
		let seatedAny = false;
		for (const conn of this.queued()) {
			const local = conn.state.quickPlay.local ?? 1;
			const room = this.nearestOpenQuickPlay(conn.state.quickPlay.wide, local);
			if (!room) continue;
			const name = conn.state.quickPlay.name;
			conn.state.quickPlay = null;
			const seated = this.seatMember(conn, room, name, true, now, local);
			if (seated.error) continue;
			seatedAny = true;
			this.send(conn, "QuickPlayMatchFound", { lobby: room.lobby, room_peer_id: seated.peer });
			this.sendLobbyUpdate(room);
		}
		if (seatedAny) this.pushQueueStatus();
	}

	// When a quick play lobby may start by itself (should_auto_start), or null: two or more players, all ready, connections
	// checked, and full, or nobody joined, left or un-readied for the grace time.
	autoStartAt(room) {
		const l = room.lobby;
		if (l.Kind !== "QuickPlay" || l.InGame || l.IsCheckingConnections || room.allReadySince === null || this.peerCount(l) < 2) return null;
		if (this.isFull(l)) return room.allReadySince;
		return Math.max(room.allReadySince, room.membershipChangedAt) + QUICK_PLAY_AUTO_START_GRACE_MS;
	}

	autoStartQuickPlayLobbies(now) {
		for (const room of [...this.rooms.values()]) {
			const at = this.autoStartAt(room);
			if (at === null || now < at) continue;
			room.lobby.EndGameChoice ??= [];
			this.setInGame(room, true, now);
			this.log(`[lobby] ${room.lobby.RoomId} started (${room.lobby.Players.map((p) => p.Name).join(" vs ")}), quick play`);
			this.persist?.save(room);
			this.sendToLobby(room, "StartLobby", {});
		}
	}

	// ---- the lobby list (get_lobbies) ----

	listedLobbies() {
		const hide = (m) => ({ ...m, RoomPeerId: "" });
		return [...this.rooms.values()]
			.map((r) => r.lobby)
			.filter((l) => l.Players.some((p) => p.IsHost))
			.filter((l) => (l.Kind === "Standard" ? !this.isFull(l) || l.InGame || this.seriesInProgress(l) : l.Kind === "QuickPlay" ? l.InGame : false))
			.sort((a, b) => Number(a.InGame) - Number(b.InGame))
			.map((l) => ({ ...l, Players: l.Players.map(hide), Spectators: l.Spectators.map(hide), MatchPlayers: l.MatchPlayers.map(hide), EndGameChoice: l.EndGameChoice && l.EndGameChoice.map(hide) }));
	}

	// ---- for the platform ----

	// Counts only (no names or ids), for checking that nobody is mid-match before a redeploy, which disconnects everyone.
	stats() {
		const lobbies = [...this.rooms.values()].map((r) => r.lobby);
		const matches = lobbies.filter((l) => l.InGame);
		return {
			connections: this.conns.size,
			lobbies: lobbies.length,
			matches: matches.length,
			playersInMatches: matches.reduce((n, l) => n + l.Players.length, 0),
			searching: this.queued().length,
		};
	}

	// Whether `peer` is a player or spectator in lobby `roomId` (signaling rooms, TURN credentials).
	isMember(roomId, peer) {
		const lobby = this.rooms.get(roomId)?.lobby;
		return !!lobby && !!peer && [...lobby.Players, ...lobby.Spectators].some((m) => m.RoomPeerId === peer);
	}

	// Whether `peer` is a player (not a spectator) of lobby `roomId` and its match is on (the Switch match relay, relay.js).
	isPlayingIn(roomId, peer) {
		const lobby = this.rooms.get(roomId)?.lobby;
		return !!lobby && lobby.InGame && !!peer && lobby.Players.some((m) => m.RoomPeerId === peer);
	}
}

// Votes, as they show in EndGameChoice.
const CHOICES = { RematchLobbyChoice: "Rematch", ArcherSelectChoice: "Archer", SeriesContinueChoice: "Continue" };

function vote(conn, choice, now) {
	const room = this.recordChoice(conn, choice);
	if (!room) return;
	this.resolveEndGame(room, false, now);
	if (this.rooms.has(room.lobby.RoomId)) this.sendLobbyUpdate(room);
}

const handlers = {
	KeepAlive() {},

	Identify(conn, body) {
		const id = String(body.player_id ?? "");
		if (!(id.startsWith("steam:") || id.startsWith("local:")) || id.length > 64) return this.log(`[identify] invalid player id ${id.slice(0, 80)}`);
		conn.state.playerId = id;
		conn.state.name = clean(body.name, MAX_NAME);
	},

	GetLobbies(conn) {
		this.send(conn, "GetLobbiesResponse", { lobbies: this.listedLobbies() });
	},

	GetLeaderboard(conn, body, now) {
		if (now - (conn.state.lastLeaderboard ?? -Infinity) < LEADERBOARD_COOLDOWN_MS) return;
		conn.state.lastLeaderboard = now;
		this.send(conn, "Leaderboard", { entries: [], own: null, around: [], total: 0 });
	},

	GetPlayerProfile(conn, body, now) {
		if (now - (conn.state.lastProfile ?? -Infinity) < PROFILE_COOLDOWN_MS) return;
		conn.state.lastProfile = now;
		this.send(conn, "PlayerProfile", { rank: Number.isInteger(body.rank) ? body.rank : null, profile: null });
	},

	CreateLobby(conn, body, now) {
		const fail = (message) => this.send(conn, "CreateLobbyResponse", { success: false, message, lobby: null });
		this.exitQuickPlay(conn);
		this.leave(conn, now);
		const sent = body.lobby && typeof body.lobby === "object" ? body.lobby : {};
		if (sent.Kind === "Ranked") return fail("Ranked lobbies are automated");
		// TF.EX picks the room id (a GUID) and uses it for its own room URL straight away. (xnet-* names are the lobby-free relay
		// rooms', routes.js.)
		const roomId = String(sent.RoomId ?? "");
		if (!/^[A-Za-z0-9_-]{1,64}$/.test(roomId) || /^xnet-/i.test(roomId)) return fail("Bad room id");
		if (this.rooms.has(roomId)) return fail("Lobby with that room id already exists");
		const players = Array.isArray(sent.Players) ? sent.Players : [];
		if (!players.length) return fail("Host not found");
		const local = localPlayers(body.local_players);
		if (local === null) return fail("Invalid local player count");
		if (local >= Math.min(MAX_PLAYERS, Math.max(2, int(sent.MaxPlayers, MAX_PLAYERS)))) return fail("No room left for another player");
		const peer = crypto.randomUUID();
		const host = this.player(players[0], { Name: conn.state.name || "PLAYER", RoomPeerId: peer, IsHost: true, Seat: 0 });
		conn.state.name = host.Name;
		const kind = ["Standard", "Private", "QuickPlay"].includes(sent.Kind) ? sent.Kind : "Standard";
		const lobby = this.newLobby({
			name: clean(sent.Name, 64) || host.Name,
			roomId,
			maxPlayers: int(sent.MaxPlayers, MAX_PLAYERS),
			players: [host],
			gameData: this.gameData(sent.GameData, this.newSeed()),
			mods: this.mods(sent.Mods),
			kind,
			joinCode: kind === "Private" ? this.newCode() : null,
		});
		this.addGuests(lobby, host, local);
		if (this.tooBig(lobby)) return fail("Lobby too big");
		const room = this.newRoom(lobby, now);
		this.rooms.set(roomId, room);
		this.attach(conn, room, peer);
		this.persist?.save(room);
		this.log(`[lobby] ${host.Name} created ${kind} lobby ${roomId}${lobby.JoinCode ? ` (code ${lobby.JoinCode})` : ""}`);
		this.send(conn, "CreateLobbyResponse", { success: true, message: "", lobby });
	},

	JoinLobby(conn, body, now) {
		const roomId = String(body.room_id ?? "");
		const fail = (message) => this.send(conn, "JoinLobbyResponse", { success: false, message, room_peer_id: "", lobby: null });
		this.exitQuickPlay(conn);
		if (this.roomOf(conn) && this.roomOf(conn).lobby.RoomId !== roomId) this.leave(conn, now);
		if (this.playingRoomOf(conn)) return fail("Player already in a lobby");
		const room = this.rooms.get(roomId);
		if (!room) return fail(`Lobby ${roomId} not found`);
		if (room.lobby.Kind === "Ranked") return fail("Ranked matches can't be joined");
		if (this.roomOf(conn)) this.leave(conn, now); // (a spectator of this lobby joining again)
		const isPlayer = body.is_player !== false;
		const seated = this.seatMember(conn, room, clean(body.name, MAX_NAME), isPlayer, now, localPlayers(body.local_players));
		if (seated.error) return fail(seated.error);
		this.send(conn, "JoinLobbyResponse", { success: true, message: "", room_peer_id: seated.peer, lobby: room.lobby });
		this.sendLobbyUpdate(room);
		if (!isPlayer) this.notifyHostOfLateSpectator(room, seated.peer);
	},

	JoinPrivate(conn, body, now) {
		const fail = (message) => this.send(conn, "PrivateJoinResult", { success: false, message, room_peer_id: "", lobby: null });
		this.exitQuickPlay(conn);
		this.leave(conn, now);
		if (now - (conn.state.lastPrivateJoin ?? -Infinity) < PRIVATE_JOIN_COOLDOWN_MS) return fail("Too many attempts, wait a moment");
		conn.state.lastPrivateJoin = now;
		const code = String(body.code ?? "").trim().toUpperCase();
		const room = [...this.rooms.values()].find((r) => r.lobby.JoinCode === code);
		if (!room) return fail("Invalid or expired code");
		const isPlayer = body.is_player !== false;
		const seated = this.seatMember(conn, room, clean(body.name, MAX_NAME), isPlayer, now, localPlayers(body.local_players));
		if (seated.error) return fail(seated.error);
		this.send(conn, "PrivateJoinResult", { success: true, message: "", room_peer_id: seated.peer, lobby: room.lobby });
		this.sendLobbyUpdate(room);
		if (!isPlayer) this.notifyHostOfLateSpectator(room, seated.peer);
	},

	LeaveLobby(conn, body, now) {
		const left = this.leave(conn, now);
		this.send(conn, "LeaveLobbyResponse", left ? { success: true, message: "" } : { success: false, message: "Lobby not found" });
	},

	// The device's Player at the sent seat (a guest), else its owner; the server keeps peer id, host, seat, LocalIndex and a
	// guest's name (update_player).
	UpdatePlayer(conn, body, now) {
		const room = this.playingRoomOf(conn);
		if (!room) return;
		const lobby = room.lobby;
		const own = (p) => p.RoomPeerId === conn.state.peer;
		let index = lobby.Players.findIndex((p) => own(p) && p.Seat === body.player?.Seat);
		if (index < 0) index = lobby.Players.findIndex((p) => own(p) && !isGuest(p));
		const before = lobby.Players[index];
		const updated = this.player(body.player, before);
		if (!updated.CustomVariants.length) updated.CustomVariants = before.CustomVariants;
		lobby.Players[index] = updated;
		if (this.tooBig(lobby)) lobby.Players[index] = before;
		if (this.isFull(lobby) && lobby.EndGameChoice === null) lobby.EndGameChoice = [];
		this.refreshReady(room, now);
		this.sendLobbyUpdate(room);
		this.tryStartSeriesGame(room, now);
	},

	UpdateLobbySettings(conn, body, now) {
		const room = this.playingRoomOf(conn);
		if (!room) return;
		const lobby = room.lobby;
		if (lobby.Kind === "Ranked" || !this.isHost(room, conn) || lobby.InGame || this.seriesInProgress(lobby)) return;
		const before = { GameData: lobby.GameData, MaxPlayers: lobby.MaxPlayers, Mods: lobby.Mods, Series: lobby.Series };
		lobby.MaxPlayers = Math.min(MAX_PLAYERS, Math.max(this.minMaxPlayers(lobby), int(body.max_players, lobby.MaxPlayers)));
		lobby.GameData = this.gameData(body.game_data, lobby.GameData.Seed);
		lobby.Mods = this.mods(body.mods);
		lobby.Series = null;
		if (this.tooBig(lobby)) return void Object.assign(lobby, before);
		for (const p of lobby.Players) p.Ready = false;
		room.membershipChangedAt = now;
		this.refreshReady(room, now);
		this.sendLobbyUpdate(room);
	},

	StartLobbyChoice(conn, body, now) {
		const error = this.startLobby(conn, now);
		if (error) this.log(`[lobby] start refused: ${error}`);
	},

	PeerMeasured(conn, body, now) {
		this.recordPeerMeasured(conn, String(body.room_peer_id ?? ""), now);
	},

	MatchEnded(conn, body, now) {
		if (Number.isInteger(body.winner_seat)) {
			this.handleMatchReport(conn, {
				winner_seat: body.winner_seat,
				frame: Number.isInteger(body.frame) ? body.frame : null,
				checksum: typeof body.checksum === "string" ? body.checksum : null,
				scores: Array.isArray(body.scores) ? body.scores.map((s) => int(s)) : null,
			}, now);
		}
		const room = this.playingRoomOf(conn);
		if (room) this.startEndGameCountdown(room, now);
	},

	RematchLobbyChoice(conn, body, now) {
		vote.call(this, conn, CHOICES.RematchLobbyChoice, now);
	},

	ArcherSelectChoice(conn, body, now) {
		vote.call(this, conn, CHOICES.ArcherSelectChoice, now);
	},

	SeriesContinueChoice(conn, body, now) {
		vote.call(this, conn, CHOICES.SeriesContinueChoice, now);
	},

	SeriesPickMap(conn, body, now) {
		const room = this.playingRoomOf(conn);
		if (!room) return;
		const series = room.lobby.Series;
		const seats = room.lobby.Players.filter((p) => p.RoomPeerId === conn.state.peer).map((p) => p.Seat);
		const picking = series ? seats.filter((seat) => this.sideOfSeat(series, seat) === series.PickerSide) : seats.slice(0, 1);
		let error = picking.length ? null : "Not your pick";
		for (const seat of picking) error ??= this.pickSeriesMap(room, seat, body.map_id);
		if (error) return this.log(`[lobby] series pick refused: ${error}`);
		this.sendLobbyUpdate(room);
		this.tryStartSeriesGame(room, now);
	},

	EnterQuickPlay(conn, body, now) {
		this.leave(conn, now);
		this.enterQuickPlay(conn, clean(body.name, MAX_NAME), body.is_wide === true, now, localPlayers(body.local_players));
	},

	ExitQuickPlay(conn) {
		this.exitQuickPlay(conn);
		const counts = this.queueCounts();
		this.send(conn, "QuickPlayStatus", { queued: false, searching_standard: counts.standard, searching_wide: counts.wide, message: "" });
	},

	EnterRanked(conn, body, now) {
		this.leave(conn, now);
		this.send(conn, "RankedStatus", { queued: false, searching_standard: 0, searching_wide: 0, message: RANKED_UNAVAILABLE_MESSAGE });
	},

	ExitRanked(conn) {
		this.send(conn, "RankedStatus", { queued: false, searching_standard: 0, searching_wide: 0, message: "" });
	},

	// Relayed to the whole lobby, the sender included.
	SkinChunk(conn, body) {
		const room = this.playingRoomOf(conn);
		const c = body.chunk;
		if (!room || !c || typeof c !== "object") return;
		const ok = Number.isInteger(c.chunk_count) && Number.isInteger(c.chunk_index) && c.chunk_count > 0 && c.chunk_count <= MAX_SKIN_CHUNKS && c.chunk_index >= 0 && c.chunk_index < c.chunk_count
			&& typeof c.data === "string" && c.data.length <= MAX_SKIN_CHUNK_DATA && String(c.bundle_id ?? "").length <= 128 && String(c.custom_archer_id ?? "").length <= 256;
		if (!ok) return this.log("[skin] chunk rejected by size limits");
		const chunk = { bundle_id: String(c.bundle_id ?? ""), custom_archer_id: String(c.custom_archer_id ?? ""), chunk_index: c.chunk_index, chunk_count: c.chunk_count, data: c.data };
		this.sendToLobby(room, "SkinChunk", { chunk, from: conn.state.peer });
	},
};
