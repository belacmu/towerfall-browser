using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using HarmonyLib;

namespace TowerFallBrowser;

// Lobby matches against the Nintendo Switch build of TowerFall (Towerfall Switch Mods/switch-online,
// LOBBY-PROTOCOL.md section 5). The Switch speaks TF.EX's lobby protocol and GGRS wire format, but it
// has no WebRTC and runs its session at 60 Hz, where TF.EX runs 240. A lobby player whose UpdatePlayer
// says Platform "Switch" is the signal (TF.EX only shows a notice for it). When this page starts a match
// (MapScene.StartSession -> NetplayManager.UpdatePlayers) in a lobby of exactly 2 players, one of them
// on the Switch and this page the other:
//  - the session's room is the server's match relay, <server>/relay/<RoomId>?peer=<own>&remote=<other>
//    (netplay/tfnet.js picks its WebSocket relay transport from the /relay/ path; the server lets only
//    that lobby's players in, cloudflare/tfex-server/relay.js), instead of matchbox + WebRTC;
//  - the session runs at 60 Hz (TfexFps.SetSessionRate) until the game is back at the main menu;
//  - no spectators (the relay room carries exactly the 2 players).
// Every other lobby is left as TF.EX makes it. A lobby this page hosts also says the host can do this
// (the lobby mod TowerFallBrowser.Relay; TF.EX ignores mods it doesn't know), so a Switch can pick it.
// ?tfexplatform=Switch (TOWERFALL_TFEX_PLATFORM) makes this page claim that platform itself, so two
// browsers can rehearse a Switch lobby.
public static class SwitchLobby
{
	public const string SwitchPlatform = "Switch";
	public const string RelayModName = "TowerFallBrowser.Relay";
	private const string WiderSetModName = "Teuria.WiderSet"; // TF.EX's WiderSetModApiData.Name
	public const int SessionFps = 60;

	private static bool active; // this session runs over the relay
	private static object manager; // TF.EX's NetplayManager
	private static PropertyInfo ggrsConfig, netplayConfig, serverConf, roomUrl, localPeerId, spectators;
	private static MethodInfo ownLobby;
	private static PropertyInfo lobbyPlayers, lobbyRoomId, lobbyMods, playerPlatform, playerPeerId, playerSeat;
	private static FieldInfo preferencesServer;
	private static Type customMod;
	private static Type mainMenu, engineType;
	private static PropertyInfo engineScene;

