using System;
using System.Linq;
using System.Reflection;
using HarmonyLib;

namespace TowerFallBrowser;

// What this page tells TF.EX's lobby it plays on: "Browser" (TF.EX's Platform.Current knows Windows, Linux and macOS and says
// "Unknown" for anything else, which other players see as "... IS PLAYING ON UNKNOWN"; the runtime here answers
// OperatingSystem.IsBrowser(), so the page says so, the way TF.EX names the others). ?tfexplatform=<name> (TOWERFALL_TFEX_PLATFORM,
// debug) makes it claim another, e.g. "Switch", so two browsers can rehearse a lobby with the Switch in it (no instant replay, as on
// the Switch). Every lobby, with the Switch in it or not, plays as TF.EX makes it: its 240 Hz, its spectators.
public static class PagePlatform
{
	public const string BrowserPlatform = "Browser";
	public const string SwitchPlatform = "Switch";

	public static void Patch(Harmony harmony)
	{
		string asked = Environment.GetEnvironmentVariable("TOWERFALL_TFEX_PLATFORM");
		ClaimPlatform(harmony, string.IsNullOrEmpty(asked) && OperatingSystem.IsBrowser() ? BrowserPlatform : asked, debug: !string.IsNullOrEmpty(asked));
	}

	private static Type Find(string name) =>
		AppDomain.CurrentDomain.GetAssemblies().Select(a => a.GetType(name)).FirstOrDefault(t => t != null);

	// What this page's UpdatePlayer and CreateLobby say its platform is (TF.EX: Platform.Current): "Browser", or
	// ?tfexplatform=<name> (debug).
	private static void ClaimPlatform(Harmony harmony, string platform, bool debug)
	{
		if (string.IsNullOrEmpty(platform)) return;
		claimed = platform.Length > 32 ? platform[..32] : platform;
		Type type = Find("TF.EX.Domain.Utils.Platform");
		PropertyInfo current = type?.GetProperty("Current", BindingFlags.Public | BindingFlags.Static);
		if (current == null)
		{
			Console.WriteLine("[netplay] TF.EX's Platform.Current not found: the page's platform stays TF.EX's");
			return;
		}
		// A get-only auto property: its backing field (the getter may be inlined into its callers), and the getter too.
		try
		{
			type.GetField("<Current>k__BackingField", BindingFlags.NonPublic | BindingFlags.Static)?.SetValue(null, claimed);
		}
		catch (Exception e)
		{
			Console.WriteLine($"[netplay] couldn't set TF.EX's Platform.Current field ({e.Message})");
		}
		harmony.Patch(current.GetMethod, postfix: new HarmonyMethod(typeof(PagePlatform).GetMethod(nameof(PlatformPostfix), BindingFlags.NonPublic | BindingFlags.Static)));
		Console.WriteLine(debug ? $"[netplay] DEBUG: this page says it plays on \"{current.GetValue(null)}\" (?tfexplatform)" : $"[netplay] TF.EX platform: {current.GetValue(null)}");
		// The Switch has no instant replay and says so (UseInstantReplay false turns it off for the match): a page that plays the
		// Switch's part does the same.
		MethodInfo instantReplay = Find("TF.EX.Domain.NetplayOptions")?.GetProperty("UseInstantReplay", BindingFlags.Public | BindingFlags.Static)?.GetMethod;
		if (claimed == SwitchPlatform && instantReplay != null)
		{
			harmony.Patch(instantReplay, postfix: new HarmonyMethod(typeof(PagePlatform).GetMethod(nameof(NoInstantReplay), BindingFlags.NonPublic | BindingFlags.Static)));
			Console.WriteLine("[netplay] DEBUG: and has no instant replay, like the Switch");
		}
	}

	private static void NoInstantReplay(ref bool __result) => __result = false;

	private static string claimed;

	private static void PlatformPostfix(ref string __result) => __result = claimed;
}
