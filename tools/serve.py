#!/usr/bin/env python3
"""Dev server for the browser build. Threads need cross-origin isolation (COOP/COEP).
Usage: serve.py [port] [--pages] [--verbose] [--diag]
--diag: pages report their memory (WebAssembly heap, JS heap), audio output level (peak sample; gaps: blocks with runs of exact silence) and new [perf]/error log lines
here every 5 s, printed as [diag] lines, and run JavaScript queued with
`curl 'localhost:PORT/__eval' --data 'towerfallCommand("profile")'` (result: a [diag] line). For browsers whose console can't be read, e.g. iOS
Safari in the Simulator or on a phone on this network (with --host 0.0.0.0 that isn't localhost,
the page isn't cross-origin isolated, so prefer the Simulator)."""
import os
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# TOWERFALL_WWW serves another build (e.g. an AOT one published with tools/build.sh PUBLISH_DIR=...).
WWW = os.environ.get("TOWERFALL_WWW") or os.path.join(ROOT, "web/bin/Release/net10.0/publish/wwwroot")
GAMEFILES = os.path.join(ROOT, "gamefiles")


# Injected into index.html with --diag. Runs on the page's main thread.
DIAG_SCRIPT = b"""<script>
(() => {
	// Watchdog: the main thread records a heartbeat and whether it's inside SDL's audio callback
	// in shared memory; a worker reports them, so a frozen main thread still shows where it is.
	// [0] heartbeat (ms since start), [1] in audio callback, [2] audio callbacks so far.
	// [3] the main-thread timer running now (an id; the worker knows where each was created).
	const watch = new Int32Array(new SharedArrayBuffer(16));
	const t0 = performance.now();
	setInterval(() => Atomics.store(watch, 0, Math.round(performance.now() - t0)), 250);
	const watchdog = new Worker("/__watchdog.js");
	watchdog.postMessage([watch, performance.timeOrigin + t0]);
	let nextTimer = 1;
	for (const name of ["setTimeout", "setInterval"]) {
		const original = self[name];
		self[name] = function (fn, ...rest) {
			if (typeof fn !== "function") return original.call(this, fn, ...rest);
			const id = nextTimer++;
			const where = (fn.name || "anonymous") + " < " + String(new Error().stack).split("\\n").slice(1, 6).join(" < ");
			watchdog.postMessage({ timer: id, where: where.slice(0, 600) });
			return original.call(this, function (...args) {
				const outer = Atomics.exchange(watch, 3, id);
				try {
					return fn.apply(this, args);
				} finally {
					Atomics.store(watch, 3, outer);
				}
			}, ...rest);
		};
	}
	// Spin trap: Emscripten's main thread waits for locks by spinning on performance.now(). If one
	// task calls it a million times, send its stack with a synchronous request (the only way out of
	// a stuck main thread: in WebKit even workers' requests go through it).
	const now = performance.now.bind(performance);
	let spinCalls = 0;
	let spinSent = false;
	queueMicrotask(function reset() { spinCalls = 0; setTimeout(reset, 50); });
	performance.now = () => {
		if (++spinCalls > 1000000 && !spinSent) {
			spinSent = true;
			try {
				const xhr = new XMLHttpRequest();
				xhr.open("GET", "/__diag?" + encodeURIComponent(JSON.stringify({ spinStack: String(new Error().stack), timer: Atomics.load(watch, 3) })), false);
				xhr.send();
			} catch {}
		}
		return now();
	};
	// Audio level: SDL plays through a ScriptProcessorNode; measure what it outputs.
	let peak = 0;
	let gaps = 0;
	let blocks = 0;
	const create = AudioContext.prototype.createScriptProcessor;
	AudioContext.prototype.createScriptProcessor = function (...args) {
		const node = create.apply(this, args);
		// SDL assigns onaudioprocess; run its handler from a listener that also measures.
		let handler = null;
		let listener = null;
		Object.defineProperty(node, "onaudioprocess", {
			get: () => handler,
			set: (fn) => {
				if (listener) node.removeEventListener("audioprocess", listener);
				handler = fn;
				listener = fn && ((e) => {
					Atomics.store(watch, 1, 1);
					Atomics.add(watch, 2, 1);
					fn(e);
					Atomics.store(watch, 1, 0);
					const data = e.outputBuffer.getChannelData(0);
					let zeros = 0;
					let longest = 0;
					for (let i = 0; i < data.length; i++) {
						const v = Math.abs(data[i]);
						if (v > peak) peak = v;
						zeros = v === 0 ? zeros + 1 : 0;
						if (zeros > longest) longest = zeros;
					}
					// A run of exact silence (>= 256 samples) inside sound: the mixer fell behind.
					if (longest >= 256 && longest < data.length) gaps++;
					blocks++;
				});
				if (listener) node.addEventListener("audioprocess", listener);
			},
		});
		return node;
	};
	let from = 0;
	const report = () => {
		const log = self.consoleLog ?? [];
		if (from > log.length) from = 0;
		const lines = log.slice(from).filter((l) => /\\[perf\\]|\\[diag\\]|rror|InstantReplay|etablished|Lobby|exception|command|sweep|scenario/i.test(l)).slice(-8);
		from = log.length;
		const heap = self.wasm?.Module?.HEAPU8?.length;
		const d = { wasmMB: heap ? Math.round(heap / 1048576) : null, jsMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null, audioPeak: Math.round(peak * 1000) / 1000, audioState: self.wasm?.Module?.SDL3?.audioContext?.state ?? null, audioCallbacks: Atomics.load(watch, 2), audioGaps: `${gaps}/${blocks}`, lines };
		peak = 0;
		gaps = 0;
		blocks = 0;
		fetch("/__diag?" + encodeURIComponent(JSON.stringify(d)), { cache: "no-store" }).catch(() => {});
	};
	setInterval(report, 5000);
	setInterval(async () => {
		const js = await (await fetch("/__eval", { cache: "no-store" })).text().catch(() => "");
		if (!js) return;
		let result;
		try {
			result = await (0, eval)(js);
		} catch (e) {
			result = "error: " + e;
		}
		fetch("/__diag?" + encodeURIComponent(JSON.stringify({ eval: js, result: String(result) })));
	}, 1000);
	addEventListener("error", (e) => fetch("/__diag?" + encodeURIComponent(JSON.stringify({ error: String(e.message) }))));
})();
</script>"""


