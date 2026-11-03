// Physical controllers (Bluetooth or USB) through the browser's Gamepad API. The game runs in a
// worker, where that API doesn't exist, so the page polls up to 8 pads and sends each one's state,
// in SDL's gamepad layout, to the host (PadBridge.cs), which plugs a virtual gamepad in per pad.

export const MAX_PADS = 8;
const DEADZONE = 0.12;
const MAX = 32767;

// Standard mapping (the W3C layout most browsers apply to Xbox, DualShock/DualSense, Pro Controller
// and often Joy-Cons) to SDL_GamepadButton indices: south, east, west, north, back, guide, start,
// left stick, right stick, left shoulder, right shoulder, d-pad up/down/left/right.
const STANDARD_TO_SDL = [0, 1, 2, 3, 9, 10, null, null, 4, 6, 7, 8, 11, 12, 13, 14, 5];
const LEFT_TRIGGER = 1 << 15;
const RIGHT_TRIGGER = 1 << 16;

const axis = (v) => {
	if (!(Math.abs(v) > DEADZONE)) return 0;
	return Math.round(Math.max(-1, Math.min(1, v)) * MAX);
};

const pressed = (b) => !!b && (b.pressed || b.value > 0.5);

// A pad's state as [buttons, lx, ly, rx, ry, lt, rt] (stick axes -32767..32767, triggers 0..32767).
// Pads without the standard mapping (some Joy-Cons) are read as if they had it: right for most.
export function readPad(pad) {
	let buttons = 0;
	STANDARD_TO_SDL.forEach((sdl, i) => {
		if (sdl !== null && pressed(pad.buttons[i])) buttons |= 1 << sdl;
	});
	const lt = pad.buttons[6]?.value ?? 0, rt = pad.buttons[7]?.value ?? 0;
	if (lt > 0.5) buttons |= LEFT_TRIGGER;
	if (rt > 0.5) buttons |= RIGHT_TRIGGER;
	// A pad with no d-pad buttons but a hat axis (index 9, -1..1 in 2/7 steps) isn't mapped here.
	const a = pad.axes;
	return [buttons, axis(a[0] ?? 0), axis(a[1] ?? 0), axis(a[2] ?? 0), axis(a[3] ?? 0), Math.round(lt * MAX), Math.round(rt * MAX)];
}

// Polls every frame; send(slot, state) on a change, release(slot) when a pad goes. Slots are the
// pads' own browser indices, so a pad keeps its slot while connected.
export function startPads(send, release) {
	if (!navigator.getGamepads) return;
	const last = new Array(MAX_PADS).fill(null);
	const poll = () => {
		const pads = navigator.getGamepads();
		for (let i = 0; i < MAX_PADS; i++) {
			const pad = pads[i];
			if (!pad || !pad.connected) {
				if (last[i] !== null) { last[i] = null; release(i); }
				continue;
			}
			const state = readPad(pad);
			const key = state.join(",");
			if (key !== last[i]) { last[i] = key; send(i, ...state); }
		}
		requestAnimationFrame(poll);
	};
	requestAnimationFrame(poll);
}
