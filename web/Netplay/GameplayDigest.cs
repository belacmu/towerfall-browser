using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Reflection;
using System.Text.RegularExpressions;
using HarmonyLib;
using Microsoft.Xna.Framework;

namespace TowerFallBrowser;

// The gameplay digest as GGRS's desync checksum, for sessions against the Switch (switch-online docs/ws-parity.md section 3).
// TF.EX's checksum is fletcher16 of its serialized state, which the Switch can't produce; with this on, both peers hand GGRS
// the same digest of the state instead: the gameplay RNG, each seat's player (alive, position, speed) and the arrows' positions.
// ggrs-ffi takes it through netplay_set_pending_checksum (netplay/ggrs-ffi.patch), called right before TF.EX's
// NetplayManager.SaveGameState, i.e. for GGRS frame f the state at its start (after f-1's Level.Update and entity flush).
// Both sides must have it on, or every checksum report is a desync. TF.EX itself (desktop, and the browser against desktop)
// keeps fletcher16, so the digest is used only in a session with a Switch player in it (SwitchLobby.Active: every peer of that
// lobby sees the same players, so they all agree), never against desktop TF.EX. Tests and debugging force it for every
// session (xnet / xlobby digest=1, ?digest=1).
// On a DesyncDetected event the frame's digest input is logged ([digest] lines), to diff against the Switch's log.
public static class GameplayDigestHook
{
	public static bool Enabled { get; private set; } // forced: every session uses it
	private static bool installed;

	// The last saves' digest inputs by value, for the DesyncDetected log (its "local checksum" is one of them; the frame a
	// save is for isn't known here during a rollback). Reports arrive well within this many saves.
	private const int Kept = 1024;
	private static readonly Dictionary<ulong, DigestInput> recent = new();
	private static readonly Queue<ulong> recentOrder = new();
	private static MethodInfo isInit;
	private static Type levelType;
	private static FieldInfo position, speed;
	private static PropertyInfo playerIndex, playerDead, itemByTag, engineScene;
	private static object playerTag, arrowTag;
	private static Func<object> engineInstance;
	private static MethodInfo resolveRngService, gameplayGetter;
	private static FieldInfo eventsField;
	private static readonly Regex desyncLocal = new(@"DesyncDetected.* local checksum (\d+)");

	// Switches the digest on for this page (from then on, every save in a TF.EX session uses it). Returns null or an error.
	public static string Enable(Assembly towerFall)
	{
		if (Enabled) return null;
		string error = Install(towerFall);
		if (error != null) return error;
		Enabled = true;
		Console.WriteLine($"[digest] on: GGRS checksums are the gameplay digest (version {GameplayDigest.Version}), not fletcher16 of TF.EX's state");
		return null;
	}

	// The hooks, used by sessions against the Switch (or every session once Enable has run). Returns null or an error.
	public static string Install(Assembly towerFall)
	{
		if (installed) return null;
		const BindingFlags any = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static;
		Type manager = Find("TF.EX.Domain.Services.NetplayManager");
		if (manager == null) return "TF.EX isn't loaded";
		levelType = towerFall.GetType("TowerFall.Level", true);
		Type player = towerFall.GetType("TowerFall.Player", true);
		Type entity = towerFall.GetType("Monocle.Entity", true);
		Type engine = towerFall.GetType("Monocle.Engine", true);
		Type gameTags = towerFall.GetType("Monocle.GameTags", true);
		position = entity.GetField("Position");
		speed = player.GetField("Speed");
		playerIndex = player.GetProperty("PlayerIndex");
		playerDead = player.GetProperty("Dead");
		playerTag = Enum.Parse(gameTags, "Player");
		arrowTag = Enum.Parse(gameTags, "Arrow");
		itemByTag = towerFall.GetType("Monocle.Scene", true).GetProperty("Item", new[] { gameTags });
		engineScene = engine.GetProperty("Scene", BindingFlags.Public | BindingFlags.Instance);
		FieldInfo instanceField = engine.GetField("Instance", any);
		PropertyInfo instanceProperty = engine.GetProperty("Instance", any);
		engineInstance = instanceField != null ? () => instanceField.GetValue(null) : () => instanceProperty.GetValue(null);
		resolveRngService = Find("TF.State.Domain.ServiceCollections").GetMethod("ResolveRngService", any);
		gameplayGetter = Find("TF.State.Domain.Ports.IRngService").GetProperty("Gameplay").GetMethod;
		isInit = manager.GetMethod("IsInit", Type.EmptyTypes);
		eventsField = manager.GetField("_events", any);
		var harmony = new Harmony("TowerFallBrowser.GameplayDigest");
		harmony.Patch(manager.GetMethod("SaveGameState", any), prefix: new HarmonyMethod(typeof(GameplayDigestHook), nameof(SavePrefix)));
		harmony.Patch(manager.GetMethod("GetEventAndUpdate", any), postfix: new HarmonyMethod(typeof(GameplayDigestHook), nameof(EventsPostfix)));
		installed = true;
		return null;
	}

