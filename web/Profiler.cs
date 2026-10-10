using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Reflection;
using System.Text;
using HarmonyLib;

namespace TowerFallBrowser;

// Times chosen methods (inclusive, per frame) with Harmony prefixes/postfixes, for finding what's
// slow in the browser. Turned on by the host's "profile [Type::Method ...]" command (Type::* for
// every method of a type, Type::Prefix* for those starting with Prefix; with no arguments, a set covering TF.EX's per-tick work); results are
// printed with each [perf] line.
public static class Profiler
{
	private static readonly string[] Defaults =
	{
		"TowerFall.Level::Update",
		"TowerFall.Level::Render",
		"TF.EX.Patchs.Engine.TFGamePatch::NetplayLogic",
		"TF.EX.Domain.Services.NetplayManager::AdvanceGameState",
		"TF.EX.Domain.Services.NetplayManager::SaveGameState",
		"TF.EX.Domain.Services.NetplayManager::LoadGameState",
		"TF.EX.Domain.Services.NetplayManager::UpdateNetplayRequests",
		"TF.State.Core.Api.TfStateApi::CaptureGameState",
		"TF.State.Core.Api.TfStateApi::RestoreGameStateBytes",
		"TF.State.TowerFallExtensions.LevelExtensions::GetState",
		"TF.State.TowerFallExtensions.LevelExtensions::LoadState",
		"TF.EX.Domain.Services.ReplayService::AddRecord",
		"TF.EX.Domain.Services.SyncTestUtilsService::AddFrame",
		"TF.EX.Domain.InstantReplayFootage::Bake",
		"TF.EX.Domain.InstantReplayFootage::Capture",
		"TF.EX.Domain.InstantReplayFootage::Restore",
		"TF.EX.Domain.InstantReplayFootage::Track",
		"TowerFall.ReplayFrame::Record",
		"TowerFall.Level::CoreRender",
		"TowerFall.Level::PreRender",
		"Monocle.Engine::Draw",
		"TowerFall.Level::HandlePausing",
	};

	private sealed class Entry
	{
		public string Name;
		public long Ticks;
		public long Bytes;
		public int Calls;
	}

	private static readonly Dictionary<MethodBase, Entry> entries = new();
	private static Harmony harmony;

	public static bool Enabled => harmony != null;

	public static string Start(string[] specs)
	{
		harmony ??= new Harmony("TowerFallBrowser.Profiler");
		var prefix = new HarmonyMethod(typeof(Profiler).GetMethod(nameof(Prefix), BindingFlags.NonPublic | BindingFlags.Static));
		var postfix = new HarmonyMethod(typeof(Profiler).GetMethod(nameof(Postfix), BindingFlags.NonPublic | BindingFlags.Static));
		var report = new StringBuilder();
		foreach (string spec in specs.Length > 0 ? specs : Defaults)
		{
			// lines:Type::Method times the stretches between the calls inside that one method.
			if (spec.StartsWith("lines:", StringComparison.Ordinal))
			{
				report.Append(' ').Append(Lines.Start(harmony, spec["lines:".Length..]));
				continue;
			}
			string[] parts = spec.Split("::");
			// Namespace.* matches every type in that namespace (and below).
			IEnumerable<Type> types = parts[0].EndsWith(".*")
				? AppDomain.CurrentDomain.GetAssemblies().SelectMany(a => { try { return a.GetTypes(); } catch { return Array.Empty<Type>(); } })
					.Where(t => t.FullName != null && t.FullName.StartsWith(parts[0][..^1], StringComparison.Ordinal) && !t.IsGenericTypeDefinition)
				: new[] { AppDomain.CurrentDomain.GetAssemblies().Select(a => a.GetType(parts[0])).FirstOrDefault(t => t != null) }.Where(t => t != null);
			var found = types.SelectMany(type => type.GetMethods(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static | BindingFlags.DeclaredOnly)
				.Where(m => (parts[^1].EndsWith('*') ? m.Name.StartsWith(parts[^1][..^1], StringComparison.Ordinal) && !m.Name.StartsWith('<') : m.Name == parts[^1]) && !m.IsAbstract && !m.ContainsGenericParameters)
				.Select(m => (Type: type, Method: (MethodBase)m))).ToArray();
			if (found.Length == 0)
			{
				report.Append($" {spec}: not found;");
				continue;
			}
			foreach ((Type type, MethodBase m) in found)
			{
				MethodBase[] methods = found.Where(f => f.Type == type).Select(f => f.Method).ToArray();
				if (entries.ContainsKey(m)) continue;
				try
				{
					bool overloaded = methods.Count(o => o.Name == m.Name) > 1;
					string name = $"{type.Name}.{m.Name}" + (overloaded ? $"({string.Join(",", m.GetParameters().Select(p => p.ParameterType.Name))})" : "");
					entries[m] = new Entry { Name = name };
					harmony.Patch(m, prefix: prefix, postfix: postfix);
				}
				catch (Exception e)
				{
					entries.Remove(m);
					report.Append($" {spec}: {e.Message};");
				}
			}
		}
		return $"profiling {entries.Count} methods.{report}";
	}

