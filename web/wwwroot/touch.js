// On-screen controls for touch screens. They drive a virtual gamepad in the host (TouchGamepad.cs),
// so the game sees an ordinary controller. Layout: a floating stick anywhere on the left half,
// jump/shoot/dodge at the bottom right, back and pause at the top left.
//
// The page's Controls button turns them on and off (remembered per browser); by default they're on
// for touch screens. ?touch / ?notouch in the URL override that.

// TouchGamepad's state bits: SDL_GamepadButton indices, plus the triggers.
const A = 1 << 0;
const B = 1 << 1;
const X = 1 << 2;
const START = 1 << 6;
const RIGHT_SHOULDER = 1 << 10;
const RIGHT_TRIGGER = 1 << 16;

// Dodge presses both right shoulder and right trigger, whichever the game has it on.
const BUTTONS = [
	{ name: "jump", label: "Jump", bits: A },
	{ name: "shoot", label: "Shoot", bits: X },
	{ name: "dodge", label: "Dodge", bits: RIGHT_SHOULDER | RIGHT_TRIGGER },
	{ name: "back", label: "Back", bits: B },
	{ name: "pause", label: "Pause", bits: START },
];

const TOUCH_KEY = "towerfall.touch";

export function touchWanted() {
	const params = new URLSearchParams(location.search);
	if (params.has("notouch")) return false;
	if (params.has("touch")) return true;
	try {
		const saved = localStorage.getItem(TOUCH_KEY);
		if (saved !== null) return saved === "1";
	} catch {}
	return matchMedia("(pointer: coarse)").matches;
}

export function saveTouchWanted(on) {
	try {
		localStorage.setItem(TOUCH_KEY, on ? "1" : "0");
	} catch {}
}

// Adds the controls to the page. `send(buttons, x, y)` gets their state; flush() calls it once
// per frame at most, when something changed.
export function createTouchControls(send) {
	const root = document.createElement("div");
	root.id = "touch";
	root.innerHTML =
		`<div class="stick"><div class="knob"></div></div>` +
		BUTTONS.map((b) => `<div class="tbutton ${b.name}" data-bits="${b.bits}">${b.label}</div>`).join("");
	document.body.append(root);
	const stick = root.querySelector(".stick");
	const knob = root.querySelector(".knob");

	// pointerId -> { kind: "stick", ox, oy, x, y } or { kind: "button", el }
	const pointers = new Map();
	let sent = "0,0,0";

	const buttonAt = (x, y) => document.elementFromPoint(x, y)?.closest?.("#touch .tbutton") ?? null;
	// The resting stick's radius: 0.8 * --size in index.html.
	const radius = () => Math.min(Math.min(innerWidth, innerHeight) * 0.19, 88) * 0.8;

	function stickValue(p) {
		const r = radius();
		let dx = p.x - p.ox;
		let dy = p.y - p.oy;
		const d = Math.hypot(dx, dy);
		// Past the rim, drag the stick along: reversing direction then doesn't need the finger to
		// travel all the way back.
		if (d > r) {
			p.ox += (dx * (d - r)) / d;
			p.oy += (dy * (d - r)) / d;
			dx = p.x - p.ox;
			dy = p.y - p.oy;
		}
		return { x: dx / r, y: dy / r };
	}

	function render() {
		const held = new Set();
		for (const p of pointers.values()) if (p.kind === "button" && p.el) held.add(p.el);
		for (const el of root.querySelectorAll(".tbutton")) el.classList.toggle("down", held.has(el));
		const p = [...pointers.values()].find((q) => q.kind === "stick");
		stick.classList.toggle("active", !!p);
		if (p) {
			const v = stickValue(p);
			const r = radius();
			stick.style.cssText = `left:${p.ox}px;top:${p.oy}px;width:${2 * r}px;height:${2 * r}px`;
			knob.style.transform = `translate(${v.x * r}px, ${v.y * r}px)`;
		} else {
			stick.style.cssText = "";
			knob.style.transform = "";
		}
	}

	root.addEventListener("pointerdown", (e) => {
		e.preventDefault();
		root.setPointerCapture(e.pointerId);
		const el = buttonAt(e.clientX, e.clientY);
		if (el) {
			pointers.set(e.pointerId, { kind: "button", el });
		} else if (e.clientX < innerWidth / 2 && ![...pointers.values()].some((p) => p.kind === "stick")) {
			pointers.set(e.pointerId, { kind: "stick", ox: e.clientX, oy: e.clientY, x: e.clientX, y: e.clientY });
		}
		render();
	});
	root.addEventListener("pointermove", (e) => {
		const p = pointers.get(e.pointerId);
		if (!p) return;
		if (p.kind === "stick") {
			p.x = e.clientX;
			p.y = e.clientY;
		} else {
			// Sliding a finger from one button to another switches between them.
			p.el = buttonAt(e.clientX, e.clientY);
		}
		render();
	});
	const release = (e) => {
		pointers.delete(e.pointerId);
		render();
	};
	root.addEventListener("pointerup", release);
	root.addEventListener("pointercancel", release);
	root.addEventListener("contextmenu", (e) => e.preventDefault());

	return {
		// Hiding lets go of everything held.
		setVisible(visible) {
			root.hidden = !visible;
			if (!visible) pointers.clear();
			render();
		},
		flush() {
			let buttons = 0;
			let x = 0;
			let y = 0;
			for (const p of pointers.values()) {
				if (p.kind === "button" && p.el) buttons |= Number(p.el.dataset.bits);
				if (p.kind === "stick") {
					const v = stickValue(p);
					x = Math.round(Math.max(-1, Math.min(1, v.x)) * 32767);
					y = Math.round(Math.max(-1, Math.min(1, v.y)) * 32767);
				}
			}
			const state = `${buttons},${x},${y}`;
			if (state === sent) return;
			sent = state;
			return send(buttons, x, y);
		},
	};
}
