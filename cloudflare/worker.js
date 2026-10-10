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
		const prefix = `/${env.KEY}/gamefiles/`;
		const url = new URL(request.url);
		if (!env.KEY || env.KEY.length < 16 || !url.pathname.startsWith(prefix)) {
			return new Response("Not found", { status: 404 });
		}
		const key = "gamefiles/" + decodeURIComponent(url.pathname.slice(prefix.length));
		return withCors(await fromBucket(request, env, key));
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
	// Personal files: keep them out of shared caches.
	headers.set("Cache-Control", "private, no-cache");
	return new Response(request.method === "HEAD" ? null : object.body, { headers });
}

// The site is cross-origin isolated (COEP require-corp, for threads), so it can only read these
// cross-origin responses with CORS.
function withCors(response) {
	response.headers.set("Access-Control-Allow-Origin", "*");
	response.headers.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
	response.headers.set("Cross-Origin-Resource-Policy", "cross-origin");
	return response;
}
