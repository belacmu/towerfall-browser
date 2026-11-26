using System;
using System.Linq;
using System.Reflection;
using HarmonyLib;

namespace TowerFallBrowser;

// Switch harness (local test page only, not for main): ?statedump=N logs, every Nth GGRS save, the exact bytes TF.EX's
// NetplayManager.SaveGameState hands to ggrs (TF.State's encoded GameState), in the Switch's format, for
// switch-online tools/tfex/statediff.py:
//   [state] dump frame <F> part <k>/<n> <base64, 384 characters a line>
// F = GameState.Frame (TF.State sets it from StateFlags.CurrentFrame when it captures the state, just before this save).
// All parts of one state are logged together (tools/serve.py --diag forwards them as [diag-trace] lines).
public static class StateDump
{
	private const int LineChars = 384;
	private static int every, saves;
	private static FieldInfo currentFrame;

	public static string Enable(int n)
	{
		if (every > 0) return null;
		Type manager = AppDomain.CurrentDomain.GetAssemblies().Select(a => a.GetType("TF.EX.Domain.Services.NetplayManager", false)).FirstOrDefault(t => t != null);
		Type flags = AppDomain.CurrentDomain.GetAssemblies().Select(a => a.GetType("TF.State.Domain.Context.StateFlags", false)).FirstOrDefault(t => t != null);
		MethodInfo save = manager?.GetMethod("SaveGameState", new[] { typeof(byte[]) });
		currentFrame = flags?.GetField("CurrentFrame", BindingFlags.Public | BindingFlags.Static);
		if (save == null || currentFrame == null) return "TF.EX's SaveGameState or TF.State's StateFlags.CurrentFrame not found";
		new Harmony("TowerFallBrowser.StateDump").Patch(save, prefix: new HarmonyMethod(typeof(StateDump), nameof(SavePrefix)));
		every = Math.Max(1, n);
		Console.WriteLine($"[state] dump on: every {every}th GGRS save, base64 in {LineChars}-character parts");
		return null;
	}

	private static int lastFrame = -1, skipped;
	private static string lastB64;

	private static void SavePrefix(byte[] state)
	{
		if (state == null) return;
		try
		{
			// by frame, as the Switch's hw.txt statedump (a frame re-saved by a rollback logs again: the last is what GGRS kept), but not
			// a re-save with that frame's last dumped bytes: a stalled session re-saves the same frame on every update (as the Switch)
			int frame = (int)currentFrame.GetValue(null);
			if (frame % every != 0) return;
			string b64 = Convert.ToBase64String(state);
			if (frame == lastFrame && b64 == lastB64) { skipped++; return; }
			if (skipped > 0) Console.WriteLine($"[state] dump frame {lastFrame}: {skipped} more saves with the same bytes, not logged");
			lastFrame = frame; lastB64 = b64; skipped = 0;
			int parts = Math.Max(1, (b64.Length + LineChars - 1) / LineChars);
			var sb = new System.Text.StringBuilder(b64.Length + parts * 48);
			for (int k = 0; k < parts; k++)
			{
				if (k > 0) sb.Append('\n');
				sb.Append($"[state] dump frame {frame} part {k + 1}/{parts} ").Append(b64, k * LineChars, Math.Min(LineChars, b64.Length - k * LineChars));
			}
			Console.WriteLine(sb.ToString());
		}
		catch (Exception e)
		{
			Console.WriteLine($"[state] dump failed: {e.Message}");
		}
	}
}
