using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using HarmonyLib;
using Microsoft.Xna.Framework;

namespace TowerFallBrowser;

// `xlobby`: the xnet log and scripted input (XplayNet.cs) for a match started from a real TF.EX lobby (create / join, archer
// select, ready, start), e.g. a rehearsal of a lobby match against the Switch (?tfexplatform=Switch on one page; PagePlatform.cs).
//
//   xlobby [script0=<path or inline>] [script1=..] [maxticks=N] [origin=266] [margin=24]
//
// Run it before the match (e.g. ?command=xlobby ...): it only arms the logging. Unlike xnet nothing of TF.EX's lobby path is
// replaced: TF.EX's own mode (NetplayRoundLogic), seats and handles, seed, archers, the first round spawned on the first
// synchronised frame, its kill-cam handling, its rules (no test mode). The local handle (the index of this page's peer id in
// the session's Players, which are ordered by Seat) plays script<handle>, at T = G - origin as in xnet (origin= must be the
// GGRS frame of tick 0 of this path: run once without scripts, the log's "origin ggrs_frame" line says it). Extra [xlobby] lines:
// the session (GoalScore, MatchLength, round logic, input delay, rate), the GGRS frame of synchronisation and of the first
// round's spawn, and at the end the frames the match results appear and local inputs go neutral.
public static partial class XplayVersus
{
	private static bool netLobby;
	private static bool lobbyPatched;
	private static bool lobbyResultsSeen, lobbyNeutralSeen;
	private static MethodInfo lobbyIsInit;

	private static void LobbyLog(string text) => Console.WriteLine($"[xlobby] t={netClock?.ElapsedMilliseconds ?? 0}ms G={SafeFrame()} {text}");

	private static int SafeFrame()
	{
		try
		{
			return (int)netplayCurrentFrame.Invoke(null, null);
		}
		catch
		{
			return -1;
		}
	}

	public static string StartLobby(Assembly towerFall, Game theGame, string[] words)
	{
		game = theGame;
		if (Find("TF.EX.Core.TFCommands") == null) return "TF.EX isn't loaded (?mods=TF.EX)";
		var options = words.Skip(1).Where(w => w.Contains('=')).Select(w => w.Split('=', 2)).ToDictionary(p => p[0], p => p[1]);
		int Opt(string key, int fallback) => options.TryGetValue(key, out string v) ? int.Parse(v, CultureInfo.InvariantCulture) : fallback;
		maxTicks = Opt("maxticks", 6000);
		netInputOrigin = Opt("origin", 266);
		netMargin = Opt("margin", 24);
		for (int i = 0; i < 2; i++)
		{
			string s = options.TryGetValue($"script{i}", out string sc) ? sc : "-";
			if (s.Length > 0 && s != "-" && !s.Contains(':') && File.Exists(s)) s = File.ReadAllText(s).Trim();
			scripts[i] = Parse(s);
		}
		rngTrace = 0;
		rngDraws = 0;
		impure = false;
		coTrace = false;
		Resolve(towerFall);
		ResolveNet(towerFall);
		netManager = resolveNetplayManager.Invoke(null, null);
		lobbyIsInit = Find("TF.EX.Domain.Ports.INetplayManager").GetMethod("IsInit");
		netLobby = true;
		netMode = true;
		netClock = System.Diagnostics.Stopwatch.StartNew();
		if (!patched) Patch(towerFall);
		PatchNet(towerFall);
		PatchLobby(towerFall);
		Reset();
		ResetNet();
		lobbyResultsSeen = lobbyNeutralSeen = false;
		active = true;
		Console.WriteLine($"[xlobby] cfg maxticks={maxTicks} origin={netInputOrigin} margin={netMargin} script_steps={scripts[0].Count}/{scripts[1].Count}");
		return "armed: logging the next lobby match";
	}

	private static void PatchLobby(Assembly towerFall)
	{
		if (lobbyPatched) return;
		lobbyPatched = true;
		const BindingFlags any = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static | BindingFlags.DeclaredOnly;
		var harmony = new Harmony("TowerFallBrowser.XplayLobby");
		Type self = typeof(XplayVersus);
		HarmonyMethod Hm(string name) => new HarmonyMethod(self.GetMethod(name, BindingFlags.NonPublic | BindingFlags.Static));
		Type manager = Find("TF.EX.Domain.Services.NetplayManager");
		harmony.Patch(manager.GetMethod("OnSessionEstablished", any), prefix: Hm(nameof(LobbyEstablishedPrefix)), postfix: Hm(nameof(LobbyEstablishedPostfix)));
		harmony.Patch(manager.GetMethod("Init", any), postfix: Hm(nameof(LobbyInitPostfix)));
		Type gate = Find("TF.EX.Domain.Context.VersusMatchResultsInputGate");
		harmony.Patch(gate.GetMethod("ShouldFeedNeutralInput", any), postfix: Hm(nameof(LobbyNeutralPostfix)));
		harmony.Patch(gate.GetMethod("IsVersusMatchResultsShown", any), postfix: Hm(nameof(LobbyResultsPostfix)));
		MethodInfo matchEnded = Find("TF.EX.Domain.Services.MatchmakingService")?.GetMethod("NotifyMatchEnded", any);
		if (matchEnded != null) harmony.Patch(matchEnded, prefix: Hm(nameof(LobbyMatchEndedPrefix)));
		MethodInfo reset = manager.GetMethod("Reset", any);
		harmony.Patch(reset, prefix: Hm(nameof(LobbyResetPrefix)));
	}

