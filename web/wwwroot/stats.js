// Performance numbers from real play, on any device: the Stats panel (the corner's Stats button, or
// ?stats) and reports to the site's server (cloudflare/tfex-server/reports.js).
//  - Every second it takes the game's numbers (web/Diagnostics.cs: frame times, and online the tick
//    rate, rollbacks, ping, input delay, slow-down), the packet timing from netplay/tfnet.js
//    (globalThis.tfnetStats) and how late the page's main thread runs timers.
//  - A report goes to the server when an online match ends (after MIN_ONLINE_S of play), after every
//    SOLO_REPORT_S of play in levels, and when the page is hidden or closes. It holds numbers, the device type
//    (user agent, cores, memory, screen) and the site version: no names or lobby codes.
//  - Reports only go to our own server: not with ?tfexserver=official, and from a localhost page
//    only to a local server (so test runs don't fill the real one).

const SOLO_REPORT_S = 300;
const MIN_ONLINE_S = 20;
const ONLINE_END_S = 5; // an online match is over after this long without one
const TIMELINE_STEP_S = 10;
const MAX_TIMELINE = 90;

// Totals over a stretch of windows (seconds of play).
class Summary {
	constructor() {
		this.seconds = this.frames = this.gameMs = this.worstMs = this.over16 = this.over33 = this.gcs = 0;
		this.online = this.ticks = this.rollbacks = this.rollbackTicks = this.deepestRollback = 0;
		this.aheadFrames = this.netplayFrames = this.droppedMs = 0;
		this.ping = { n: 0, sum: 0, max: 0 };
		this.behind = 0;
		this.inputDelay = null;
		this.aheadFrom = null;
		this.packets = 0;
		this.wait = timing();
		this.late = timing();
		this.rtt = timing(); // WebRTC's own round trip: the network alone
		this.path = "";
		this.routes = "";
		this.timeline = [];
		this.step = null;
	}

	add(w) {
		this.seconds += w.seconds;
		this.frames += w.frames;
		this.gameMs += w.gameMs;
		this.worstMs = Math.max(this.worstMs, w.worstMs);
		this.over16 += w.over16;
		this.over33 += w.over33;
		this.gcs += w.gcs;
		if (w.netplayFrames > 0) {
			this.online += w.seconds;
			this.ticks += w.ticks ?? 0;
			this.rollbacks += w.rollbacks;
			this.rollbackTicks += w.rollbackTicks;
			this.deepestRollback = Math.max(this.deepestRollback, w.deepestRollback);
			this.aheadFrames += w.aheadFrames;
			this.netplayFrames += w.netplayFrames;
			this.droppedMs += w.droppedMs ?? 0;
			if (w.ping != null) {
				this.ping.n++;
				this.ping.sum += w.ping;
				this.ping.max = Math.max(this.ping.max, w.ping);
			}
			this.behind = Math.max(this.behind, w.localBehind ?? 0, w.remoteBehind ?? 0);
			if (w.inputDelay != null) this.inputDelay = w.inputDelay;
			if (w.aheadFrom != null) this.aheadFrom = w.aheadFrom;
		}
		this.packets += w.packets ?? 0;
		merge(this.wait, w.wait);
		merge(this.late, w.late);
		merge(this.rtt, w.rtt);
		if (w.path) this.path = w.path;
		if (w.routes) this.routes = w.routes;
		// A coarse timeline, one row per TIMELINE_STEP_S.
		this.step ??= new Summary.Step();
		this.step.add(w);
		if (this.step.seconds >= TIMELINE_STEP_S) {
			if (this.timeline.length < MAX_TIMELINE) this.timeline.push(this.step.row(this.seconds));
			this.step = null;
		}
	}

