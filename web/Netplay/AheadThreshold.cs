using System;
using System.Linq;
using System.Reflection;
using HarmonyLib;

namespace TowerFallBrowser;

// TF.EX runs its tick loop 10% slow whenever GGRS says this player is ahead of another
// (NetplayManager.IsFramesAhead: frames_ahead > 0, GGRS's averaged frame advantage, in 240 Hz
// ticks). Ordinary network jitter keeps that average at 1 much of the time, so players spent a
// fifth to over a quarter of a match in slow motion even on equal computers. Here it slows down
// from 2 ticks ahead. Measured (two players at full speed, ~92 ms ping with jitter, 2 matches
// each): slowed down 20-29% of the match at 1 tick, 2% at 2, 1% at 3; rollbacks no more often or
// deeper. Only this player's own pacing changes, so matches with desktop TF.EX work the same.
// ?env=TOWERFALL_AHEAD=N slows down from N ticks instead (1: TF.EX's own rule).
public static class AheadThreshold
{
	private static FieldInfo framesAhead;
	private const int Default = 2;
	private static int threshold;

	// How many ticks ahead TF.EX slows down from (1 unless changed here).
	public static int From => framesAhead != null ? threshold : 1;

	public static void Install()
	{
		if (framesAhead != null) return;
		if (!int.TryParse(Environment.GetEnvironmentVariable("TOWERFALL_AHEAD"), out threshold)) threshold = Default;
		if (threshold <= 1) return;
		try
		{
			Type manager = AppDomain.CurrentDomain.GetAssemblies().Select(a => a.GetType("TF.EX.Domain.Services.NetplayManager")).FirstOrDefault(t => t != null);
			if (manager == null) return; // TF.EX isn't enabled
			const BindingFlags any = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance;
			MethodInfo isAhead = manager.GetMethod("IsFramesAhead", any, null, Type.EmptyTypes, null);
			framesAhead = manager.GetField("_framesAhead", any);
			if (isAhead?.ReturnType != typeof(bool) || framesAhead?.FieldType != typeof(int))
			{
				framesAhead = null;
				Console.WriteLine("[netplay] TF.EX's IsFramesAhead isn't as expected; it stays as it is.");
				return;
			}
			new Harmony("TowerFallBrowser.AheadThreshold").Patch(isAhead, prefix: new HarmonyMethod(typeof(AheadThreshold).GetMethod(nameof(IsFramesAhead), BindingFlags.NonPublic | BindingFlags.Static)));
			Console.WriteLine($"[netplay] slowing down from {threshold} ticks ahead");
		}
		catch (Exception e)
		{
			framesAhead = null;
			Console.WriteLine($"[netplay] IsFramesAhead stays as it is: {e.Message}");
		}
	}

	private static bool IsFramesAhead(object __instance, ref bool __result)
	{
		__result = (int)framesAhead.GetValue(__instance) >= threshold;
		return false;
	}
}
