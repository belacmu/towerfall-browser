#!/usr/bin/env node
// Smoke-tests catalog mods in headless Chrome against a local private-mode server (game files
// staged with tools/stage-gamefiles.sh, site served by tools/serve.py). For each mod it boots the
// game with only that mod (and its dependencies) enabled and checks the in-page log: the mod must
// load, nothing may log an error, and the game must reach the title screen and keep running.
// Results go to mods/overrides.json ("works" / "broken" with the first error), so the page offers
// what works (tools/update-catalog.py --offline folds them into mods/catalog.json). Usage:
//   node tools/smoke-mods.mjs [--url http://localhost:8080/] [--only Name,Name] [--retest]
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const base = opt("--url", "http://localhost:8080/");
const only = opt("--only", null)?.split(",");
const retest = args.includes("--retest");
const chrome = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
// The real GPU where Chrome can use it headless (Metal on macOS); software rendering elsewhere,
// which costs several CPU cores per running game.
const GPU_FLAGS = process.platform === "darwin" ? ["--use-angle=metal", "--ignore-gpu-blocklist"] : ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"];
const profile = path.join(os.homedir(), ".towerfall-browser", "smoke-profile"); // keeps the imported game
const port = 9334;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const catalog = JSON.parse(fs.readFileSync(path.join(root, "mods/catalog.json"), "utf8"));
const overridesPath = path.join(root, "mods/overrides.json");
const overrides = fs.existsSync(overridesPath) ? JSON.parse(fs.readFileSync(overridesPath, "utf8")) : {};
const mods = catalog.mods.flatMap((e) => e.mods).filter((m) => m.status !== "unsupported");
const todo = mods.filter((m) => (only ? only.includes(m.name) : retest || !overrides[m.name]));

try {
	const r = await fetch(new URL("gamefiles/manifest.json", base));
	if (!r.ok) throw new Error(`HTTP ${r.status}`);
} catch (e) {
	console.error(`No private-mode server at ${base} (${e.message}). Run tools/stage-gamefiles.sh and tools/serve.py first.`);
	process.exit(1);
}
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
	throw new Error(`Chrome isn't answering on port ${port} (${pathname})`);
}

// Resolves to null if the page doesn't answer within 15 s (a hung main thread), undefined if the
// evaluation failed (e.g. mid-navigation).
async function evaluate(ws, expression) {
	const id = Math.floor(Math.random() * 1e9);
	return new Promise((resolve) => {
		setTimeout(() => resolve(null), 15_000);
		const onMessage = (m) => {
			const d = JSON.parse(m.data);
			if (d.id !== id) return;
			ws.removeEventListener("message", onMessage);
			resolve(d.result?.result?.value);
		};
		ws.addEventListener("message", onMessage);
		ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true } }));
	});
}

const STATE = `JSON.stringify({ log: self.consoleLog ?? [], status: document.getElementById("status")?.textContent, error: document.getElementById("error")?.textContent })`;

async function test(mod) {
	const url = `${base}?mute&nointro&autoplay&allmods&mods=${encodeURIComponent(mod.name)}`;
	const target = await devtools(`/json/new?${encodeURIComponent(url)}`, "PUT");
	const ws = new WebSocket(target.webSocketDebuggerUrl);
	await new Promise((r) => ws.addEventListener("open", r));
	const started = Date.now();
	let result = { status: "broken", note: "Timed out before reaching the title screen." };
	let loadedAt = null;
	let silent = 0;
	while (Date.now() - started < 180_000) {
		await sleep(2000);
		const raw = await evaluate(ws, STATE);
		if (raw === null) {
			if (++silent >= 3) {
				result = { status: "broken", note: "The page stopped responding (the game hung)." };
				break;
			}
			continue;
		}
		if (!raw) continue;
		silent = 0;
		const s = JSON.parse(raw);
		if (process.env.SMOKE_VERBOSE && Math.round((Date.now() - started) / 1000) % 20 < 2) {
			console.log(`  ${Math.round((Date.now() - started) / 1000)}s: ${s.status} | ${(s.error || "").slice(0, 120)} | ${s.log.length} log lines`);
		}
		const errors = s.log.filter((l) => /^\[error\]/.test(l) && !/getInternalformat|deprecated/i.test(l));
		if (s.error) {
			result = { status: "broken", note: s.error.split("\n")[0].slice(0, 200) };
			break;
		}
		if (errors.length) {
			result = { status: "broken", note: errors[0].replace(/^\[error\]\s*/, "").slice(0, 200) };
			break;
		}
		if (!loadedAt && s.log.some((l) => l.includes("total of mods loaded"))) loadedAt = Date.now();
		// Loaded, and still running cleanly a little later (title screen, music, first frames).
		if (loadedAt && Date.now() - loadedAt > 12_000 && s.log.some((l) => l.includes("[perf]"))) {
			result = s.log.some((l) => l.includes(`${mod.name} ${mod.version} has been loaded`) || l.includes(`${mod.name} `) && l.includes("has been loaded"))
				? { status: "works", note: `Loads and runs to the title screen without errors (automated check, ${new Date().toISOString().slice(0, 10)}).` }
				: { status: "broken", note: "FortRise didn't load it (check its dependencies)." };
			break;
		}
	}
	if (process.env.SMOKE_VERBOSE) {
		const raw = await evaluate(ws, STATE).catch(() => null);
		if (raw) console.log(JSON.parse(raw).log.slice(-15).join("\n"));
	}
	ws.close();
	await devtools(`/json/close/${target.id}`).catch(() => {});
	return result;
}

console.log(`Testing ${todo.length} of ${mods.length} mods against ${base}`);
for (const [i, mod] of todo.entries()) {
	const result = await test(mod);
	overrides[mod.name] = { ...overrides[mod.name], ...result, version: mod.version };
	fs.writeFileSync(overridesPath, JSON.stringify(overrides, null, "\t") + "\n");
	console.log(`[${i + 1}/${todo.length}] ${mod.name} ${mod.version}: ${result.status} — ${result.note}`);
}
browser.kill();
process.exit(0);
