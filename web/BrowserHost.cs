using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.JavaScript;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging;
using Microsoft.Xna.Framework;
using TowerFallBrowser;

[assembly: System.Runtime.Versioning.SupportedOSPlatform("browser")]

// Entry points called from wwwroot/main.js. The game itself is not part of this build: main.js
// copies the player's own TowerFall.exe and content into OPFS, and Init() loads that unmodified
// assembly. The browser owns the main loop, so instead of TFGame.Main()/Game.Run() we construct
// the game and tick it once per animation frame.
public static partial class BrowserHost
{
	// OPFS is mounted here; main.js puts the game files under game/ and FortRise under fortrise/.
	public const string Root = "/libsdl";
	public const string SaveDir = Root + "/save";
	// Folders used as working directories are linked at the root: WASMFS reports the current
	// directory inside a mount without the mount's prefix (cwd /libsdl/x reads back as /x), so
	// relative paths only resolve if /x exists too.
	public const string GameDir = "/game";
	public const string GameAssembly = GameDir + "/TowerFall.exe";
	// The player's FortRise folder: main.js copies FortRise's patch module and Internals/ here;
	// Mods/, Saves/ and the generated TowerFall.Patch.dll live here too.
	public const string FortRiseDir = "/fortrise";

	private const string AudioSampleFrames = "2048";

	private static void Main()
	{
		Console.WriteLine("TowerFall browser host loaded");
	}

	[DllImport("Emscripten")]
	private static extern int mount_opfs();

	[DllImport("Emscripten")]
	private static extern int mount_fetch(string url, string dir);

	[DllImport("Emscripten")]
	private static extern int mount_fetch_file(string path);

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

	// fortriseVersion: null for the plain game. frameworkUrl/assemblies (FortRise only): where the
	// app's assemblies are served and their "served-name|assembly-name.dll" pairs, for Cecil.
	[JSExport]
	internal static Task Init(bool noIntro, string fortriseVersion, string frameworkUrl, string[] assemblies)
	{
		try
		{
			Directory.CreateDirectory(SaveDir);
			foreach (string dir in new[] { GameDir, FortRiseDir })
			{
				string target = Root + dir;
				Directory.CreateDirectory(target);
				if (!Directory.Exists(dir)) Directory.CreateSymbolicLink(dir, target);
			}
			// TFGame.GetSavePath() (Linux branch) resolves to $XDG_DATA_HOME/TowerFall. This must
			// be set before anything touches TFGame, whose static fields capture the save path.
			Environment.SetEnvironmentVariable("XDG_DATA_HOME", SaveDir);
			Environment.SetEnvironmentVariable("HOME", SaveDir);
			// FNA resolves content against the app base directory ("/") and the game resolves
			// DarkWorldContent/ against the working directory, so link both at "/" too.
			foreach (string dir in new[] { "Content", "DarkWorldContent" })
			{
				string target = Path.Combine(GameDir, dir);
				if (Directory.Exists(target) && !Directory.Exists("/" + dir))
				{
					Directory.CreateSymbolicLink("/" + dir, target);
				}
			}
			Directory.SetCurrentDirectory("/");

			if (fortriseVersion == null)
			{
				towerFall = Assembly.LoadFrom(GameAssembly);
				Type tfGame = towerFall.GetType("TowerFall.TFGame", throwOnError: true);
				game = (Game)Activator.CreateInstance(tfGame, new object[] { noIntro });
			}
			else
			{
				MountAssemblies(frameworkUrl, assemblies);
				// MonoMod resolves TowerFall.exe's references from the FortRise folder.
				foreach (string dll in new[] { "FNA.dll", "Steamworks.NET.dll" })
				{
					File.Copy("/bin/" + dll, Path.Combine(FortRiseDir, dll), overwrite: true);
				}
				// ...and the framework from /bin.
				Environment.SetEnvironmentVariable("MONOMOD_DEPDIRS", "/bin");
				// The provider decides what's shown (see PlainConsoleLoggerProvider); don't filter before it.
				ILoggerFactory loggers = LoggerFactory.Create(b => b.SetMinimumLevel(LogLevel.Trace).AddProvider(new PlainConsoleLoggerProvider()));
				ModInstaller.Apply(FortRiseDir, loggers.CreateLogger("Mods"));
				// TF.EX's lobby connection would deadlock .NET's browser WebSocket (see PolledWebSocket).
				PolledWebSocket.Install();
				game = FortRiseLauncher.Start(GameAssembly, FortRiseDir, fortriseVersion, noIntro, loggers);
				towerFall = game.GetType().Assembly;
			}
			TouchGamepad.AttachIfEnabled();

			// The constructor's GameData.CheckForDLC() also requires Steam to report the DLC as
			// installed. In the browser, having the Dark World content is enough.
			bool darkWorld = Directory.Exists("/DarkWorldContent");
			towerFall.GetType("TowerFall.GameData", throwOnError: true)
				.GetField("darkWorldFound", BindingFlags.NonPublic | BindingFlags.Static)
				.SetValue(null, darkWorld);

			runApplication = typeof(Game).GetField("RunApplication", BindingFlags.NonPublic | BindingFlags.Instance);
			object version = towerFall.GetType("TowerFall.TFGame").GetField("Version", BindingFlags.Public | BindingFlags.Static)?.GetValue(null);
			Console.WriteLine($"TowerFall {version}{(fortriseVersion != null ? $" with FortRise {fortriseVersion}" : "")} on {RuntimeInformation.FrameworkDescription}; Dark World: {darkWorld}");
		}
		catch (Exception e)
		{
			Console.Error.WriteLine("Error in Init()!");
			Console.Error.WriteLine(e);
			return Task.FromException(e);
		}
		return Task.CompletedTask;
	}

