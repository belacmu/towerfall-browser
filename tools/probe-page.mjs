#!/usr/bin/env node
// Opens the page in headless Chrome and streams the in-page log (self.consoleLog) to stdout, for
// checking things the smoke test doesn't cover (frame rate with TF.EX, netplay between two
// players). Each --profile is a separate browser (its own OPFS, so two can play each other).
//   node tools/probe-page.mjs [--url URL] [--seconds 90] [--profile name] [--port 9340] [--filter regex]
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const url = opt("--url", "http://localhost:8080/?mute&nointro&autoplay");
const seconds = Number(opt("--seconds", "90"));
const profileName = opt("--profile", "probe");
const port = Number(opt("--port", "9340"));
const filter = opt("--filter", null) && new RegExp(opt("--filter", null));
const chrome = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
// The real GPU where Chrome can use it headless (Metal on macOS); software rendering elsewhere,
// which costs several CPU cores per running game.
const GPU_FLAGS = process.platform === "darwin" ? ["--use-angle=metal", "--ignore-gpu-blocklist"] : ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"];
const profile = path.join(os.homedir(), ".towerfall-browser", `${profileName}-profile`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.mkdirSync(profile, { recursive: true });
const browser = spawn(chrome, [
	"--headless=new", `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, "--no-first-run",
	...GPU_FLAGS, "--autoplay-policy=no-user-gesture-required", "about:blank",
], { stdio: "ignore" });
process.on("exit", () => browser.kill());

async function devtools(pathname, method = "GET") {
	for (let i = 0; i < 100; i++) {
		try {
			return await (await fetch(`http://127.0.0.1:${port}${pathname}`, { method, signal: AbortSignal.timeout(10_000) })).json();
		} catch {
			await sleep(100);
		}
	}
	throw new Error(`Chrome isn't answering on port ${port}`);
}

const target = await devtools(`/json/new?${encodeURIComponent(url)}`, "PUT");
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));
let nextId = 1;
const evaluate = (expression) =>
	new Promise((resolve) => {
		const id = nextId++;
		const timer = setTimeout(() => resolve(null), 15_000);
		const onMessage = (m) => {
			const d = JSON.parse(m.data);
			if (d.id !== id) return;
			clearTimeout(timer);
			ws.removeEventListener("message", onMessage);
			resolve(d.result?.result?.value);
		};
		ws.addEventListener("message", onMessage);
		ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true } }));
	});

let printed = 0;
const started = Date.now();
while (Date.now() - started < seconds * 1000) {
	await sleep(1000);
	const raw = await evaluate(`JSON.stringify({ log: self.consoleLog ?? [], error: document.getElementById("error")?.textContent })`);
	if (raw === null) {
		console.log(`[probe] page not answering (${Math.round((Date.now() - started) / 1000)}s)`);
		continue;
	}
	const elapsed = Math.round((Date.now() - started) / 1000);
	if (!raw) {
		if (elapsed % 10 === 0) console.log(`[probe] ${elapsed}s: no page state yet`);
		continue;
	}
	const s = JSON.parse(raw);
	if (s.log.length < printed) printed = 0; // reloaded
	for (const line of s.log.slice(printed)) if (!filter || filter.test(line)) console.log(line);
	printed = s.log.length;
	if (s.error) {
		console.log(`[probe] page error: ${s.error}`);
		break;
	}
}
browser.kill();
process.exit(0);
