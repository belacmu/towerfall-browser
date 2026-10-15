using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Reflection.Emit;
using System.Text;
using HarmonyLib;
using Microsoft.Xna.Framework;

namespace TowerFallBrowser;

// `xnet`: the lobby-free two-player peer-to-peer version of the Switch cross-play test (see XplayVersus.cs for xplay2, the
// sync-test version, and Towerfall Switch Mods/switch-online/BROWSER-RELAY.md for the full description).
//
//   xnet <roomUrl> <seat 0|1> <localPeerUuid> <remotePeerUuid> [script=<path or inline>] [seed=42] [maxticks=N] [fps=60]
//        [delay=D] [origin=266] [host=1] [hello=1] [synctimeout=120] [margin=24] [replay=off]
//
// roomUrl is a room URL in the sense of ggrs-ffi: a relay one (ws://localhost:PORT/relay/<room>, see netplay/tfnet.js; ?peer=<local>&remote=<remote>
// [&hello=1] is appended here) or a matchbox one (then it is a normal WebRTC match; the peers must be in one matchbox room).
// It runs the same match as TF.EX's `test lms 0 0 42 2 #NONE# 2` (same MatchSettings, level order, RNG), but over a real
// GGRS P2PSession (ggrs-ffi init_p2p) and TF.EX's own netplay frame driver, with this browser as seat <seat> and the remote peer as
// the other seat. The local seat's input comes from the script (same format and semantics as xplay2, see below), the remote seat's
// from GGRS (the packets). Log lines are the xplay2 ones ([xplay2] T/R/U/A, [xplay2pre], [xplay2setup]) plus [xnet] lines.
//
// What it does instead of the lobby (the paths bypassed are listed in BROWSER-RELAY.md):
//   NetplayManager.SetRoomAndServerMode(url, host) + GGRSConfig.Netplay.{Players,LocalPeerId,NumPlayers} + SetLocalSeat (what the lobby's
//   MapScene.StartSession patch and RollCallElement do) + TFCommands.StartGame(LastManStanding, map 0, startLevel 0, 2 players) (what the test
//   command runs) with the Session.StartGame call held back until the GGRS session is Running on both sides (what TF.EX's NetplayRoundLogic does
//   by leaving the level frozen until `IsSynchronized`), and ExFlags.IsTestMode forced true so the rules that test mode changes (PlayerGoals = 2,
//   RandomLevelSeed = seed, unlock neutralisation, ...) are the same as in the reference.
//
// Input timing. TF.EX asks for the local input once per GGRS frame (InputService.GetPolledInput, just before netplay_advance_frame) and GGRS
// applies it `D` frames later (input delay). The applied input of the AdvanceFrame whose Level.Update sees netplay_current_frame() == G (the
// number all log lines use) is script step T = G - origin (origin = 266, the measured GGRS frame of tick 0). So the input handed to GGRS when
// netplay_current_frame() == c is for G = c + D + 1: the script at T = c + D + 1 - origin, `pressed` flags = flag(T) && !flag(T-1). It is a pure function
// of the frame, so rollbacks and different delays on the two peers change nothing (a peer with D = 2 and one with D = 8 apply the same inputs at the same G).
//
// Logging. With rollbacks, the first time the game reaches frame G is usually with a *predicted* remote input; only the last simulation of G
// (after the confirming inputs arrived) is the real one. So every Level.Update's state is kept per G (a later simulation replaces it) and printed
// once G is `margin` (24) frames behind the newest one, which is past the prediction window (15 at 60 Hz): such a frame can't be rolled back any more.
public static partial class XplayVersus
{
	private const int NetNoOrigin = int.MinValue;
	private static bool netMode;
	private static bool netPending; // waiting for the GGRS session to synchronise before starting the game
	private static bool netStarted; // Session.StartGame has run
	private static int netSeat;
	private static int netInputOrigin = 266;
	private static int netDelay = -1; // delay= (frames), -1: TF.EX's own
	private static int netEffDelay; // GGRSConfig.InputDelay actually used
	private static int netMargin = 24;
	private static int netSyncTimeoutMs = 120000;
	private static object netSession;
	private static object netManager;
	private static Stopwatch netClock;
	private static Type netInputType, netVecType;
	private static MethodInfo netIsSynchronized, netPoll, netHasFailed, netNetworkStats, netFramesAhead, netIsDisconnected;
	private static FieldInfo netEventsField;
	private static int netRollbacks, netRollbackFrames, netRollbackMax;
	private static int netNextFlush = NetNoOrigin;
	private static int netOrigin = NetNoOrigin; // detected: the first G with a non-frozen archer at the start of the tick
	private static bool netStoppedLogging;
	private static readonly SortedDictionary<int, TickRec> netRecs = new();
	private static readonly List<(int g, string snap)> netPre = new();
	private static readonly bool[] netFrozenSeen = new bool[2];
	private static int netLastRound = -1;
	private static bool netLastEnding;
	private static int netLastArrowTick = int.MinValue;
	private static int netLastStatsTick = int.MinValue;
	private static TickRec netCur;
	private static long netLastUpdateMs = -1; // when the last Level.Update ran
	private static int netLastT = int.MinValue; // the last tick printed