	// The numbers, rounded, as they go into a report.
	result() {
		const r = (x, d = 1) => Math.round(x * 10 ** d) / 10 ** d;
		const out = {
			seconds: r(this.seconds, 0),
			fps: r(this.frames / this.seconds),
			gameMsPerFrame: r(this.gameMs / this.frames, 2),
			worstFrameMs: r(this.worstMs, 0),
			framesOver16ms: this.over16,
			framesOver33ms: this.over33,
			gcs: this.gcs,
			mainThreadLateMs: summarize(this.late),
		};
		if (this.online > 0) {
			Object.assign(out, {
				onlineSeconds: r(this.online, 0),
				ticksPerSecond: r(this.ticks / this.online, 0), // 240 is full speed
				rollbacksPerSecond: r(this.rollbacks / this.online, 1),
				rollbackTicksAvg: this.rollbacks ? r(this.rollbackTicks / this.rollbacks, 1) : 0,
				rollbackTicksMax: this.deepestRollback,
				slowingDownPercent: this.netplayFrames ? r((100 * this.aheadFrames) / this.netplayFrames, 0) : 0,
				slowDownFromTicksAhead: this.aheadFrom, // (web/Netplay/AheadThreshold.cs; TF.EX's own rule is 1)
				catchUpDroppedMs: r(this.droppedMs, 0),
				pingMs: this.ping.n ? { avg: r(this.ping.sum / this.ping.n, 0), max: this.ping.max } : null,
				// The same round trip measured by WebRTC: the network alone. Ping minus this is what
				// the two games and browsers add.
				networkRttMs: summarize(this.rtt),
				framesBehindMax: this.behind,
				inputDelayTicks: this.inputDelay,
				connection: this.path,
				routes: this.routes, // what each side found and tried (tfnet.js TFNet.routes)
				packetsPerSecond: r(this.packets / this.online, 0),
				packetToGameMs: summarize(this.wait),
			});
		}
		return out;
	}
}

// One timeline row: [seconds so far, fps, game ms/frame, worst frame ms, ticks/s, rollbacks/s,
// ping, packet-to-game ms (avg), main thread late (max)].
Summary.Step = class {
	constructor() {
		this.seconds = this.frames = this.gameMs = this.worstMs = this.ticks = this.rollbacks = this.online = 0;
		this.ping = null;
		this.wait = timing();
		this.late = timing();
	}
	add(w) {
		this.seconds += w.seconds;
		this.frames += w.frames;
		this.gameMs += w.gameMs;
		this.worstMs = Math.max(this.worstMs, w.worstMs);
		if (w.netplayFrames > 0) {
			this.online += w.seconds;
			this.ticks += w.ticks ?? 0;
			this.rollbacks += w.rollbacks;
			if (w.ping != null) this.ping = w.ping;
		}
		merge(this.wait, w.wait);
		merge(this.late, w.late);
	}
	row(at) {
		const r = (x, d = 1) => Math.round(x * 10 ** d) / 10 ** d;
		return [r(at, 0), r(this.frames / this.seconds), r(this.gameMs / Math.max(1, this.frames), 1), r(this.worstMs, 0),
			this.online ? r(this.ticks / this.online, 0) : null, this.online ? r(this.rollbacks / this.online, 1) : null, this.ping,
			this.wait.n ? r(this.wait.sum / this.wait.n, 2) : null, r(this.late.max, 0)];
	}
};

function timing() {
	return { n: 0, sum: 0, max: 0, over4: 0, over16: 0 };
}
function merge(into, t) {
	if (!t) return;
	into.n += t.n;
	into.sum += t.sum;
	into.max = Math.max(into.max, t.max);
	into.over4 += t.over4;
	into.over16 += t.over16;
}
function summarize(t) {
	if (!t.n) return null;
	const r = (x) => Math.round(x * 100) / 100;
	return { avg: r(t.sum / t.n), max: r(t.max), over4Percent: r((100 * t.over4) / t.n), over16Percent: r((100 * t.over16) / t.n) };
}

// How late the main thread runs a 50 ms timer: what packets and frames wait behind.
function lateTimer() {
	const t = timing();
	let expected = performance.now() + 50;
	setInterval(() => {
		const now = performance.now();
		const late = Math.max(0, now - expected);
		t.n++;
		t.sum += late;
		t.max = Math.max(t.max, late);
		if (late > 4) t.over4++;
		if (late > 16.7) t.over16++;
		expected = now + 50;
	}, 50);
	return () => {
		const out = { ...t };
		Object.assign(t, timing());
		return out;
	};
}

