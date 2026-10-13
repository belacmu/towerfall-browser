using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using HarmonyLib;

namespace TowerFallBrowser;

// TF.Replay (part of TF.EX) records each tick of a match, 240 a second, and after every rollback
// drops the recorded ticks past the rollback's frame with Record.RemoveAll(rec => rec.Frame > frame).
// That reads every tick recorded since the match began, so rollbacks get slower the longer a match
// goes on (measured: 0.19 ms per rollback at the start, 0.6 ms after 3 minutes, still growing).
// Ticks are appended in frame order (rolled-back ones are re-recorded in order after the drop), so
// the ticks to drop are always at the end: this drops them from there, which leaves the same list.
// It's only used while TF.Replay's method is the one checked (Known); otherwise it stays off.
// ?env=TOWERFALL_REPLAYFIX=0 turns it off; =check also verifies the order on each call (slow).
public static class ReplayRecordFix
{
	// TF.Replay's ReplayService.RemovePredictedRecords as of TF.EX 0.19.2 (IL bytes, SHA-256).
	private static readonly HashSet<string> Known = new() { "C74B397EF4612A8E" };

	private static FieldInfo replayField, lastFrameField;
	private static PropertyInfo recordProperty, frameProperty;
	private static bool check;
	private static int checkFailures;
	private static long calls, ticks; // (check mode: the time the drop itself takes)

	public static void Install()
	{
		string mode = Environment.GetEnvironmentVariable("TOWERFALL_REPLAYFIX");
		if (mode == "0" || replayField != null) return;
		check = mode == "check";
		try
		{
			Type service = AppDomain.CurrentDomain.GetAssemblies().Select(a => a.GetType("TF.Replay.Domain.Services.ReplayService")).FirstOrDefault(t => t != null);
			if (service == null) return; // TF.EX isn't enabled
			const BindingFlags any = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance;
			MethodInfo remove = service.GetMethod("RemovePredictedRecords", any, null, new[] { typeof(int) }, null);
			string fingerprint = remove == null ? "missing" : Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(remove.GetMethodBody().GetILAsByteArray()))[..16];
			if (!Known.Contains(fingerprint))
			{
				Console.WriteLine($"[replay] TF.Replay's RemovePredictedRecords changed ({fingerprint}); it stays as it is.");
				return;
			}
			replayField = service.GetField("_replay", any);
			lastFrameField = service.GetField("_lastFrame", any);
			recordProperty = replayField?.FieldType.GetProperty("Record");
			frameProperty = recordProperty?.PropertyType.GetGenericArguments().FirstOrDefault()?.GetProperty("Frame");
			if (lastFrameField?.FieldType != typeof(int) || frameProperty?.PropertyType != typeof(int) || !typeof(IList).IsAssignableFrom(recordProperty.PropertyType))
			{
				replayField = null;
				Console.WriteLine("[replay] TF.Replay's recording isn't as expected; RemovePredictedRecords stays as it is.");
				return;
			}
			new Harmony("TowerFallBrowser.ReplayRecordFix").Patch(remove, prefix: new HarmonyMethod(typeof(ReplayRecordFix).GetMethod(nameof(Remove), BindingFlags.NonPublic | BindingFlags.Static)));
			Console.WriteLine($"[replay] rollbacks drop recorded ticks from the end{(check ? " (checking the order)" : "")}");
		}
		catch (Exception e)
		{
			replayField = null;
			Console.WriteLine($"[replay] RemovePredictedRecords stays as it is: {e.Message}");
		}
	}

	// In place of RemovePredictedRecords(frame).
	private static bool Remove(object __instance, int frame)
	{
		object replay = replayField.GetValue(__instance);
		if (replay == null) return false;
		var records = (IList)recordProperty.GetValue(replay);
		if (check && checkFailures < 3)
		{
			for (int i = 1; i < records.Count; i++)
			{
				if (Frame(records[i]) < Frame(records[i - 1]))
				{
					checkFailures++;
					Console.WriteLine($"[replay] check: recorded ticks out of order at {i} of {records.Count} ({Frame(records[i - 1])} then {Frame(records[i])})");
					break;
				}
			}
		}
		long start = System.Diagnostics.Stopwatch.GetTimestamp();
		while (records.Count > 0 && Frame(records[records.Count - 1]) > frame) records.RemoveAt(records.Count - 1);
		if (check)
		{
			ticks += System.Diagnostics.Stopwatch.GetTimestamp() - start;
			if (++calls % 200 == 0)
			{
				long stateBytes = 0;
				var stateProperty = records.Count > 0 ? records[0].GetType().GetProperty("State") : null;
				foreach (object r in records) stateBytes += (stateProperty?.GetValue(r) as byte[])?.Length ?? 0;
				Console.WriteLine($"[replay] check: {calls} drops, {ticks * 1e6 / System.Diagnostics.Stopwatch.Frequency / 200:0.0} µs each lately, {records.Count} ticks recorded holding {stateBytes / 1048576.0:0.0} MB of states");
			}
			if (calls % 200 == 0) ticks = 0;
		}
		lastFrameField.SetValue(__instance, Math.Min((int)lastFrameField.GetValue(__instance), frame));
		return false;
	}

	private static int Frame(object record) => (int)frameProperty.GetValue(record);
}