	private class TickRec
	{
		public int G, Sims;
		public string Snap, ArrowSnap;
		public int[] Obs = { -1, -1 }; // per seat at the start of the tick: -1 no living Player, 0 not Frozen, 1 Frozen
		public int Round;
		public bool Ending;
		public string Scores, Quivers;
		public int ArrowCount;
		public ulong SumX, SumY;
		public uint TimeMult;
	}

	private static void NetLog(string text) => Console.WriteLine($"[xnet] t={netClock?.ElapsedMilliseconds ?? 0}ms {text}");

	public static string StartNet(Assembly towerFall, Game theGame, string[] words)
	{
		game = theGame;
		if (TfexFps.Fps != 60) return "needs the page opened with ?fortrise&tfexfps=60 (TF.EX's session at 60 ticks/s)";
		Type commands = Find("TF.EX.Core.TFCommands");
		if (commands == null) return "TF.EX isn't loaded (?mods=TF.EX)";
		if (words.Length < 5) return "usage: xnet <roomUrl> <seat 0|1> <localPeerUuid> <remotePeerUuid> [script=..] [seed=42] [maxticks=N] [fps=60] [delay=D] [origin=266] [host=1] [hello=1]";
		string roomUrl = words[1];
		if (!int.TryParse(words[2], out netSeat) || netSeat < 0 || netSeat > 1) return "seat must be 0 or 1";
		string local = words[3].ToLowerInvariant(), remote = words[4].ToLowerInvariant();
		if (!Guid.TryParse(local, out _) || !Guid.TryParse(remote, out _)) return "peer ids must be UUIDs";
		var options = words.Skip(5).Where(w => w.Contains('=')).Select(w => w.Split('=', 2)).ToDictionary(p => p[0], p => p[1]);
		int Opt(string key, int fallback) => options.TryGetValue(key, out string v) ? int.Parse(v, CultureInfo.InvariantCulture) : fallback;
		int seed = Opt("seed", 42);
		maxTicks = Opt("maxticks", 6000);
		netDelay = Opt("delay", -1);
		netInputOrigin = Opt("origin", 266);
		netMargin = Opt("margin", 24);
		netSyncTimeoutMs = Opt("synctimeout", 120) * 1000;
		if (Opt("fps", 60) != 60) return "fps must be 60 (the Switch's rate; the page needs tfexfps=60)";
		bool host = Opt("host", 0) == 1;
		bool replayOff = options.TryGetValue("replay", out string rp) && rp == "off";
		string scriptArg = options.TryGetValue("script", out string sc) ? sc : "-";
		if (scriptArg.Length > 0 && scriptArg != "-" && !scriptArg.Contains(':') && File.Exists(scriptArg)) scriptArg = File.ReadAllText(scriptArg).Trim();
		scripts[0] = new List<Step>();
		scripts[1] = new List<Step>();
		scripts[netSeat] = Parse(scriptArg);
		// The room URL: peer ids go in the query (the lobby does the same with ?peer=); relay rooms also need the other peer's id.
		string sep = roomUrl.Contains('?') ? "&" : "?";
		roomUrl += $"{sep}peer={local}&remote={remote}";
		if (Opt("hello", 0) == 1) roomUrl += "&hello=1";

		rngTrace = 0;
		rngDraws = 0;
		impure = false;
		coTrace = false;
		Resolve(towerFall);
		ResolveNet(towerFall);
		object manager = netManager = resolveNetplayManager.Invoke(null, null);
		Type managerIface = Find("TF.EX.Domain.Ports.INetplayManager");
		if ((bool)managerIface.GetMethod("HasSetMode").Invoke(manager, null)) return "TF.EX is already in a netplay mode (a match or a test is running)";
		netMode = true;
		netClock = Stopwatch.StartNew();
		if (!patched) Patch(towerFall);
		PatchNet(towerFall);
		Reset();
		ResetNet();
		active = true;
		if (replayOff)
		{
			object save = towerFall.GetType("TowerFall.SaveData", true).GetField("Instance").GetValue(null);
			object opts = save.GetType().GetField("Options").GetValue(save);
			FieldInfo mode = opts.GetType().GetField("ReplayMode");
			mode.SetValue(opts, Enum.Parse(mode.FieldType, "Off"));
		}

		// 1. The session configuration the lobby would have made.
		managerIface.GetMethod("SetRoomAndServerMode").Invoke(manager, new object[] { roomUrl, host });
		object config = manager.GetType().GetProperty("GGRSConfig").GetValue(manager);
		object netplay = config.GetType().GetProperty("Netplay").GetValue(config);
		var players = new List<string> { null, null };
		players[netSeat] = local;
		players[1 - netSeat] = remote;
		netplay.GetType().GetProperty("Players").SetValue(netplay, players);
		netplay.GetType().GetProperty("Spectators").SetValue(netplay, new List<string>());
		netplay.GetType().GetProperty("LocalPeerId").SetValue(netplay, local);
		managerIface.GetMethod("UpdateNumPlayers").Invoke(manager, new object[] { 2 });
		managerIface.GetMethod("SetLocalSeat").Invoke(manager, new object[] { netSeat });
		if (netDelay >= 0) managerIface.GetMethod("SetSessionInputDelay").Invoke(manager, new object[] { netDelay });
		// 2. What StartTestMode does besides starting a test session.
		object stateApi = Find("TF.EX.Domain.Interop.StateApi").GetProperty("Current").GetValue(null);
		stateApi.GetType().GetMethod("SetSeed").Invoke(stateApi, new object[] { seed });
		Type services = Find("TF.EX.Domain.ServiceCollections");
		object replayService = services.GetMethod("ResolveReplayService", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static).Invoke(null, null);
		replayService.GetType().GetMethod("Initialize").Invoke(replayService, new object[] { null, null });
		// The seats' PlayerInputs: KeyboardInput, as TF.EX's EnsureRemoteController creates them; TF.EX's KeyboardInput.GetState postfix replaces each state
		// with the GGRS input of the seat (a FakeController would return a neutral state outside test mode).
		Type tfGame = towerFall.GetType("TowerFall.TFGame", true);
		var playerInputs = (Array)tfGame.GetField("PlayerInputs").GetValue(null);
		Type keyboard = towerFall.GetType("TowerFall.KeyboardInput", true);
		for (int i = 0; i < 2; i++)
			if (playerInputs.GetValue(i) == null) playerInputs.SetValue(Activator.CreateInstance(keyboard), i);
		Console.WriteLine($"[xnet] cfg room={roomUrl.Replace(local, "<local>").Replace(remote, "<remote>")} seat={netSeat} seed={seed} maxticks={maxTicks} fps=60 delay={(netDelay >= 0 ? netDelay.ToString() : "TF.EX default")} origin={netInputOrigin} host={host} margin={netMargin} script_steps={scripts[netSeat].Count}");
		// 3. TF.EX's own start of a match (settings, level order, Session, NetplayManager.Init -> native init_p2p in a task); our Session.StartGame prefix
		// holds the Session back (netSession) until the GGRS session is synchronised.
		MethodInfo start = commands.GetMethod("StartGame", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
		Type modes = towerFall.GetType("TowerFall.Modes", true);
		object lms = Enum.Parse(modes, "LastManStanding");
		start.Invoke(null, new object[] { lms, manager, 0, 0, new List<string>(), 2, null });
		if (netSession == null) return "Session.StartGame wasn't reached";
		// Init asked for the first-round spawn to be done by NetplayManager.EstablishSessionIfSynchronized (the lobby flow); here the round logic spawns the
		// archers itself when the game starts, so that deferred spawn would duplicate them.
		manager.GetType().GetField("_pendingSessionRoundLogic", BindingFlags.NonPublic | BindingFlags.Instance).SetValue(manager, null);
		netEffDelay = (int)config.GetType().GetProperty("InputDelay").GetValue(config);
		netPending = true;
		NetLog($"waiting for the GGRS session to synchronise (input delay {netEffDelay} frames)");
		return $"TF.EX netplay session starting (lms, level 0, map 0, 2 players, seat {netSeat}, delay {netEffDelay})";
	}

	private static void ResolveNet(Assembly towerFall)
	{
		if (netInputType != null) return;
		const BindingFlags any = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static;
		netInputType = Find("TF.EX.Domain.Models.Input");
		netVecType = Find("TF.EX.Domain.Models.Vector2f");
		Type iface = Find("TF.EX.Domain.Ports.INetplayManager");
		netIsSynchronized = iface.GetMethod("IsSynchronized");
		netPoll = iface.GetMethod("Poll");
		netHasFailed = iface.GetMethod("HasFailedInitialConnection");
		netIsDisconnected = iface.GetMethod("IsDisconnected");
		Type ggrs = Find("TF.EX.Domain.Externals.GGRSFFI");
		netNetworkStats = ggrs.GetMethod("netplay_network_stats", any);
		netFramesAhead = ggrs.GetMethod("netplay_frames_ahead", any);
	}

	private static void ResetNet()
	{
		netStarted = false;
		netPending = false;
		netSession = null;
		netRollbacks = netRollbackFrames = netRollbackMax = 0;
		netNextFlush = NetNoOrigin;
		netOrigin = NetNoOrigin;
		netStoppedLogging = false;
		netRecs.Clear();
		netPre.Clear();
		netFrozenSeen[0] = netFrozenSeen[1] = false;
		netLastRound = -1;
		netLastEnding = false;
		netLastArrowTick = netLastStatsTick = int.MinValue;
		netCur = null;
		netLastUpdateMs = -1;
		netLastT = int.MinValue;
	}

	private static bool netPatched;

	private static void PatchNet(Assembly towerFall)
	{
		if (netPatched) return;
		netPatched = true;
		const BindingFlags any = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static | BindingFlags.DeclaredOnly;
		var harmony = new Harmony("TowerFallBrowser.XplayNet");
		Type self = typeof(XplayVersus);
		// Hold Session.StartGame back until the GGRS session is Running. Last, so that TF.EX's own prefixes of it have run; they run again at the real call.
		harmony.Patch(AccessTools.Method(towerFall.GetType("TowerFall.Session", true), "StartGame"),
			prefix: new HarmonyMethod(self.GetMethod(nameof(NetSessionStartGamePrefix), BindingFlags.NonPublic | BindingFlags.Static) ) { priority = Priority.Last });
		// The game loop hook that waits for synchronisation and then starts the match. First: TF.EX's TFGame.Update prefix replaces the original.
		harmony.Patch(AccessTools.Method(towerFall.GetType("TowerFall.TFGame", true), "Update"),
			prefix: new HarmonyMethod(self.GetMethod(nameof(NetWaitHook), BindingFlags.NonPublic | BindingFlags.Static)) { priority = Priority.First });
		// The local input handed to GGRS: the script instead of the keyboard.
		Type inputService = Find("TF.EX.Domain.Services.TF.InputService");
		harmony.Patch(inputService.GetMethod("GetPolledInput"), transpiler: new HarmonyMethod(self.GetMethod(nameof(PolledInputTranspiler), BindingFlags.NonPublic | BindingFlags.Static)));
		// Test-mode rules (PlayerGoals, RandomLevelSeed, unlock neutralisation, ...) read ExFlags.IsTestMode / StateFlags.IsTestMode, which TF.EX sets from the
		// netplay mode being Test and pushes in ExFlags.Push: keep it true.
		Type exFlags = Find("TF.EX.Domain.Context.ExFlags");
		harmony.Patch(exFlags.GetMethod("Push"), prefix: new HarmonyMethod(self.GetMethod(nameof(ExFlagsPushPrefix), BindingFlags.NonPublic | BindingFlags.Static)));
		// TF.EX's Level constructor patch drops the vanilla kill-cam recorder in test / replay / TF.EX-netplay-mode sessions (the lobby's mode is a custom
		// `Modes` value, ours is plain LastManStanding): without this, a rollback near a round's end leaves the recorder in a state its End() throws on
		// (NullReferenceException in Session.EndRound), and EndRound would run the kill-cam instead of going straight to the results.
		Type levelT = towerFall.GetType("TowerFall.Level", true);
		harmony.Patch(levelT.GetConstructor(new[] { towerFall.GetType("TowerFall.Session", true), typeof(System.Xml.XmlElement) }),
			postfix: new HarmonyMethod(self.GetMethod(nameof(NetLevelCtorPostfix), BindingFlags.NonPublic | BindingFlags.Static)));
		// Logging: GGRS events, rollbacks.
		Type manager = Find("TF.EX.Domain.Services.NetplayManager");
		netEventsField = manager.GetField("_events", any);
		harmony.Patch(manager.GetMethod("GetEventAndUpdate", any), postfix: new HarmonyMethod(self.GetMethod(nameof(NetEventsPostfix), BindingFlags.NonPublic | BindingFlags.Static)));
		harmony.Patch(manager.GetMethod("LoadGameState", any), postfix: new HarmonyMethod(self.GetMethod(nameof(NetLoadGameStatePostfix), BindingFlags.NonPublic | BindingFlags.Static)));
	}

	private static bool NetSessionStartGamePrefix(object __instance)
	{
		if (!netMode || netLobby || netStarted || !active) return true;
		if (netSession == null)
		{
			netSession = __instance;
			return false;
		}
		return true;
	}

	private static void NetLevelCtorPostfix(object __instance)
	{
		if (!netMode || netLobby || !active) return;
		Type t = __instance.GetType();
		const BindingFlags any = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance;
		PropertyInfo prop = t.GetProperty("ReplayRecorder", any);
		if (prop != null) prop.SetValue(__instance, null);
		else t.GetField("ReplayRecorder", any)?.SetValue(__instance, null);
	}

	private static void ExFlagsPushPrefix()
	{
		if (!netMode || netLobby) return;
		Find("TF.EX.Domain.Context.ExFlags").GetField("IsTestMode").SetValue(null, true);
	}

	// The game thread, once per TFGame.Update, before TF.EX's frame driver.
	private static void NetWaitHook()
	{
		if (netMode && netStarted && !netStoppedLogging && netLastUpdateMs >= 0 && netClock.ElapsedMilliseconds - netLastUpdateMs > 4000)
		{
			// No frame for 4 s: the match is over (the Level is gone) or the peers stalled. Nothing is simulated any more, so the records still held back
			// (the last 24 ticks) are as final as they will get.
			NetLog($"no frame for 4 s: printing the last {netRecs.Count} held ticks (rollbacks={netRollbacks} rolled-back frames={netRollbackFrames} max depth={netRollbackMax} Level.Update calls repeated={resimulated})");
			NetFlush(int.MaxValue);
			if (!netStoppedLogging)
			{
				netStoppedLogging = true;
				Console.WriteLine($"[xplay2] stopped logging after {netLastT} ticks (no more frames)");
			}
		}
		if (!netMode || !netPending) return;
		try
		{
			netPoll.Invoke(netManager, null); // (also drains GGRS events, which the log patch prints)
			if ((bool)netHasFailed.Invoke(netManager, null))
			{
				netPending = false;
				NetLog("FAILED: TF.EX reports the initial connection failed (no peer?)");
				return;
			}
			if ((bool)netIsSynchronized.Invoke(netManager, null))
			{
				netPending = false;
				netStarted = true;
				NetLog("GGRS session synchronised; starting the match (Session.StartGame)");
				netSession.GetType().GetMethod("StartGame").Invoke(netSession, null);
			}
			else if (netClock.ElapsedMilliseconds > netSyncTimeoutMs)
			{
				netPending = false;
				NetLog($"FAILED: not synchronised after {netSyncTimeoutMs / 1000} s");
			}
		}
		catch (Exception e)
		{
			netPending = false;
			NetLog($"FAILED: {e}");
		}
	}

	// GetPolledInput() { if (<ours returns non-null>) return it; <original> }
	private static IEnumerable<CodeInstruction> PolledInputTranspiler(IEnumerable<CodeInstruction> code, MethodBase original, ILGenerator il)
	{
		Type inputType = ((MethodInfo)original).ReturnType;
		Label orig = il.DefineLabel();
		yield return new CodeInstruction(OpCodes.Call, AccessTools.Method(typeof(XplayVersus), nameof(NetPolledInput)));
		yield return new CodeInstruction(OpCodes.Dup);
		yield return new CodeInstruction(OpCodes.Brfalse, orig);
		yield return new CodeInstruction(OpCodes.Unbox_Any, inputType);
		yield return new CodeInstruction(OpCodes.Ret);
		var pop = new CodeInstruction(OpCodes.Pop);
		pop.labels.Add(orig);
		yield return pop;
		foreach (CodeInstruction i in code) yield return i;
	}

	private static int netPolledCalls;

	// The local seat's input for the GGRS frame this call feeds (see the header): a boxed TF.EX Input, or null (not ours to answer).
	private static object NetPolledInput()
	{
		if (!netMode || !netStarted) return null;
		netPolledCalls++;
		int c = (int)netplayCurrentFrame.Invoke(null, null);
		int t = c + netEffDelay + 1 - netInputOrigin;
		object input = Activator.CreateInstance(netInputType);
		List<Step> steps = scripts[netSeat];
		Step? cur = StepAt(steps, t), prev = StepAt(steps, t - 1);
		if (cur is not Step s) return input;
		int pf = prev?.Flags ?? 0;
		bool jump = (s.Flags & 1) != 0, shoot = (s.Flags & 2) != 0, dodge = (s.Flags & 4) != 0, alt = (s.Flags & 8) != 0;
		bool pjump = (pf & 1) != 0, pshoot = (pf & 2) != 0, pdodge = (pf & 4) != 0, palt = (pf & 8) != 0;
		float ax = s.MoveX, ay = s.MoveY;
		if (s.MoveX != 0 && s.MoveY != 0)
		{
			ax *= 0.70710677f;
			ay *= 0.70710677f;
		}
		void Set(string name, object value) => netInputType.GetProperty(name).SetValue(input, value);
		int B(bool b) => b ? 1 : 0;
		Set("jump_check", B(jump));
		Set("jump_pressed", B(jump && !pjump));
		Set("shoot_check", B(shoot));
		Set("shoot_pressed", B(shoot && !pshoot));
		Set("alt_shoot_check", B(alt));
		Set("alt_shoot_pressed", B(alt && !palt));
		Set("dodge_check", B(dodge));
		Set("dodge_pressed", B(dodge && !pdodge));
		Set("arrow_pressed", B((s.Flags & 0x10) != 0));
		Set("move_x", s.MoveX);
		Set("move_y", s.MoveY);
		object vec = Activator.CreateInstance(netVecType);
		netVecType.GetProperty("X").SetValue(vec, ax);
		netVecType.GetProperty("Y").SetValue(vec, ay);
		Set("aim_axis", vec);
		return input;
	}

	private static void NetEventsPostfix(object __instance)
	{
		if (!netMode || !active) return;
		var events = (System.Collections.IEnumerable)netEventsField.GetValue(__instance);
		if (events == null) return;
		foreach (object e in events.Cast<object>().ToList()) NetLog($"G={frame} event: {e}");
	}

	private static void NetLoadGameStatePostfix()
	{
		if (!netMode || !active) return;
		int to = (int)netplayCurrentFrame.Invoke(null, null);
		int depth = Math.Max(0, maxFrame - to);
		netRollbacks++;
		netRollbackFrames += depth;
		if (depth > netRollbackMax) netRollbackMax = depth;
		if (netRollbacks <= 5) NetLog($"rollback #{netRollbacks}: from frame {maxFrame} back to {to} ({depth} frames)");
	}

	// ---- per-tick records (Level.Update prefix / postfix, net mode) ----

	private static void NetLevelPrefix(object level)
	{
		frame = CurrentFrame();
		firstPass = frame > maxFrame;
		netCur = null;
		if (frame < 0) return;
		if (!firstPass) resimulated++;
		else maxFrame = frame;
		var rec = new TickRec { G = frame, Snap = Snapshot(level), ArrowSnap = ArrowSnapshot(level) };
		for (int i = 0; i < 2; i++)
		{
			object p = getPlayer.Invoke(level, new object[] { i });
			rec.Obs[i] = p == null || (bool)playerDead.GetValue(p) ? -1 : (int)playerState.GetValue(p) == 5 ? 1 : 0; // PlayerStates.Frozen
		}
		netCur = rec;
	}

	private static void NetLevelPostfix(object level)
	{
		TickRec rec = netCur;
		netCur = null;
		if (rec == null) return;
		object session = levelSession.GetValue(level);
		rec.Round = (int)sessionRoundIndex.GetValue(session);
		rec.Ending = (bool)levelType.GetField("Ending").GetValue(level);
		var arrows = (System.Collections.IList)itemByTag.GetValue(level, new[] { arrowTag });
		ulong sx = 0, sy = 0;
		foreach (object a in arrows)
		{
			var pos = (Vector2)position.GetValue(a);
			sx += Bits(pos.X);
			sy += Bits(pos.Y);
		}
		rec.ArrowCount = arrows.Count;
		rec.SumX = sx;
		rec.SumY = sy;
		rec.Quivers = string.Join(",", Enumerable.Range(0, 2).Select(i =>
		{
			object p = getPlayer.Invoke(level, new object[] { i });
			return p == null ? "-" : arrowListCount.GetValue(playerArrows.GetValue(p)).ToString();
		}));
		rec.Scores = string.Join(",", (int[])session.GetType().GetField("Scores").GetValue(session));
		rec.TimeMult = Bits((float)timeMult.GetValue(null));
		netLastUpdateMs = netClock.ElapsedMilliseconds;
		if (netRecs.TryGetValue(rec.G, out TickRec old)) rec.Sims = old.Sims + 1;
		netRecs[rec.G] = rec;
		NetFlush(rec.G - netMargin);
	}

	// Prints, in order, every record with G <= limit (not simulated again from now on).
	private static void NetFlush(int limit)
	{
		while (netRecs.Count > 0)
		{
			int g = netRecs.Keys.First();
			if (g > limit) return;
			TickRec rec = netRecs[g];
			netRecs.Remove(g);
			NetEmit(rec);
		}
	}

	private static void NetEmit(TickRec rec)
	{
		if (netStoppedLogging) return;
		if (netOrigin == NetNoOrigin)
		{
			if (rec.Obs[0] != 0 && rec.Obs[1] != 0)
			{
				for (int s = 0; s < 2; s++) if (rec.Obs[s] == 1) netFrozenSeen[s] = true;
				netPre.Add((rec.G, rec.Snap));
				if (netPre.Count > 400) netPre.RemoveAt(0);
				return;
			}
			netOrigin = rec.G;
			Console.WriteLine($"[xplay2] cfg target_elapsed_ticks={game.TargetElapsedTime.Ticks} one_frame_delay={oneFrameDelay.GetValue(null)} first_ggrs_frame={(netPre.Count > 0 ? netPre[0].g : rec.G)}");
			foreach (var (pf, text) in netPre) Console.WriteLine($"[xplay2pre] T {pf - netOrigin} {text}");
			netPre.Clear();
			Console.WriteLine($"[xplay2] origin ggrs_frame={netOrigin}");
			if (netOrigin != netInputOrigin)
				NetLog($"WARNING: tick 0 is at GGRS frame {netOrigin}, not origin={netInputOrigin}: the scripted inputs are shifted by {netOrigin - netInputOrigin} ticks (use origin={netOrigin})");
		}
		int t = rec.G - netOrigin;
		if (t > maxTicks)
		{
			netStoppedLogging = true;
			NetLog($"stopped logging after {maxTicks} ticks (rollbacks={netRollbacks} rolled-back frames={netRollbackFrames} max depth={netRollbackMax} Level.Update calls repeated={resimulated})");
			Console.WriteLine($"[xplay2] stopped logging after {maxTicks} ticks");
			return;
		}
		netLastT = t;
		Console.WriteLine($"[xplay2] T {t} {rec.Snap}");
		Console.WriteLine($"[xplay2] R {t} {rec.ArrowSnap}");
		for (int s = 0; s < 2; s++)
		{
			if (rec.Obs[s] == 1) netFrozenSeen[s] = true;
			else if (rec.Obs[s] == 0 && netFrozenSeen[s])
			{
				netFrozenSeen[s] = false;
				Console.WriteLine($"[xplay2] U {t} seat={s} round={rec.Round}");
			}
		}
		bool log = false;
		string why = "";
		if (rec.Round != netLastRound)
		{
			netLastRound = rec.Round;
			log = true;
			why = "round_start";
		}
		else if (rec.Ending && !netLastEnding)
		{
			log = true;
			why = "round_ending";
		}
		netLastEnding = rec.Ending;
		if (t % 300 == 0 && t != netLastArrowTick) log = true;
		if (log)
		{
			netLastArrowTick = t;
			Console.WriteLine($"[xplay2] A {t} round={rec.Round}{(why != "" ? " " + why : "")} scores={rec.Scores} arrows={rec.ArrowCount} sumx={rec.SumX:x16} sumy={rec.SumY:x16} quivers={rec.Quivers} timemult={rec.TimeMult:x8} resim={resimulated}");
		}
		if (t % 300 == 0 && t != netLastStatsTick)
		{
			netLastStatsTick = t;
			NetStats(t);
		}
	}

	private static void NetStats(int t)
	{
		try
		{
			var args = new object[] { -1, null };
			netNetworkStats.Invoke(null, args);
			object st = args[1];
			Type stt = st.GetType();
			int ahead = (int)netFramesAhead.Invoke(null, null);
			NetLog($"stats T={t} ping={stt.GetField("ping").GetValue(st)}ms send_queue={stt.GetField("send_queue_len").GetValue(st)} local_frames_behind={stt.GetField("local_frames_behind").GetValue(st)} remote_frames_behind={stt.GetField("remote_frames_behind").GetValue(st)} frames_ahead={ahead} rollbacks={netRollbacks} rolled_back_frames={netRollbackFrames} max_depth={netRollbackMax} repeated_updates={resimulated} current_G={maxFrame}");
		}
		catch (Exception e)
		{
			NetLog($"stats unavailable: {e.GetType().Name} {e.Message}");
		}
	}
}
