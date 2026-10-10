#!/usr/bin/env node
// Drives two (or more) headless browsers playing each other, for testing online play locally.
// Each player is its own Chrome with its own profile (so its own OPFS). Control them over HTTP:
//   curl 'localhost:9400/A/key?k=Enter'          press a key (DOM key name: Enter, ArrowDown, x, ...)
//   curl 'localhost:9400/A/type?t=ABCD'          type text, one key at a time
//   curl 'localhost:9400/A/shot' -o a.png        screenshot
//   curl 'localhost:9400/A/log?from=0'           in-page log lines from that index
//   curl 'localhost:9400/A/console?from=0'       console output of all threads (works while hung)
//   curl 'localhost:9400/A/eval' --data 'js'     evaluate in the page
//   curl 'localhost:9400/A/evalworkers' --data 'js'  evaluate in every worker thread
//   curl 'localhost:9400/A/catch', then 'localhost:9400/A/pauses'   stacks of uncaught exceptions in workers
//   curl 'localhost:9400/quit'
// Usage: node tools/netplay-driver.mjs [--url URL] [--players A,B] [--port 9400]
// (Another driver at the same time: a different --port and different player names, which name
// the profiles.)
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import os from "node:os";

const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const url = opt("--url", "http://localhost:8080/?mute&nointro&autoplay&mods=TF.EX");
const names = opt("--players", "A,B").split(",");
const port = Number(opt("--port", "9400"));
const chrome = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
// The real GPU where Chrome can use it headless (Metal on macOS); software rendering elsewhere,
// which costs several CPU cores per running game.
const GPU_FLAGS = process.platform === "darwin" ? ["--use-angle=metal", "--ignore-gpu-blocklist"] : ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const children = [];
process.on("exit", () => children.forEach((c) => c.kill()));
process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));

