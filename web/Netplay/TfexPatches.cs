using System;
using System.Linq;
using System.Net.Http;
using System.Reflection;
using System.Text.Json;
using System.Threading.Tasks;
using HarmonyLib;

namespace TowerFallBrowser;

// Browser changes to TF.EX (the online-play mod), applied with Harmony once FortRise has loaded it.
//  - Its update check reads GitHub's release redirect, which browsers can't read cross-origin;
//    the official server needs the check to pass. GitHub's API allows cross-origin reads.
//  - It can't update itself in the browser: the site pins TF.EX and ships updates
//    (tools/fetch-tfex.sh), so applying an update fails with a note saying so.
//  - Lobby codes it copies also go on the system clipboard (SDL's is internal to the page).
//  - Its server: the official one turns browsers away, so the page names ours (TFEX_SERVER, see
//    main.js) and TF.EX's OFFICIAL setting (its default, and RESET in its options) means that one
//    here, shown as BROWSER. LOCAL and CUSTOM choices stand. ?tfexserver= (TFEX_SERVER_FORCE) picks
//    the server for the visit whatever is saved, until it's changed in the options.
public static class TfexPatches
{
	private const string LatestRelease = "https://api.github.com/repos/Fcornaire/TF.EX/releases/latest";
	private static bool applied;

	public static void Apply()
	{
		if (applied) return;
		Type updater = AppDomain.CurrentDomain.GetAssemblies()
			.Select(a => a.GetType("TF.EX.Common.AutoUpdater")).FirstOrDefault(t => t != null);
		if (updater == null) return; // TF.EX isn't enabled
		applied = true;
		var harmony = new Harmony("TowerFallBrowser.TfexPatches");
		const BindingFlags all = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static;
		harmony.Patch(updater.GetMethod("FetchLatestVersion", all),
			prefix: new HarmonyMethod(typeof(TfexPatches).GetMethod(nameof(FetchLatestVersion), all)));
		harmony.Patch(updater.GetMethod("DownloadAndApply", all),
			prefix: new HarmonyMethod(typeof(TfexPatches).GetMethod(nameof(DownloadAndApply), all)));
		Type clipboard = updater.Assembly.GetType("TF.EX.Domain.Services.ClipboardService")
			?? AppDomain.CurrentDomain.GetAssemblies().Select(a => a.GetType("TF.EX.Domain.Services.ClipboardService")).FirstOrDefault(t => t != null);
		if (clipboard != null)
		{
			harmony.Patch(clipboard.GetMethod("SetText", all),
				postfix: new HarmonyMethod(typeof(TfexPatches).GetMethod(nameof(ClipboardSet), all)));
		}
		StateSpeedups.Patch(harmony);
		PatchServer(harmony);
		Console.WriteLine("[netplay] TF.EX patched for the browser (update check via the GitHub API, no self-update).");
	}

	private const string BrowserLabel = "BROWSER";
	private static string browserServer;
	private static FieldInfo preferencesServer;
	private static string officialServer;

	private static void PatchServer(Harmony harmony)
	{
		browserServer = Environment.GetEnvironmentVariable("TFEX_SERVER");
		if (string.IsNullOrEmpty(browserServer)) return;
		Type preferences = FindType("TF.EX.Domain.Models.NetplayPreferences");
		Type settings = FindType("TF.EX.NetplaySettings");
		preferencesServer = preferences?.GetField("Server", BindingFlags.Public | BindingFlags.Static);
		officialServer = preferences?.GetField("OfficialServer", BindingFlags.Public | BindingFlags.Static)?.GetRawConstantValue() as string;
		if (preferencesServer == null || officialServer == null || settings == null)
		{
			Console.WriteLine("[netplay] couldn't find TF.EX's server setting; leaving it alone");
			return;
		}
		const BindingFlags all = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static;
		harmony.Patch(settings.GetMethod("Apply", all),
			postfix: new HarmonyMethod(typeof(TfexPatches).GetMethod(nameof(SettingsApplied), all)));
		MethodInfo display = FindType("TF.EX.ServerOptionsButton")?.GetMethod("Display", all);
		if (display != null)
		{
			harmony.Patch(display, prefix: new HarmonyMethod(typeof(TfexPatches).GetMethod(nameof(DisplayServer), all)));
		}
		if (Environment.GetEnvironmentVariable("TFEX_SERVER_FORCE") == "1") preferencesServer.SetValue(null, browserServer);
		else SettingsApplied();
		Console.WriteLine($"[netplay] TF.EX server: {preferencesServer.GetValue(null)}");
	}

	private static Type FindType(string name) =>
		AppDomain.CurrentDomain.GetAssemblies().Select(a => a.GetType(name)).FirstOrDefault(t => t != null);

	// TF.EX copies its saved settings into NetplayPreferences here; OFFICIAL becomes ours.
	private static void SettingsApplied()
	{
		if ((string)preferencesServer.GetValue(null) == officialServer) preferencesServer.SetValue(null, browserServer);
	}

	private static bool DisplayServer(string server, ref string __result)
	{
		if (server != browserServer) return true;
		__result = BrowserLabel;
		return false;
	}

	// What TF.EX's NETPLAY button does (version check, then the netplay menu), for scripted tests.
	public static string EnterNetplay(object mainMenu)
	{
		Assembly patches = AppDomain.CurrentDomain.GetAssemblies().FirstOrDefault(a => a.GetType("TF.EX.Patchs.Engine.TFGamePatch") != null);
		if (patches == null) return "TF.EX isn't loaded";
		MethodInfo request = patches.GetType("TF.EX.Patchs.Engine.TFGamePatch").GetMethod("RequestNetplayEntry", BindingFlags.Public | BindingFlags.Static);
		FieldInfo requested = patches.GetType("TF.EX.Patchs.Scene.WiderSetMenu").GetField("IsNetplayRequested", BindingFlags.Public | BindingFlags.Static);
		PropertyInfo state = mainMenu.GetType().GetProperty("State");
		request.Invoke(null, new object[] { mainMenu, (Action)(() =>
		{
			requested.SetValue(null, true);
			state.SetValue(mainMenu, Enum.ToObject(state.PropertyType, 62)); // TF.EX's MenuState.NetplaySelect
		}) });
		return "entering netplay";
	}

	private static bool FetchLatestVersion(ref Task<Version> __result)
	{
		__result = LatestVersion();
		return false;
	}

	private static async Task<Version> LatestVersion()
	{
		using var client = new HttpClient();
		using var request = new HttpRequestMessage(HttpMethod.Get, LatestRelease);
		request.Headers.Add("Accept", "application/vnd.github+json");
		using HttpResponseMessage response = await client.SendAsync(request);
		response.EnsureSuccessStatusCode();
		using JsonDocument release = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
		return new Version(release.RootElement.GetProperty("tag_name").GetString().TrimStart('v', 'V'));
	}

	[System.Runtime.InteropServices.DllImport("Emscripten")]
	private static extern void tfclip_write(string text);

	private static void ClipboardSet(string text)
	{
		tfclip_write(text ?? "");
		Console.WriteLine($"[netplay] copied to the clipboard: {text}");
	}

	private static bool DownloadAndApply(object __instance, ref Task<bool> __result)
	{
		__instance.GetType().GetField("_failureReason", BindingFlags.NonPublic | BindingFlags.Instance)
			?.SetValue(__instance, "THE BROWSER VERSION UPDATES TF.EX ITSELF. CHECK BACK SOON");
		__result = Task.FromResult(false);
		return false;
	}
}