	// Mono.Cecil (MonoMod) needs the app's assemblies as files and looks for the framework in /bin.
	// They're served under _framework/ (with content hashes in their names), so expose them there
	// through a fetch-on-read filesystem: only the ones Cecil actually opens get downloaded.
	private static void MountAssemblies(string frameworkUrl, string[] assemblies)
	{
		if (Directory.Exists("/bin")) return;
		Directory.CreateDirectory("/bin");
		int ret = mount_fetch(frameworkUrl, "/framework");
		if (ret != 0) throw new Exception($"Failed to mount {frameworkUrl} ({ret})");
		var paths = new System.Collections.Generic.List<string>();
		foreach (string pair in assemblies)
		{
			string[] names = pair.Split('|');
			ret = mount_fetch_file("/framework/" + names[0]);
			if (ret != 0) throw new Exception($"Failed to mount {names[0]} ({ret})");
			File.CreateSymbolicLink("/bin/" + names[1], "/framework/" + names[0]);
			paths.Add("/bin/" + names[1]);
		}
		// Cecil's default resolver (used directly by FortRise's Relinker) finds framework assemblies
		// through this list, which the browser runtime leaves empty.
		AppContext.SetData("TRUSTED_PLATFORM_ASSEMBLIES", string.Join(Path.PathSeparator, paths));
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
				TfexPatches.Apply();
			}
			// Commands wait until the main menu has been up for 5 s (mods register theirs late; until
			// then e.g. "test" is the base game's own command)...
			if (!commandsReady)
			{
				menuFrames = game.GetType().GetProperty("Scene")?.GetValue(game)?.GetType().FullName == "TowerFall.MainMenu" ? menuFrames + 1 : 0;
				// ...and TowerFall's background loading (game data, default match settings) is done.
				commandsReady = menuFrames > 300 && towerFall.GetType("TowerFall.TFGame")?.GetProperty("Loaded", BindingFlags.Public | BindingFlags.Static)?.GetValue(null) is true;
			}
			if (startMode != null) ApplyStartMode();
			while (commandsReady && commands.TryDequeue(out string[] command))
			{
				RunGameCommand(command);
			}
			// (Set on the game thread, which SDL belongs to.)
			if (startMusic)
			{
				startMusic = false;
				try
				{
					StartMusicNow();
				}
				catch (Exception e)
				{
					Console.WriteLine($"[music] {e}");
				}
			}
			if (Interlocked.Exchange(ref pastedText, null) is string pasted)
			{
				SDL3.SDL.SDL_SetClipboardText(pasted);
			}
			if (keysFrames > 0)
			{
				keysFrames--;
				var down = Microsoft.Xna.Framework.Input.Keyboard.GetState().GetPressedKeys();
				string now = string.Join(",", down);
				for (int i = 0; i < 4; i++)
				{
					var pad = Microsoft.Xna.Framework.Input.GamePad.GetState((PlayerIndex)i);
					if (pad.IsConnected) now += $" pad{i}: {pad.Buttons} stick {pad.ThumbSticks.Left} triggers {pad.Triggers.Left:0.#}/{pad.Triggers.Right:0.#}";
				}
				if (now != lastKeys) Console.WriteLine($"[keys] {(now.Length > 0 ? now : "(none)")}");
				lastKeys = now;
			}
			TouchGamepad.Update();
			long frameStart = System.Diagnostics.Stopwatch.GetTimestamp();
			game.RunOneFrame();
			frameTicks += System.Diagnostics.Stopwatch.GetTimestamp() - frameStart;
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