	// This session's checksums are the digest: forced, or a lobby match with a Switch player.
	private static bool InUse() => Enabled || SwitchLobby.Active;

	private static Type Find(string name) =>
		AppDomain.CurrentDomain.GetAssemblies().Select(a => a.GetType(name, false)).FirstOrDefault(t => t != null);

	// Before TF.EX hands GGRS the state of the frame being saved.
	private static void SavePrefix(object __instance)
	{
		if (!InUse() || !(bool)isInit.Invoke(__instance, null)) return; // (TF.EX's save returns early then)
		try
		{
			DigestInput d = Capture();
			ulong value = GameplayDigest.Compute(d);
			TowerFallBrowser.Netplay.GgrsFfiImports.netplay_set_pending_checksum(value);
			if (recent.TryAdd(value, d))
			{
				recentOrder.Enqueue(value);
				if (recentOrder.Count > Kept) recent.Remove(recentOrder.Dequeue());
			}
		}
		catch (Exception e)
		{
			Console.WriteLine($"[digest] capture failed: {e.GetType().Name}: {e.Message}");
		}
	}

	private static DigestInput Capture()
	{
		var d = new DigestInput();
		object random = gameplayGetter.Invoke(resolveRngService.Invoke(null, null), null);
		object state = random.GetType().GetMethod("Snapshot").Invoke(random, null);
		Type st = state.GetType();
		string[] names = { "S0", "S1", "S2", "S3" };
		for (int i = 0; i < 4; i++) d.Rng[i] = (ulong)st.GetField(names[i]).GetValue(state);
		object engine = engineInstance();
		object scene = engine == null ? null : engineScene.GetValue(engine);
		if (scene == null || !levelType.IsInstanceOfType(scene)) return d;
		foreach (object p in (IList)itemByTag.GetValue(scene, new[] { playerTag }))
		{
			int seat = (int)playerIndex.GetValue(p);
			if (seat < 0 || seat > 3 || (bool)playerDead.GetValue(p)) continue;
			var pos = (Vector2)position.GetValue(p);
			var spd = (Vector2)speed.GetValue(p);
			d.Seat[seat] = new DigestSeat { Alive = true, X = pos.X, Y = pos.Y, SX = spd.X, SY = spd.Y };
		}
		foreach (object a in (IList)itemByTag.GetValue(scene, new[] { arrowTag }))
		{
			var pos = (Vector2)position.GetValue(a);
			d.Arrows.Add((pos.X, pos.Y));
		}
		return d;
	}

	// TF.EX only logs DesyncDetected; add what was hashed for that frame.
	private static void EventsPostfix(object __instance)
	{
		if (!InUse() || eventsField.GetValue(__instance) is not IEnumerable events) return;
		foreach (object e in events)
		{
			Match m = desyncLocal.Match(e?.ToString() ?? "");
			if (!m.Success) continue;
			Console.WriteLine($"[digest] {e}");
			if (!ulong.TryParse(m.Groups[1].Value, NumberStyles.None, CultureInfo.InvariantCulture, out ulong value) || !recent.TryGetValue(value, out DigestInput d))
			{
				Console.WriteLine($"[digest] local checksum {m.Groups[1].Value}: its input isn't kept");
				continue;
			}
			Console.WriteLine($"[digest] local {value:x16}: {Describe(d)}");
		}
	}

