using System;
using System.Diagnostics;
using System.Linq;
using System.Reflection;
using System.Text;
using HarmonyLib;

namespace TowerFallBrowser;

// The numbers behind the page's Stats panel (main.js), for reports from real play on any device:
// frame times, and in online matches TF.EX's tick rate, rollbacks, ping, input delay and slow-down.
// The page asks for them about once a second (TakeWindow); everything since the previous ask.
// Frame timing is always counted (a few additions per frame); TF.EX is only read while the panel is
// open, by reflection on its NetplayManager (fields as of TF.EX 0.19), and anything missing is
// left out rather than failing.
public static class Diagnostics
{
	public static volatile bool On;

	// This window, on the game thread.
	private static int frames, longFrames, veryLongFrames, aheadFrames, netplayFrames;
	private static long frameTicks, worstFrameTicks;
	private static int rollbacks, rollbackTicks, deepestRollback;
	private static int lastGen0 = -1;
	private static int lastCurrentFrame = -1;
	private static double lastDroppedMs;
	private static readonly Stopwatch window = Stopwatch.StartNew();

	// TF.EX, once found.
	private static object netplay;
	private static FieldInfo framesAhead, framesToReSimulate, networkStats, currentFrame, isInit;
	private static MethodInfo inputDelay;
	private static FieldInfo ping, kbpsSent, localBehind, remoteBehind;
	private static bool lookedUp, patched;
	private static int lookAgain;

	// Game thread, after each frame.
	public static void Frame(long ticks)
	{
		frames++;
		frameTicks += ticks;
		worstFrameTicks = Math.Max(worstFrameTicks, ticks);
		if (ticks > Stopwatch.Frequency / 60) longFrames++;
		if (ticks > Stopwatch.Frequency / 30) veryLongFrames++;
		if (!On) return;
		if (!lookedUp && lookAgain-- <= 0)
		{
			lookAgain = 60;
			LookUp();
		}
		if (InSession() && framesAhead?.GetValue(netplay) is int ahead)
		{
			netplayFrames++;
			if (ahead >= AheadThreshold.From) aheadFrames++; // TF.EX runs 10% slow while it's ahead of another player
		}
	}

	// A JSON object with this window's numbers (since the previous call), and starts a new window.
	public static string TakeWindow(string scene)
	{
		var sb = new StringBuilder("{");
		sb.Append($"\"scene\":\"{scene ?? ""}\",");
		double seconds = window.Elapsed.TotalSeconds;
		window.Restart();
		double ms(long t) => t * 1000.0 / Stopwatch.Frequency;
		int gen0 = GC.CollectionCount(0);
		sb.Append($"\"seconds\":{seconds:0.###},\"frames\":{frames},\"gameMs\":{ms(frameTicks):0.##},\"worstMs\":{ms(worstFrameTicks):0.#},\"over16\":{longFrames},\"over33\":{veryLongFrames}");
		// (No heap size: GC.GetTotalMemory takes 3-10 ms here.)
		sb.Append($",\"gcs\":{(lastGen0 < 0 ? 0 : gen0 - lastGen0)}");
		lastGen0 = gen0;
		(frames, longFrames, veryLongFrames, frameTicks, worstFrameTicks) = (0, 0, 0, 0, 0);

		if (InSession() && currentFrame?.GetValue(null) is int frame && frame > 0 && netplayFrames > 0)
		{
			if (lastCurrentFrame > 0 && frame >= lastCurrentFrame) sb.Append($",\"ticks\":{frame - lastCurrentFrame}");
			lastCurrentFrame = frame;
			sb.Append($",\"aheadFrames\":{aheadFrames},\"netplayFrames\":{netplayFrames},\"aheadFrom\":{AheadThreshold.From}");
			sb.Append($",\"rollbacks\":{rollbacks},\"rollbackTicks\":{rollbackTicks},\"deepestRollback\":{deepestRollback}");
			sb.Append($",\"droppedMs\":{TickCatchUp.DroppedTotalMs - lastDroppedMs:0}");
			try
			{
				if (inputDelay?.Invoke(netplay, null) is int delay) sb.Append($",\"inputDelay\":{TfexFps.SessionTicks(delay)}"); // (GGRS's ticks)
				object stats = networkStats?.GetValue(netplay);
				if (stats != null && ping != null)
				{
					sb.Append($",\"ping\":{ping.GetValue(stats)},\"kbpsSent\":{kbpsSent?.GetValue(stats) ?? 0}");
					sb.Append($",\"localBehind\":{localBehind?.GetValue(stats) ?? 0},\"remoteBehind\":{remoteBehind?.GetValue(stats) ?? 0}");
				}
			}
			catch
			{
			}
		}
		else
		{
			lastCurrentFrame = -1;
		}
		lastDroppedMs = TickCatchUp.DroppedTotalMs;
		(aheadFrames, netplayFrames, rollbacks, rollbackTicks, deepestRollback) = (0, 0, 0, 0, 0);
		return sb.Append('}').ToString();
	}

