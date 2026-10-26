using System;
using System.Reflection;
using HarmonyLib;

namespace TowerFallBrowser;

// A wide (WiderSet) lobby's rematch must open WiderSet's towers. WiderSet puts them on the map in a postfix of
// MainMenu.GotoVersusLevelSelect (MapScene.TowerSet = its set); TF.EX's lobby start goes through that, but its RematchLobby
// handler makes `new MapScene(Versus)` itself, so a wide rematch opened the vanilla set, which WiderSet hides in wide: the map
// held only WORKSHOP LEVELS, TF.EX's map confirmed it, and the page crashed. Here a map scene that starts while WiderSet is wide
// with no tower set chosen gets WiderSet's, as GotoVersusLevelSelect would have given it. Nothing changes when WiderSet isn't
// loaded or isn't wide, or when something already chose the set.
public static class WideMapSet
{
	private const string WiderSetTowers = "Teuria.WiderSet/<Teuria.WiderSet>/TowerFall";   // WiderSet 0.9.0's MainMenuHooks
	private static MethodInfo isWide;
	private static FieldInfo towerSet;

	public static void Patch(Harmony harmony)
	{
		Type module = AccessTools.TypeByName("Teuria.WiderSet.WiderSetModule"), map = AccessTools.TypeByName("TowerFall.MapScene");
		isWide = module == null ? null : AccessTools.PropertyGetter(module, "IsWide");   // a static property
		towerSet = map == null ? null : AccessTools.Field(map, "towerSet");
		MethodInfo begin = map == null ? null : AccessTools.DeclaredMethod(map, "Begin");
		if (isWide != null && towerSet != null && begin != null)
			harmony.Patch(begin, prefix: new HarmonyMethod(typeof(WideMapSet).GetMethod(nameof(BeforeBegin), BindingFlags.NonPublic | BindingFlags.Static)));
		Console.WriteLine($"[netplay] wide map set on a map made outside GotoVersusLevelSelect: {(isWide != null && towerSet != null && begin != null ? "ok" : module == null ? "WiderSet not loaded" : "MISSING")}");
	}

	private static void BeforeBegin(object __instance)
	{
		if (isWide.Invoke(null, null) is true && towerSet.GetValue(__instance) == null)
		{
			towerSet.SetValue(__instance, WiderSetTowers);
			Console.WriteLine("[netplay] wide map: WiderSet's towers (the map was made without GotoVersusLevelSelect: a rematch)");
		}
	}
}