	private static void Prefix(out (long Time, long Bytes) __state)
	{
		__state = (Stopwatch.GetTimestamp(), GC.GetAllocatedBytesForCurrentThread());
	}

	private static void Postfix((long Time, long Bytes) __state, MethodBase __originalMethod)
	{
		if (entries.TryGetValue(__originalMethod, out Entry e))
		{
			e.Ticks += Stopwatch.GetTimestamp() - __state.Time;
			e.Bytes += GC.GetAllocatedBytesForCurrentThread() - __state.Bytes;
			e.Calls++;
		}
	}

	// The busiest methods since the last report, per frame.
	public static string Report(int frames)
	{
		var sb = new StringBuilder();
		if (StateSpeedups.GetAllCalls > 0)
		{
			double total = StateSpeedups.GetAllTicks * 1000.0 / Stopwatch.Frequency;
			sb.Append($"\n[profile]   {total / frames,7:0.00} ms/frame {StateSpeedups.GetAllCalls / (double)frames,6:0.0} calls/frame {total,8:0} ms in {StateSpeedups.GetAllCalls,6} calls  StateSpeedups.GetAll");
			StateSpeedups.GetAllTicks = 0;
			StateSpeedups.GetAllCalls = 0;
		}
		Lines.Report(sb, frames);
		foreach (Entry e in entries.Values.Where(e => e.Calls > 0).OrderByDescending(e => Math.Max(e.Ticks / (double)Stopwatch.Frequency * 1000, e.Bytes / 1048576.0)))
		{
			double ms = e.Ticks * 1000.0 / Stopwatch.Frequency / frames;
			double total = e.Ticks * 1000.0 / Stopwatch.Frequency;
			sb.Append($"\n[profile]   {ms,7:0.00} ms/frame {e.Calls / (double)frames,6:0.0} calls/frame {total,8:0} ms in {e.Calls,6} calls {e.Bytes / 1048576.0,8:0.0} MB  {e.Name}");
			e.Ticks = 0;
			e.Bytes = 0;
			e.Calls = 0;
		}
		return sb.ToString();
	}

	// A line profiler for one method: a probe before each call inside it records the time since the
	// previous probe, so each stretch (a call and the plain code after it, up to the next call) gets
	// its share. Stretches are named by the call that starts them.
	private static class Lines
	{
		private static string[] names = Array.Empty<string>();
		private static long[] ticks = Array.Empty<long>();
		private static int[] hits = Array.Empty<int>();
		private static int last = -1;
		private static long lastTime;
		private static int depth;
		private static string method;