// The page's own numbers since the last call, from netplay/tfnet.js.
function takePackets() {
	const s = globalThis.tfnetStats;
	if (!s) return {};
	const out = { packets: s.packets, wait: s.wait, rtt: s.rtt, path: s.path, routes: s.routes };
	s.packets = 0;
	s.wait = null;
	s.rtt = null;
	return out;
}

function device() {
	const params = new URLSearchParams(location.search);
	return {
		userAgent: navigator.userAgent,
		cores: navigator.hardwareConcurrency ?? null,
		memoryGb: navigator.deviceMemory ?? null,
		screen: `${screen.width}x${screen.height}@${devicePixelRatio}`,
		touch: navigator.maxTouchPoints > 0,
		// Runs that aren't real play: TF.EX's sync test, or the slow-computer stand-in.
		test: /(^|;)test($|;)/.test(params.get("command") ?? "") || null,
		slowcpu: Number(params.get("slowcpu")) > 1 ? Number(params.get("slowcpu")) : null,
	};
}

// A failure before or while starting the game (fail() in main.js), so problems on players' devices
// show up in the reports (tools/reports.sh) like play does: the step, the error, the device and
// what its browser supports. URLs are left out (a private file host's link holds its key).
export function reportFailure(serverUrl, { step, error, version }) {
	try {
		const local = ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
		if (!serverUrl || local) return;
		const clean = (text) => String(text ?? "").replace(/[a-z]+:\/\/\S+/gi, "<url>").slice(0, 2000);
		const body = JSON.stringify({
			kind: "loadfail",
			v: 1,
			site: location.pathname.includes("/preview/") ? "preview" : "main",
			version,
			at: new Date().toISOString(),
			step: clean(step),
			error: clean(error),
			device: device(),
			standalone: matchMedia("(display-mode: standalone)").matches || navigator.standalone === true,
			crossOriginIsolated: self.crossOriginIsolated === true,
			createWritable: typeof FileSystemFileHandle !== "undefined" && "createWritable" in FileSystemFileHandle.prototype,
		});
		const url = serverUrl.replace(/^ws/, "http").replace(/\/+$/, "") + "/report";
		fetch(url, { method: "POST", body, keepalive: true, headers: { "Content-Type": "text/plain" } }).catch(() => {});
	} catch {}
}

