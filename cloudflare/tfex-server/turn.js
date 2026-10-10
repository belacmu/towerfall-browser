// GET /turn: the ICE servers browsers use for match connections (netplay/tfnet.js asks before it
// connects to anyone). STUN alone finds a direct path when both players' routers allow one; behind
// stricter NATs (many mobile carriers and ISPs) only a TURN relay gets through. With a Cloudflare
// TURN key (TURN_KEY_ID and TURN_KEY_API_TOKEN secrets) this returns short-lived credentials for
// Cloudflare's relay; without one, STUN only.

export const STUN_ONLY = [{ urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] }];

// Long enough for a long session of rematches: credentials are fetched once per match room, and the
// relay needs them valid to keep an allocation alive.
const TTL = 6 * 3600;

export async function iceServers(env) {
	if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) return STUN_ONLY;
	try {
		const res = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`, {
			method: "POST",
			headers: { Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, "Content-Type": "application/json" },
			body: JSON.stringify({ ttl: TTL }),
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const { iceServers } = await res.json();
		// Browsers block port 53, so a port-53 server would only hold up ICE gathering.
		return iceServers.map((s) => ({ ...s, urls: [].concat(s.urls).filter((u) => !/:53(\?|$)/.test(u)) }));
	} catch (e) {
		console.error("[turn] couldn't get credentials:", e);
		return STUN_ONLY;
	}
}