	// Text the player pasted on the page (Ctrl+V), for the game's clipboard: SDL's is internal to
	// the page in the browser. Mods like TF.EX read it to paste lobby codes.
	[JSExport]
	internal static Task SetClipboardText(string text)
	{
		pastedText = text;
		return Task.CompletedTask;
	}

	private static string pastedText;

	// The page's Music button: the music bank arrived after the game started (imports from a file
	// host leave it out at first), so start the game's music now, on the game thread.
	[JSExport]
	internal static Task StartMusic()
	{
		startMusic = true;
		return Task.CompletedTask;
	}

	private static bool startMusic;

	// Monocle.Music.Initialize() loads the music bank, or leaves music off (all null) if it can't; the
	// game calls it once at startup, when the bank wasn't there yet. The menu's music request back then
	// was dropped, so ask again on the main menu; elsewhere music starts with the next song.
	private static void StartMusicNow()
	{
		Assembly tf = game.GetType().Assembly;
		Type music = tf.GetType("Monocle.Music");
		music.GetMethod("Initialize", BindingFlags.NonPublic | BindingFlags.Static).Invoke(null, null);
		if (music.GetField("audioEngine", BindingFlags.NonPublic | BindingFlags.Static).GetValue(null) == null)
		{
			Console.WriteLine("[music] couldn't load the music bank");
			return;
		}
		Console.WriteLine("[music] on");
		object scene = game.GetType().GetProperty("Scene")?.GetValue(game);
		if (scene?.GetType().FullName == "TowerFall.MainMenu")
		{
			tf.GetType("TowerFall.MainMenu").GetMethod("PlayMenuMusic").Invoke(null, new object[] { false, false });
		}
	}

	// On-screen controls (wwwroot/touch.js): a virtual gamepad, plugged in by Init() when enabled
	// before it, or before the next frame when enabled later.
	[JSExport]
	internal static Task EnableTouchGamepad()
	{
		TouchGamepad.Enabled = true;
		return Task.CompletedTask;
	}

	// Their state: TouchGamepad's button bits and the stick (-32767..32767, y down).
	[JSExport]
	internal static Task SetTouchGamepad(int buttons, int x, int y)
	{
		TouchGamepad.Set(buttons, x, y);
		return Task.CompletedTask;
	}

	private static readonly System.Collections.Concurrent.ConcurrentQueue<string[]> commands = new();

	// Runs a line in the game's dev console (Monocle Commands, where mods such as TF.EX register
	// theirs) before the next frame; for tests, e.g. TF.EX's "test" (rollback sync test) and
	// "online <mode> <room url>".
	[JSExport]
	internal static Task RunCommand(string line)
	{
		string[] words = line.Split(' ', StringSplitOptions.RemoveEmptyEntries);
		if (words.Length > 0) commands.Enqueue(words);
		return Task.CompletedTask;
	}

	// ?mode=versus|quest|darkworld|trials: once the main menu is up, do what that mode's button does.
	[JSExport]
	internal static Task SetStartMode(string mode)
	{
		startMode = mode.ToLowerInvariant();
		return Task.CompletedTask;
	}

	private static string startMode;
	private static int mainMenuFrames;
	private const string QuickPlaySearch = " quickplay search"; // (not a mode anyone can type)
	private static int quickPlayWait;

