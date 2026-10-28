using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using HarmonyLib;

namespace TowerFallBrowser;

// Lobby matches against the Nintendo Switch build of TowerFall (Towerfall Switch Mods/switch-online,
// LOBBY-PROTOCOL.md section 5). The Switch is a TF.EX client: TF.EX's lobby protocol, lobbies, quick play
// and private lobbies, its matchbox room (<server>/room/<RoomId>) with WebRTC data channels, GGRS's wire
// format. Everything stays TF.EX's own, except where the Switch really differs. A lobby player whose
// UpdatePlayer says Platform "Switch" is the signal (TF.EX only shows a notice for it). When this page
// starts a match (MapScene.StartSession -> NetplayManager.UpdatePlayers) in a lobby with a Switch player
// in it, of any size, until the game is back at the main menu:
//  - the session runs at 60 Hz (TfexFps.SetSessionRate): the Switch runs its session at 60 Hz (not yet TF.EX's
//    240), and GGRS peers must agree on the rate;
//  - no spectators: the Switch can't serve spectators at 60 Hz yet.
// GGRS's desync checksum is TF.EX's own (fletcher16 of TF.State's state): the Switch rolls back with TF.State's own
// state bytes, identical to the PC's.
// A lobby of only browsers runs at 60 Hz with no spectators too (a browser-only rule, docs/BROWSER-60HZ.md); every
// lobby with a desktop TF.EX player in it is left exactly as TF.EX makes it.
// ?tfexplatform=Switch (TOWERFALL_TFEX_PLATFORM) makes this page claim that platform itself, so two
// browsers can rehearse a Switch lobby.
public static class SwitchLobby
{
	public const string SwitchPlatform = "Switch";
	// What this page says it plays on. TF.EX's Platform.Current knows Windows, Linux and macOS (OperatingSystem.Is*) and says
	// "Unknown" for anything else, which other players see as "... IS PLAYING ON UNKNOWN". The runtime here answers
	// OperatingSystem.IsBrowser(), so the page says so, the way TF.EX names the others.
	public const string BrowserPlatform = "Browser";
	public const int SessionFps = 60;
	// ?hz=240 (Switch harness, tests only: the Switch's hw.txt "hz 240" on the other side): a Switch lobby at TF.EX's 240 Hz, with its
	// spectators (only the 60 Hz session can't serve them). Browser-only lobbies keep their rule (docs/BROWSER-60HZ.md).
	private static readonly int testHz = int.TryParse(Environment.GetEnvironmentVariable("TOWERFALL_SWITCHLOBBY_HZ"), out int hz) && hz is 60 or 240 ? hz : 0;

	private static bool lowRate; // this session runs at SessionFps (a Switch lobby, or browsers only)
	private static object manager; // TF.EX's NetplayManager
	private static PropertyInfo ggrsConfig, netplayConfig, serverConf, localPeerId, spectators;
	private static MethodInfo ownLobby;
	private static PropertyInfo lobbyPlayers, playerPlatform, playerPeerId, playerSeat;
	private static Type mainMenu, engineType;
	private static PropertyInfo engineScene;


