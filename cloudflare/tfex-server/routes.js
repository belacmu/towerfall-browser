// What the server accepts: its three WebSocket endpoints, and which browser pages may open them.

// Pages that may connect (browsers send Origin; desktop TF.EX sends none and is always let in):
// the site, and dev servers on this machine (any port). More can be added with ALLOWED_ORIGINS
// (comma-separated; "*" allows any page).
export const DEFAULT_ORIGINS = ["https://belacmu.github.io"];
const LOCAL = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

export function originAllowed(origin, allowed) {
	if (!origin || LOCAL.test(origin)) return true;
	return allowed.includes("*") || allowed.includes(origin);
}

export function allowedOrigins(extra) {
	return [...DEFAULT_ORIGINS, ...String(extra ?? "").split(",").map((o) => o.trim()).filter(Boolean)];
}

const ROOM_ID = /^[A-Za-z0-9_-]{1,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Relay rooms named xnet-<anything> are for lobby-free tests (the browser's `xnet` harness meeting
// the Switch): anyone may join them, still 2 peers at most. Every other relay room is a lobby's
// match, for its players only. (No lobby can have such a RoomId: matchmaker.js refuses it.)
export const lobbyFreeRelay = (roomId) => /^xnet-/i.test(roomId);

// /ws -> matchmaking; /room/<id>?peer=<uuid> -> match signaling; /ping_measurement/<id>?peer=<uuid>
// -> lobby ping signaling; /relay/<id>?peer=<uuid> -> match relay (relay.js; peer required).
// Anything else: null. A peer id that isn't a UUID (or a relay without one): { bad: true }.
export function parseRoute(url) {
	const path = url.pathname.replace(/\/+$/, "");
	if (path === "/ws") return { kind: "ws" };
	const m = /^\/(room|ping_measurement|relay)\/([^/]+)$/.exec(path);
	if (!m || !ROOM_ID.test(m[2])) return null;
	const peer = url.searchParams.get("peer");
	if (peer !== null && !UUID.test(peer)) return { bad: true };
	if (m[1] === "relay") return peer === null ? { bad: true } : { kind: "relay", roomId: m[2], peer: peer.toLowerCase() };
	return { kind: m[1] === "room" ? "room" : "ping", roomId: m[2], peer };
}
