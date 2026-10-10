#!/usr/bin/env node
// Drives two (or more) headless browsers playing each other, for testing online play locally.
// Each player is its own Chrome with its own profile (so its own OPFS). Control them over HTTP:
//   curl 'localhost:9400/A/key?k=Enter'          press a key (DOM key name: Enter, ArrowDown, x, ...)
//   curl 'localhost:9400/A/type?t=ABCD'          type text, one key at a time
//   curl 'localhost:9400/A/shot' -o a.png        screenshot
//   curl 'localhost:9400/A/log?from=0'           in-page log lines from that index
//   curl 'localhost:9400/A/eval' --data 'js'     evaluate in the page
//   curl 'localhost:9400/quit'
// Usage: node tools/netplay-driver.mjs [--url URL] [--players A,B] [--port 9400]
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
		"--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--autoplay-policy=no-user-gesture-required",
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
	return { name, send };
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
for (const [i, name] of names.entries()) players[name] = await launch(name, 9341 + i);
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
