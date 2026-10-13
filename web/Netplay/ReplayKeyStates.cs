using System;
using System.IO;
using System.Linq;
using System.Reflection;

namespace TowerFallBrowser;

// TF.Replay (part of TF.EX) records online matches as replays. Its SAVE STATE setting defaults to
// FULL: a whole game state kept in memory for every tick, 240 a second (measured about 18 MB per
// minute of match), too much for a phone. KEY keeps 16 a second (about 15x less) and replays still
// work (seeking snaps to the last kept state). In the browser KEY is the default: while TF.Replay
// has no saved settings, it gets KEY; once there are some (FortRise saves them with the game), the
// player's choice in TF.Replay's options stands.
public static class ReplayKeyStates
{
	public static void Apply()
	{
		try
		{
			Type module = AppDomain.CurrentDomain.GetAssemblies().Select(a => a.GetType("TF.Replay.Core.TFReplayModule")).FirstOrDefault(t => t != null);
			Type modIO = AppDomain.CurrentDomain.GetAssemblies().Select(a => a.GetType("FortRise.ModIO")).FirstOrDefault(t => t != null);
			if (module == null || modIO == null) return; // TF.EX isn't enabled
			string root = (string)modIO.GetMethod("GetRootPath", BindingFlags.Public | BindingFlags.Static).Invoke(null, null);
			if (File.Exists(Path.Combine(root, "Saves", "TF.Replay", "TF.Replay.settings.json"))) return; // the player's own settings
			const BindingFlags any = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static;
			object mod = module.GetProperty("Instance", any)?.GetValue(null);
			// (Mod has GetSettings() and GetSettings<T>(); the plain one.)
			MethodInfo getSettings = mod?.GetType().GetMethods(any).FirstOrDefault(m => m.Name == "GetSettings" && !m.IsGenericMethodDefinition && m.GetParameters().Length == 0);
			object settings = getSettings?.Invoke(mod, null);
			PropertyInfo saveState = settings?.GetType().GetProperty("SaveState");
			MethodInfo apply = settings?.GetType().GetMethod("Apply", any, null, Type.EmptyTypes, null);
			if (saveState?.PropertyType != typeof(string) || apply == null)
			{
				Console.WriteLine("[replay] TF.Replay's settings aren't as expected; SAVE STATE stays as it is.");
				return;
			}
			saveState.SetValue(settings, "KEY");
			apply.Invoke(settings, null);
			Console.WriteLine("[replay] SAVE STATE: KEY by default (no saved TF.Replay settings yet)");
		}
		catch (Exception e)
		{
			Console.WriteLine($"[replay] SAVE STATE stays as it is: {e.Message}");
		}
	}
}