	// MainMenu's FightButton, QuestButton, DarkWorldButton and TrialsButton: pick the match settings
	// and rollcall mode, then go to the rollcall (archer select). "online" is TF.EX's NETPLAY button;
	// "quickplay" then picks its QUICK PLAY (the search for opponents).
	private static void ApplyStartMode()
	{
		object scene = game.GetType().GetProperty("Scene")?.GetValue(game);
		PropertyInfo state = scene?.GetType().GetProperty("State");
		if (startMode == QuickPlaySearch)
		{
			// Wait for TF.EX's netplay menu (62, after its version check) to be up for a moment, since
			// creating it sets up netplay; then its QUICK PLAY (65). Give up after 20 s.
			bool onNetplay = scene?.GetType().FullName == "TowerFall.MainMenu" && Convert.ToInt32(state.GetValue(scene)) == 62;
			mainMenuFrames = onNetplay ? mainMenuFrames + 1 : 0;
			if (onNetplay && mainMenuFrames >= 30)
			{
				state.SetValue(scene, Enum.ToObject(state.PropertyType, 65));
				startMode = null;
				Console.WriteLine("[mode] quickplay: searching");
			}
			else if (++quickPlayWait > 1200)
			{
				startMode = null;
				Console.WriteLine("[mode] quickplay: the netplay menu didn't come up");
			}
			return;
		}
		// Wait for the menu's top level (pressing start for the player on the title screen), and give
		// it a moment to tween in.
		string menuState = scene?.GetType().FullName == "TowerFall.MainMenu" ? state.GetValue(scene).ToString() : null;
		if (menuState == "PressStart" && ++mainMenuFrames >= 30)
		{
			state.SetValue(scene, Enum.Parse(state.PropertyType, "Main"));
			mainMenuFrames = 0;
			return;
		}
		if (menuState != "Main")
		{
			if (menuState != "PressStart") mainMenuFrames = 0;
			return;
		}
		if (++mainMenuFrames < 30) return;
		string mode = startMode;
		startMode = null;
		if (mode == "online" || mode == "quickplay")
		{
			string result = TfexPatches.EnterNetplay(scene);
			Console.WriteLine($"[mode] {mode}: {result}");
			if (mode == "quickplay" && result == TfexPatches.EnteringNetplay)
			{
				startMode = QuickPlaySearch;
				mainMenuFrames = 0;
			}
			return;
		}
		string rollcall = mode switch
		{
			"versus" => "Versus",
			"quest" => "Quest",
			"darkworld" => "DarkWorld",
			"trials" => "Trials",
			_ => null,
		};
		if (rollcall == null)
		{
			Console.WriteLine($"[mode] unknown mode \"{mode}\" (versus, quest, darkworld, trials, online or quickplay)");
			return;
		}
		Type menu = scene.GetType();
		if (rollcall == "DarkWorld" && !(bool)menu.Assembly.GetType("TowerFall.GameData").GetProperty("DarkWorldDLC").GetValue(null))
		{
			Console.WriteLine("[mode] darkworld: Dark World isn't installed");
			return;
		}
		menu.GetField("CurrentMatchSettings").SetValue(null, menu.GetField(rollcall + "MatchSettings").GetValue(null));
		FieldInfo rollcallMode = menu.GetField("RollcallMode");
		rollcallMode.SetValue(null, Enum.Parse(rollcallMode.FieldType, rollcall));
		state.SetValue(scene, Enum.Parse(state.PropertyType, "Rollcall"));
		Console.WriteLine($"[mode] {mode}");
	}

	private static int menuFrames;
	private static int keysFrames;
	private static string lastKeys = "";
	private static bool commandsReady;

