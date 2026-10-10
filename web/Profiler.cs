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
// every method of a type; with no arguments, a set covering TF.EX's per-tick work); results are
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
			string[] parts = spec.Split("::");
			Type type = AppDomain.CurrentDomain.GetAssemblies().Select(a => a.GetType(parts[0])).FirstOrDefault(t => t != null);
			MethodBase[] methods = type?.GetMethods(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static | BindingFlags.DeclaredOnly)
				.Where(m => (parts[^1] == "*" ? !m.Name.StartsWith('<') : m.Name == parts[^1]) && !m.IsAbstract && !m.ContainsGenericParameters).ToArray() ?? Array.Empty<MethodBase>();
			if (methods.Length == 0)
			{
				report.Append($" {spec}: not found;");
				continue;
			}
			foreach (MethodBase m in methods)
			{
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

	private static void Prefix(out long __state)
	{
		__state = Stopwatch.GetTimestamp();
	}

	private static void Postfix(long __state, MethodBase __originalMethod)
	{
		if (entries.TryGetValue(__originalMethod, out Entry e))
		{
			e.Ticks += Stopwatch.GetTimestamp() - __state;
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
		foreach (Entry e in entries.Values.Where(e => e.Calls > 0).OrderByDescending(e => e.Ticks))
		{
			double ms = e.Ticks * 1000.0 / Stopwatch.Frequency / frames;
			double total = e.Ticks * 1000.0 / Stopwatch.Frequency;
			sb.Append($"\n[profile]   {ms,7:0.00} ms/frame {e.Calls / (double)frames,6:0.0} calls/frame {total,8:0} ms in {e.Calls,6} calls  {e.Name}");
			e.Ticks = 0;
			e.Calls = 0;
		}
		return sb.ToString();
	}
}
