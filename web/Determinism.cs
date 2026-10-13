using System;

namespace TowerFallBrowser;

// Checks for cross-platform determinism (docs/SWITCH-CROSSPLAY.md): does the browser's .NET compute
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