	public static string Describe(DigestInput d)
	{
		static string B(float f) => BitConverter.SingleToUInt32Bits(f).ToString("x8");
		var parts = new List<string> { "rng=" + string.Join(",", d.Rng.Select(s => s.ToString("x16"))) };
		for (int s = 0; s < 4; s++)
			parts.Add($"p{s}=" + (d.Seat[s].Alive ? $"{B(d.Seat[s].X)},{B(d.Seat[s].Y)},{B(d.Seat[s].SX)},{B(d.Seat[s].SY)}" : "-"));
		parts.Add($"arrows={d.Arrows.Count}:" + string.Join(";", d.Arrows.Select(a => ((ulong)BitConverter.SingleToUInt32Bits(a.X) << 32) | BitConverter.SingleToUInt32Bits(a.Y))
			.OrderBy(v => v).Select(v => v.ToString("x16"))));
		return string.Join(" ", parts);
	}
}

// From switch-online hw-probe/tests/refgen/Digest.cs (normative, with its C++ twin digest.hpp; reference values in
// hw-probe/tests/digest-ref.txt, checked by the `digesttest` command here).
public struct DigestSeat { public bool Alive; public float X, Y, SX, SY; }
public class DigestInput {
    public ulong[] Rng = new ulong[4];              // DeterministicRandom's s0..s3 (TF.State Rng model S0..S3)
    public DigestSeat[] Seat = new DigestSeat[4];   // seat = Player.PlayerIndex; Alive = in Level[GameTags.Player] && !Dead
    public List<(float X, float Y)> Arrows = new List<(float, float)>();   // Level[GameTags.Arrow], any order
}

public static class GameplayDigest {
    public const uint Version = 1;
    static uint Bits(float f) => BitConverter.SingleToUInt32Bits(f);
    public static ulong Compute(DigestInput d) {
        ulong h = 1469598103934665603UL;
        void Byte(byte b) { h = (h ^ b) * 1099511628211UL; }
        void U32(uint v) { for (int i = 0; i < 4; i++) Byte((byte)(v >> (8 * i))); }
        void U64(ulong v) { for (int i = 0; i < 8; i++) Byte((byte)(v >> (8 * i))); }
        U32(Version);
        for (int i = 0; i < 4; i++) U64(d.Rng[i]);
        for (int s = 0; s < 4; s++) {
            DigestSeat p = d.Seat[s];
            Byte(p.Alive ? (byte)1 : (byte)0);
            if (p.Alive) { U32(Bits(p.X)); U32(Bits(p.Y)); U32(Bits(p.SX)); U32(Bits(p.SY)); }
        }
        U32((uint)d.Arrows.Count);
        var pos = new List<ulong>();
        foreach (var a in d.Arrows) pos.Add(((ulong)Bits(a.X) << 32) | Bits(a.Y));
        pos.Sort();
        foreach (ulong v in pos) U64(v);
        return h;
    }

    // Reference cases (same generator as digest-test.cpp).
    public static void Run() {
        ulong x = 0x2545F4914F6CDD1DUL;
        ulong R() { x ^= x << 13; x ^= x >> 7; x ^= x << 17; return x; }
        float F() { return (float)((long)(R() % 640000) - 160000) / 1000f; }
        for (int c = 0; c < 40; c++) {
            var d = new DigestInput();
            for (int i = 0; i < 4; i++) d.Rng[i] = R();
            for (int s = 0; s < 4; s++) d.Seat[s] = new DigestSeat { Alive = R() % 3 != 0, X = F(), Y = F(), SX = F(), SY = F() };
            int n = (int)(R() % (c < 20 ? 6UL : 40UL));
            for (int k = 0; k < n; k++) d.Arrows.Add((F(), F()));
            if (c == 7) d.Arrows.Add(d.Arrows.Count > 0 ? d.Arrows[0] : (1f, 2f));          // a duplicate position
            if (c == 9 && d.Arrows.Count > 0) d.Arrows[0] = (-0f, d.Arrows[0].Item2);         // negative zero
            Console.WriteLine($"digest {c} {Compute(d):x16}");
        }
    }
}
