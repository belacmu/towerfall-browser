using System;
using System.Linq;
using System.Reflection;
using HarmonyLib;

namespace TowerFallBrowser;

// TF.EX's online NetplayManager.Init (from NetplayRoundLogic.OnLevelLoadFinish, in the loader scene) starts Connect on a worker
// (Task.Run). Connect's NativeInit first serializes the GGRS config, then sets GGRSFFI.IsInInit around netplay_init. Until then
// IsDisconnected asks ggrs-ffi, which still reports the previous session as disconnected (its netplay_reset sets the flag), and
// TF.EX's LevelPatch lets a disconnected session's level update. On a PC the worker gets there within microseconds, before the
// level is the scene; in the page's WebAssembly worker it can take a few frames, so a rematch's level ran 3-4 updates before the
// session (a ShiftBlock's counter 0.75 ahead of the other players' at frame 0: the Switch harness's smoke rematch desynced in
// about half the runs). Here IsInInit is set on the main thread when Init starts Connect, as it effectively is on a PC; TF.EX's
// NativeInit sets it again and clears it when netplay_init returns (its finally), so nothing else changes.
public static class InitWindow
{
	private static FieldInfo isInInit;
	private static PropertyInfo isInit;

	public static void Patch(Harmony harmony)
	{
		Type manager = Find("TF.EX.Domain.Services.NetplayManager");
		isInInit = Find("TF.EX.Domain.Externals.GGRSFFI")?.GetField("IsInInit", BindingFlags.Public | BindingFlags.Static);
		isInit = manager?.GetProperty("_isInit", BindingFlags.NonPublic | BindingFlags.Instance);   // (a property over _isInitInternal in TF.EX 0.27)
		MethodInfo init = manager?.GetMethod("Init", BindingFlags.Public | BindingFlags.Instance);
		if (isInInit == null || isInit == null || init == null)
		{
			Console.WriteLine($"[netplay] InitWindow: TF.EX isn't as expected (GGRSFFI.IsInInit {isInInit != null}, NetplayManager._isInit {isInit != null}, Init {init != null}): not applied");
			return;
		}
		harmony.Patch(init, prefix: new HarmonyMethod(typeof(InitWindow).GetMethod(nameof(InitPrefix), BindingFlags.NonPublic | BindingFlags.Static)));
	}

	// (Init returns at once when already initialized; test and replay sessions run NativeInit on this thread, which clears it.)
	private static void InitPrefix(object __instance)
	{
		if ((bool)isInit.GetValue(__instance)) return;
		isInInit.SetValue(null, true);
	}

	private static Type Find(string name) =>
		AppDomain.CurrentDomain.GetAssemblies().Select(a => a.GetType(name)).FirstOrDefault(t => t != null);
}
