// What the server accepts: its three WebSocket endpoints, and which browser pages may open them.

// Pages that may connect (browsers send Origin; desktop TF.EX sends none and is always let in).
// More can be added with ALLOWED_ORIGINS (comma-separated; "*" allows any page).
export const DEFAULT_ORIGINS = ["https://belacmu.github.io", "http://localhost:8080", "http://127.0.0.1:8080"];

export function originAllowed(origin, allowed) {
	if (!origin) return true;
	return allowed.includes("*") || allowed.includes(origin);
}

export function allowedOrigins(extra) {
	return [...DEFAULT_ORIGINS, ...String(extra ?? "").split(",").map((o) => o.trim()).filter(Boolean)];
}

const ROOM_ID = /^[A-Za-z0-9_-]{1,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// /ws -> matchmaking; /room/<id>?peer=<uuid> -> match signaling; /ping_measurement/<id>?peer=<uuid>
// -> lobby ping signaling. Anything else: null. A peer id that isn't a UUID: { bad: true }.
export function parseRoute(url) {
	const path = url.pathname.replace(/\/+$/, "");
	if (path === "/ws") return { kind: "ws" };
	const m = /^\/(room|ping_measurement)\/([^/]+)$/.exec(path);
	if (!m || !ROOM_ID.test(m[2])) return null;
	const peer = url.searchParams.get("peer");
	if (peer !== null && !UUID.test(peer)) return { bad: true };
	return { kind: m[1] === "room" ? "room" : "ping", roomId: m[2], peer };
}
