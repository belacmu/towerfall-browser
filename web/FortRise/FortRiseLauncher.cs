using System;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Runtime.Loader;
using System.Threading;
using Microsoft.Extensions.Logging;
using Microsoft.Xna.Framework;

namespace TowerFallBrowser;

// Starts TowerFall under FortRise, the way FortLauncher's FortRiseHandler.Run plus the patched
// TFGame.Main do on desktop, minus the blocking Game.Run(): the host ticks the returned game.
public static class FortRiseLauncher
{
	private static int shownPercent = -1;

	// The page shows patching's progress from these lines (and leaves them out of the console).
	public static void ReportPatchProgress(double fraction)
	{
		int percent = (int)(fraction * 100);
		if (percent == shownPercent) return;
		shownPercent = percent;
		Console.WriteLine($"[progress] patch {percent}");
	}

	public static Game Start(string exePath, string fortriseDir, string fortriseVersion, bool noIntro, ILoggerFactory loggers)
	{
		ILogger log = loggers.CreateLogger("FortRise");
		string patchFile = FortRisePatcher.EnsurePatched(exePath, fortriseDir, fortriseVersion, loggers, ReportPatchProgress);

		// FortRiseHandler.LoadAssembly: dependencies not in the app resolve from the FortRise folder.
		AssemblyLoadContext.Default.Resolving += (context, name) =>
		{
			string path = Path.Combine(fortriseDir, name.Name + ".dll");
			return File.Exists(path) ? context.LoadFromAssemblyPath(path) : null;
		};
		// Loaded from a path (not bytes) because RiseCore finds its folder via Assembly.Location.
		Assembly game;
		try
		{
			game = Assembly.LoadFrom(patchFile);
		}
		catch (BadImageFormatException e)
		{
			// A damaged cached patch would otherwise fail every start: patch again, once.
			log.LogWarning("TowerFall.Patch.dll didn't load ({Error}); patching again.", e.Message);
			shownPercent = -1;
			patchFile = FortRisePatcher.EnsurePatched(exePath, fortriseDir, fortriseVersion, loggers, ReportPatchProgress, force: true);
			game = Assembly.LoadFrom(patchFile);
		}
		Directory.SetCurrentDirectory(Path.GetDirectoryName(exePath));
		KeepSavesInFortRiseFolder(game, fortriseDir, log);

		// The patched TFGame.Main, up to `new TFGame(noIntro).Run()`.
		CultureInfo.DefaultThreadCurrentCulture = CultureInfo.InvariantCulture;
		CultureInfo.DefaultThreadCurrentUICulture = CultureInfo.InvariantCulture;
		Thread.CurrentThread.CurrentCulture = CultureInfo.InvariantCulture;
		Thread.CurrentThread.CurrentUICulture = CultureInfo.InvariantCulture;

		Type riseCore = game.GetType("FortRise.RiseCore", throwOnError: true);
		Type semVer = game.GetType("FortRise.SemanticVersion", throwOnError: true);
		object version = Activator.CreateInstance(semVer, fortriseVersion);
		riseCore.GetProperty("FortRiseVersion", BindingFlags.Public | BindingFlags.Static).SetValue(null, version);
		Call(riseCore, "LauncherPipe", log, loggers);
		Call(riseCore, "Start");
		Call(riseCore, "ParseArgs", (object)Array.Empty<string>());
		// TryInit (Steam) is skipped: our Steamworks.NET stand-in would refuse, and Steam is never
		// "running" in the browser anyway. The SELinux execheap probe only runs on Linux.

		Type tfGame = game.GetType("TowerFall.TFGame", throwOnError: true);
		log.LogInformation("Running the game!");
		return (Game)Activator.CreateInstance(tfGame, new object[] { noIntro });
	}

	// FortRise keeps every mod's settings and save data in Saves/ under ModIO.GetRootPath(), the app's
	// base directory: the game folder on desktop, but "/" here, an in-memory folder that a reload
	// empties (so TF.EX's input delay, TF.Replay's options etc. reset every visit). It's pointed at the
	// FortRise folder instead, in OPFS next to Mods/, before RiseCore.Start loads the mods' settings.
	// FortRise uses GetRootPath for nothing else.
	private static string savesRoot;

	private static void KeepSavesInFortRiseFolder(Assembly game, string fortriseDir, ILogger log)
	{
		MethodInfo getRootPath = game.GetType("FortRise.ModIO")?.GetMethod("GetRootPath", BindingFlags.Public | BindingFlags.Static, Type.EmptyTypes);
		if (getRootPath == null)
		{
			log.LogWarning("FortRise.ModIO.GetRootPath not found; mod settings won't be kept between visits.");
			return;
		}
		savesRoot = fortriseDir.TrimEnd('/') + "/";
		new HarmonyLib.Harmony("TowerFallBrowser.FortRiseSaves").Patch(getRootPath,
			prefix: new HarmonyLib.HarmonyMethod(typeof(FortRiseLauncher).GetMethod(nameof(RootPath), BindingFlags.NonPublic | BindingFlags.Static)));
	}

	private static bool RootPath(ref string __result)
	{
		__result = savesRoot;
		return false;
	}

	private static void Call(Type type, string method, params object[] args)
	{
		MethodInfo m = type.GetMethod(method, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static)
			?? throw new MissingMethodException(type.FullName, method);
		try
		{
			m.Invoke(null, args);
		}
		catch (TargetInvocationException e) when (e.InnerException != null)
		{
			System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(e.InnerException).Throw();
		}
	}
}
