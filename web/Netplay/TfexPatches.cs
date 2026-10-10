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
		Console.WriteLine("[netplay] TF.EX patched for the browser (update check via the GitHub API, no self-update).");
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
