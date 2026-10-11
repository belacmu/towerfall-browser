// A private host for your own TowerFall files, so the public site can load them on devices that
// can't pick a folder (phones). The site is told about it once with a link (see docs/MOBILE.md):
//   https://belacmu.github.io/towerfall-browser/#gamefiles=https://<this worker>/<KEY>/
// and then fetches /<KEY>/gamefiles/* from here, cross-origin. The files come from an R2 bucket
// (uploaded by tools/upload-gamefiles.sh), in the same layout as tools/serve.py's private mode.
//
// KEY is a long random secret (wrangler secret, never in the repo): without it every request is a
// 404 that never touches the bucket, so the files aren't findable and strangers can't run up R2
// reads. Anyone with the link can download them, so share it only with yourself.

export default {
	async fetch(request, env) {
		if (request.method === "OPTIONS") return withCors(new Response(null, { status: 204 }));
		if (request.method !== "GET" && request.method !== "HEAD") {
			return new Response("Method not allowed", { status: 405 });
		}
		const url = new URL(request.url);
		// /<KEY>/gamefiles/<path>
		const [, given = "", top, ...rest] = url.pathname.split("/");
		if (!env.KEY || env.KEY.length < 16 || !(await sameSecret(given, env.KEY)) || top !== "gamefiles") {
			return new Response("Not found", { status: 404 });
		}
		let key;
		try {
			key = "gamefiles/" + rest.map(decodeURIComponent).join("/");
		} catch {
			return new Response("Bad path", { status: 400 });
		}
		return withCors(await fromBucket(request, env, key));
	},
};

// Compares the key in the URL with KEY in constant time (for its length).
async function sameSecret(given, secret) {
	const a = new TextEncoder().encode(given);
	const b = new TextEncoder().encode(secret);
	return a.byteLength === b.byteLength && crypto.subtle.timingSafeEqual(a, b);
}

// Ranges (the page reads packs in pieces, see tools/upload-gamefiles.sh) and conditional requests
// come straight from R2. HEAD only reads the object's metadata.
async function fromBucket(request, env, key) {
	const object = request.method === "HEAD" ? await env.GAMEFILES.head(key) : await env.GAMEFILES.get(key, { range: request.headers, onlyIf: request.headers });
	if (!object) return new Response("Not found", { status: 404 });
	const headers = new Headers();
	object.writeHttpMetadata(headers);
	headers.set("ETag", object.httpEtag);
	headers.set("Accept-Ranges", "bytes");
	if (key.endsWith(".json")) headers.set("Content-Type", "application/json");
	// Personal files: keep them out of shared caches. Packs are named by their content, so they never
	// change; everything else is checked each time.
	headers.set("Cache-Control", key.startsWith("gamefiles/packs/") ? "private, max-age=31536000, immutable" : "private, no-cache");
	// A condition that failed (If-None-Match: the browser's copy is current) leaves no body.
	if (request.method === "GET" && !("body" in object)) return new Response(null, { status: 304, headers });
	let status = 200;
	let length = object.size;
	if (object.range && request.headers.has("Range")) {
		const start = "suffix" in object.range ? object.size - object.range.suffix : object.range.offset ?? 0;
		length = "suffix" in object.range ? object.range.suffix : object.range.length ?? object.size - start;
		headers.set("Content-Range", `bytes ${start}-${start + length - 1}/${object.size}`);
		status = 206;
	}
	headers.set("Content-Length", String(length));
	return new Response(request.method === "HEAD" ? null : object.body, { status, headers });
}

// The site is cross-origin isolated (COEP require-corp, for threads), so it can only read these
// cross-origin responses with CORS. Range isn't a "simple" header everywhere, so range requests
// can be preflighted: the answer is cached for a day.
function withCors(response) {
	response.headers.set("Access-Control-Allow-Origin", "*");
	response.headers.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
	response.headers.set("Access-Control-Allow-Headers", "Range, If-None-Match");
	response.headers.set("Access-Control-Expose-Headers", "Content-Range, Content-Length, ETag");
	response.headers.set("Access-Control-Max-Age", "86400");
	response.headers.set("Cross-Origin-Resource-Policy", "cross-origin");
	return response;
}
