using System;
using System.Linq;
using System.Reflection;
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
//  - the input delay GGRS gets (GGRSConfig.InputDelay / MaxInputDelay of a non-test config) is converted from TF.EX's 240 Hz
//    ticks to the session's: ceil(ticks * rate / 240). Everything before that stays in TF.EX's units, as on a PC: the
//    preference (ToFrames), InputDelayAdvisor's proposal, the delay this page publishes in the lobby (Player.InputDelay) and a
//    series host's (SeriesInputDelay). Rescaling ToFrames instead (until TF.EX 0.21.1 here) left an advisor- or series-chosen
//    delay 4x too long at 60 Hz and published 60 Hz ticks where every other client reads 240 Hz ones.
// Not changed (spectator UI thresholds, InstantReplayFootage's 240-based footage constants): see the report.
public static class TfexFps
{
	private static int pageFps; // ?tfexfps=N, 0: off
	private static int sessionFps; // SetSessionRate, 0: off
	private static int ScenarioFps;

	// The rate TF.EX's sessions run at now, 0: its own (240).
	public static int Fps => sessionFps != 0 ? sessionFps : pageFps;

	// This session's rate (0: back to the page's / TF.EX's own). Takes effect for what TF.EX reads from then on:
	// GGRSConfig.Fps (the session's tick length, GGRS's windows) and its input delays (converted to this rate).
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
		nameProperty = config?.GetProperty("Name");
		if (getFps != null)
		{
			harmony.Patch(getFps, postfix: new HarmonyMethod(typeof(TfexFps).GetMethod(nameof(FpsGetter), all)));
			patched++;
		}
		var delayPostfix = new HarmonyMethod(typeof(TfexFps).GetMethod(nameof(DelayGetter), all));
		foreach (string name in new[] { "InputDelay", "MaxInputDelay" })
		{
			MethodInfo getDelay = config?.GetProperty(name)?.GetMethod;
			if (getDelay == null) continue;
			harmony.Patch(getDelay, postfix: delayPostfix);
			patched++;
		}
		Console.WriteLine($"[netplay] TF.EX session rate patches: {patched} of 3 (GGRSConfig.Fps getter {(getFps != null ? "ok" : "MISSING")})");
	}

	private static Type Find(string name) =>
		AppDomain.CurrentDomain.GetAssemblies().Select(a => a.GetType(name)).FirstOrDefault(t => t != null);

	private static void FpsGetter(ref int __result)
	{
		if (Fps != 0) __result = Fps;
	}

	// TF.EX's input delays are 240 Hz ticks (Constants.NETPLAY_FPS); a test config's are already at its own rate.
	private static void DelayGetter(object __instance, ref int __result)
	{
		if ((string)nameProperty.GetValue(__instance) != "TEST") __result = SessionTicks(__result);
	}

	// TF.EX's 240 Hz ticks (rounded up) at this session's rate.
	public static int SessionTicks(int ticks240) => Fps == 0 || Fps == 240 || ticks240 <= 0 ? ticks240 : (ticks240 * Fps + 239) / 240;

	private static PropertyInfo nameProperty;
}
