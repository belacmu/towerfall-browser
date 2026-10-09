using System;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.JavaScript;
using System.Threading.Tasks;
using Microsoft.Xna.Framework;

[assembly: System.Runtime.Versioning.SupportedOSPlatform("browser")]

// Entry points called from wwwroot/main.js. The game itself is not part of this build: main.js
// copies the player's own TowerFall.exe and content into OPFS, and Init() loads that unmodified
// assembly. The browser owns the main loop, so instead of TFGame.Main()/Game.Run() we construct
// the game and tick it once per animation frame.
public static partial class BrowserHost
{
	// OPFS is mounted here; main.js puts the game files under GameDir.
	public const string Root = "/libsdl";
	public const string GameDir = Root + "/game";
	public const string SaveDir = Root + "/save";
	public const string GameAssembly = GameDir + "/TowerFall.exe";

	private const string AudioSampleFrames = "2048";

	private static void Main()
	{
		Console.WriteLine("TowerFall browser host loaded");
	}

	[DllImport("Emscripten")]
	private static extern int mount_opfs();

	private static Game game;
	private static Assembly towerFall;
	private static FieldInfo runApplication;
	private static bool started;

	[JSExport]
	internal static Task PreInit()
	{
		return Task.Run(() =>
		{
			int ret = mount_opfs();
			if (ret != 0)
			{
				throw new Exception($"Failed to mount OPFS ({ret})");
			}
			Environment.SetEnvironmentVariable("FNA_PLATFORM_BACKEND", "SDL3");
			// FNA defaults to 4 gamepad slots; the 8-player TowerFall build polls 8 and would index
			// past the end. Builds that use 4 just leave the rest empty.
			Environment.SetEnvironmentVariable("FNA_GAMEPAD_NUM_GAMEPADS", "8");
			// Emscripten's SDL audio backend feeds a ScriptProcessorNode on the page's main
			// thread; SDL's default buffer (~1024 frames) underruns there.
			SDL3.SDL.SDL_SetHint(SDL3.SDL.SDL_HINT_AUDIO_DEVICE_SAMPLE_FRAMES, AudioSampleFrames);
		});
	}

	[JSExport]
	internal static Task Init(bool noIntro)
	{
		try
		{
			Directory.CreateDirectory(SaveDir);
			// TFGame.GetSavePath() (Linux branch) resolves to $XDG_DATA_HOME/TowerFall. This must
			// be set before anything touches TFGame, whose static fields capture the save path.
			Environment.SetEnvironmentVariable("XDG_DATA_HOME", SaveDir);
			Environment.SetEnvironmentVariable("HOME", SaveDir);
			// FNA resolves content against the app base directory ("/") and the game resolves
			// DarkWorldContent/ against the working directory (also "/"), so link both there.
			foreach (string dir in new[] { "Content", "DarkWorldContent" })
			{
				string target = Path.Combine(GameDir, dir);
				if (Directory.Exists(target) && !Directory.Exists("/" + dir))
				{
					Directory.CreateSymbolicLink("/" + dir, target);
				}
			}
			Directory.SetCurrentDirectory("/");

			towerFall = Assembly.LoadFrom(GameAssembly);
			Type tfGame = towerFall.GetType("TowerFall.TFGame", throwOnError: true);
			game = (Game)Activator.CreateInstance(tfGame, new object[] { noIntro });

			// The constructor's GameData.CheckForDLC() also requires Steam to report the DLC as
			// installed. In the browser, having the Dark World content is enough.
			bool darkWorld = Directory.Exists("/DarkWorldContent");
			towerFall.GetType("TowerFall.GameData", throwOnError: true)
				.GetField("darkWorldFound", BindingFlags.NonPublic | BindingFlags.Static)
				.SetValue(null, darkWorld);

			runApplication = typeof(Game).GetField("RunApplication", BindingFlags.NonPublic | BindingFlags.Instance);
			object version = tfGame.GetField("Version", BindingFlags.Public | BindingFlags.Static)?.GetValue(null);
			Console.WriteLine($"TowerFall {version} on {RuntimeInformation.FrameworkDescription}; Dark World: {darkWorld}");
		}
		catch (Exception e)
		{
			Console.Error.WriteLine("Error in Init()!");
			Console.Error.WriteLine(e);
			return Task.FromException(e);
		}
		return Task.CompletedTask;
	}

	[JSExport]
	internal static Task<bool> MainLoop()
	{
		try
		{
			if (!started)
			{
				// Mirror Game.Run(): initialize, BeginRun, BeforeLoop (registers the game with the
				// platform and marks it active), then fall through to per-frame ticks.
				Invoke("DoInitialize");
				typeof(Game).GetField("hasInitialized", BindingFlags.NonPublic | BindingFlags.Instance).SetValue(game, true);
				Invoke("BeginRun");
				Invoke("BeforeLoop");
				typeof(Game).GetField("gameTimer", BindingFlags.NonPublic | BindingFlags.Instance).SetValue(game, System.Diagnostics.Stopwatch.StartNew());
				started = true;
			}
			game.RunOneFrame();
			ReportFrameRate();
		}
		catch (Exception e)
		{
			Console.Error.WriteLine("Error in MainLoop()!");
			Console.Error.WriteLine(e);
			LogToGame(e);
			return Task.FromException<bool>(e);
		}
		return Task.FromResult((bool)runApplication.GetValue(game));
	}

	// Writes the exception to the game's own error_log.txt (in the save dir), like a desktop crash.
	private static void LogToGame(Exception e)
	{
		try
		{
			towerFall?.GetType("TowerFall.TFGame")
				?.GetMethod("Log", BindingFlags.Public | BindingFlags.Static)
				?.Invoke(null, new object[] { e, false });
		}
		catch
		{
		}
	}

	private static readonly System.Diagnostics.Stopwatch fpsClock = System.Diagnostics.Stopwatch.StartNew();
	private static int fpsFrames;

	private static void ReportFrameRate()
	{
		fpsFrames++;
		double seconds = fpsClock.Elapsed.TotalSeconds;
		if (seconds >= 5)
		{
			Console.WriteLine($"[perf] {fpsFrames / seconds:0.0} frames/s");
			fpsFrames = 0;
			fpsClock.Restart();
		}
	}

	private static void Invoke(string method)
	{
		typeof(Game).GetMethod(method, BindingFlags.NonPublic | BindingFlags.Instance).Invoke(game, null);
	}
}
