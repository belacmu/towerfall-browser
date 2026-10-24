using System;
using System.Linq;
using System.Reflection;
using HarmonyLib;
using Microsoft.Xna.Framework;

namespace TowerFallBrowser;

// Drawing must not change TF.State's saved state (a TF.EX / TowerFall issue: docs/TFEX-UPSTREAM.md). The game draws a wrapped
// entity's copies by moving it (LevelEntity.Render: X -= 320, draw, X += 320) and a wiggling arrow by turning its images
// (Arrow.DoWrapRender: Rotation += n, draw, Rotation -= n). In floats (x + n) - n isn't always x, and TF.State saves both, so the
// saved state, and GGRS's checksum, depended on how many frames each player's machine drew (frame skips; resimulated frames
// aren't drawn): two players could desync while playing the same. Here the values are kept across the draw and put back exactly.
// The Switch port does the same (switch-online pcgameplay.cpp), so the two agree.
public static class RenderKeepsState
{
	private static FieldInfo position, rotation;
	private static MethodInfo graphics;

	public static void Patch(Harmony harmony)
	{
		Type entity = Find("Monocle.Entity"), levelEntity = Find("TowerFall.LevelEntity"), arrow = Find("TowerFall.Arrow"), image = Find("Monocle.Image");
		position = entity?.GetField("Position");
		rotation = image?.GetField("Rotation") ?? Find("Monocle.GraphicsComponent")?.GetField("Rotation");
		graphics = arrow == null ? null : AccessTools.PropertyGetter(arrow, "Graphics");
		MethodInfo render = levelEntity == null ? null : AccessTools.DeclaredMethod(levelEntity, "Render");
		MethodInfo wrapRender = arrow == null ? null : AccessTools.DeclaredMethod(arrow, "DoWrapRender");
		const BindingFlags st = BindingFlags.NonPublic | BindingFlags.Static;
		if (render != null && position != null)
			harmony.Patch(render, prefix: new HarmonyMethod(typeof(RenderKeepsState).GetMethod(nameof(KeepPosition), st)),
				postfix: new HarmonyMethod(typeof(RenderKeepsState).GetMethod(nameof(RestorePosition), st)));
		if (wrapRender != null && rotation != null && graphics != null)
			harmony.Patch(wrapRender, prefix: new HarmonyMethod(typeof(RenderKeepsState).GetMethod(nameof(KeepRotations), st)),
				postfix: new HarmonyMethod(typeof(RenderKeepsState).GetMethod(nameof(RestoreRotations), st)));
		Console.WriteLine($"[netplay] drawing keeps the saved state: LevelEntity.Render {(render != null && position != null ? "ok" : "MISSING")}, Arrow.DoWrapRender {(wrapRender != null && rotation != null && graphics != null ? "ok" : "MISSING")}");
	}

	private static void KeepPosition(object __instance, out Vector2 __state) => __state = (Vector2)position.GetValue(__instance);
	private static void RestorePosition(object __instance, Vector2 __state) => position.SetValue(__instance, __state);

	private static void KeepRotations(object __instance, out float[] __state)
	{
		var images = graphics.Invoke(__instance, null) as Array;
		__state = images == null ? null : images.Cast<object>().Select(i => i == null ? 0f : (float)rotation.GetValue(i)).ToArray();
	}

	private static void RestoreRotations(object __instance, float[] __state)
	{
		if (__state == null || graphics.Invoke(__instance, null) is not Array images) return;
		for (int i = 0; i < images.Length && i < __state.Length; i++)
			if (images.GetValue(i) is object img) rotation.SetValue(img, __state[i]);
	}

	private static Type Find(string name) => AppDomain.CurrentDomain.GetAssemblies().Select(a => a.GetType(name)).FirstOrDefault(t => t != null);
}