	private static void RunGameCommand(string[] words)
	{
		try
		{
			if (words[0] == "keys")
			{
				// Logs the keys (and gamepad state) FNA reports, for the next 10 seconds (input debugging).
				keysFrames = 600;
				Console.WriteLine("[command] keys: logging pressed keys and gamepads for 10 s");
				return;
			}
			if (words[0] == "bench")
			{
				Bench.Run();
				return;
			}
			if (words[0] == "netplay")
			{
				object menu = game.GetType().GetProperty("Scene")?.GetValue(game);
				Console.WriteLine($"[command] netplay: {(menu?.GetType().FullName == "TowerFall.MainMenu" ? TfexPatches.EnterNetplay(menu) : "not on the main menu")}");
				return;
			}
			if (words[0] == "menustate" && words.Length > 1)
			{
				// Jumps the main menu to a state (TowerFall's MainMenu.MenuState; mods add their
				// own, e.g. TF.EX's 62 netplay, 63 private, 64 join code), for scripted tests.
				object scene = game.GetType().GetProperty("Scene")?.GetValue(game);
				PropertyInfo state = scene?.GetType().GetProperty("State");
				if (scene?.GetType().FullName != "TowerFall.MainMenu" || state == null)
				{
					Console.WriteLine("[command] menustate: not on the main menu");
					return;
				}
				state.SetValue(scene, Enum.ToObject(state.PropertyType, int.Parse(words[1])));
				Console.WriteLine($"[command] menustate {words[1]}");
				return;
			}
			if (words[0] == "profile")
			{
				Console.WriteLine($"[command] profile: {Profiler.Start(words[1..])}");
				return;
			}
			object console = game.GetType().GetProperty("Commands")?.GetValue(game);
			if (console == null)
			{
				Console.WriteLine($"[command] {string.Join(' ', words)}: the game has no console");
				return;
			}
			Console.WriteLine($"[command] {string.Join(' ', words)}");
			// What the command prints goes to the console's screen buffer (newest first); echo it.
			var output = console.GetType().GetField("drawCommands", BindingFlags.NonPublic | BindingFlags.Instance)?.GetValue(console) as List<string>;
			output?.Clear();
			// Let exceptions through (with their stack) instead of a one-line note.
			console.GetType().GetField("safeExecute", BindingFlags.NonPublic | BindingFlags.Instance)?.SetValue(console, false);
			console.GetType().GetMethod("ExecuteCommand", new[] { typeof(string), typeof(string[]) })
				.Invoke(console, new object[] { words[0].ToLowerInvariant(), words[1..] });
			for (int i = (output?.Count ?? 0) - 1; i >= 0; i--)
			{
				Console.WriteLine($"[command]   {output[i]}");
			}
		}
		catch (Exception e)
		{
			Console.Error.WriteLine($"[command] {string.Join(' ', words)} failed: {e.InnerException ?? e}");
		}
	}

	// FortRise asks for a restart (e.g. after changing mods in its in-game menu) by setting
	// RiseCore.WillRestart and exiting; on desktop it relaunches itself. main.js reloads the page.
	// (Async: the page's main thread may not call into .NET synchronously.)
	[JSExport]
	internal static Task<bool> WantsRestart()
	{
		return Task.FromResult(towerFall?.GetType("FortRise.RiseCore")
			?.GetProperty("WillRestart", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static)
			?.GetValue(null) is true);
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
	private static long frameTicks;
	private static int lastGen0, lastGen1, lastGen2;
	private static TimeSpan lastPaused;
	private static double lastAllocatedMb;

	private static void ReportFrameRate()
	{
		fpsFrames++;
		double seconds = fpsClock.Elapsed.TotalSeconds;
		if (seconds >= 5)
		{
			double busy = frameTicks * 1000.0 / System.Diagnostics.Stopwatch.Frequency / fpsFrames;
			int gen0 = GC.CollectionCount(0), gen1 = GC.CollectionCount(1), gen2 = GC.CollectionCount(2);
			TimeSpan paused = GC.GetTotalPauseDuration();
			string gc = $", GC {gen0 - lastGen0}/{gen1 - lastGen1}/{gen2 - lastGen2} (gen 0/1/2), {(paused - lastPaused).TotalMilliseconds:0} ms paused, {GC.GetTotalAllocatedBytes() / 1048576.0 - lastAllocatedMb:0} MB allocated";
			(lastGen0, lastGen1, lastGen2, lastPaused, lastAllocatedMb) = (gen0, gen1, gen2, paused, GC.GetTotalAllocatedBytes() / 1048576.0);
			Console.WriteLine($"[perf] {fpsFrames / seconds:0.0} frames/s, {busy:0.0} ms/frame in the game{gc}{(Profiler.Enabled ? Profiler.Report(fpsFrames) : "")}");
			fpsFrames = 0;
			frameTicks = 0;
			fpsClock.Restart();
		}
	}

	private static void Invoke(string method)
	{
		typeof(Game).GetMethod(method, BindingFlags.NonPublic | BindingFlags.Instance).Invoke(game, null);
	}
}
