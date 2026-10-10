// Matchmaking at /ws, compatible with TF.EX's client (v0.19.1: src/network/TF.EX.Domain/Services/
// MatchmakingService.cs and the menus that call it). The protocol is read from that client; the
// official server isn't open source, so where the client leaves room the choices here are ours
// (docs/MULTIPLAYER.md lists them).
//
// Messages are JSON objects with one key, the message name. TF.EX sends them as binary frames and
// recognizes ours by their first characters ({"Name"), so the name always comes first. Lobby
// objects use TF.EX's field names (Lobby.cs, PascalCase); message fields are snake_case. Integers
// must stay integers and collections must never be null (TF.EX parses JSON via MessagePack).
//
// A connection (`conn`) is anything with an `id`, send(text), close(code, reason) and a `state`
// object that save() persists (a Durable Object keeps it with the socket through hibernation).
// Lobbies are kept as records { lobby, timers } and handed to `persist` when they change.

export const KEEPALIVE_MS = 30_000;
// Connections that send nothing for this long are dropped (TF.EX echoes every KeepAlive).
const IDLE_MS = 3 * KEEPALIVE_MS + 10_000;
// The end-of-match vote ("PICK IN 30" in TF.EX); undecided players go to archer select.
const VOTE_MS = 33_000;
// The series screen's "STARTS IN 60": then the server picks a tower if needed and starts.
const SERIES_PICK_MS = 62_000;
// Quick play starts this long after everyone has picked an archer ("MATCH STARTING...").
const QUICK_START_MS = 1_500;

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // JoinCodeEntry: A-Z without I and O, 2-9
const CODE_LENGTH = 5;
const MAX_NAME = 10; // NetplayPreferences.MaxNameLength
const MAX_PLAYERS = 4;
const TOWERS = 16; // TF.EX's netplay towers (Constants.cs): map ids 0..15, -1 random
const TEAM_DEATHMATCH = 5; // TowerFall.Modes
const MAX_SKIN_CHUNK = 320 * 1024; // 192 KiB per chunk, as base64

const clean = (s, max) => String(s ?? "").slice(0, max);
const int = (v, fallback = 0) => (Number.isInteger(v) ? v : fallback);
const strings = (list, n, max) => (Array.isArray(list) ? list.slice(0, n).map((s) => clean(s, max)) : []);

export class Matchmaker {
	constructor({ persist = null, log = () => {}, random = Math.random } = {}) {
		this.persist = persist;
		this.log = log;
		this.random = random;
		this.rooms = new Map(); // RoomId -> { lobby, timers: { vote, seriesPick, quickStart } }
		this.conns = new Map(); // conn.id -> conn
		this.keepAliveAt = 0;
	}

	// After a Durable Object wakes up: its lobbies from storage and the sockets still connected.
	// Members whose connection is gone are removed (everyone, after a redeploy).
	restore(rooms, conns) {
		for (const conn of conns) this.conns.set(conn.id, conn);
		for (const room of rooms) this.rooms.set(room.lobby.RoomId, room);
		for (const room of [...this.rooms.values()]) {
			const live = new Set(this.members(room).map((c) => c.state.peer));
			for (const m of [...room.lobby.Players, ...room.lobby.Spectators]) if (!live.has(m.RoomPeerId)) this.removeMember(room, m.RoomPeerId, Date.now());
		}
	}

	open(conn, now = Date.now()) {
		conn.state = { seen: now };
		conn.save?.();
		this.conns.set(conn.id, conn);
		if (this.keepAliveAt < now) this.keepAliveAt = now + KEEPALIVE_MS;
		this.send(conn, "KeepAlive", {});
	}

	close(conn, now = Date.now()) {
		if (!this.conns.has(conn.id)) return;
		this.leave(conn, now);
		this.conns.delete(conn.id);
	}

