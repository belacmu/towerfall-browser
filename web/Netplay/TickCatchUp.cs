using System;
using System.Diagnostics;
using System.Linq;
using System.Reflection;

namespace TowerFallBrowser;

// TF.EX's online loop (TFGamePatch.TFGameUpdate_Patch) runs as many 240 Hz ticks in a frame as the
// time since its previous frame calls for, with no limit. On a computer too slow to run 240 ticks a
// second, each frame then owes more ticks than the last, and it spirals into a slideshow (measured
// with ?slowcpu=4: 5.5 frames/s, then 0.6, 0.2, 0.1, with 10 s frames). Before each frame, this
// caps what TF.EX will catch up to MaxTicks ticks by moving its clock bookkeeping (LastUpdate,
// Accumulator) forward; time beyond that is dropped, so a slow computer plays in slow motion
// instead, and GGRS has the other players wait for it as it would for any slow player. Nothing
// changes in what's simulated or sent. If TF.EX's fields aren't as expected, it stays off.
// ?env=TOWERFALL_TICK_CAP=0 turns it off (for comparing).
public static class TickCatchUp
{
	private const int MaxTicks = 8; // two 60 Hz frames' worth: room to recover from a short hitch
	private static readonly TimeSpan Cap = TimeSpan.FromSeconds(MaxTicks / 240.0);

	private static Stopwatch clock;
	private static FieldInfo lastUpdate, accumulator;
	private static bool off = Environment.GetEnvironmentVariable("TOWERFALL_TICK_CAP") == "0";
	private static int lookAgain;

	// Time dropped since the last report, for the [perf] line.
	public static double DroppedMs;

	// Game thread, before each frame.
	public static void BeforeFrame()
	{
		if (off) return;
		if (clock == null && !Find()) return;
		var now = clock.Elapsed;
		var acc = (TimeSpan)accumulator.GetValue(null);
		var last = (TimeSpan)lastUpdate.GetValue(null);
		TimeSpan owed = acc + (now - last);
		if (owed <= Cap) return;
		DroppedMs += (owed - Cap).TotalMilliseconds;
		if (acc > Cap)
		{
			accumulator.SetValue(null, Cap);
			acc = Cap;
		}
		lastUpdate.SetValue(null, now - (Cap - acc));
	}

	private static bool Find()
	{
		// TF.EX loads with the mods, after the first frames; look once a second until it's there.
		if (lookAgain-- > 0) return false;
		lookAgain = 60;
		Type patch = AppDomain.CurrentDomain.GetAssemblies().Select(a => a.GetType("TF.EX.Patchs.Engine.TFGamePatch")).FirstOrDefault(t => t != null);
		if (patch == null) return false;
		const BindingFlags flags = BindingFlags.NonPublic | BindingFlags.Static;
		FieldInfo clockField = patch.GetField("UpdateClock", flags);
		lastUpdate = patch.GetField("LastUpdate", flags);
		accumulator = patch.GetField("Accumulator", flags);
		if (clockField?.FieldType != typeof(Stopwatch) || lastUpdate?.FieldType != typeof(TimeSpan) || accumulator?.FieldType != typeof(TimeSpan))
		{
			off = true;
			Console.WriteLine("[netplay] TF.EX's tick loop isn't as expected; catch-up stays uncapped.");
			return false;
		}
		clock = (Stopwatch)clockField.GetValue(null);
		Console.WriteLine($"[netplay] Online catch-up capped at {MaxTicks} ticks a frame.");
		return true;
	}
}