		public static string Start(Harmony harmony, string spec)
		{
			string[] parts = spec.Split("::");
			Type type = AppDomain.CurrentDomain.GetAssemblies().Select(a => a.GetType(parts[0])).FirstOrDefault(t => t != null);
			MethodInfo target = type?.GetMethods(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static | BindingFlags.Instance | BindingFlags.DeclaredOnly)
				.FirstOrDefault(m => m.Name == parts[^1] && !m.ContainsGenericParameters);
			if (target == null) return $"{spec}: not found;";
			method = $"{type.Name}.{target.Name}";
			const BindingFlags flags = BindingFlags.NonPublic | BindingFlags.Static;
			harmony.Patch(target,
				prefix: new HarmonyMethod(typeof(Lines).GetMethod(nameof(Enter), flags)),
				finalizer: new HarmonyMethod(typeof(Lines).GetMethod(nameof(Leave), flags)),
				transpiler: new HarmonyMethod(typeof(Lines).GetMethod(nameof(Transpile), flags)));
			return $"lines in {method}: {names.Length} stretches;";
		}

		private static IEnumerable<CodeInstruction> Transpile(IEnumerable<CodeInstruction> instructions)
		{
			var list = new List<string> { "(start)" };
			MethodInfo hit = typeof(Lines).GetMethod(nameof(Hit), BindingFlags.NonPublic | BindingFlags.Static);
			var code = instructions.ToList();
			for (int i = 0; i < code.Count; i++)
			{
				CodeInstruction ins = code[i];
				if (!((ins.opcode == System.Reflection.Emit.OpCodes.Call || ins.opcode == System.Reflection.Emit.OpCodes.Callvirt || ins.opcode == System.Reflection.Emit.OpCodes.Newobj) && ins.operand is MethodBase callee))
				{
					continue;
				}
				// Before any prefix (constrained., tail., ...), which must come right before its call.
				int at = i;
				while (at > 0 && code[at - 1].opcode.OpCodeType == System.Reflection.Emit.OpCodeType.Prefix) at--;
				var probe = new CodeInstruction(System.Reflection.Emit.OpCodes.Ldc_I4, list.Count);
				code[at].MoveLabelsTo(probe);
				code[at].MoveBlocksTo(probe);
				code.Insert(at, new CodeInstruction(System.Reflection.Emit.OpCodes.Call, hit));
				code.Insert(at, probe);
				i += 2;
				list.Add($"{(ins.opcode == System.Reflection.Emit.OpCodes.Newobj ? "new " : "")}{callee.DeclaringType?.Name}.{callee.Name}");
			}
			names = list.ToArray();
			ticks = new long[names.Length];
			hits = new int[names.Length];
			return code;
		}

		private static void Enter()
		{
			if (depth++ == 0)
			{
				last = 0;
				lastTime = Stopwatch.GetTimestamp();
			}
		}

		private static Exception Leave(Exception __exception)
		{
			if (--depth == 0) Hit(-1);
			return __exception;
		}

		private static void Hit(int site)
		{
			if (depth != 1) return; // only the outermost call
			long now = Stopwatch.GetTimestamp();
			if (last >= 0)
			{
				ticks[last] += now - lastTime;
				hits[last]++;
			}
			last = site;
			lastTime = Stopwatch.GetTimestamp();
		}

		public static void Report(StringBuilder sb, int frames)
		{
			if (method == null) return;
			double total = ticks.Sum() * 1000.0 / Stopwatch.Frequency;
			sb.Append($"\n[lines]   {method}: {total / frames,7:0.00} ms/frame in its own stretches");
			foreach (int i in Enumerable.Range(0, names.Length).Where(i => hits[i] > 0).OrderByDescending(i => ticks[i]).Take(25))
			{
				double ms = ticks[i] * 1000.0 / Stopwatch.Frequency;
				sb.Append($"\n[lines]   {ms / frames,7:0.000} ms/frame {hits[i] / (double)frames,6:0.0}/frame  #{i,-4} {names[i]}");
			}
			Array.Clear(ticks);
			Array.Clear(hits);
		}
	}
}