	public static void Patch(Harmony harmony)
	{
		const BindingFlags all = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static;
		Type managerType = Find("TF.EX.Domain.Services.NetplayManager");
		Type services = Find("TF.EX.Domain.ServiceCollections");
		Type matchmaking = Find("TF.EX.Domain.Ports.IMatchmakingService");
		Type lobby = Find("TF.EX.Domain.Models.WebSocket.Lobby");
		Type player = Find("TF.EX.Domain.Models.WebSocket.Player");
		Type config = Find("TF.EX.Domain.Models.GGRSConfig");
		Type netplay = Find("TF.EX.Domain.Models.NetplayConfig");
		mainMenu = Find("TowerFall.MainMenu");
		engineType = Find("Monocle.Engine");
		Type tfGame = Find("TowerFall.TFGame");
		MethodInfo updatePlayers = managerType?.GetMethod("UpdatePlayers", all);
		MethodInfo addLate = managerType?.GetMethod("AddLateSpectator", all);
		MethodInfo addSpectators = managerType?.GetMethod("AddSpectators", all);
		MethodInfo sceneTransition = tfGame == null ? null : AccessTools.Method(tfGame, "OnSceneTransition");
		ggrsConfig = managerType?.GetProperty("GGRSConfig", all);
		netplayConfig = config?.GetProperty("Netplay");
		serverConf = netplay?.GetProperty("ServerConf");
		localPeerId = netplay?.GetProperty("LocalPeerId");
		spectators = netplay?.GetProperty("Spectators");
		ownLobby = matchmaking?.GetMethod("GetOwnLobby");
		// TF.EX 0.21: the match's players (Lobby.MatchPlayers when the server sends them, else Players), what its UpdatePlayers seats.
		lobbyPlayers = lobby?.GetProperty("SessionPlayers") ?? lobby?.GetProperty("Players");
		playerPlatform = player?.GetProperty("Platform");
		playerPeerId = player?.GetProperty("RoomPeerId");
		playerSeat = player?.GetProperty("Seat");
		engineScene = engineType?.GetProperty("Scene", BindingFlags.Public | BindingFlags.Instance);
		resolveMatchmaking = services?.GetMethod("ResolveMatchmakingService", all);
		object[] needed = { updatePlayers, addLate, addSpectators, sceneTransition, ggrsConfig, netplayConfig, serverConf, localPeerId, spectators, ownLobby,
			lobbyPlayers, playerPlatform, playerPeerId, playerSeat, mainMenu, engineScene, resolveMatchmaking };
		if (needed.Any(x => x == null))
		{
			Console.WriteLine($"[netplay] Switch lobbies: TF.EX isn't as expected ({needed.Count(x => x == null)} members missing); Switch players can't be played");
			return;
		}
		harmony.Patch(updatePlayers, postfix: new HarmonyMethod(typeof(SwitchLobby).GetMethod(nameof(UpdatePlayersPostfix), all)));
		var noSpectators = new HarmonyMethod(typeof(SwitchLobby).GetMethod(nameof(SpectatorsPrefix), all));
		harmony.Patch(addLate, prefix: noSpectators);
		harmony.Patch(addSpectators, prefix: noSpectators);
		harmony.Patch(sceneTransition, postfix: new HarmonyMethod(typeof(SwitchLobby).GetMethod(nameof(SceneTransitionPostfix), all)));
		string asked = Environment.GetEnvironmentVariable("TOWERFALL_TFEX_PLATFORM");
		ClaimPlatform(harmony, string.IsNullOrEmpty(asked) && OperatingSystem.IsBrowser() ? BrowserPlatform : asked, debug: !string.IsNullOrEmpty(asked));
	}

	private static MethodInfo resolveMatchmaking;

	private static Type Find(string name) =>
		AppDomain.CurrentDomain.GetAssemblies().Select(a => a.GetType(name)).FirstOrDefault(t => t != null);

