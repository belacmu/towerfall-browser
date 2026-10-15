using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Reflection.Emit;
using HarmonyLib;

namespace TowerFallBrowser;

// Runs TF.EX's online / sync-test session at another tick rate than its fixed 240 Hz
// (Constants.NETPLAY_FPS), e.g. the vanilla 60. Two ways in:
//  - for the page (EXPERIMENT, opt-in, ?tfexfps=60 -> TOWERFALL_TFEX_FPS), every session;
//  - for one session (SetSessionRate, e.g. SwitchLobby.cs for a match against the Switch), until
//    SetSessionRate(0) (SwitchLobby does that when the game is back at the main menu).
// The patches are installed when TF.EX loads (patching methods later, after the interpreter may have
// inlined the small getters, is not safe); with neither rate set they leave every value as TF.EX's.
// TF.EX already supports a session rate: GGRSConfig.Fps is sent to GGRS (windows scaled from it),
// NetplayManager.GetSessionFps() feeds TFGamePatch.ManageTimeStep, which sets TargetElapsedTime when
// the rate isn't 240, and the gameplay patches scale from TargetElapsedTime. Only the sync test's
// `fps` argument ever sets it (the ScenarioSweeper uses 60), so here:
//  - GGRSConfig.Fps's getter returns the forced rate, whichever factory built the config (test,
//    local, server, the constructor's default, spectate/replay), so GetSessionFps and the FFI config agree;
//  - NetplayPreferences.ToFrames (input delay ms -> ticks) uses the forced rate;
//  - InputDelayAdvisor's ms-per-tick constant (4.1667, inlined by the compiler) is read from FrameMs().
// Not changed (spectator UI thresholds, InstantReplayFootage's 240-based footage constants): see the report.
public static class TfexFps
{
	private static int pageFps; // ?tfexfps=N, 0: off
	private static int sessionFps; // SetSessionRate, 0: off
	private static int ScenarioFps;

	// The rate TF.EX's sessions run at now, 0: its own (240).
	public static int Fps => sessionFps != 0 ? sessionFps : pageFps;

	// This session's rate (0: back to the page's / TF.EX's own). Takes effect for what TF.EX computes from
	// then on: GGRSConfig.Fps (the session's tick length, GGRS's windows) and ToFrames (input delay).
	public static void SetSessionRate(int fps)
	{
		if (fps != 0 && (fps < 30 || fps > 240)) throw new ArgumentOutOfRangeException(nameof(fps));
		if (fps == sessionFps) return;
		sessionFps = fps;
		Console.WriteLine($"[netplay] TF.EX session rate: {(Fps != 0 ? Fps + " Hz" : "TF.EX's own (240 Hz)")}");
	}

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
		if (int.TryParse(Environment.GetEnvironmentVariable("TOWERFALL_TFEX_FPS"), out int fps) && fps >= 30 && fps <= 240)
		{
			pageFps = fps;
			Console.WriteLine($"[netplay] EXPERIMENT: TF.EX session forced to {fps} Hz");
		}
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
		Console.WriteLine($"[netplay] TF.EX session rate patches: {patched} (GGRSConfig.Fps getter {(getFps != null ? "ok" : "MISSING")})");
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

	private static void FpsGetter(ref int __result)
	{
		if (Fps != 0) __result = Fps;
	}

	private static void ToFramesPostfix(int ms, ref int __result)
	{
		if (Fps != 0) __result = (ms * Fps + 999) / 1000;
	}

	public static double FrameMs() => Fps != 0 ? 1000.0 / Fps : FrameMs240;

	// ldc.r8 4.1666... -> call FrameMs() (same stack effect).
	private static IEnumerable<CodeInstruction> FrameMsTranspiler(IEnumerable<CodeInstruction> code)
	{
		MethodInfo frameMs = typeof(TfexFps).GetMethod(nameof(FrameMs));
		foreach (CodeInstruction ins in code)
		{
			if (ins.opcode == OpCodes.Ldc_R8 && ins.operand is double d && Math.Abs(d - FrameMs240) < 1e-9)
			{
				ins.opcode = OpCodes.Call;
				ins.operand = frameMs;
			}
			yield return ins;
		}
	}
}
