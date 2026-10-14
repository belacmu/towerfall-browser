using System;

namespace TowerFallBrowser;

// Checks for cross-platform determinism (Towerfall Switch Mods/switch-online, PLAN.md): does the browser's .NET compute
// single-precision floats exactly as IEEE 754 says (each operation rounded to float, no wider
// intermediates, no fused multiply-add)? "floattest" host command; tools/floattest-reference.mjs
// computes the same with exact rounding, and the hashes must match. Run twice: the first pass is
// interpreted, later passes run as the jiterpreter's compiled WebAssembly.
public static class Determinism
{
	public static string FloatTest()
	{
		uint first = FloatPass();
		uint later = 0;
		for (int i = 0; i < 30; i++) later = FloatPass();
		return $"first pass {first:x8}, after warm-up {later:x8}";
	}

	// Math library results, against the Switch game's own sin/cos/atan2/pow (the cross-play probe,
	// ~/Code/tfx-crossplay-exlaunch, computes the same inputs on the Switch and logs the same
	// hashes). The game's Math.Sin/Cos/Atan2/Pow are exactly these calls on both platforms. Twice:
	// interpreted, then after warm-up (the jiterpreter may compile Math calls differently).
	public static string MathTest()
	{
		string first = MathPass();
		string later = "";
		for (int i = 0; i < 20; i++) later = MathPass();
		return first == later ? $"{first} (same after warm-up)" : $"first pass {first}; after warm-up {later}";
	}

	private static float Range(float lo, float hi)
	{
		double t = (Next() % 1000001) / 1000000.0;
		return (float)(lo + t * (hi - lo));
	}

	private sealed class Fnv64
	{
		public ulong H = 1469598103934665603ul;
		public void Mix(double d)
		{
			ulong bits = double.IsNaN(d) ? 0x7FF8000000000000ul : (ulong)BitConverter.DoubleToInt64Bits(d);
			for (int i = 0; i < 8; i++)
			{
				H ^= (bits >> (8 * i)) & 0xFF;
				H *= 1099511628211ul;
			}
		}
	}

	private static string MathPass()
	{
		var hs = new Fnv64();
		var hc = new Fnv64();
		var ha = new Fnv64();
		var hp = new Fnv64();
		state = 2463534242;
		for (int i = 0; i < 100000; i++)
		{
			float angle = Range(-10f, 10f);
			hs.Mix(Math.Sin(angle));
			hc.Mix(Math.Cos(angle));
			float y = Range(-500f, 500f);
			float x = Range(-500f, 500f);
			ha.Mix(Math.Atan2(y, x));
			float b = Range(0f, 2f);
			float e = Range(0f, 3f);
			hp.Mix(Math.Pow(b, e));
			hp.Mix(Math.Pow(0.9800000190734863, e)); // Arrow.ArrowUpdate's drag
		}
		return $"sin {hs.H:x16} cos {hc.H:x16} atan2 {ha.H:x16} pow {hp.H:x16}";
	}

	// xorshift32: the same sequence in C# and JavaScript (integer only).
	private static uint state;
	private static uint Next()
	{
		state ^= state << 13;
		state ^= state >> 17;
		state ^= state << 5;
		return state;
	}

	private static float Sample()
	{
		uint bits = Next();
		switch (Next() % 4)
		{
			case 0:
				float f = BitConverter.Int32BitsToSingle((int)bits);
				return float.IsFinite(f) ? f : 1.5f;
			case 1:
				return (float)((Next() % 2000000) / 1000.0 - 1000.0);
			case 2:
				return BitConverter.Int32BitsToSingle((int)(bits & 0x807FFFFF)); // subnormal (or zero)
			default:
				return 1f + BitConverter.Int32BitsToSingle((int)(bits & 0x007FFFFF | 0x34000000));
		}
	}

	private static uint hash;
	private static void Mix(float f)
	{
		uint bits = float.IsNaN(f) ? 0x7FC00000u : (uint)BitConverter.SingleToInt32Bits(f);
		for (int i = 0; i < 4; i++)
		{
			hash ^= (bits >> (8 * i)) & 0xFF;
			hash *= 16777619;
		}
	}

	private static uint FloatPass()
	{
		state = 2463534242;
		hash = 2166136261;
		for (int i = 0; i < 20000; i++)
		{
			float a = Sample(), b = Sample(), c = Sample();
			Mix(a + b);
			Mix(a - b);
			Mix(a * b);
			Mix(b != 0 ? a / b : 0f);
			Mix(a * b + c);
			Mix(a * b - c * a);
			Mix((float)Math.Sqrt(Math.Abs(a)));
			float m = a % 1000000f;
			Mix(m);
			Mix((float)(int)m);
			Mix((float)Math.Round(m));
			Mix((float)Math.Floor(m));
			Mix((float)(double)a * 0.98f);
		}
		return hash;
	}
}
