using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Reflection;
using System.Reflection.Emit;
using HarmonyLib;
using Microsoft.Xna.Framework;

namespace TowerFallBrowser;

// The browser half of the Switch determinism test (docs/SWITCH-CROSSPLAY.md step 3), the same as the
// Switch probe (tools/switch-probe) does there:
//   - The game runs fixed-step, so Engine.Update takes its IsFixedTimeStep branch (TimeMult =
//     TimeRate), not measured frame time.
//   - In Player.Update, right after `input = PlayerInputs[i].GetState()`, player 1's InputState comes
//     from a script, platform-neutral: frames counted from the first Player.Update after the
//     player's first NormalUpdate.
//   - Each of those frames logs player 1's position and speed as float bits, as the frame starts:
//     "[xplay] T <frame> <x> <y> <sx> <sy>", to compare with the Switch's log.
// "xplay <script>" host command (needs FortRise for Harmony: ?fortrise). Script: frame:flags:moveX:
// moveY steps joined by commas, each held until the next; flags 1 jump, 2 shoot, 4 dodge, 8 alt
// shoot, 0x10 arrows (hex).
public static class CrossplayTest
{
	private struct Step
	{
		public int Frame, Flags, MoveX, MoveY;
	}

	private const int MaxFrames = 1500;
	private static List<Step> steps = new();
	private static object player; // player 1, from its first NormalUpdate
	private static int frame = -1;
	private static bool prevJump, prevShoot, prevDodge, prevAlt;
	private static FieldInfo position, speed;
	private static Type inputStateType;
	private static FieldInfo engineTimeRate;
	private static MethodInfo setTimeMult, setDeltaTime;

	public static string Start(Assembly towerFall, Game game, string script)
	{
		steps = script.Split(',', StringSplitOptions.RemoveEmptyEntries).Select(s =>
		{
			string[] p = s.Split(':');
			return new Step
			{
				Frame = int.Parse(p[0], CultureInfo.InvariantCulture),
				Flags = int.Parse(p[1], NumberStyles.HexNumber, CultureInfo.InvariantCulture),
				MoveX = int.Parse(p[2], CultureInfo.InvariantCulture),
				MoveY = int.Parse(p[3], CultureInfo.InvariantCulture),
			};
		}).ToList();
		Type playerType = towerFall.GetType("TowerFall.Player", throwOnError: true);
		// (From the running game's assembly: under FortRise the unpatched TowerFall.exe is loaded too.)
		Type engineType = towerFall.GetType("Monocle.Engine", throwOnError: true);
		inputStateType = towerFall.GetType("TowerFall.InputState", throwOnError: true);
		position = engineType.Assembly.GetType("Monocle.Entity").GetField("Position");
		speed = playerType.GetField("Speed");

		var harmony = new Harmony("TowerFallBrowser.CrossplayTest");
		// Fixed timestep, as the Switch computes it. The game runs fixed-step (Monocle's Engine turns
		// it off at startup), so FNA's Tick waits for a whole frame (on the game's own thread) and
		// updates once per 1/60 s. But PC 1.3.3.3's Engine.Update then sets TimeMult = ActualDeltaTime
		// * 60 (0.999996 with 166,666-tick frames), where the Switch's (1.4.1.6) sets TimeMult = TimeRate
		// and DeltaTime = TimeRate / 60: so Engine.Update gets the Switch's values.
		game.IsFixedTimeStep = true;
		engineTimeRate = engineType.GetField("TimeRate", BindingFlags.Public | BindingFlags.Static);
		setTimeMult = engineType.GetProperty("TimeMult").GetSetMethod(true);
		setDeltaTime = engineType.GetProperty("DeltaTime").GetSetMethod(true);
		harmony.Patch(AccessTools.Method(engineType, "Update"), transpiler: new HarmonyMethod(typeof(CrossplayTest), nameof(SwitchTimeStep)));
		harmony.Patch(AccessTools.Method(playerType, "Update"), transpiler: new HarmonyMethod(typeof(CrossplayTest), nameof(ScriptedInput)));
		harmony.Patch(AccessTools.Method(playerType, "NormalUpdate"), prefix: new HarmonyMethod(typeof(CrossplayTest), nameof(NormalUpdatePrefix)));
		return $"{steps.Count} steps; fixed timestep; scripted player 1 input";
	}

