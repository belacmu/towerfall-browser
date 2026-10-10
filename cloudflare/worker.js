// A private deployment of the site that also hosts your own TowerFall files, for devices that can't
// pick a folder (phones). It's the private mode of tools/serve.py on Cloudflare: /gamefiles/* comes
// from an R2 bucket (uploaded by tools/upload-gamefiles.sh), everything else from the public site,
// with the COOP/COEP headers threads need. See docs/MOBILE.md.
//
// Cloudflare Access must sit in front of it. The Worker also verifies Access's token on every
// request and refuses without a valid one, so a missing or broken Access setup can't expose the
// game files.

export default {
	async fetch(request, env) {
		if (request.method !== "GET" && request.method !== "HEAD") {
			return new Response("Method not allowed", { status: 405 });
		}
		if (!(await accessAllowed(request, env))) {
			return new Response("Forbidden: this site is only reachable through Cloudflare Access.", { status: 403 });
		}
		const url = new URL(request.url);
		const response = url.pathname.startsWith("/gamefiles/")
			? await fromBucket(request, env, decodeURIComponent(url.pathname.slice(1)))
			: await fromSite(request, env, url);
		response.headers.set("Cross-Origin-Embedder-Policy", "require-corp");
		response.headers.set("Cross-Origin-Opener-Policy", "same-origin");
		response.headers.set("Cross-Origin-Resource-Policy", "same-origin");
		// Personal files: keep them out of shared caches.
		if (url.pathname.startsWith("/gamefiles/")) response.headers.set("Cache-Control", "private, no-cache");
		return response;
	},
};

async function fromBucket(request, env, key) {
	const object = await env.GAMEFILES.get(key);
	if (!object) return new Response("Not found", { status: 404 });
	const headers = new Headers();
	object.writeHttpMetadata(headers);
	headers.set("ETag", object.httpEtag);
	headers.set("Content-Length", String(object.size));
	if (key.endsWith(".json")) headers.set("Content-Type", "application/json");
	return new Response(request.method === "HEAD" ? null : object.body, { headers });
}

// The public site (SITE_URL, e.g. the GitHub Pages build), as if it were served from here.
async function fromSite(request, env, url) {
	const target = new URL(url.pathname.slice(1) + url.search, env.SITE_URL);
	const upstream = await fetch(target, { method: request.method, headers: { Accept: request.headers.get("Accept") ?? "*/*" } });
	return new Response(upstream.body, upstream);
}

// --- Cloudflare Access ------------------------------------------------------------------------
// Access passes the signed-in user's token (an RS256 JWT) in Cf-Access-Jwt-Assertion. Check its
// signature against the team's keys, its audience (the Access application's AUD tag) and expiry.

let keyCache = { team: null, at: 0, keys: [] };

async function accessKeys(team) {
	if (keyCache.team === team && Date.now() - keyCache.at < 3600_000) return keyCache.keys;
	const res = await fetch(`https://${team}/cdn-cgi/access/certs`);
	if (!res.ok) throw new Error(`Access certs: ${res.status}`);
	const { keys } = await res.json();
	keyCache = { team, at: Date.now(), keys };
	return keys;
}

const base64url = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

async function accessAllowed(request, env) {
	const team = env.ACCESS_TEAM_DOMAIN;
	const aud = env.ACCESS_AUD;
	if (!team || !aud) return false;
	const token = request.headers.get("Cf-Access-Jwt-Assertion");
	if (!token) return false;
	try {
		const [h, p, s] = token.split(".");
		const header = JSON.parse(new TextDecoder().decode(base64url(h)));
		const claims = JSON.parse(new TextDecoder().decode(base64url(p)));
		if (header.alg !== "RS256") return false;
		const jwk = (await accessKeys(team)).find((k) => k.kid === header.kid);
		if (!jwk) return false;
		const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
		const signed = new TextEncoder().encode(`${h}.${p}`);
		if (!(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, base64url(s), signed))) return false;
		const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
		const now = Date.now() / 1000;
		return auds.includes(aud) && claims.iss === `https://${team}` && claims.exp > now && (claims.nbf ?? 0) <= now + 60;
	} catch (e) {
		console.error("Access token check failed:", e);
		return false;
	}
}