	// MapScene.StartSession (TF.EX's prefix) has just listed the lobby's players for the session (GGRSConfig.Netplay), before
	// the level loads and NetplayManager.Init opens the room (TfexFps converts its input delay to the new rate).
	private static void UpdatePlayersPostfix(object __instance)
	{
		try
		{
			manager = __instance;
			object lobby = ownLobby.Invoke(resolveMatchmaking.Invoke(null, null), null);
			var players = ((IEnumerable)lobbyPlayers.GetValue(lobby)).Cast<object>().OrderBy(p => (int)playerSeat.GetValue(p)).ToList();
			object config = ggrsConfig.GetValue(__instance);
			object netplay = netplayConfig.GetValue(config);
			string local = (string)localPeerId.GetValue(netplay) ?? "";
			object server = serverConf.GetValue(netplay);
			bool switchLobby = players.Any(p => (string)playerPlatform.GetValue(p) == SwitchPlatform);
			// BROWSER-ONLY RULE (docs/BROWSER-60HZ.md): a lobby of only browsers (and Switches) plays at 60 Hz too, where
			// TF.EX runs 240: a quarter of the ticks to simulate and resimulate, which phones keep up with. Every player
			// sees the same platforms, so all agree; a desktop TF.EX player (Windows / Linux / macOS, or none given) keeps
			// the lobby on TF.EX's own 240 Hz, so desktop TF.EX is never affected.
			bool browserLobby = players.All(p => (string)playerPlatform.GetValue(p) is BrowserPlatform or SwitchPlatform);
			if (!(switchLobby || browserLobby) || server == null || players.All(p => (string)playerPeerId.GetValue(p) != local))
			{
				Stop();
				return;
			}
			if (switchLobby && testHz == 240)
			{
				Stop();
				Console.WriteLine($"[netplay] Switch lobby: this match ({players.Count} players) runs at TF.EX's 240 Hz (?hz=240, test), spectators as TF.EX has them");
				return;
			}
			spectators.SetValue(netplay, new List<string>()); // the Switch can't serve spectators at 60 Hz yet
			lowRate = true;
			TfexFps.SetSessionRate(SessionFps); // a Switch lobby runs 60 Hz unless the Switch's tester says otherwise (?hz=240); GGRS peers must agree
			Console.WriteLine($"[netplay] {(switchLobby ? "Switch" : "Browser")} lobby: this match ({players.Count} players) runs at {SessionFps} Hz over TF.EX's room, no spectators");
		}
		catch (Exception e)
		{
			Console.WriteLine($"[netplay] Switch lobby check failed: {e}");
		}
	}

	private static void Stop()
	{
		if (!lowRate) return;
		lowRate = false;
		TfexFps.SetSessionRate(0);
	}

	// The Switch can't serve spectators at 60 Hz yet, and a spectator joining a 60 Hz browser lobby may be desktop TF.EX at 240.
	private static bool SpectatorsPrefix(MethodBase __originalMethod)
	{
		if (!lowRate) return true;
		Console.WriteLine($"[netplay] Switch lobby: spectator not added ({__originalMethod.Name})");
		return false;
	}

	// Back at the main menu (roll call, or out of the lobby): TF.EX's own rate again.
	private static void SceneTransitionPostfix(object __instance)
	{
		object scene = engineScene.GetValue(__instance);
		if (lowRate && scene != null && mainMenu.IsInstanceOfType(scene)) Stop();
	}

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
		harmony.Patch(current.GetMethod, postfix: new HarmonyMethod(typeof(SwitchLobby).GetMethod(nameof(PlatformPostfix), BindingFlags.NonPublic | BindingFlags.Static)));
		Console.WriteLine(debug ? $"[netplay] DEBUG: this page says it plays on \"{current.GetValue(null)}\" (?tfexplatform)" : $"[netplay] TF.EX platform: {current.GetValue(null)}");
		// The Switch has no instant replay and says so (UseInstantReplay false turns it off for the match): a page that plays the
		// Switch's part does the same.
		MethodInfo instantReplay = Find("TF.EX.Domain.NetplayOptions")?.GetProperty("UseInstantReplay", BindingFlags.Public | BindingFlags.Static)?.GetMethod;
		if (claimed == SwitchPlatform && instantReplay != null)
		{
			harmony.Patch(instantReplay, postfix: new HarmonyMethod(typeof(SwitchLobby).GetMethod(nameof(NoInstantReplay), BindingFlags.NonPublic | BindingFlags.Static)));
			Console.WriteLine("[netplay] DEBUG: and has no instant replay, like the Switch");
		}
	}

	private static void NoInstantReplay(ref bool __result) => __result = false;

	private static string claimed;

	private static void PlatformPostfix(ref string __result) => __result = claimed;
}