	private static void LobbyInitPostfix(object __instance)
	{
		if (!netLobby || !active) return;
		try
		{
			object config = __instance.GetType().GetProperty("GGRSConfig").GetValue(__instance);
			object netplay = config.GetType().GetProperty("Netplay").GetValue(config);
			object server = netplay.GetType().GetProperty("ServerConf").GetValue(netplay);
			string room = server?.GetType().GetProperty("RoomUrl").GetValue(server) as string ?? "";
			var players = ((IEnumerable)netplay.GetType().GetProperty("Players").GetValue(netplay)).Cast<string>().ToList();
			string local = (string)netplay.GetType().GetProperty("LocalPeerId").GetValue(netplay);
			netSeat = players.IndexOf(local);
			netEffDelay = (int)config.GetType().GetProperty("InputDelay").GetValue(config);
			LobbyLog($"session init: fps={config.GetType().GetProperty("Fps").GetValue(config)} input_delay={netEffDelay} max_input_delay={config.GetType().GetProperty("MaxInputDelay").GetValue(config)} players={players.Count} handle={netSeat} spectators={((ICollection)netplay.GetType().GetProperty("Spectators").GetValue(netplay)).Count} relay={room.Contains("/relay/")} room={System.Text.RegularExpressions.Regex.Replace(room, "[0-9a-f]{8}-[0-9a-f-]{27}", "<id>")}");
			object level = engineInstanceScene();
			object session = level == null ? null : levelSession.GetValue(level);
			LogMatchSettings(session);
		}
		catch (Exception e)
		{
			LobbyLog($"init log failed: {e.Message}");
		}
	}

	private static object engineInstanceScene()
	{
		object engine = engineType.GetProperty("Instance").GetValue(null);
		object scene = engineType.GetProperty("Scene").GetValue(engine);
		return scene != null && levelType.IsInstanceOfType(scene) ? scene : null;
	}

	private static void LogMatchSettings(object session)
	{
		if (session == null) return;
		object ms = session.GetType().GetField("MatchSettings").GetValue(session);
		Type mst = ms.GetType();
		object roundLogic = session.GetType().GetField("RoundLogic")?.GetValue(session) ?? session.GetType().GetProperty("RoundLogic")?.GetValue(session);
		LobbyLog($"match: Mode={mst.GetField("Mode").GetValue(ms)}({(int)mst.GetField("Mode").GetValue(ms)}) MatchLength={mst.GetField("MatchLength").GetValue(ms)}({(int)mst.GetField("MatchLength").GetValue(ms)}) GoalScore={mst.GetProperty("GoalScore").GetValue(ms)} PlayerAmount={towerFallType("TowerFall.TFGame").GetProperty("PlayerAmount").GetValue(null)} RandomLevelSeed={mst.GetField("RandomLevelSeed").GetValue(ms)} round_logic={roundLogic?.GetType().FullName} round={sessionRoundIndex.GetValue(session)} test_mode={Find("TF.EX.Domain.Context.ExFlags").GetField("IsTestMode").GetValue(null)}");
	}

	private static Type towerFallType(string name) => levelType.Assembly.GetType(name, true);

	private static void LobbyEstablishedPrefix()
	{
		if (!netLobby || !active) return;
		netStarted = true; // (inputs: the script from here on; T < 0 is neutral anyway)
		object level = engineInstanceScene();
		int players = level == null ? -1 : Enumerable.Range(0, 2).Count(i => getPlayer.Invoke(level, new object[] { i }) != null);
		LobbyLog($"session established (first synchronised frame): spawning the first round; players in the level before: {players}");
	}

	private static void LobbyEstablishedPostfix()
	{
		if (!netLobby || !active) return;
		object level = engineInstanceScene();
		int players = level == null ? -1 : Enumerable.Range(0, 2).Count(i => getPlayer.Invoke(level, new object[] { i }) != null);
		bool versusStart = false;
		if (level != null)
		{
			Type vs = towerFallType("TowerFall.VersusStart");
			MethodInfo get = level.GetType().GetMethod("Get", Type.EmptyTypes)?.MakeGenericMethod(vs);
			versusStart = get?.Invoke(level, null) != null;
		}
		LobbyLog($"first round spawned: players in the level={players} VersusStart={(versusStart ? "added" : "not found yet (added this frame)")} (this frame's Level.Update follows)");
		LogMatchSettings(level == null ? null : levelSession.GetValue(level));
	}

	private static void LobbyResultsPostfix(bool __result)
	{
		if (!netLobby || !active || !__result || lobbyResultsSeen) return;
		lobbyResultsSeen = true;
		LobbyLog("match results shown (VersusMatchResults in the level)");
	}

	private static void LobbyNeutralPostfix(bool __result)
	{
		if (!netLobby || !active || !__result || lobbyNeutralSeen) return;
		lobbyNeutralSeen = true;
		LobbyLog("local input fed to GGRS is neutral from here (results shown for more than 60 frames)");
	}

	private static void LobbyMatchEndedPrefix(int winnerSeat, IList<int> scores)
	{
		if (!netLobby || !active) return;
		LobbyLog($"sending MatchEnded winner_seat={winnerSeat} scores={string.Join(",", scores ?? new List<int>())}");
	}

	private static void LobbyResetPrefix()
	{
		if (!netLobby || !active) return;
		try
		{
			if (lobbyIsInit != null && netManager != null && (bool)lobbyIsInit.Invoke(netManager, null)) LobbyLog("GGRS session reset (relay socket closed)");
		}
		catch
		{
		}
	}
}
