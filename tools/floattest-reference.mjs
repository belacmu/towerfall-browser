#!/usr/bin/env node
// The exact IEEE 754 single-precision answer to web/Determinism.cs's FloatTest: the same inputs and
// operations, every operation rounded to float with Math.fround. The browser's "floattest" command
// must print this hash for both passes. (docs/SWITCH-CROSSPLAY.md)
const f = Math.fround;
const u32 = new Uint32Array(1);
const f32 = new Float32Array(u32.buffer);
const fromBits = (bits) => ((u32[0] = bits >>> 0), f32[0]);
const toBits = (x) => ((f32[0] = x), u32[0]);

let state = 2463534242;
const next = () => {
	state = (state ^ (state << 13)) >>> 0;
	state = (state ^ (state >>> 17)) >>> 0;
	state = (state ^ (state << 5)) >>> 0;
	return state;
};

function sample() {
	const bits = next();
	switch (next() % 4) {
		case 0: {
			const x = fromBits(bits);
			return Number.isFinite(x) ? x : 1.5;
		}
		case 1:
			return f((next() % 2000000) / 1000 - 1000);
		case 2:
			return fromBits(bits & 0x807fffff);
		default:
			return f(1 + fromBits(((bits & 0x007fffff) | 0x34000000) >>> 0));
	}
}

let hash = 2166136261;
function mix(x) {
	const bits = Number.isNaN(x) ? 0x7fc00000 : toBits(x);
	for (let i = 0; i < 4; i++) {
		hash = (hash ^ ((bits >>> (8 * i)) & 0xff)) >>> 0;
		hash = Math.imul(hash, 16777619) >>> 0;
	}
}

// .NET's Math.Round(double): to nearest, ties to even.
function roundHalfEven(x) {
	const r = Math.round(x);
	return r - x === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

for (let i = 0; i < 20000; i++) {
	const a = sample(), b = sample(), c = sample();
	mix(f(a + b));
	mix(f(a - b));
	mix(f(a * b));
	mix(b !== 0 ? f(a / b) : 0);
	mix(f(f(a * b) + c));
	mix(f(f(a * b) - f(c * a)));
	mix(f(Math.sqrt(Math.abs(a))));
	const m = f(a % 1000000);
	mix(m);
	mix(f(Math.trunc(m) | 0)); // (an int: no negative zero, as in C#)
	mix(f(roundHalfEven(m)));
	mix(f(Math.floor(m)));
	mix(f(a * f(0.98)));
}
console.log(`exact IEEE single precision: ${hash.toString(16).padStart(8, "0")}`);