	message(conn, text, now = Date.now()) {
		if (!this.conns.has(conn.id)) this.conns.set(conn.id, conn);
		conn.state.seen = now;
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

	// Runs what is due: keep-alives (dropping silent connections) and lobby timers.
	wake(now = Date.now()) {
		if (now >= this.keepAliveAt) {
			this.keepAliveAt = now + KEEPALIVE_MS;
			for (const conn of [...this.conns.values()]) {
				if (now - (conn.state.seen ?? now) > IDLE_MS) {
					conn.close(4008, "no keep-alive");
					this.close(conn, now);
				} else this.send(conn, "KeepAlive", {});
			}
		}
		for (const room of [...this.rooms.values()]) {
			const t = room.timers;
			if (t.vote && now >= t.vote) this.resolveVote(room, now);
			if (t.quickStart && now >= t.quickStart) {
				t.quickStart = null;
				if (this.allReady(room.lobby)) this.start(room, now);
			}
			if (t.seriesPick && now >= t.seriesPick) this.forceSeriesStart(room, now);
		}
	}

	// When wake() should run next (null: nothing to do until a message arrives).
	nextWake() {
		let next = this.conns.size ? this.keepAliveAt || Date.now() : null;
		for (const room of this.rooms.values()) {
			for (const t of Object.values(room.timers)) if (t && (next === null || t < next)) next = t;
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

	sendAll(room, name, body = {}) {
		for (const conn of this.members(room)) this.send(conn, name, body);
	}

	// Stores the lobby and sends it to every member.
	changed(room) {
		this.persist?.save(room);
		this.sendAll(room, "LobbyUpdate", { lobby: room.lobby });
	}

	roomOf(conn) {
		return conn.state.roomId ? this.rooms.get(conn.state.roomId) ?? null : null;
	}

	playerOf(room, conn) {
		return room.lobby.Players.find((p) => p.RoomPeerId === conn.state.peer) ?? null;
	}

	isHost(room, conn) {
		return this.playerOf(room, conn)?.IsHost === true;
	}

	attach(conn, room, peer) {
		conn.state.roomId = room ? room.lobby.RoomId : null;
		conn.state.peer = peer;
		conn.save?.();
	}

	closeRoom(room) {
		for (const conn of this.members(room)) this.attach(conn, null, null);
		this.rooms.delete(room.lobby.RoomId);
		this.persist?.remove(room.lobby.RoomId);
		this.log(`[lobby] ${room.lobby.RoomId} closed`);
	}

	// Leaves whatever lobby or queue the connection is in.
	leave(conn, now) {
		this.leaveQuickPlay(conn);
		const room = this.roomOf(conn);
		const peer = conn.state.peer;
		this.attach(conn, null, null);
		if (!room) return false;
		this.removeMember(room, peer, now);
		return true;
	}

	removeMember(room, peer, now) {
		const lobby = room.lobby;
		const player = lobby.Players.find((p) => p.RoomPeerId === peer);
		lobby.Players = lobby.Players.filter((p) => p.RoomPeerId !== peer);
		lobby.Spectators = lobby.Spectators.filter((p) => p.RoomPeerId !== peer);
		lobby.EndGameChoice = lobby.EndGameChoice.filter((v) => v.RoomPeerId !== peer);
		if (player?.IsHost || lobby.Players.length === 0) {
			// TF.EX leaves a lobby whose host has gone (HandleLobbyUpdate: "Host left the game"), so
			// the others get it without a host once, and it closes. There's no host migration: the
			// host's role in the GGRS session is fixed when it joins.
			this.changed(room);
			this.closeRoom(room);
			return;
		}
		if (player && lobby.Series?.Status === "InProgress") this.abortSeries(room, "PLAYER LEFT");
		if (player && room.timers.vote && this.votesComplete(lobby)) {
			this.resolveVote(room, now);
			return;
		}
		this.changed(room);
	}

	// A Player as TF.EX sends it. The server keeps the fields it owns (peer id, seat, host, name).
	player(sent, own) {
		const p = sent && typeof sent === "object" ? sent : {};
		const team = int(p.Team, own.Team ?? -1);
		return {
			Name: own.Name,
			ArcherIndex: int(p.ArcherIndex),
			ArcherAltIndex: int(p.ArcherAltIndex),
			Ready: p.Ready === true,
			RoomPeerId: own.RoomPeerId,
			IsHost: own.IsHost,
			Seat: own.Seat,
			Team: team >= -1 && team <= 1 ? team : -1,
			CustomArcherId: clean(p.CustomArcherId, 128),
			ArcherMods: strings(p.ArcherMods, 64, 128),
			CustomVariants: strings(p.CustomVariants, 256, 128),
			UseInstantReplay: p.UseInstantReplay === true,
			HaveModifiedGameFiles: p.HaveModifiedGameFiles === true,
			Platform: clean(p.Platform, 32),
			InputDelay: Number.isInteger(p.InputDelay) ? p.InputDelay : null,
		};
	}

	newMember(name, isHost, seat) {
		return this.player({}, { Name: clean(name, MAX_NAME) || "PLAYER", RoomPeerId: crypto.randomUUID(), IsHost: isHost, Seat: seat, Team: -1 });
	}

	gameData(sent, keep) {
		const g = sent && typeof sent === "object" ? sent : {};
		const map = int(g.MapId, -1);
		return {
			MapId: map >= -1 && map < TOWERS ? map : -1,
			Mode: [3, 4, 5].includes(g.Mode) ? g.Mode : 3,
			MatchLength: int(g.MatchLength, 2) >= 0 && int(g.MatchLength, 2) <= 3 ? int(g.MatchLength, 2) : 2,
			Variants: strings(g.Variants, 256, 128),
			Seed: keep?.Seed ?? this.newSeed(),
			BestOf: keep ? keep.BestOf : [0, 1, 3, 5, 7].includes(g.BestOf) ? g.BestOf : 0,
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

	newCode() {
		const used = new Set([...this.rooms.values()].map((r) => r.lobby.JoinCode));
		for (;;) {
			let code = "";
			for (let i = 0; i < CODE_LENGTH; i++) code += CODE_CHARS[Math.floor(this.random() * CODE_CHARS.length)];
			if (!used.has(code)) return code;
		}
	}

	newSeed() {
		return Math.floor(this.random() * 0x7fffffff);
	}

	freeSeat(lobby) {
		for (let seat = 0; seat < lobby.MaxPlayers; seat++) if (!lobby.Players.some((p) => p.Seat === seat)) return seat;
		return -1;
	}

	seriesInProgress(lobby) {
		return lobby.Series?.Status === "InProgress";
	}

	// TF.EX's AreAllPlayersReady: two or more, all ready, and in team deathmatch two real teams.
	allReady(lobby) {
		if (lobby.Players.length < 2 || !lobby.Players.every((p) => p.Ready)) return false;
		if (lobby.GameData.Mode !== TEAM_DEATHMATCH) return true;
		const blue = lobby.Players.filter((p) => p.Team === 0).length;
		const red = lobby.Players.filter((p) => p.Team === 1).length;
		return blue + red === lobby.Players.length && blue > 0 && red > 0;
	}

	// ---- joining ----

	joinRefusal(room, asPlayer) {
		if (!room) return "LOBBY NOT FOUND";
		if (!asPlayer) return null;
		const lobby = room.lobby;
		if (lobby.InGame || this.seriesInProgress(lobby)) return "MATCH ALREADY STARTED";
		if (lobby.Players.length >= lobby.MaxPlayers) return "LOBBY FULL";
		return null;
	}

	// Adds the connection; returns its peer id. The caller answers it, then calls joined().
	join(conn, room, name, asPlayer, now) {
		this.leave(conn, now);
		const lobby = room.lobby;
		const member = this.newMember(name || conn.state.name, false, asPlayer ? this.freeSeat(lobby) : -1);
		(asPlayer ? lobby.Players : lobby.Spectators).push(member);
		this.attach(conn, room, member.RoomPeerId);
		this.log(`[lobby] ${member.Name} joined ${lobby.RoomId} as ${asPlayer ? "player" : "spectator"}`);
		return member.RoomPeerId;
	}

	joined(room, peer) {
		this.changed(room);
		// A spectator arriving mid-match: the host adds it to the running GGRS session.
		if (room.lobby.InGame && room.lobby.Spectators.some((s) => s.RoomPeerId === peer)) {
			this.sendAll(room, "SpectatorJoined", { room_peer_id: peer });
		}
	}

	// ---- matches ----

	// Everyone goes into the match: the lobby (InGame, new seed) first, then StartLobby.
	start(room, now) {
		const lobby = room.lobby;
		lobby.InGame = true;
		lobby.EndGameChoice = [];
		lobby.GameData.Seed = this.newSeed();
		room.timers.vote = null;
		room.timers.quickStart = null;
		room.timers.seriesPick = null;
		room.reported = false;
		this.log(`[lobby] ${lobby.RoomId} started (${lobby.Players.map((p) => p.Name).join(" vs ")})`);
		this.changed(room);
		this.sendAll(room, "StartLobby", {});
		void now;
	}

	vote(conn, choice, now) {
		const room = this.roomOf(conn);
		if (!room || !room.lobby.InGame) return;
		const peer = conn.state.peer;
		if (!this.playerOf(room, conn)) return;
		const lobby = room.lobby;
		lobby.EndGameChoice = lobby.EndGameChoice.filter((v) => v.RoomPeerId !== peer);
		lobby.EndGameChoice.push({ RoomPeerId: peer, Choice: choice });
		room.timers.vote ??= now + VOTE_MS;
		if (this.votesComplete(lobby)) return this.resolveVote(room, now);
		this.changed(room);
	}

	votesComplete(lobby) {
		return lobby.Players.every((p) => lobby.EndGameChoice.some((v) => v.RoomPeerId === p.RoomPeerId));
	}

	// Everyone voted, or time ran out: a rematch if all asked for one, the series screen in a
	// series, archer select otherwise. Each with a new seed.
	resolveVote(room, now) {
		const lobby = room.lobby;
		room.timers.vote = null;
		if (!lobby.InGame) return;
		const rematch = lobby.Players.length > 1 && lobby.Players.every((p) => lobby.EndGameChoice.some((v) => v.RoomPeerId === p.RoomPeerId && v.Choice === "Rematch"));
		lobby.EndGameChoice = [];
		lobby.GameData.Seed = this.newSeed();
		room.reported = false;
		if (lobby.Series) {
			lobby.InGame = false;
			for (const p of lobby.Players) p.Ready = false;
			if (this.seriesInProgress(lobby)) room.timers.seriesPick = now + SERIES_PICK_MS;
			this.sendAll(room, "SeriesLobby", {});
			this.changed(room);
		} else if (rematch) {
			// The lobby (new seed) must arrive before RematchLobby starts the next MapScene.
			this.changed(room);
			this.sendAll(room, "RematchLobby", {});
		} else {
			lobby.InGame = false;
			for (const p of lobby.Players) p.Ready = false;
			this.sendAll(room, "ArcherSelectLobby", {});
			this.changed(room);
		}
	}

	// ---- series (GameData.BestOf > 0) ----

	newSeries(room) {
		const lobby = room.lobby;
		const seats = lobby.Players.map((p) => p.Seat).sort((a, b) => a - b);
		const sides = lobby.GameData.Mode === TEAM_DEATHMATCH ? [0, 1].map((team) => lobby.Players.filter((p) => p.Team === team).map((p) => p.Seat).sort((a, b) => a - b)) : seats.map((s) => [s]);
		lobby.Series = { BestOf: lobby.GameData.BestOf, Sides: sides, Games: [], Status: "InProgress", WinnerSide: null, PickerSide: null, NextMapId: null, AbortReason: null, AwaitingResult: true, Picks: [] };
		lobby.GameData.MapId = Math.floor(this.random() * TOWERS);
	}

	sideOf(series, seat) {
		const side = series.Sides.findIndex((seats) => seats.includes(seat));
		return side >= 0 ? side : null;
	}

	seriesResult(room, report) {
		const lobby = room.lobby;
		const series = lobby.Series;
		if (!series || series.Status !== "InProgress" || !series.AwaitingResult) return;
		// winner_seat is a GGRS handle: the index among the players ordered by seat.
		const bySeat = [...lobby.Players].sort((a, b) => a.Seat - b.Seat);
		const winner = bySeat[report.winner_seat];
		const side = winner ? this.sideOf(series, winner.Seat) : null;
		const scores = [];
		for (const [handle, p] of bySeat.entries()) scores[p.Seat] = int(report.scores?.[handle]);
		for (let i = 0; i < scores.length; i++) scores[i] ??= 0;
		series.Games.push({ MapId: lobby.GameData.MapId, WinnerSide: side ?? -1, Scores: scores });
		series.AwaitingResult = false;
		series.Picks = [];
		series.NextMapId = null;
		const needed = Math.floor(series.BestOf / 2) + 1;
		if (side !== null && series.Games.filter((g) => g.WinnerSide === side).length >= needed) {
			series.Status = "Finished";
			series.WinnerSide = side;
			series.PickerSide = null;
		} else {
			// The side that lost picks the next tower (after a draw, the same side as before).
			series.PickerSide = side === null ? series.PickerSide ?? 0 : series.Sides.length === 2 ? 1 - side : null;
		}
	}

	abortSeries(room, reason) {
		const series = room.lobby.Series;
		series.Status = "Aborted";
		series.AbortReason = reason;
		series.AwaitingResult = false;
		room.timers.seriesPick = null;
	}

	pickerSeats(series, lobby) {
		return series.PickerSide === null ? [] : (series.Sides[series.PickerSide] ?? []).filter((s) => lobby.Players.some((p) => p.Seat === s));
	}

	settlePicks(series, lobby) {
		const seats = this.pickerSeats(series, lobby);
		if (seats.length && seats.every((s) => series.Picks.some((p) => p.Seat === s))) {
			const picks = series.Picks.map((p) => p.MapId);
			series.NextMapId = picks[Math.floor(this.random() * picks.length)];
		}
	}

	// On the series screen the match starts by itself once everyone is ready and the tower is
	// known (TF.EX never sends StartLobbyChoice there). A finished series restarts the same way.
	maybeStartSeries(room, now) {
		const lobby = room.lobby;
		const series = lobby.Series;
		if (!series || lobby.InGame || !this.allReady(lobby)) return false;
		if (series.Status === "Finished") {
			if (lobby.Players.length !== lobby.MaxPlayers) return false;
			this.newSeries(room);
		} else if (series.Status === "InProgress" && series.NextMapId !== null) {
			lobby.GameData.MapId = series.NextMapId;
			series.AwaitingResult = true;
		} else return false;
		this.start(room, now);
		return true;
	}

	forceSeriesStart(room, now) {
		room.timers.seriesPick = null;
		const lobby = room.lobby;
		const series = lobby.Series;
		if (!series || series.Status !== "InProgress" || lobby.InGame) return;
		if (series.NextMapId === null) {
			const played = new Set(series.Games.map((g) => g.MapId));
			const open = [...Array(TOWERS).keys()].filter((m) => !played.has(m));
			series.NextMapId = open[Math.floor(this.random() * open.length)] ?? 0;
		}
		for (const p of lobby.Players) p.Ready = true;
		if (!this.maybeStartSeries(room, now)) this.changed(room);
	}

	// ---- quick play ----

	leaveQuickPlay(conn) {
		if (!conn.state.quickPlay) return;
		conn.state.quickPlay = null;
		conn.save?.();
		this.quickPlayStatus();
	}

	queued() {
		return [...this.conns.values()].filter((c) => c.state.quickPlay).sort((a, b) => a.state.quickPlay.since - b.state.quickPlay.since);
	}

	quickPlayStatus() {
		const queue = this.queued();
		const standard = queue.filter((c) => !c.state.quickPlay.wide).length;
		const wide = queue.length - standard;
		for (const conn of queue) this.send(conn, "QuickPlayStatus", { queued: true, searching_standard: standard, searching_wide: wide, message: "" });
	}

	// Two players searching with the same screen width (WiderSet) make a match.
	matchQuickPlay(now) {
		for (const wide of [false, true]) {
			const queue = this.queued().filter((c) => c.state.quickPlay.wide === wide);
			while (queue.length >= 2) {
				const conns = queue.splice(0, 2);
				const lobby = {
					Name: clean(conns[0].state.quickPlay.name, MAX_NAME) || "QUICK PLAY",
					RoomId: crypto.randomUUID(),
					MaxPlayers: conns.length,
					Players: conns.map((c, seat) => this.newMember(c.state.quickPlay.name, seat === 0, seat)),
					Spectators: [],
					GameData: { MapId: -1, Mode: 3, MatchLength: 2, Variants: [], Seed: this.newSeed(), BestOf: 0 },
					EndGameChoice: [],
					Mods: [],
					InGame: false,
					Kind: "QuickPlay",
					JoinCode: "",
					Series: null,
					MissingVariants: [],
				};
				const room = { lobby, timers: { vote: null, seriesPick: null, quickStart: null } };
				this.rooms.set(lobby.RoomId, room);
				this.persist?.save(room);
				for (const [seat, conn] of conns.entries()) {
					conn.state.quickPlay = null;
					this.attach(conn, room, lobby.Players[seat].RoomPeerId);
					this.send(conn, "QuickPlayMatchFound", { lobby, room_peer_id: lobby.Players[seat].RoomPeerId });
				}
				this.log(`[quickplay] matched ${lobby.Players.map((p) => p.Name).join(" vs ")}`);
			}
		}
		void now;
	}
}

const handlers = {
	KeepAlive() {},

	Identify(conn, body) {
		conn.state.playerId = clean(body.player_id, 128);
		conn.state.name = clean(body.name, MAX_NAME);
	},

	GetLobbies(conn) {
		const lobbies = [...this.rooms.values()].map((r) => r.lobby).filter((l) => l.Kind === "Standard");
		this.send(conn, "GetLobbiesResponse", { lobbies });
	},

	CreateLobby(conn, body, now) {
		const fail = (message) => this.send(conn, "CreateLobbyResponse", { success: false, message, lobby: null });
		const sent = body.lobby;
		if (!sent || typeof sent !== "object") return fail("NO LOBBY");
		// TF.EX picks the room id (a GUID) and uses it for its own room URL straight away.
		const roomId = String(sent.RoomId ?? "");
		if (!/^[A-Za-z0-9_-]{1,64}$/.test(roomId)) return fail("BAD ROOM ID");
		if (this.rooms.has(roomId)) return fail("ROOM ID IN USE");
		this.leave(conn, now);
		const kind = sent.Kind === "Private" ? "Private" : "Standard";
		const players = Array.isArray(sent.Players) ? sent.Players : [];
		const sentHost = players.find((p) => p?.IsHost) ?? players[0];
		const name = clean(sentHost?.Name, MAX_NAME) || conn.state.name || "PLAYER";
		const host = this.player(sentHost, { Name: name, RoomPeerId: crypto.randomUUID(), IsHost: true, Seat: 0, Team: -1 });
		const gameData = this.gameData(sent.GameData);
		const minPlayers = gameData.Mode === TEAM_DEATHMATCH ? 3 : 2;
		const lobby = {
			Name: clean(sent.Name, MAX_NAME) || name,
			RoomId: roomId,
			MaxPlayers: Math.min(MAX_PLAYERS, Math.max(minPlayers, int(sent.MaxPlayers, 2))),
			Players: [host],
			Spectators: [],
			GameData: gameData,
			EndGameChoice: [],
			Mods: this.mods(sent.Mods),
			InGame: false,
			Kind: kind,
			JoinCode: kind === "Private" ? this.newCode() : "",
			Series: null,
			MissingVariants: [],
		};
		const room = { lobby, timers: { vote: null, seriesPick: null, quickStart: null } };
		this.rooms.set(roomId, room);
		this.attach(conn, room, host.RoomPeerId);
		this.persist?.save(room);
		this.log(`[lobby] ${name} created ${kind} lobby ${roomId}${lobby.JoinCode ? ` (code ${lobby.JoinCode})` : ""}`);
		this.send(conn, "CreateLobbyResponse", { success: true, message: "", lobby });
	},

	JoinLobby(conn, body, now) {
		const room = this.rooms.get(String(body.room_id ?? ""));
		const asPlayer = body.is_player !== false;
		const refusal = room?.lobby.Kind === "Standard" ? this.joinRefusal(room, asPlayer) : "LOBBY NOT FOUND";
		if (refusal) return this.send(conn, "JoinLobbyResponse", { success: false, message: refusal, room_peer_id: "", lobby: null });
		const peer = this.join(conn, room, clean(body.name, MAX_NAME), asPlayer, now);
		this.send(conn, "JoinLobbyResponse", { success: true, message: "", room_peer_id: peer, lobby: room.lobby });
		this.joined(room, peer);
	},

	JoinPrivate(conn, body, now) {
		const code = String(body.code ?? "").trim().toUpperCase();
		const room = code.length === CODE_LENGTH ? [...this.rooms.values()].find((r) => r.lobby.JoinCode === code) : undefined;
		const asPlayer = body.is_player !== false;
		const refusal = this.joinRefusal(room, asPlayer);
		if (refusal) return this.send(conn, "PrivateJoinResult", { success: false, message: refusal, room_peer_id: "", lobby: null });
		const peer = this.join(conn, room, clean(body.name, MAX_NAME), asPlayer, now);
		this.send(conn, "PrivateJoinResult", { success: true, message: "", room_peer_id: peer, lobby: room.lobby });
		this.joined(room, peer);
	},

	LeaveLobby(conn, body, now) {
		const left = this.leave(conn, now);
		this.send(conn, "LeaveLobbyResponse", { success: true, message: left ? "" : "NOT IN A LOBBY" });
	},

	// TF.EX waits for a LobbyUpdate after UpdatePlayer (its controllers stay locked until then).
	UpdatePlayer(conn, body, now) {
		const room = this.roomOf(conn);
		if (!room) return;
		const lobby = room.lobby;
		const index = lobby.Players.findIndex((p) => p.RoomPeerId === conn.state.peer);
		if (index < 0) return this.send(conn, "LobbyUpdate", { lobby });
		lobby.Players[index] = this.player(body.player, lobby.Players[index]);
		if (lobby.Kind === "QuickPlay" && !lobby.InGame) room.timers.quickStart = this.allReady(lobby) ? now + QUICK_START_MS : null;
		if (this.maybeStartSeries(room, now)) return;
		this.changed(room);
	},

	UpdateLobbySettings(conn, body) {
		const room = this.roomOf(conn);
		if (!room || !this.isHost(room, conn)) return;
		const lobby = room.lobby;
		if (lobby.InGame || lobby.Kind === "QuickPlay" || this.seriesInProgress(lobby)) return;
		lobby.GameData = this.gameData(body.game_data, lobby.GameData);
		const minPlayers = Math.max(lobby.Players.length, lobby.GameData.Mode === TEAM_DEATHMATCH ? 3 : 2);
		lobby.MaxPlayers = Math.min(MAX_PLAYERS, Math.max(minPlayers, int(body.max_players, lobby.MaxPlayers)));
		if (Array.isArray(body.mods)) lobby.Mods = this.mods(body.mods);
		// New settings: everyone picks again (TF.EX un-joins a player the server un-readies).
		for (const p of lobby.Players) p.Ready = false;
		this.changed(room);
	},

	StartLobbyChoice(conn, body, now) {
		const room = this.roomOf(conn);
		if (!room || !this.isHost(room, conn)) return;
		const lobby = room.lobby;
		if (lobby.InGame || lobby.Kind === "QuickPlay" || this.seriesInProgress(lobby) || !this.allReady(lobby)) return;
		if (lobby.GameData.BestOf > 0) {
			if (lobby.Players.length !== lobby.MaxPlayers) return;
			this.newSeries(room);
		}
		this.start(room, now);
	},

	MatchEnded(conn, body, now) {
		const room = this.roomOf(conn);
		if (!room || !room.lobby.InGame || !this.playerOf(room, conn)) return;
		room.timers.vote ??= now + VOTE_MS;
		if (!room.reported) {
			room.reported = true;
			this.seriesResult(room, { winner_seat: int(body.winner_seat, -1), scores: Array.isArray(body.scores) ? body.scores : [] });
			this.changed(room);
		}
	},

	RematchLobbyChoice(conn, body, now) {
		if (this.roomOf(conn)?.lobby.Series) return;
		this.vote(conn, "Rematch", now);
	},

	ArcherSelectChoice(conn, body, now) {
		this.vote(conn, "ArcherSelect", now);
	},

	SeriesContinueChoice(conn, body, now) {
		this.vote(conn, "Continue", now);
	},

	SeriesPickMap(conn, body, now) {
		const room = this.roomOf(conn);
		const player = room && this.playerOf(room, conn);
		const series = room?.lobby.Series;
		if (!player) return;
		// A refused pick gets the lobby back unchanged (TF.EX waits to see its pick in one).
		const refuse = () => this.send(conn, "LobbyUpdate", { lobby: room.lobby });
		if (!series || series.Status !== "InProgress" || series.AwaitingResult || room.lobby.InGame) return refuse();
		const map = int(body.map_id, -1);
		if (map < 0 || map >= TOWERS || series.Games.some((g) => g.MapId === map)) return refuse();
		if (!this.pickerSeats(series, room.lobby).includes(player.Seat)) return refuse();
		series.Picks = series.Picks.filter((p) => p.Seat !== player.Seat);
		series.Picks.push({ Seat: player.Seat, MapId: map });
		series.NextMapId = null;
		this.settlePicks(series, room.lobby);
		if (this.maybeStartSeries(room, now)) return;
		this.changed(room);
	},

	EnterQuickPlay(conn, body, now) {
		this.leave(conn, now);
		conn.state.quickPlay = { wide: body.is_wide === true, name: clean(body.name, MAX_NAME) || conn.state.name || "PLAYER", since: now };
		conn.save?.();
		this.matchQuickPlay(now);
		this.quickPlayStatus();
	},

	ExitQuickPlay(conn) {
		this.leaveQuickPlay(conn);
	},

	SkinChunk(conn, body) {
		const room = this.roomOf(conn);
		if (!room || !this.playerOf(room, conn) || !body.chunk || typeof body.chunk !== "object") return;
		const text = `{"SkinChunk":${JSON.stringify({ chunk: body.chunk, from: conn.state.peer })}}`;
		if (text.length > MAX_SKIN_CHUNK) return;
		for (const member of this.members(room)) if (member !== conn) member.send(text);
	},
};
