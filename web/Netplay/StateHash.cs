using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using HarmonyLib;

namespace TowerFallBrowser;

// `statehash` (host command, for tests): logs a hash of the state TF.EX hands GGRS for every frame of an
// online session, as "[statehash] <frame> <fnv-1a 64 of the bytes> <length>". A frame can be saved several
// times (rollbacks resimulate it with corrected inputs); the last save is the one kept, printed once the frame
// is 60 frames behind the newest, past any rollback. Two runs of the same scripted match (xnet) must print the
// same lines whatever the browser-side speedups do, which shows they leave the state byte-for-byte alone.
public static class StateHash
{
	private static readonly SortedDictionary<int, (ulong Hash, int Length)> last = new();
	private static FieldInfo currentFrame;
	private static int newest = int.MinValue;

	public static string Start()
	{
		Type manager = AppDomain.CurrentDomain.GetAssemblies().Select(a => a.GetType("TF.EX.Domain.Services.NetplayManager")).FirstOrDefault(t => t != null);
		MethodInfo save = manager?.GetMethod("SaveGameState", BindingFlags.Public | BindingFlags.Instance, null, new[] { typeof(byte[]) }, null);
		currentFrame = AppDomain.CurrentDomain.GetAssemblies().Select(a => a.GetType("TF.EX.Domain.Context.ExFlags")).FirstOrDefault(t => t != null)
			?.GetField("CurrentFrame", BindingFlags.Public | BindingFlags.Static);
		if (save == null || currentFrame == null) return "TF.EX isn't loaded";
		new Harmony("TowerFallBrowser.StateHash").Patch(save, prefix: new HarmonyMethod(typeof(StateHash).GetMethod(nameof(Saved), BindingFlags.NonPublic | BindingFlags.Static)));
		return "hashing every saved state";
	}

	private static void Saved(byte[] state)
	{
		if (state == null) return;
		int frame = (int)currentFrame.GetValue(null);
		ulong hash = 14695981039346656037UL;
		foreach (byte b in state) hash = (hash ^ b) * 1099511628211UL;
		last[frame] = (hash, state.Length);
		newest = Math.Max(newest, frame);
		while (last.Count > 0)
		{
			int oldest = last.Keys.First();
			if (oldest > newest - 60) break;
			Console.WriteLine($"[statehash] {oldest} {last[oldest].Hash:x16} {last[oldest].Length}");
			last.Remove(oldest);
		}
	}
}