async function launch(name, debugPort) {
	const profile = path.join(os.homedir(), ".towerfall-browser", `netplay-${name}-profile`);
	fs.mkdirSync(profile, { recursive: true });
	children.push(spawn(chrome, [
		"--headless=new", `--user-data-dir=${profile}`, `--remote-debugging-port=${debugPort}`, "--no-first-run",
		...GPU_FLAGS, "--autoplay-policy=no-user-gesture-required", "--mute-audio", // the page's audio runs, silently
		"--window-size=960,600", "about:blank",
	], { stdio: "ignore" }));
	let target;
	for (let i = 0; i < 100 && !target; i++) {
		try {
			target = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(url)}`, { method: "PUT" })).json();
		} catch {
			await sleep(200);
		}
	}
	const ws = new WebSocket(target.webSocketDebuggerUrl);
	await new Promise((r) => ws.addEventListener("open", r));
	let nextId = 1;
	const send = (method, params = {}) =>
		new Promise((resolve) => {
			const id = nextId++;
			const timer = setTimeout(() => resolve({ error: "timeout" }), 20_000);
			const onMessage = (m) => {
				const d = JSON.parse(m.data);
				if (d.id !== id) return;
				clearTimeout(timer);
				ws.removeEventListener("message", onMessage);
				resolve(d.result ?? { error: d.error });
			};
			ws.addEventListener("message", onMessage);
			ws.send(JSON.stringify({ id, method, params }));
		});
	// Console output from every thread (the page and its workers), captured by DevTools so it's
	// readable even when the page's main thread hangs.
	const consoleLines = [];
	const pausedWaiters = [];
	const workerSessions = [];
	const catching = new Set();
	const pauses = [];
	// Pause every worker on uncaught exceptions (wasm traps included) and record the stack.
	const catchWorkers = async () => {
		for (const sessionId of workerSessions) {
			catching.add(sessionId);
			ws.send(JSON.stringify({ id: nextId++, sessionId, method: "Debugger.enable" }));
			ws.send(JSON.stringify({ id: nextId++, sessionId, method: "Debugger.setPauseOnExceptions", params: { state: "all" } }));
		}
		return workerSessions.length;
	};
	// Evaluates in every worker (the game runs on one), e.g. runtime diagnostics.
	const evalWorkers = (expression) =>
		Promise.all(workerSessions.map((sessionId) => new Promise((resolve) => {
			const id = nextId++;
			const timer = setTimeout(() => resolve({ sessionId, error: "timeout" }), 10_000);
			const onMessage = (m) => {
				const d = JSON.parse(m.data);
				if (d.id !== id) return;
				clearTimeout(timer);
				ws.removeEventListener("message", onMessage);
				resolve({ sessionId, value: d.result?.result?.value ?? d.result?.exceptionDetails?.exception?.description ?? d.error });
			};
			ws.addEventListener("message", onMessage);
			ws.send(JSON.stringify({ id, sessionId, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } }));
		})));
	ws.addEventListener("message", (m) => {
		const d = JSON.parse(m.data);
		if (d.method === "Target.attachedToTarget") {
			workerSessions.push(d.params.sessionId);
			ws.send(JSON.stringify({ id: nextId++, sessionId: d.params.sessionId, method: "Runtime.enable" }));
			ws.send(JSON.stringify({ id: nextId++, sessionId: d.params.sessionId, method: "Runtime.runIfWaitingForDebugger" }));
		} else if (d.method === "Debugger.paused" && catching.has(d.sessionId)) {
			// An exception in a worker we're watching: record where, then let it continue.
			pauses.push({ session: d.sessionId, reason: d.params.reason, description: d.params.data?.description, frames: d.params.callFrames.map((f) => `${f.functionName || "(anonymous)"} ${f.url.split("/").pop()}:${f.location.lineNumber}:${f.location.columnNumber}`) });
			ws.send(JSON.stringify({ id: nextId++, sessionId: d.sessionId, method: "Debugger.resume" }));
		} else if (d.method === "Debugger.paused") {
			pausedWaiters.splice(0).forEach((w) => w({ session: d.sessionId ?? "page", frames: d.params.callFrames.map((f) => `${f.functionName || "(anonymous)"} ${f.url.split("/").pop()}:${f.location.lineNumber}`) }));
		} else if (d.method?.startsWith("Network.webSocket")) {
			const q = d.params;
			consoleLines.push(`network ${d.method.slice(8)}: ${q.url ?? ""}${q.response ? ` ${q.response.status}` : ""}${q.errorMessage ? ` ${q.errorMessage}` : ""}`);
		} else if (d.method === "Runtime.consoleAPICalled") {
			const text = d.params.args.map((a) => a.value ?? a.description ?? "").join(" ");
			consoleLines.push(`${d.sessionId ? "worker" : "page"} ${d.params.type}: ${text}`);
			if (consoleLines.length > 20000) consoleLines.splice(0, 5000);
		}
	});
	await send("Runtime.enable");
	await send("Network.enable");
	await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
	// The page main thread's stack right now (for hangs): pause, read, resume.
	const stack = async () => {
		await send("Debugger.enable");
		const paused = new Promise((r) => {
			pausedWaiters.push(r);
			setTimeout(() => r({ error: "didn't pause within 10 s" }), 10_000);
		});
		await send("Debugger.pause");
		const result = await paused;
		await send("Debugger.resume");
		await send("Debugger.disable");
		return result;
	};
	return { name, send, consoleLines, stack, evalWorkers, catchWorkers, pauses };
}

// Key events as the game sees them (SDL reads DOM keydown/keyup on the canvas' document).
const CODES = { Enter: 13, Escape: 27, " ": 32, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Backspace: 8, Tab: 9 };
function keyInfo(k) {
	if (CODES[k] != null) return { key: k, code: k === " " ? "Space" : k, windowsVirtualKeyCode: CODES[k] };
	const c = k.length === 1 ? k.toUpperCase() : k;
	const code = /^[A-Z]$/.test(c) ? `Key${c}` : /^[0-9]$/.test(c) ? `Digit${c}` : k;
	return { key: k.length === 1 ? k.toLowerCase() : k, code, windowsVirtualKeyCode: c.length === 1 ? c.charCodeAt(0) : 0 };
}
async function press(p, k, hold = 80) {
	const info = keyInfo(k);
	await p.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...info });
	await sleep(hold); // the game samples input once per frame
	await p.send("Input.dispatchKeyEvent", { type: "keyUp", ...info });
	await sleep(60);
}

const players = {};
// Chrome's debugging ports follow --port (9341.. for the default 9400), so two drivers can run at once.
for (const [i, name] of names.entries()) players[name] = await launch(name, port - 59 + i);
console.log(`Players ${names.join(", ")} loading ${url}; control on http://localhost:${port}/`);

http.createServer(async (req, res) => {
	const u = new URL(req.url, "http://x");
	const [, name, action] = u.pathname.split("/");
	if (name === "quit") {
		res.end("bye\n");
		process.exit(0);
	}
	const p = players[name];
	if (!p) return res.writeHead(404).end(`no player ${name}\n`);
	let body = "";
	for await (const chunk of req) body += chunk;
	try {
		if (action === "key") {
			for (let n = Number(u.searchParams.get("n") ?? 1); n > 0; n--) await press(p, u.searchParams.get("k"), Number(u.searchParams.get("hold") ?? 80));
			res.end("ok\n");
		} else if (action === "type") {
			for (const ch of u.searchParams.get("t")) await press(p, ch);
			res.end("ok\n");
		} else if (action === "shot") {
			const r = await p.send("Page.captureScreenshot", { format: "png" });
			res.writeHead(200, { "content-type": "image/png" }).end(Buffer.from(r.data ?? "", "base64"));
		} else if (action === "log") {
			const from = Number(u.searchParams.get("from") ?? 0);
			const r = await p.send("Runtime.evaluate", { expression: `JSON.stringify((self.consoleLog ?? []).slice(${from}))`, returnByValue: true });
			const lines = JSON.parse(r.result?.value ?? "[]");
			res.end(lines.map((l, i) => `${from + i}: ${l}`).join("\n") + "\n");
		} else if (action === "stack") {
			res.end(JSON.stringify(await p.stack(), null, 1) + "\n");
		} else if (action === "console") {
			const from = Number(u.searchParams.get("from") ?? 0);
			res.end(p.consoleLines.slice(from).map((l, i) => `${from + i}: ${l}`).join("\n") + "\n");
		} else if (action === "catch") {
			res.end(`watching ${await p.catchWorkers()} workers\n`);
		} else if (action === "pauses") {
			res.end(JSON.stringify(p.pauses, null, 1) + "\n");
		} else if (action === "evalworkers") {
			res.end(JSON.stringify(await p.evalWorkers(body), null, 1) + "\n");
		} else if (action === "eval") {
			const r = await p.send("Runtime.evaluate", { expression: body, returnByValue: true, awaitPromise: true });
			res.end(JSON.stringify(r.result?.value ?? r) + "\n");
		} else {
			res.writeHead(404).end("unknown action\n");
		}
	} catch (e) {
		res.writeHead(500).end(String(e) + "\n");
	}
}).listen(port);
