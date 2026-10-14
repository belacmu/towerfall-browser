using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Reflection.Emit;
using HarmonyLib;

namespace TowerFallBrowser;

// EXPERIMENT (opt-in, ?tfexfps=60 -> TOWERFALL_TFEX_FPS): run TF.EX's online / sync-test session at
// another tick rate than its fixed 240 Hz (Constants.NETPLAY_FPS), e.g. the vanilla 60.
// TF.EX already supports a session rate: GGRSConfig.Fps is sent to GGRS (windows scaled from it),
// NetplayManager.GetSessionFps() feeds TFGamePatch.ManageTimeStep, which sets TargetElapsedTime when
// the rate isn't 240, and the gameplay patches scale from TargetElapsedTime. Only the sync test's
// `fps` argument ever sets it (the ScenarioSweeper uses 60), so here:
//  - GGRSConfig.Fps's getter returns the forced rate, whichever factory built the config (test,
//    local, server, the constructor's default, spectate/replay), so GetSessionFps and the FFI config agree;
//  - NetplayPreferences.ToFrames (input delay ms -> ticks) uses the forced rate;
//  - InputDelayAdvisor's ms-per-tick constant (4.1667, inlined by the compiler) is rewritten.
// Not changed (spectator UI thresholds, InstantReplayFootage's 240-based footage constants): see the report.
public static class TfexFps
{
	public static int Fps; // 0: off
	private static int ScenarioFps;

	private static void StartTestModePrefix(ref int fps) => fps = ScenarioFps;

	public static void Patch(Harmony harmony)
	{
		// Control for the scenario sweep (`scenario`), which always runs at 60: TOWERFALL_SCENARIO_FPS=240 runs it at 240.
		if (int.TryParse(Environment.GetEnvironmentVariable("TOWERFALL_SCENARIO_FPS"), out int scenarioFps))
		{
			ScenarioFps = scenarioFps;
			MethodInfo start = Find("TF.EX.Core.TFCommands")?.GetMethod("StartTestMode", BindingFlags.NonPublic | BindingFlags.Static);
			if (start != null) harmony.Patch(start, prefix: new HarmonyMethod(typeof(TfexFps).GetMethod(nameof(StartTestModePrefix), BindingFlags.NonPublic | BindingFlags.Static)));
			Console.WriteLine($"[netplay] EXPERIMENT: scenario sweep forced to {scenarioFps} Hz ({(start != null ? "ok" : "StartTestMode MISSING")})");
		}
		if (!int.TryParse(Environment.GetEnvironmentVariable("TOWERFALL_TFEX_FPS"), out int fps) || fps < 30 || fps > 240) return;
		Fps = fps;
		const BindingFlags all = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static | BindingFlags.DeclaredOnly;
		int patched = 0;
		Type config = Find("TF.EX.Domain.Models.GGRSConfig");
		MethodInfo getFps = config?.GetProperty("Fps")?.GetMethod;
		if (getFps != null)
		{
			harmony.Patch(getFps, postfix: new HarmonyMethod(typeof(TfexFps).GetMethod(nameof(FpsGetter), all)));
			patched++;
		}
		MethodInfo toFrames = Find("TF.EX.Domain.Models.NetplayPreferences")?.GetMethod("ToFrames", all);
		if (toFrames != null)
		{
			harmony.Patch(toFrames, postfix: new HarmonyMethod(typeof(TfexFps).GetMethod(nameof(ToFramesPostfix), all)));
			patched++;
		}
		Type advisor = Find("TF.EX.Patchs.InputDelayAdvisor");
		if (advisor != null)
		{
			var transpiler = new HarmonyMethod(typeof(TfexFps).GetMethod(nameof(FrameMsTranspiler), all));
			foreach (MethodBase m in Methods(advisor).Where(HasFrameMs))
			{
				harmony.Patch(m, transpiler: transpiler);
				patched++;
			}
		}
		Console.WriteLine($"[netplay] EXPERIMENT: TF.EX session forced to {fps} Hz ({patched} patches; GGRSConfig.Fps getter {(getFps != null ? "ok" : "MISSING")})");
	}

	private static Type Find(string name) =>
		AppDomain.CurrentDomain.GetAssemblies().Select(a => a.GetType(name)).FirstOrDefault(t => t != null);

	private static IEnumerable<MethodBase> Methods(Type type)
	{
		const BindingFlags all = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static | BindingFlags.DeclaredOnly;
		foreach (MethodBase m in type.GetMethods(all)) yield return m;
		foreach (Type nested in type.GetNestedTypes(all))
			foreach (MethodBase m in Methods(nested)) yield return m;
	}

	private const double FrameMs240 = 1000.0 / 240;

	// ldc.r8 4.1666...: opcode 0x23 then the 8 bytes of the double.
	private static bool HasFrameMs(MethodBase m)
	{
		byte[] il = m.GetMethodBody()?.GetILAsByteArray();
		if (il == null) return false;
		byte[] want = BitConverter.GetBytes(FrameMs240);
		for (int i = 0; i + 9 <= il.Length; i++)
			if (il[i] == 0x23 && il.AsSpan(i + 1, 8).SequenceEqual(want)) return true;
		return false;
	}

	private static void FpsGetter(ref int __result) => __result = Fps;

	private static void ToFramesPostfix(int ms, ref int __result) => __result = (ms * Fps + 999) / 1000;

	private static IEnumerable<CodeInstruction> FrameMsTranspiler(IEnumerable<CodeInstruction> code)
	{
		foreach (CodeInstruction ins in code)
		{
			if (ins.opcode == OpCodes.Ldc_R8 && ins.operand is double d && Math.Abs(d - FrameMs240) < 1e-9)
				ins.operand = 1000.0 / Fps;
			yield return ins;
		}
	}
}
