using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Reflection;
using System.Reflection.Emit;
using System.Text;
using HarmonyLib;
using Microsoft.Xna.Framework;

namespace TowerFallBrowser;

// The browser half of the Switch cross-play determinism test, two-player version (Towerfall Switch
// Mods/switch-online, TEST5-MATCH-SETUP.md): TF.EX's own sync-test session ("test lms 0 0 42 2 #NONE# 2",
// run at 60 ticks/s, see TfexFps.cs) with both archers driven by scripts, and one log line per tick.
//
// "xplay2 <script0> <script1> [seed=42] [maxticks=6000] [rngtrace=N] [impure=1] [replay=off] [cd=N] [cotrace=1]" host command (needs ?fortrise&tfexfps=60 and TF.EX).
// It installs the patches below, then runs TF.EX's `test` command exactly as the dev console would
// (TF.EX.Core.TFCommands.LaunchTestMode); rngtrace=N also logs who made each of the first N draws of the
// gameplay RNG (the call stack), to line the Switch's draw order up with it; impure=1 is a negative control that
// indexes the script by call count instead of tick (the sync test must then report a desync); replay=off sets the
// cd=N sets the GGRS SyncTest check distance (default 2; 0 = no rollbacks at all; with replay=off a plain forward run);
// cotrace=1 logs [xplay2co] lines (every VersusStart Coroutine.Update, each Level.Update, each Engine.Scene change);
// game's Replay option to off for this run (TF.EX's instant replay is on by default and runs between rounds). Script: frame:flags:moveX:moveY steps joined by commas, each held
// until the next; flags 1 jump, 2 shoot, 4 dodge, 8 alt shoot, 0x10 arrows (hex). "-" is "no input".
//
// Ticks. TF.EX drives the game itself: every tick is one GGRS AdvanceFrame request (netplay_current_frame()
// is its number) and the sync test rolls back and resimulates the last 2 ticks after each one, so one
// Level.Update call is not one tick. Everything here is therefore a function of the GGRS frame number, never
// of a call counter:
//  - tick 0 is the first tick (GGRS frame F0) in which a Player.Update reaches the line after
//    `input = PlayerInputs[i].GetState()` with the player's State != Frozen, i.e. the first tick the
//    archer can respond to input (players spawn Frozen and VersusStart's intro calls Session.StartRound ->
//    Player.Unfreeze). T = GGRS frame - F0, continuing across rounds (the netplay frame counter only
//    advances in Level scenes, so loading screens between rounds add nothing).
//  - Input. Under TF.EX the result of every PlayerInput.GetState() is already replaced by the netplay input
//    array's entry for the seat (KeyboardInput/XGamepadInput/FakeController GetState postfixes: GetCurrentInput
//    -> RightStickShot.Apply). The script replaces that at the call site in Player.Update, as the earlier
//    single-player harness did, so it wins over whatever GGRS delivered and is a pure function of T:
//    cur = step(T), prev = step(T-1) (none before tick 0), pressed = check && !prevCheck. A pure function
//    of the tick is what makes it rollback-safe (a call counter would drift on resimulated ticks).
//    Input before tick 0 is not touched (the game's own, i.e. neutral).
//  - Log: once per tick, only the first time the game reaches that GGRS frame (a high-water mark: ticks the
//    sync test resimulates are at or below it). The line holds the state at the START of the tick (read in a
//    Level.Update prefix, printed in its postfix once tick 0 is known), like the Switch's per-frame log.
public static class XplayVersus
{
	private struct Step
	{
		public int Frame, Flags, MoveX, MoveY;
	}

	private const int NoOrigin = int.MinValue;
	private static readonly List<Step>[] scripts = { new(), new() };
	private static int maxTicks = 6000;
	private static int rngTrace; // log the callers of the first N gameplay RNG draws
	private static int rngDraws;
	private static bool coTrace; // cotrace=1: log every Coroutine.Update of a VersusStart (and each Level.Update / scene change near a round change)
	private static bool impure; // negative control: script index = calls so far, not the tick
	private static readonly int[] impureCalls = new int[2];
	private static bool patched;
	private static Game game;
	private static bool active;

	// Per run state.
	private static int origin = NoOrigin; // GGRS frame of tick 0
	private static int maxFrame = -1; // highest GGRS frame seen
	private static bool firstPass; // this Level.Update is the first time the game reaches `frame`
	private static int frame = -1;
	private static string pendingLine;
	private static string pendingArrowLine; // "arrows=... q0=... q1=... list=..." read at the same point as pendingLine
	private static readonly List<(int frame, string text)> pre = new();
	private static bool cfgLogged;
	private static int lastRound = -1;
	private static bool lastEnding;
	private static int lastArrowTick = int.MinValue;
	private static readonly bool[] frozenSeen = new bool[2]; // seat was Frozen the last first-pass tick we saw its Player.Update
	private static readonly List<(int frame, int seat)> unfreezes = new(); // first non-Frozen Player.Update of a seat's round, printed with the tick
	private static int resimulated; // Level.Update calls on ticks the game had already reached (the sync test's rollbacks)