	private static void LookUp()
	{
		// TF.EX loads with the mods; until its services exist, look again on later frames.
		Type services = FindType("TF.EX.Domain.ServiceCollections");
		if (services == null) return;
		try
		{
			if (services.GetField("ServiceProvider")?.GetValue(null) == null) return;
			netplay = services.GetMethod("ResolveNetplayManager")?.Invoke(null, null);
		}
		catch
		{
			return;
		}
		lookedUp = true;
		if (netplay == null) return;
		const BindingFlags any = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance;
		Type type = netplay.GetType();
		framesAhead = type.GetField("_framesAhead", any);
		isInit = type.GetField("_isInitInternal", any);
		framesToReSimulate = type.GetField("_framesToReSimulateInternal", any);
		networkStats = type.GetField("_networkStats", any);
		inputDelay = type.GetMethod("GetEffectiveInputDelay", any, null, Type.EmptyTypes, null);
		currentFrame = FindType("TF.EX.Domain.Context.ExFlags")?.GetField("CurrentFrame", BindingFlags.Public | BindingFlags.Static)
			?? AppDomain.CurrentDomain.GetAssemblies().Where(a => a.GetName().Name?.StartsWith("TF.EX", StringComparison.Ordinal) == true)
				.SelectMany(a => { try { return a.GetTypes(); } catch { return Array.Empty<Type>(); } })
				.FirstOrDefault(t => t.Name == "ExFlags")?.GetField("CurrentFrame", BindingFlags.Public | BindingFlags.Static);
		if (networkStats != null)
		{
			Type s = networkStats.FieldType;
			(ping, kbpsSent, localBehind, remoteBehind) = (s.GetField("ping"), s.GetField("kbps_sent"), s.GetField("local_frames_behind"), s.GetField("remote_frames_behind"));
		}
		// Rollbacks: each one starts with a state load; how far it goes back is set just before.
		MethodInfo load = type.GetMethod("LoadGameState", any, null, Type.EmptyTypes, null);
		if (load != null && framesToReSimulate != null && !patched)
		{
			patched = true;
			try
			{
				new Harmony("TowerFallBrowser.Diagnostics").Patch(load, postfix: new HarmonyMethod(typeof(Diagnostics).GetMethod(nameof(AfterLoad), BindingFlags.NonPublic | BindingFlags.Static)));
			}
			catch (Exception e)
			{
				Console.WriteLine($"[stats] can't count rollbacks: {e.Message}");
			}
		}
		Console.WriteLine($"[stats] TF.EX found{(currentFrame == null ? " (no tick counter)" : "")}{(ping == null ? " (no network stats)" : "")}");
	}

	// An online session (or TF.EX's sync test) is running.
	private static bool InSession() => netplay != null && isInit?.GetValue(netplay) is true;

	private static void AfterLoad()
	{
		if (!On || framesToReSimulate?.GetValue(netplay) is not double depth) return;
		rollbacks++;
		rollbackTicks += (int)depth;
		deepestRollback = Math.Max(deepestRollback, (int)depth);
	}

	private static Type FindType(string name) =>
		AppDomain.CurrentDomain.GetAssemblies().Select(a => a.GetType(name)).FirstOrDefault(t => t != null);
}