WATCHDOG_SCRIPT = b"""
		const timers = new Map();
		let started = false;
		onmessage = ({ data }) => {
			if (data.timer) return timers.set(data.timer, data.where);
			if (started) return;
			started = true;
			const [watch, t0] = data;
			fetch("/__diag?" + encodeURIComponent(JSON.stringify({ watchdog: "up" })));
			setInterval(() => {
				const age = Math.round(performance.timeOrigin + performance.now() - t0 - Atomics.load(watch, 0));
				if (age > 3000) fetch("/__diag?" + encodeURIComponent(JSON.stringify({ frozenMs: age, inAudioCallback: Atomics.load(watch, 1), audioCallbacks: Atomics.load(watch, 2), inTimer: timers.get(Atomics.load(watch, 3)) ?? Atomics.load(watch, 3) })));
			}, 2000);
		};
	"""

PENDING_EVAL = []


class Handler(SimpleHTTPRequestHandler):
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".wasm": "application/wasm",
        ".json": "application/json",
    }

    def do_GET(self):
        if "--diag" in sys.argv and self.path.startswith("/__diag?"):
            from urllib.parse import unquote
            print(f"[diag] {self.client_address[0]} {unquote(self.path[len('/__diag?'):])}", flush=True)
            self.send_response(204)
            self.end_headers()
            return
        if "--diag" in sys.argv and self.path == "/__watchdog.js":
            self.send_response(200)
            self.send_header("Content-Type", "text/javascript")
            self.send_header("Content-Length", str(len(WATCHDOG_SCRIPT)))
            self.end_headers()
            self.wfile.write(WATCHDOG_SCRIPT)
            return
        if "--diag" in sys.argv and self.path == "/__eval":
            body = PENDING_EVAL.pop(0).encode() if PENDING_EVAL else b""
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if "--diag" in sys.argv and self.path.split("?")[0] in ("/", "/index.html"):
            body = open(os.path.join(WWW, "index.html"), "rb").read().replace(b"</head>", DIAG_SCRIPT + b"</head>", 1)
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()

    def do_POST(self):
        if "--diag" in sys.argv and self.path == "/__eval":
            PENDING_EVAL.append(self.rfile.read(int(self.headers.get("Content-Length", 0))).decode())
            self.send_response(204)
            self.end_headers()
            return
        self.send_error(405)

    def translate_path(self, path):
        path = super().translate_path(path)
        rel = os.path.relpath(path, os.getcwd())
        if rel == "gamefiles" or rel.startswith("gamefiles" + os.sep):
            return os.path.join(GAMEFILES, rel[len("gamefiles") + 1:])
        return os.path.join(WWW, rel)

    def end_headers(self):
        # --pages: behave like GitHub Pages (no COOP/COEP; coi-serviceworker.js has to add them).
        if "--pages" not in sys.argv:
            self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
            self.send_header("Cross-Origin-Opener-Policy", "same-origin")
            self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        if not self.path.startswith("/gamefiles/") or self.path.endswith("manifest.json"):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, fmt, *args):
        if "--verbose" in sys.argv:
            super().log_message(fmt, *args)


if __name__ == "__main__":
    port = int(next((a for a in sys.argv[1:] if a.isdigit()), 8080))
    print(f"Serving TowerFall on http://localhost:{port}")
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
