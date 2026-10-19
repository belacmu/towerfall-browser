using System;
using System.Diagnostics;
using System.Reflection;
using System.Reflection.Emit;
using MonoMod.Utils;

namespace TowerFallBrowser;

// Micro-benchmarks for the browser runtime ("bench" host command), to compare ways of reading a
// private field: TF.State reads hundreds per state save through MonoMod's DynamicData.
public static class Bench
{
	private sealed class Sample
	{
#pragma warning disable CS0414, CS0169
		private float counter = 1.5f;
		private object reference = "x";
#pragma warning restore CS0414, CS0169
	}

	[System.Runtime.InteropServices.DllImport("Emscripten")]
	private static extern int tfnet_state(int h);

	public static void Run()
	{
		var sample = new Sample();
		FieldInfo field = typeof(Sample).GetField("counter", BindingFlags.NonPublic | BindingFlags.Instance);
		const int n = 20000;
		float sink = 0;

		Time("direct (baseline loop)", n, () => { for (int i = 0; i < n; i++) sink += i; });
		Time("DynamicData.For(x).Get<float>", n, () => { for (int i = 0; i < n; i++) sink += DynamicData.For(sample).Get<float>("counter"); });
		var dyn = DynamicData.For(sample);
		Time("cached DynamicData .Get<float>", n, () => { for (int i = 0; i < n; i++) sink += dyn.Get<float>("counter"); });
		Time("FieldInfo.GetValue", n, () => { for (int i = 0; i < n; i++) sink += (float)field.GetValue(sample); });
		var fast = field.GetFastInvoker();
		Time("MonoMod FastInvoker", n, () => { for (int i = 0; i < n; i++) sink += (float)fast(sample); });
		Func<object, object> emitted = EmitGetter(field);
		Time("DynamicMethod getter", n, () => { for (int i = 0; i < n; i++) sink += (float)emitted(sample); });
		// A call proxied synchronously to the page's main thread (what the netcode transport does).
		Time("call proxied to the page (tfnet_state)", 2000, () => { for (int i = 0; i < 2000; i++) sink += tfnet_state(0); });
		Console.WriteLine($"[bench] done ({sink > 0})");
	}

	// "bench dynfor": bytes allocated and time per DynamicData.For call, for the same object, two alternating
	// objects, 64 long-lived objects in turn, and new objects.
	public static void RunDynamicDataFor()
	{
		var objects = new Sample[64];
		for (int i = 0; i < objects.Length; i++) objects[i] = new Sample();
		void Measure(string name, int n, Func<int, object> pick)
		{
			for (int i = 0; i < n; i++) DynamicData.For(pick(i)); // warm up
			long bytes = GC.GetAllocatedBytesForCurrentThread();
			var sw = Stopwatch.StartNew();
			for (int i = 0; i < n; i++) DynamicData.For(pick(i));
			sw.Stop();
			bytes = GC.GetAllocatedBytesForCurrentThread() - bytes;
			Console.WriteLine($"[bench] DynamicData.For, {name}: {bytes / (double)n:0.0} bytes/call, {sw.Elapsed.TotalMilliseconds * 1000 / n:0.00} us/call");
		}
		Measure("same object", 20000, _ => objects[0]);
		Measure("two alternating", 20000, i => objects[i & 1]);
		Measure("64 in turn", 20000, i => objects[i & 63]);
		Measure("new objects", 2000, _ => new Sample());
	}

	// "bench dyndata": the first DynamicData of each kind of entity (TF.EX takes one in many entity
	// constructors) plus first reads of 5 of its fields, which is what a new kind of entity appearing
	// mid-game costs. Run it before playing, while those types are still new to DynamicData.
	public static void RunDynamicData(Assembly game)
	{
		Type entity = game.GetType("Monocle.Entity");
		var types = new System.Collections.Generic.List<(string Name, double Ms)>();
		var total = Stopwatch.StartNew();
		foreach (Type type in game.GetTypes())
		{
			if (type.IsAbstract || type.IsValueType || type.ContainsGenericParameters || !entity.IsAssignableFrom(type)) continue;
			var sw = Stopwatch.StartNew();
			var dyn = new DynamicData(System.Runtime.CompilerServices.RuntimeHelpers.GetUninitializedObject(type));
			int read = 0;
			foreach (FieldInfo f in type.GetFields(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance))
			{
				if (read++ == 5) break;
				dyn.TryGet(f.Name, out object _);
			}
			types.Add((type.Name, sw.Elapsed.TotalMilliseconds));
		}
		types.Sort((a, b) => b.Ms.CompareTo(a.Ms));
		Console.WriteLine($"[bench] first DynamicData of {types.Count} entity types: {total.Elapsed.TotalMilliseconds:0} ms in all, slowest: {string.Join(", ", types.GetRange(0, Math.Min(5, types.Count)).ConvertAll(t => $"{t.Name} {t.Ms:0.0} ms"))}");
	}

	public static Func<object, object> EmitGetter(FieldInfo field)
	{
		var method = new DynamicMethod("get_" + field.Name, typeof(object), new[] { typeof(object) }, field.DeclaringType, skipVisibility: true);
		ILGenerator il = method.GetILGenerator();
		il.Emit(OpCodes.Ldarg_0);
		il.Emit(field.DeclaringType.IsValueType ? OpCodes.Unbox : OpCodes.Castclass, field.DeclaringType);
		il.Emit(OpCodes.Ldfld, field);
		if (field.FieldType.IsValueType) il.Emit(OpCodes.Box, field.FieldType);
		il.Emit(OpCodes.Ret);
		return (Func<object, object>)method.CreateDelegate(typeof(Func<object, object>));
	}

	private static void Time(string name, int n, Action run)
	{
		run(); // warm up (and let the jiterpreter compile)
		var sw = Stopwatch.StartNew();
		run();
		Console.WriteLine($"[bench] {name}: {sw.Elapsed.TotalMilliseconds * 1000 / n:0.000} µs each");
	}
}