// startStats(host, { serverUrl, version }): starts collecting; returns nothing. host is the .NET
// exports' BrowserHost; serverUrl the TF.EX server's ws(s) URL the page uses (or null).
export function startStats(host, { serverUrl, official, version }) {
	const local = ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
	const serverLocal = /^wss?:\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(serverUrl ?? "");
	const reportUrl = serverUrl && !official && (!local || serverLocal) ? serverUrl.replace(/^ws/, "http").replace(/\/+$/, "") + "/report" : null;
	const site = local ? "local" : location.pathname.includes("/preview/") ? "preview" : "main";
	const takeLate = lateTimer();
	let total = new Summary();
	const recent = []; // the last 5 windows, for the panel
	let online = null, quiet = 0, solo = new Summary();
	let hiddenBefore = document.hidden;

	const send = (kind, summary, beacon = false) => {
		if (!reportUrl) return;
		const body = JSON.stringify({ kind, v: 1, site, version, at: new Date().toISOString(), device: device(), ...summary.result(), timeline: summary.timeline });
		try {
			if (beacon && navigator.sendBeacon) navigator.sendBeacon(reportUrl, new Blob([body], { type: "text/plain" }));
			else fetch(reportUrl, { method: "POST", body, keepalive: true, headers: { "Content-Type": "text/plain" } }).catch(() => {});
		} catch {}
	};

	host.SetDiagnostics(true).catch(() => {});
	setInterval(async () => {
		let w;
		try {
			w = JSON.parse(await host.TakeDiagnostics());
		} catch {
			return;
		}
		Object.assign(w, takePackets(), { late: takeLate() });
		// A hidden tab (in the background, or a locked phone) isn't play: its timers are throttled, so
		// its windows would report 0 fps and a minute of lateness. They're left out, and so is the
		// first one after it's shown again (it still holds the gap).
		const skip = document.hidden || hiddenBefore;
		hiddenBefore = document.hidden;
		if (skip) return;
		total.add(w);
		recent.push(w);
		if (recent.length > 5) recent.shift();
		if (w.netplayFrames > 0) {
			(online ??= new Summary()).add(w);
			quiet = 0;
		} else {
			if (online && ++quiet >= ONLINE_END_S) {
				if (online.online >= MIN_ONLINE_S) send("online", online);
				online = null;
			}
			if (w.scene === "Level") {
				solo.add(w);
				if (solo.seconds >= SOLO_REPORT_S) {
					send("solo", solo);
					solo = new Summary();
				}
			}
		}
		render();
	}, 1000);

	// Leaving the page sends what's there. iPhones often skip pagehide (switching apps, locking the
	// phone, closing from the tab switcher), but do report the page being hidden.
	const flush = () => {
		if (online?.online >= MIN_ONLINE_S) send("online", online, true);
		if (solo.seconds >= 60) send("solo", solo, true);
		online = null;
		solo = new Summary();
	};
	addEventListener("pagehide", flush);
	document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && flush());

	// The panel.
	const button = document.getElementById("statsToggle");
	const panel = document.getElementById("statsPanel");
	const text = panel?.querySelector("pre");
	const show = (on) => {
		panel.hidden = !on;
		button.textContent = on ? "Stats: on" : "Stats";
		try {
			localStorage.setItem("towerfall.stats", on ? "1" : "0");
		} catch {}
		render();
	};
	button?.addEventListener("click", () => show(panel.hidden));
	panel?.querySelector(".copy")?.addEventListener("click", async (e) => {
		const report = JSON.stringify({ kind: "copied", site, version, at: new Date().toISOString(), device: device(), ...total.result(), timeline: total.timeline }, null, 1);
		try {
			await navigator.clipboard.writeText(report);
			e.target.textContent = "Copied";
		} catch {
			// No clipboard access (e.g. an old browser): show it to select by hand.
			text.textContent = report;
			e.target.textContent = "Select the text above";
		}
		setTimeout(() => (e.target.textContent = "Copy report"), 2000);
	});
	panel?.querySelector(".reset")?.addEventListener("click", () => {
		total = new Summary();
		render();
	});
	let wanted = new URLSearchParams(location.search).has("stats");
	try {
		wanted ||= localStorage.getItem("towerfall.stats") === "1";
	} catch {}
	if (button && panel) {
		button.hidden = false;
		show(wanted);
	}

	function render() {
		if (!text || panel.hidden) return;
		const now = new Summary();
		for (const w of recent) now.add(w);
		const n = now.seconds ? now.result() : null;
		const t = total.result();
		const ms = (x) => (x == null ? "–" : `${x.avg}/${x.max}`);
		const lines = [];
		if (n) {
			lines.push(`${n.fps} fps · ${n.gameMsPerFrame} ms/frame · worst ${n.worstFrameMs} · page late ${ms(n.mainThreadLateMs)} ms`);
			if (n.onlineSeconds) {
				lines.push(`${n.ticksPerSecond}/240 ticks/s · ${n.rollbacksPerSecond} rollbacks/s (max ${n.rollbackTicksMax}) · slow-down ${n.slowingDownPercent}%`);
				lines.push(`ping ${n.pingMs?.avg ?? "–"} ms (network ${n.networkRttMs ? Math.round(n.networkRttMs.avg) : "–"}) · delay ${n.inputDelayTicks ?? "–"} · packets wait ${ms(n.packetToGameMs)} ms`);
				lines.push(`${n.connection || "connection ?"}`);
			}
		}
		lines.push(`all ${Math.round(t.seconds || 0)} s: ${t.framesOver16ms ?? 0} slow frames, worst ${t.worstFrameMs ?? 0} ms${t.onlineSeconds ? `, ${t.ticksPerSecond} ticks/s, ${t.rollbacksPerSecond} rollbacks/s` : ""}`);
		lines.push(reportUrl ? "(avg/max) Numbers like these, no names, go to the site's server after matches and every 5 min of play." : "(avg/max) Reports are off for this page.");
		text.textContent = lines.join("\n");
	}
}
