// On-screen controls for touch screens. They drive a virtual gamepad in the host (TouchGamepad.cs),
// so the game sees an ordinary controller. Layout: a stick on the left half (see pointerdown),
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

// How the game reads the stick (TowerFall's XGamepadInput, through FNA's default deadzone): FNA
// drops 7849/32768 off each axis and rescales the rest to 0..1; then the game runs at |x| >= 0.5,
// ducks or looks up at |y| >= 0.8, and aims at the stick's angle rounded to 45 degrees (or exactly,
// with the free aiming variant). A thumb on glass has no rim to push against, so the stick here is
// about direction, not distance: past a small deadzone it sends a full push, shaped so that the
// game sees the direction meant (see stickOutput).
const FNA_DEADZONE = 7849 / 32768;
const DEG = Math.PI / 180;

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

	// The resting stick's radius: 0.8 * --size in index.html. The thumb drags the stick along past
	// LEASH of it, so turning around takes LEASH + DEADZONE of travel, not a whole stick's width.
	const radius = () => Math.min(Math.min(innerWidth, innerHeight) * 0.19, 88) * 0.8;
	const DEADZONE = 0.16;
	const LEASH = 0.5;

	// A touch counts for the nearest button whose edge is within reach: the round buttons reach
	// SLOP of their radius past their edge, which also covers the gaps between them; the small ones
	// at the top a few pixels. A finger already holding a button keeps it a little further out.
	const SLOP = 0.6;
	const SMALL_SLOP = 14;
	const HOLD = 1.5;
	function buttonAt(x, y, held = null) {
		let best = null;
		let bestGap = Infinity;
		for (const el of root.querySelectorAll(".tbutton")) {
			const r = el.getBoundingClientRect();
			let gap;
			let reach;
			if (el.classList.contains("back") || el.classList.contains("pause")) {
				gap = Math.hypot(Math.max(r.left - x, 0, x - r.right), Math.max(r.top - y, 0, y - r.bottom));
				reach = SMALL_SLOP;
			} else {
				gap = Math.hypot(x - (r.left + r.right) / 2, y - (r.top + r.bottom) / 2) - r.width / 2;
				reach = (r.width / 2) * SLOP;
			}
			if (el === held) reach *= HOLD;
			if (gap <= reach && gap < bestGap) {
				best = el;
				bestGap = gap;
			}
		}
		return best;
	}

	// The finger's offset from the stick's centre, in stick radii.
	function stickValue(p) {
		const r = radius();
		const leash = r * LEASH;
		let dx = p.x - p.ox;
		let dy = p.y - p.oy;
		const d = Math.hypot(dx, dy);
		if (d > leash) {
			p.ox += (dx * (d - leash)) / d;
			p.oy += (dy * (d - leash)) / d;
			dx = p.x - p.ox;
			dy = p.y - p.oy;
		}
		return { x: dx / r, y: dy / r };
	}

	// What the stick sends for a finger offset: nothing inside the deadzone, else a full push in 8
	// even sectors, each doing what that direction does on a pad pushed all the way. Left/right
	// (within 22.5 degrees of level) run and aim level; the diagonals run and aim diagonally without
	// ducking (their angle is squeezed below the game's duck threshold); up/down duck or look up and
	// aim straight. Each sector's angles are squeezed a little clear of the game's 45 degree rounding
	// so free aiming still follows the thumb, and near the middle of the level and upright sectors
	// the stick sends exactly level or upright, as a pad's deadzone would, so a wobbly thumb doesn't
	// aim off or turn a dodge into a slide. Then each axis gets FNA's deadzone added back, so the
	// game sees this direction rather than one pulled towards the axes.
	const SECTORS = [
		// [thumb angle from level, up to], [sent angle from, to], in degrees
		[12, [0, 0]],
		[22.5, [0, 20]],
		[67.5, [25, 52]],
		[78, [70, 90]],
		[90, [90, 90]],
	];
	// The thumb's direction, held until it turns more than STEADY degrees away. A thumb on glass
	// never keeps still, and online every change the game sees is a new input the opponent's game
	// mispredicted and rolls back for: a scripted wobbling thumb made its opponent roll back about 45
	// times a second (a quarter of that with this). STEADY is well below the game's 45 degree aim
	// rounding, so it only costs free aiming a few degrees of resolution.
	const STEADY = 8;
	let steady = null; // degrees, or null while the stick isn't pushed
	function steadyDirection(v) {
		const a = Math.atan2(v.y, v.x) / DEG;
		const turned = steady === null ? Infinity : Math.abs(((a - steady + 540) % 360) - 180);
		if (turned > STEADY) steady = a;
		return { x: Math.cos(steady * DEG), y: Math.sin(steady * DEG) };
	}

	function stickOutput(v) {
		if (Math.hypot(v.x, v.y) < DEADZONE) {
			steady = null;
			return { x: 0, y: 0 };
		}
		v = steadyDirection(v);
		const a = Math.atan2(Math.abs(v.y), Math.abs(v.x)) / DEG;
		let from = 0;
		let out = 90;
		for (const [to, [lo, hi]] of SECTORS) {
			if (a <= to) {
				out = lo + ((hi - lo) * (a - from)) / (to - from);
				break;
			}
			from = to;
		}
		const axis = (g, sign) => (g < 1e-6 ? 0 : sign * Math.min(1, FNA_DEADZONE + g * (1 - FNA_DEADZONE)));
		return { x: axis(Math.cos(out * DEG), Math.sign(v.x)), y: axis(Math.sin(out * DEG), Math.sign(v.y)) };
	}

	function render() {
		const held = new Set();
		for (const p of pointers.values()) if (p.kind === "button" && p.el) held.add(p.el);
		for (const el of root.querySelectorAll(".tbutton")) el.classList.toggle("down", held.has(el));
		const p = [...pointers.values()].find((q) => q.kind === "stick");
		stick.classList.toggle("active", !!p);
		if (p) {
			// The knob reaches the rim where the stick starts dragging along.
			const v = stickValue(p);
			const r = radius();
			stick.style.cssText = `left:${p.ox}px;top:${p.oy}px;width:${2 * r}px;height:${2 * r}px`;
			knob.style.transform = `translate(${(v.x / LEASH) * r}px, ${(v.y / LEASH) * r}px)`;
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
		} else if (![...pointers.values()].some((p) => p.kind === "stick")) {
			// A touch anywhere on the left half (or in the resting stick's ring) takes hold of the
			// stick from where it rests, so it's pushed from there towards the thumb at once: a tap
			// off centre is a press that way, and tapping again presses again, like flicking a real
			// stick (picking the archer two to the right). Past the rim the stick comes along with
			// the thumb (stickValue); let go, it goes back to rest.
			const b = stick.getBoundingClientRect();
			const cx = (b.left + b.right) / 2;
			const cy = (b.top + b.bottom) / 2;
			if (e.clientX < innerWidth / 2 || Math.hypot(e.clientX - cx, e.clientY - cy) <= radius()) {
				pointers.set(e.pointerId, { kind: "stick", ox: cx, oy: cy, x: e.clientX, y: e.clientY });
			}
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
			p.el = buttonAt(e.clientX, e.clientY, p.el);
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
			if (![...pointers.values()].some((p) => p.kind === "stick")) steady = null;
			for (const p of pointers.values()) {
				if (p.kind === "button" && p.el) buttons |= Number(p.el.dataset.bits);
				if (p.kind === "stick") {
					const v = stickOutput(stickValue(p));
					x = Math.round(v.x * 32767);
					y = Math.round(v.y * 32767);
				}
			}
			const state = `${buttons},${x},${y}`;
			if (state === sent) return;
			sent = state;
			return send(buttons, x, y);
		},
	};
}