	// Reflection.
	private static Type playerType, levelType, inputStateType, engineType;
	private static FieldInfo position, speed;
	private static PropertyInfo playerIndex, playerState, playerDead, levelSession, sessionRoundIndex, itemByTag;
	private static MethodInfo getPlayer, netplayCurrentFrame, resolveNetplayManager, isTestMode, isInit, resolveRngService, gameplayGetter;
	private static PropertyInfo timeMult;
	private static object arrowTag;
	private static FieldInfo oneFrameDelay;
	private static PropertyInfo playerArrows;
	private static PropertyInfo arrowListCount;

	public static string Start(Assembly towerFall, Game theGame, string[] words)
	{
		game = theGame;
		if (TfexFps.Fps != 60) return "needs the page opened with ?fortrise&tfexfps=60 (TF.EX's session at 60 ticks/s)";
		Type commands = Find("TF.EX.Core.TFCommands");
		if (commands == null) return "TF.EX isn't loaded (?mods=TF.EX)";
		for (int i = 0; i < 2; i++) scripts[i] = Parse(words.Length > 1 + i ? words[1 + i] : "-");
		// words: xplay2 s0 s1 [seed] [maxticks] then key=value options.
		string[] positional = words.Skip(3).Where(w => !w.Contains('=')).ToArray();
		var options = words.Skip(3).Where(w => w.Contains('=')).Select(w => w.Split('=', 2)).ToDictionary(p => p[0], p => p[1]);
		int seed = positional.Length > 0 ? int.Parse(positional[0], CultureInfo.InvariantCulture) : 42;
		maxTicks = positional.Length > 1 ? int.Parse(positional[1], CultureInfo.InvariantCulture) : 6000;
		rngTrace = options.TryGetValue("rngtrace", out string rt) ? int.Parse(rt, CultureInfo.InvariantCulture) : 0;
		rngDraws = 0;
		impure = options.TryGetValue("impure", out string im) && im == "1";
		impureCalls[0] = impureCalls[1] = 0;
		coTrace = options.TryGetValue("cotrace", out string ct) && ct == "1";
		bool replayOff = options.TryGetValue("replay", out string rp) && rp == "off";
		// cd=N: GGRS SyncTest check distance (LaunchTestMode's 5th argument; TF.EX clamps it to <= 7). Default 2.
		int checkDistance = options.TryGetValue("cd", out string cdText) ? int.Parse(cdText, CultureInfo.InvariantCulture) : 2;
		Resolve(towerFall);
		if (!patched) Patch(towerFall);
		Reset();
		active = true;
		if (replayOff)
		{
			// Options.ReplayMode = Off (TF.EX's UseInstantReplay is "ReplayMode != Off"); in memory only, not saved.
			object save = towerFall.GetType("TowerFall.SaveData", true).GetField("Instance").GetValue(null);
			object opts = save.GetType().GetField("Options").GetValue(save);
			FieldInfo mode = opts.GetType().GetField("ReplayMode");
			mode.SetValue(opts, Enum.Parse(mode.FieldType, "Off"));
		}
		Console.WriteLine($"[xplay2] cfg scripts={scripts[0].Count}/{scripts[1].Count} steps seed={seed} maxticks={maxTicks} fps=60 replay={(replayOff ? "off" : "as saved")} cd={checkDistance} impure={impure} rngtrace={rngTrace}");
		// TF.EX's own `test lms 0 0 42 2 #NONE# 2`: mode, start level, map (the arguments' order differs from
		// the spec text: LaunchTestMode reads them as mode, startLevel, map, seed, checkDistance, variants, players).
		MethodInfo launch = commands.GetMethod("LaunchTestMode", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
		launch.Invoke(null, new object[] { new[] { "lms", "0", "0", seed.ToString(CultureInfo.InvariantCulture), checkDistance.ToString(CultureInfo.InvariantCulture), "#NONE#", "2" } });
		return $"TF.EX test session started (lms, level 0, map 0, 2 players, check distance {checkDistance})";
	}

	private static void Reset()
	{
		origin = NoOrigin;
		maxFrame = -1;
		firstPass = false;
		frame = -1;
		pendingLine = null;
		pre.Clear();
		cfgLogged = false;
		lastRound = -1;
		lastEnding = false;
		lastArrowTick = int.MinValue;
		resimulated = 0;
		frozenSeen[0] = frozenSeen[1] = false;
		unfreezes.Clear();
	}

	private static List<Step> Parse(string script)
	{
		if (script == "-" || script.Length == 0) return new List<Step>();
		return script.Split(',', StringSplitOptions.RemoveEmptyEntries).Select(s =>
		{
			string[] p = s.Split(':');
			return new Step
			{
				Frame = int.Parse(p[0], CultureInfo.InvariantCulture),
				Flags = int.Parse(p[1], NumberStyles.HexNumber, CultureInfo.InvariantCulture),
				MoveX = int.Parse(p[2], CultureInfo.InvariantCulture),
				MoveY = int.Parse(p[3], CultureInfo.InvariantCulture),
			};
		}).OrderBy(s => s.Frame).ToList();
	}

	private static Type Find(string name) =>
		AppDomain.CurrentDomain.GetAssemblies().Select(a => a.GetType(name)).FirstOrDefault(t => t != null);

	private static void Resolve(Assembly towerFall)
	{
		if (playerType != null) return;
		const BindingFlags any = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static;
		playerType = towerFall.GetType("TowerFall.Player", true);
		levelType = towerFall.GetType("TowerFall.Level", true);
		engineType = towerFall.GetType("Monocle.Engine", true);
		inputStateType = towerFall.GetType("TowerFall.InputState", true);
		Type entity = towerFall.GetType("Monocle.Entity", true);
		position = entity.GetField("Position");
		speed = playerType.GetField("Speed");
		playerIndex = playerType.GetProperty("PlayerIndex");
		playerState = playerType.GetProperty("State");
		playerDead = playerType.GetProperty("Dead");
		playerArrows = playerType.GetProperty("Arrows");
		arrowListCount = playerArrows.PropertyType.GetProperty("Count");
		levelSession = levelType.GetProperty("Session");
		getPlayer = levelType.GetMethod("GetPlayer");
		Type session = towerFall.GetType("TowerFall.Session", true);
		sessionRoundIndex = session.GetProperty("RoundIndex");
		Type gameTags = towerFall.GetType("Monocle.GameTags", true);
		arrowTag = Enum.Parse(gameTags, "Arrow");
		itemByTag = towerFall.GetType("Monocle.Scene", true).GetProperty("Item", new[] { gameTags });
		timeMult = engineType.GetProperty("TimeMult");
		oneFrameDelay = towerFall.GetType("Monocle.Coroutine", true).GetField("OneFrameDelay");
		Type ggrs = Find("TF.EX.Domain.Externals.GGRSFFI");
		netplayCurrentFrame = ggrs.GetMethod("netplay_current_frame", any);
		Type services = Find("TF.EX.Domain.ServiceCollections");
		resolveNetplayManager = services.GetMethod("ResolveNetplayManager", any);
		Type manager = Find("TF.EX.Domain.Ports.INetplayManager");
		isTestMode = manager.GetMethod("IsTestMode");
		isInit = manager.GetMethod("IsInit");
		Type stateServices = Find("TF.State.Domain.ServiceCollections");
		resolveRngService = stateServices.GetMethod("ResolveRngService", any);
		gameplayGetter = Find("TF.State.Domain.Ports.IRngService").GetProperty("Gameplay").GetMethod;
	}

	private static void Patch(Assembly towerFall)
	{
		patched = true;
		var harmony = new Harmony("TowerFallBrowser.XplayVersus");
		harmony.Patch(AccessTools.Method(playerType, "Update"), transpiler: new HarmonyMethod(typeof(XplayVersus), nameof(ScriptedInput)));
		// Setup trace: the match settings, and the gameplay RNG at the checkpoints of the start of a round.
		Type sessionType = towerFall.GetType("TowerFall.Session", true);
		harmony.Patch(AccessTools.Method(sessionType, "StartGame"), postfix: new HarmonyMethod(typeof(XplayVersus), nameof(SessionStartGamePostfix)));
		foreach (string name in new[] { "LevelLoadStart", "OnLevelLoadFinish", "StartRound", "GotoNextRound" })
			harmony.Patch(AccessTools.Method(sessionType, name), postfix: new HarmonyMethod(typeof(XplayVersus), nameof(SessionPostfix)));
		harmony.Patch(AccessTools.Method(towerFall.GetType("Monocle.Coroutine", true), "Update"), prefix: new HarmonyMethod(typeof(XplayVersus), nameof(CoroutineUpdateTrace)));
		harmony.Patch(AccessTools.PropertySetter(towerFall.GetType("Monocle.Engine", true), "Scene"), prefix: new HarmonyMethod(typeof(XplayVersus), nameof(SceneSetTrace)));
		Type rnd = Find("TF.State.Domain.Randomness.DeterministicRandom");
		harmony.Patch(rnd.GetMethod("NextULong"), prefix: new HarmonyMethod(typeof(XplayVersus), nameof(RngDrawPrefix)));
		harmony.Patch(AccessTools.Method(levelType, "Update"),
			prefix: new HarmonyMethod(typeof(XplayVersus), nameof(LevelUpdatePrefix)),
			postfix: new HarmonyMethod(typeof(XplayVersus), nameof(LevelUpdatePostfix)));
	}

	// Player.Update: `PlayerInputs[i].GetState()` -> Override(GetState(), this).
	private static IEnumerable<CodeInstruction> ScriptedInput(IEnumerable<CodeInstruction> code)
	{
		foreach (CodeInstruction i in code)
		{
			yield return i;
			if (i.opcode == OpCodes.Callvirt && i.operand is MethodInfo m && m.Name == "GetState" && m.ReturnType == inputStateType)
			{
				yield return new CodeInstruction(OpCodes.Box, inputStateType);
				yield return new CodeInstruction(OpCodes.Ldarg_0);
				yield return new CodeInstruction(OpCodes.Call, AccessTools.Method(typeof(XplayVersus), nameof(Override)));
				yield return new CodeInstruction(OpCodes.Unbox_Any, inputStateType);
			}
		}
	}

	private static uint Bits(float f) => BitConverter.SingleToUInt32Bits(f);

	private static int CurrentFrame()
	{
		try
		{
			object manager = resolveNetplayManager.Invoke(null, null);
			if (!(bool)isTestMode.Invoke(manager, null) || !(bool)isInit.Invoke(manager, null)) return -1;
			return (int)netplayCurrentFrame.Invoke(null, null);
		}
		catch
		{
			return -1;
		}
	}

	// cotrace=1 only (read-only reflection, no game state touched). A line per Coroutine.Update of a VersusStart:
	// the GGRS frame, the round, the coroutine's enumerator stack depth, its `delay` and its waitTimer counter before the update.
	private static void CoroutineUpdateTrace(object __instance)
	{
		if (!active || !coTrace) return;
		object entity = __instance.GetType().GetProperty("Entity")?.GetValue(__instance);
		if (entity == null || entity.GetType().Name != "VersusStart") return;
		const BindingFlags priv = BindingFlags.NonPublic | BindingFlags.Instance;
		var stack = (System.Collections.ICollection)__instance.GetType().GetField("enumerators", priv).GetValue(__instance);
		object wt = __instance.GetType().GetField("waitTimer", priv).GetValue(__instance);
		float counter = (float)wt.GetType().GetField("counter", priv).GetValue(wt);
		float delay = (float)__instance.GetType().GetField("delay", priv).GetValue(__instance);
		object round = sessionRoundIndex.GetValue(entity.GetType().GetField("session", priv).GetValue(entity));
		Console.WriteLine($"[xplay2co] VS frame={CurrentFrame()} round={round} depth={stack.Count} wait={counter.ToString("R", CultureInfo.InvariantCulture)} delay={delay.ToString("R", CultureInfo.InvariantCulture)} timemult={Bits((float)timeMult.GetValue(null)):x8}");
	}

	private static void SceneSetTrace(object value)
	{
		if (!active || !coTrace) return;
		Console.WriteLine($"[xplay2co] Engine.Scene = {value?.GetType().Name ?? "null"} frame={CurrentFrame()}");
	}

	private static void LevelUpdatePrefix(object __instance)
	{
		if (!active) return;
		if (coTrace) Console.WriteLine($"[xplay2co] Level.Update frame={CurrentFrame()} level={System.Runtime.CompilerServices.RuntimeHelpers.GetHashCode(__instance):x} round={sessionRoundIndex.GetValue(levelSession.GetValue(__instance))} firstpass={frame > maxFrame}");
		frame = CurrentFrame();
		firstPass = frame > maxFrame;
		pendingLine = null;
		if (frame >= 0 && !firstPass) resimulated++;
		if (frame < 0 || !firstPass) return;
		maxFrame = frame;
		pendingLine = Snapshot(__instance);
		pendingArrowLine = ArrowSnapshot(__instance);
	}

	private static void LevelUpdatePostfix(object __instance)
	{
		if (active && coTrace) Console.WriteLine($"[xplay2co] Level.Update done level={System.Runtime.CompilerServices.RuntimeHelpers.GetHashCode(__instance):x} pending={(pendingLine != null)}");
		if (!active || pendingLine == null) return;
		int f = frame;
		string line = pendingLine;
		string arrowLine = pendingArrowLine;
		pendingLine = null;
		pendingArrowLine = null;
		if (!cfgLogged)
		{
			cfgLogged = true;
			Console.WriteLine($"[xplay2] cfg target_elapsed_ticks={game.TargetElapsedTime.Ticks} one_frame_delay={oneFrameDelay.GetValue(null)} first_ggrs_frame={f} level_load_seed={levelType.GetField("LoadSeed").GetValue(__instance)}");
		}
		if (origin == NoOrigin)
		{
			pre.Add((f, line));
			if (pre.Count > 400) pre.RemoveAt(0);
			return;
		}
		if (pre.Count > 0)
		{
			foreach (var (pf, text) in pre) Console.WriteLine($"[xplay2pre] T {pf - origin} {text}");
			pre.Clear();
			Console.WriteLine($"[xplay2] origin ggrs_frame={origin}");
		}
		int t = f - origin;
		if (t > maxTicks)
		{
			if (t == maxTicks + 1) Console.WriteLine($"[xplay2] stopped logging after {maxTicks} ticks");
			return;
		}
		Console.WriteLine($"[xplay2] T {t} {line}");
		Console.WriteLine($"[xplay2] R {t} {arrowLine}");
		foreach (var (uf, seat) in unfreezes)
			Console.WriteLine($"[xplay2] U {uf - origin} seat={seat} round={sessionRoundIndex.GetValue(levelSession.GetValue(__instance))}");
		unfreezes.Clear();
		MaybeLogRoundAndArrows(__instance, t);
	}

	// The state at the start of this tick, as one log line (after "T <tick> ").
	private static string Snapshot(object level)
	{
		var sb = new StringBuilder(160);
		sb.Append("rng=").Append(RngFold().ToString("x16"));
		for (int i = 0; i < 2; i++)
		{
			object p = getPlayer.Invoke(level, new object[] { i });
			bool alive = p != null && !(bool)playerDead.GetValue(p);
			Vector2 pos = alive ? (Vector2)position.GetValue(p) : Vector2.Zero;
			Vector2 spd = alive ? (Vector2)speed.GetValue(p) : Vector2.Zero;
			sb.Append(" p").Append(i).Append(' ')
				.Append(Bits(pos.X).ToString("x8")).Append(' ').Append(Bits(pos.Y).ToString("x8")).Append(' ')
				.Append(Bits(spd.X).ToString("x8")).Append(' ').Append(Bits(spd.Y).ToString("x8"))
				.Append(" alive=").Append(alive ? 1 : 0);
		}
		return sb.ToString();
	}

	// Per-tick arrow dump, read in the Level.Update prefix like Snapshot: the same live Arrow entity set as the A lines
	// (level[GameTags.Arrow]), each archer's quiver (Player.Arrows.Count, '-' without a Player entity), and every arrow as
	// <Position.X bits>:<Position.Y bits>:t<ArrowType>:s<State> (8 hex each, types/states as ints), sorted ascending by (x,y) bits.
	private static string ArrowSnapshot(object level)
	{
		var arrows = (System.Collections.IList)itemByTag.GetValue(level, new[] { arrowTag });
		var items = new List<(uint x, uint y, string extra)>(arrows.Count);
		foreach (object a in arrows)
		{
			var pos = (Vector2)position.GetValue(a);
			items.Add((Bits(pos.X), Bits(pos.Y), ":t" + ArrowEnum(a, "ArrowType") + ":s" + ArrowEnum(a, "State")));
		}
		items.Sort((a, b) => a.x != b.x ? a.x.CompareTo(b.x) : a.y.CompareTo(b.y));
		var sb = new StringBuilder(64);
		sb.Append("arrows=").Append(arrows.Count);
		for (int i = 0; i < 2; i++)
		{
			object p = getPlayer.Invoke(level, new object[] { i });
			sb.Append(" q").Append(i).Append('=').Append(p == null ? "-" : arrowListCount.GetValue(playerArrows.GetValue(p)).ToString());
		}
		sb.Append(" list=").Append(string.Join(";", items.Select(it => it.x.ToString("x8") + ":" + it.y.ToString("x8") + it.extra)));
		return sb.ToString();
	}

	private static string ArrowEnum(object arrow, string name)
	{
		const BindingFlags all = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.FlattenHierarchy;
		try
		{
			Type t = arrow.GetType();
			object v = t.GetField(name, all)?.GetValue(arrow) ?? t.GetProperty(name, all)?.GetValue(arrow);
			return v == null ? "?" : Convert.ToInt32(v, CultureInfo.InvariantCulture).ToString(CultureInfo.InvariantCulture);
		}
		catch
		{
			return "?";
		}
	}

	// TF.EX's gameplay RNG (xoshiro256**, TF.State.Domain.Randomness.DeterministicRandom) state folded as s0^s1^s2^s3.
	private static ulong RngFold()
	{
		object random = gameplayGetter.Invoke(resolveRngService.Invoke(null, null), null);
		object state = random.GetType().GetMethod("Snapshot").Invoke(random, null);
		Type st = state.GetType();
		ulong h = 0;
		foreach (string n in new[] { "S0", "S1", "S2", "S3" }) h ^= (ulong)st.GetField(n).GetValue(state);
		return h;
	}

	// A line when a round starts or ends, and an arrow checksum every 300 ticks (live Arrow entities' count and
	// the sums of their position bits, commutative so list order doesn't matter, plus each archer's quiver).
	private static void MaybeLogRoundAndArrows(object level, int t)
	{
		object session = levelSession.GetValue(level);
		int round = (int)sessionRoundIndex.GetValue(session);
		bool ending = (bool)levelType.GetField("Ending").GetValue(level);
		bool log = false;
		string why = "";
		if (round != lastRound)
		{
			lastRound = round;
			log = true;
			why = "round_start";
		}
		else if (ending && !lastEnding)
		{
			log = true;
			why = "round_ending";
		}
		lastEnding = ending;
		if (t % 300 == 0 && t != lastArrowTick) log = true;
		if (!log) return;
		lastArrowTick = t;
		var arrows = (System.Collections.IList)itemByTag.GetValue(level, new[] { arrowTag });
		ulong sx = 0, sy = 0;
		foreach (object a in arrows)
		{
			var pos = (Vector2)position.GetValue(a);
			sx += Bits(pos.X);
			sy += Bits(pos.Y);
		}
		string quivers = string.Join(",", Enumerable.Range(0, 2).Select(i =>
		{
			object p = getPlayer.Invoke(level, new object[] { i });
			return p == null ? "-" : arrowListCount.GetValue(playerArrows.GetValue(p)).ToString();
		}));
		string scores = string.Join(",", (int[])session.GetType().GetField("Scores").GetValue(session));
		uint tm = Bits((float)timeMult.GetValue(null));
		Console.WriteLine($"[xplay2] A {t} round={round}{(why != "" ? " " + why : "")} scores={scores} arrows={arrows.Count} sumx={sx:x16} sumy={sy:x16} quivers={quivers} timemult={tm:x8} resim={resimulated}");
	}

	private static void RngDrawPrefix()
	{
		if (!active || rngTrace == 0 || rngDraws >= rngTrace || (frame >= 0 && !firstPass)) return; // (resimulated ticks redo the same draws)
		rngDraws++;
		var frames = new System.Diagnostics.StackTrace(1, false).GetFrames().Take(9)
			.Select(f => f.GetMethod()).Where(m => m != null && m.DeclaringType != null)
			.Select(m => m.DeclaringType.Name + "." + m.Name);
		Console.WriteLine($"[xplay2rng] draw {rngDraws} ggrs_frame={CurrentFrame()} {string.Join(" < ", frames)}");
	}

	private static void SessionPostfix(object __instance, MethodBase __originalMethod)
	{
		if (!active) return;
		int round = (int)sessionRoundIndex.GetValue(__instance);
		string level = "";
		if (__originalMethod.Name == "LevelLoadStart")
		{
			// The round's level file: VersusLevelSystem.GetNextRoundLevel has just stored it in `lastLevel`.
			object ms = __instance.GetType().GetField("MatchSettings").GetValue(__instance);
			object ls = ms.GetType().GetField("LevelSystem").GetValue(ms);
			string path = ls.GetType().GetField("lastLevel", BindingFlags.NonPublic | BindingFlags.Instance)?.GetValue(ls) as string;
			level = $" level={(path == null ? "?" : path.Replace('\\', '/').Split('/').Last())}";
		}
		Console.WriteLine($"[xplay2setup] after Session.{__originalMethod.Name} round={round}{level} rng={RngFold():x16} ggrs_frame={CurrentFrame()}");
	}

	private static string Describe(object o) => o switch
	{
		null => "null",
		bool[] b => string.Join(",", b.Select(x => x ? 1 : 0)),
		int[] i => string.Join(",", i),
		float[] f => string.Join(",", f),
		Array a => string.Join(",", a.Cast<object>().Select(x => x?.GetType().Name ?? "-")),
		_ => o.ToString(),
	};

	// One-time dump of everything the test mode's setup left in MatchSettings / TFGame, for the setup document.
	private static void SessionStartGamePostfix(object __instance)
	{
		if (!active) return;
		const BindingFlags any = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static;
		void Line(string k, object v) => Console.WriteLine($"[xplay2setup] {k}={Describe(v)}");
		try
		{
			Type sessionType = __instance.GetType();
			Assembly tf = sessionType.Assembly;
			object ms = sessionType.GetField("MatchSettings").GetValue(__instance);
			Type mst = ms.GetType();
			Line("Session.StartGame.rng", RngFold().ToString("x16"));
			Line("seed", Find("TF.State.Domain.Ports.IRngService").GetMethod("GetSeed").Invoke(resolveRngService.Invoke(null, null), null));
			foreach (string f in new[] { "Mode", "MatchLength", "RandomVersusTower", "RandomLevelSeed", "QuestHardcoreMode", "DarkWorldDifficulty" }) Line("MatchSettings." + f, mst.GetField(f).GetValue(ms));
			foreach (string pr in new[] { "TeamMode", "SoloMode", "GoalScore", "PlayerLimit", "AutobalanceLosingAmount" }) Line("MatchSettings." + pr, mst.GetProperty(pr).GetValue(ms));
			Line("MatchSettings.TreasureRates", mst.GetField("TreasureRates").GetValue(ms));
			Line("MatchSettings.MatchLength(int)", (int)mst.GetField("MatchLength").GetValue(ms));
			Line("MatchSettings.Mode(int)", (int)mst.GetField("Mode").GetValue(ms));
			Line("MatchSettings.IsCustom", mst.GetField("IsCustom", any)?.GetValue(ms));
			Line("MatchSettings.GoalMultiplier", mst.GetField("GoalMultiplier", any)?.GetValue(null) is float[] gm ? string.Join(",", gm) : "?");
			Line("MatchSettings.GoalScore(orig)", mst.GetMethod("orig_get_GoalScore", any)?.Invoke(ms, null));
			object teams = mst.GetField("Teams").GetValue(ms);
			Line("MatchSettings.Teams", string.Join(",", Enumerable.Range(0, 4).Select(i => teams.GetType().GetProperty("Item").GetValue(teams, new object[] { i }))));
			object variants = mst.GetField("Variants").GetValue(ms);
			var on = new List<string>();
			foreach (object v in (Array)variants.GetType().GetField("Variants").GetValue(variants))
				if ((bool)v.GetType().GetProperty("Value").GetValue(v)) on.Add((string)v.GetType().GetField("Title").GetValue(v));
			Line("MatchSettings.Variants.on", on.Count == 0 ? "(none)" : string.Join("|", on));
			Line("MatchSettings.Variants.count", ((Array)variants.GetType().GetField("Variants").GetValue(variants)).Length);
			object ls = mst.GetField("LevelSystem").GetValue(ms);
			Line("LevelSystem.type", ls.GetType().Name);
			Line("LevelSystem.ID", ls.GetType().GetProperty("ID").GetValue(ls));
			Line("LevelSystem.Procedural", ls.GetType().GetProperty("Procedural").GetValue(ls));
			Line("LevelSystem.ShowControls", ls.GetType().GetProperty("ShowControls").GetValue(ls));
			Line("LevelSystem.ShowTriggerControls", ls.GetType().GetProperty("ShowTriggerControls").GetValue(ls));
			object theme = ls.GetType().GetProperty("Theme").GetValue(ls);
			Line("LevelSystem.Theme", theme.GetType().GetField("Name").GetValue(theme));
			object tower = ls.GetType().GetProperty("VersusTowerData").GetValue(ls);
			Line("VersusTower.FixedFirst", tower.GetType().GetField("FixedFirst").GetValue(tower));
			Line("VersusTower.Procedural", tower.GetType().GetField("Procedural").GetValue(tower));
			var eligible = (System.Collections.IList)tower.GetType().GetMethod("GetLevels").Invoke(tower, new[] { ms });
			Line("VersusTower.GetLevels(order)", string.Join("|", eligible.Cast<string>().Select(x => x.Replace('\\', '/'))));
			Line("VersusLevelSystem.levels(after StartOnLevel)", string.Join("|", ((System.Collections.IList)ls.GetType().GetField("levels", any).GetValue(ls)).Cast<string>().Select(x => x.Replace('\\', '/'))));
			Type tfGame = tf.GetType("TowerFall.TFGame", true);
			foreach (string f in new[] { "Players", "Characters", "AltSelect", "PlayerInputs" }) Line("TFGame." + f, tfGame.GetField(f, any).GetValue(null));
			Line("TFGame.PlayerAmount", tfGame.GetProperty("PlayerAmount", any).GetValue(null));
			Type mainMenu = tf.GetType("TowerFall.MainMenu", true);
			Line("MainMenu.CurrentMatchSettings==VersusMatchSettings", ReferenceEquals(mainMenu.GetField("CurrentMatchSettings").GetValue(null), mainMenu.GetField("VersusMatchSettings").GetValue(null)));
			Line("MainMenu.VersusMatchSettings.Mode", mst.GetField("Mode").GetValue(mainMenu.GetField("VersusMatchSettings").GetValue(null)));
			Line("MenuInput.MenuInputs", tf.GetType("TowerFall.MenuInput", true).GetField("MenuInputs").GetValue(null));
			Line("Engine.TimeRate", engineType.GetField("TimeRate").GetValue(null));
			Line("Game.IsFixedTimeStep", game.IsFixedTimeStep);
			Line("Game.TargetElapsedTime.Ticks", game.TargetElapsedTime.Ticks);
			Line("Coroutine.OneFrameDelay", oneFrameDelay.GetValue(null));
			Type saveData = tf.GetType("TowerFall.SaveData", true);
			object save = saveData.GetField("Instance").GetValue(null);
			object unlocks = save?.GetType().GetField("Unlocks").GetValue(save);
			if (unlocks != null)
				foreach (string u in new[] { "SunkenCity", "TowerForge", "Ascension" })
					Line("SaveData.Unlocks." + u, unlocks.GetType().GetProperty(u)?.GetValue(unlocks) ?? unlocks.GetType().GetField(u)?.GetValue(unlocks));
			Type gd = tf.GetType("TowerFall.GameData", true);
			Line("GameData.DarkWorldDLC", gd.GetField("DarkWorldDLC", any)?.GetValue(null) ?? gd.GetProperty("DarkWorldDLC", any)?.GetValue(null));
		}
		catch (Exception e)
		{
			Console.WriteLine($"[xplay2setup] dump failed: {e}");
		}
	}

	private static object Override(object state, object self)
	{
		if (!active || frame < 0) return state;
		bool frozen = (int)playerState.GetValue(self) == 5; // PlayerStates.Frozen
		if (firstPass)
		{
			int s = (int)playerIndex.GetValue(self);
			if (s >= 0 && s < 2)
			{
				// (Printed after the tick's line, once tick 0 is known.)
				if (frozen) frozenSeen[s] = true;
				else if (frozenSeen[s])
				{
					frozenSeen[s] = false;
					unfreezes.Add((frame, s));
				}
			}
		}
		if (origin == NoOrigin)
		{
			// First tick any archer is out of the intro freeze.
			if (!firstPass || frozen) return state;
			origin = frame;
		}
		int t = frame - origin;
		if (t < 0) return state;
		int seat = (int)playerIndex.GetValue(self);
		if (seat < 0 || seat > 1) return state;
		if (impure) t = impureCalls[seat]++;
		List<Step> steps = scripts[seat];
		Step? cur = StepAt(steps, t), prev = StepAt(steps, t - 1);
		if (cur is not Step c) return state;
		int pf = prev?.Flags ?? 0;
		bool jump = (c.Flags & 1) != 0, shoot = (c.Flags & 2) != 0, dodge = (c.Flags & 4) != 0, alt = (c.Flags & 8) != 0;
		bool pjump = (pf & 1) != 0, pshoot = (pf & 2) != 0, pdodge = (pf & 4) != 0, palt = (pf & 8) != 0;
		float ax = c.MoveX, ay = c.MoveY;
		if (c.MoveX != 0 && c.MoveY != 0)
		{
			ax *= 0.70710677f;
			ay *= 0.70710677f;
		}
		object s2 = Activator.CreateInstance(inputStateType);
		void Set(string name, object value) => inputStateType.GetField(name).SetValue(s2, value);
		Set("JumpCheck", jump);
		Set("JumpPressed", jump && !pjump);
		Set("ShootCheck", shoot);
		Set("ShootPressed", shoot && !pshoot);
		Set("AltShootCheck", alt);
		Set("AltShootPressed", alt && !palt);
		Set("DodgeCheck", dodge);
		Set("DodgePressed", dodge && !pdodge);
		Set("ArrowsPressed", (c.Flags & 0x10) != 0);
		Set("MoveX", c.MoveX);
		Set("MoveY", c.MoveY);
		Set("AimAxis", new Vector2(ax, ay));
		return s2;
	}

	private static Step? StepAt(List<Step> steps, int t)
	{
		if (t < 0) return null;
		Step? current = null;
		foreach (Step s in steps) if (s.Frame <= t) current = s;
		return current;
	}
}