	// Engine.Update: TimeMult = TimeRate; DeltaTime = TimeRate * (1/60f), whatever it computed.
	private static IEnumerable<CodeInstruction> SwitchTimeStep(IEnumerable<CodeInstruction> code)
	{
		foreach (CodeInstruction i in code)
		{
			if (i.Calls(setTimeMult))
			{
				yield return new CodeInstruction(OpCodes.Pop).MoveLabelsFrom(i);
				yield return new CodeInstruction(OpCodes.Ldsfld, engineTimeRate);
			}
			else if (i.Calls(setDeltaTime))
			{
				yield return new CodeInstruction(OpCodes.Pop).MoveLabelsFrom(i);
				yield return new CodeInstruction(OpCodes.Ldsfld, engineTimeRate);
				yield return new CodeInstruction(OpCodes.Ldc_R4, 1f / 60f);
				yield return new CodeInstruction(OpCodes.Mul);
			}
			yield return i;
		}
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
				yield return new CodeInstruction(OpCodes.Call, AccessTools.Method(typeof(CrossplayTest), nameof(Override)));
				yield return new CodeInstruction(OpCodes.Unbox_Any, inputStateType);
			}
		}
	}

	private static void NormalUpdatePrefix(object __instance)
	{
		if (player != null) return;
		player = __instance;
		Console.WriteLine("[xplay] player under control (first NormalUpdate)");
	}

	private static uint Bits(float f) => BitConverter.SingleToUInt32Bits(f);

	private static object Override(object state, object self)
	{
		if (player == null || self != player) return state;
		frame++;
		// (The page keeps the last 2,000 log lines: enough frames to compare, and no more.)
		if (frame >= MaxFrames)
		{
			if (frame == MaxFrames) Console.WriteLine($"[xplay] stopped logging after {MaxFrames} frames");
			return state;
		}
		var pos = (Vector2)position.GetValue(self);
		var spd = (Vector2)speed.GetValue(self);
		Console.WriteLine($"[xplay] T {frame} {Bits(pos.X):x8} {Bits(pos.Y):x8} {Bits(spd.X):x8} {Bits(spd.Y):x8}");
		Step? current = null;
		foreach (Step s in steps) if (s.Frame <= frame) current = s;
		if (current is not Step step) return state;
		bool jump = (step.Flags & 1) != 0, shoot = (step.Flags & 2) != 0, dodge = (step.Flags & 4) != 0, alt = (step.Flags & 8) != 0;
		float ax = step.MoveX, ay = step.MoveY;
		if (step.MoveX != 0 && step.MoveY != 0)
		{
			ax *= 0.70710677f;
			ay *= 0.70710677f;
		}
		object s2 = Activator.CreateInstance(inputStateType);
		void Set(string name, object value) => inputStateType.GetField(name).SetValue(s2, value);
		Set("JumpCheck", jump);
		Set("JumpPressed", jump && !prevJump);
		Set("ShootCheck", shoot);
		Set("ShootPressed", shoot && !prevShoot);
		Set("AltShootCheck", alt);
		Set("AltShootPressed", alt && !prevAlt);
		Set("DodgeCheck", dodge);
		Set("DodgePressed", dodge && !prevDodge);
		Set("ArrowsPressed", (step.Flags & 0x10) != 0);
		Set("MoveX", step.MoveX);
		Set("MoveY", step.MoveY);
		Set("AimAxis", new Vector2(ax, ay));
		prevJump = jump;
		prevShoot = shoot;
		prevDodge = dodge;
		prevAlt = alt;
		return s2;
	}
}