	public static bool Active => active;

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
		Type server = Find("TF.EX.Domain.Models.NetplayServerConfig");
		customMod = Find("TF.EX.Domain.Models.WebSocket.CustomMod");
		mainMenu = Find("TowerFall.MainMenu");
		engineType = Find("Monocle.Engine");
		Type tfGame = Find("TowerFall.TFGame");
		MethodInfo updatePlayers = managerType?.GetMethod("UpdatePlayers", all);
		MethodInfo addLate = managerType?.GetMethod("AddLateSpectator", all);
		MethodInfo addSpectators = managerType?.GetMethod("AddSpectators", all);
		MethodInfo widerSetMod = Find("TF.EX.Patchs.Scene.MainMenuPatch")?.GetMethod("AddWiderSetLobbyMod", all);
		MethodInfo sceneTransition = tfGame == null ? null : AccessTools.Method(tfGame, "OnSceneTransition");
		ggrsConfig = managerType?.GetProperty("GGRSConfig", all);
		netplayConfig = config?.GetProperty("Netplay");
		serverConf = netplay?.GetProperty("ServerConf");
		localPeerId = netplay?.GetProperty("LocalPeerId");
		spectators = netplay?.GetProperty("Spectators");
		roomUrl = server?.GetProperty("RoomUrl");
		ownLobby = matchmaking?.GetMethod("GetOwnLobby");
		lobbyPlayers = lobby?.GetProperty("Players");
		lobbyRoomId = lobby?.GetProperty("RoomId");
		lobbyMods = lobby?.GetProperty("Mods");
		playerPlatform = player?.GetProperty("Platform");
		playerPeerId = player?.GetProperty("RoomPeerId");
		playerSeat = player?.GetProperty("Seat");
		preferencesServer = Find("TF.EX.Domain.Models.NetplayPreferences")?.GetField("Server", BindingFlags.Public | BindingFlags.Static);
		engineScene = engineType?.GetProperty("Scene", BindingFlags.Public | BindingFlags.Instance);
		resolveMatchmaking = services?.GetMethod("ResolveMatchmakingService", all);
		object[] needed = { updatePlayers, addLate, addSpectators, widerSetMod, sceneTransition, ggrsConfig, netplayConfig, serverConf, localPeerId, spectators, roomUrl, ownLobby,
			lobbyPlayers, lobbyRoomId, lobbyMods, playerPlatform, playerPeerId, playerSeat, preferencesServer, customMod, mainMenu, engineScene, resolveMatchmaking };
		if (needed.Any(x => x == null))
		{
			Console.WriteLine($"[netplay] Switch lobbies: TF.EX isn't as expected ({needed.Count(x => x == null)} members missing); Switch players can't be played");
			return;
		}
		harmony.Patch(updatePlayers, postfix: new HarmonyMethod(typeof(SwitchLobby).GetMethod(nameof(UpdatePlayersPostfix), all)));
		var noSpectators = new HarmonyMethod(typeof(SwitchLobby).GetMethod(nameof(SpectatorsPrefix), all));
		harmony.Patch(addLate, prefix: noSpectators);
		harmony.Patch(addSpectators, prefix: noSpectators);
		harmony.Patch(widerSetMod, postfix: new HarmonyMethod(typeof(SwitchLobby).GetMethod(nameof(LobbyModsPostfix), all)));
		harmony.Patch(sceneTransition, postfix: new HarmonyMethod(typeof(SwitchLobby).GetMethod(nameof(SceneTransitionPostfix), all)));
		ClaimPlatform(harmony, Environment.GetEnvironmentVariable("TOWERFALL_TFEX_PLATFORM"));
	}

	private static MethodInfo resolveMatchmaking;

	private static Type Find(string name) =>
		AppDomain.CurrentDomain.GetAssemblies().Select(a => a.GetType(name)).FirstOrDefault(t => t != null);

	// MapScene.StartSession (TF.EX's prefix) has just listed the lobby's players for the session (GGRSConfig.Netplay), before
	// the level loads and NetplayManager.Init opens the room (and computes the input delay with ToFrames, so at the new rate).
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
			bool switchLobby = players.Count == 2 && players.Any(p => (string)playerPlatform.GetValue(p) == SwitchPlatform);
			object other = players.FirstOrDefault(p => (string)playerPeerId.GetValue(p) != local);
			if (!switchLobby || server == null || other == null || players.All(p => (string)playerPeerId.GetValue(p) != local))
			{
				Stop();
				return;
			}
			string relay = $"{((string)preferencesServer.GetValue(null)).TrimEnd('/')}/relay/{lobbyRoomId.GetValue(lobby)}?peer={local}&remote={playerPeerId.GetValue(other)}";
			roomUrl.SetValue(server, relay);
			spectators.SetValue(netplay, new List<string>());
			active = true;
			TfexFps.SetSessionRate(SessionFps);
			Console.WriteLine($"[netplay] Switch lobby: this match runs at {SessionFps} Hz over the server's relay ({relay.Replace(local, "<own>").Replace((string)playerPeerId.GetValue(other), "<other>")}), no spectators");
		}
		catch (Exception e)
		{
			Console.WriteLine($"[netplay] Switch lobby check failed: {e}");
		}
	}

	private static void Stop()
	{
		if (!active) return;
		active = false;
		TfexFps.SetSessionRate(0);
	}

	// A relay room carries the 2 players only.
	private static bool SpectatorsPrefix(MethodBase __originalMethod)
	{
		if (!active) return true;
		Console.WriteLine($"[netplay] Switch lobby: spectator not added ({__originalMethod.Name})");
		return false;
	}

	// The lobby this page creates (or edits) says its host can play the Switch.
	private static void LobbyModsPostfix(object lobby)
	{
		try
		{
			var mods = (IList)lobbyMods.GetValue(lobby);
			object NewMod(string name, Dictionary<string, string> data)
			{
				object m = Activator.CreateInstance(customMod);
				customMod.GetProperty("Name").SetValue(m, name);
				customMod.GetProperty("Data").SetValue(m, data);
				return m;
			}
			// A joiner checks WiderSet only in a lobby with no mods at all ("WIDERSET MOD ON OFF REQUIRED" for a wide one); with
			// our entry the list isn't empty, so say "not wide" explicitly: CanUseWiderSet then refuses a wide joiner the same way
			// ("NOT WIDE REQUIRED") and lets everyone else in. No Version key, so no version-mismatch notice.
			if (!mods.Cast<object>().Any(m => (string)customMod.GetProperty("Name").GetValue(m) == WiderSetModName))
				mods.Add(NewMod(WiderSetModName, new Dictionary<string, string> { { "IsWide", "False" } }));
			mods.Add(NewMod(RelayModName, new Dictionary<string, string> { { "Version", "1" }, { "Fps", SessionFps.ToString() } }));
		}
		catch (Exception e)
		{
			Console.WriteLine($"[netplay] couldn't add the {RelayModName} lobby mod: {e.Message}");
		}
	}

	// Back at the main menu (roll call, or out of the lobby): TF.EX's own rate again.
	private static void SceneTransitionPostfix(object __instance)
	{
		object scene = engineScene.GetValue(__instance);
		if (active && scene != null && mainMenu.IsInstanceOfType(scene)) Stop();
	}

	// ?tfexplatform=<name>: what this page's UpdatePlayer and CreateLobby say its platform is (TF.EX: Platform.Current).
	private static void ClaimPlatform(Harmony harmony, string platform)
	{
		if (string.IsNullOrEmpty(platform)) return;
		claimed = platform.Length > 32 ? platform[..32] : platform;
		Type type = Find("TF.EX.Domain.Utils.Platform");
		PropertyInfo current = type?.GetProperty("Current", BindingFlags.Public | BindingFlags.Static);
		if (current == null)
		{
			Console.WriteLine("[netplay] ?tfexplatform: TF.EX's Platform.Current not found");
			return;
		}
		// A get-only auto property: its backing field (the getter may be inlined into its callers), and the getter too.
		try
		{
			type.GetField("<Current>k__BackingField", BindingFlags.NonPublic | BindingFlags.Static)?.SetValue(null, claimed);
		}
		catch (Exception e)
		{
			Console.WriteLine($"[netplay] ?tfexplatform: couldn't set Platform.Current's field ({e.Message})");
		}
		harmony.Patch(current.GetMethod, postfix: new HarmonyMethod(typeof(SwitchLobby).GetMethod(nameof(PlatformPostfix), BindingFlags.NonPublic | BindingFlags.Static)));
		Console.WriteLine($"[netplay] DEBUG: this page says it plays on \"{current.GetValue(null)}\" (?tfexplatform)");
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
