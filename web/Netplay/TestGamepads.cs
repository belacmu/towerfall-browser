// Switch harness (local test page only, not for main): extra virtual gamepads the harness presses, so one page seats several
// local players in a TF.EX lobby (a guest presses START on the netplay menu, A on its roll call seat), as the Switch does with its
// second controller. switch-online's lobby-auto.sh sends the commands through the driver (towerfallCommand):
//   pad attach <n>              n virtual gamepads plugged in (run from ?command=, on the main menu: the game reassigns its inputs)
//   pad <i> <button> ...        pad i presses each button in turn (held 8 frames, released 8): a b x y back start up down left right
// The keyboard stays player 1. In a match the guests stand still (XplayNet feeds the page's own seat only).
using System;
using System.Collections.Generic;
using System.Reflection;
using System.Runtime.CompilerServices;
using Microsoft.Xna.Framework;
using SDL3;

namespace TowerFallBrowser;

public static unsafe class TestGamepads
{
	private const int ButtonCount = 15;   // SDL_GamepadButton order: south east west north back guide start lstick rstick lshoulder rshoulder up down left right
	private static readonly Dictionary<string, int> Buttons = new()
	{
		["a"] = 0, ["b"] = 1, ["x"] = 2, ["y"] = 3, ["back"] = 4, ["start"] = 6,
		["up"] = 11, ["down"] = 12, ["left"] = 13, ["right"] = 14,
	};
	private static readonly List<IntPtr> pads = new();
	private static readonly List<Queue<int>> queued = new();
	private static readonly List<int> held = new(), frames = new();

	public static string Command(Game game, string[] words)
	{
		if (words.Length >= 3 && words[1] == "attach" && int.TryParse(words[2], out int n))
		{
			int before = pads.Count;
			while (pads.Count < n && Attach(pads.Count)) { }
			if (pads.Count > before) Reassign(game);
			return $"{pads.Count} virtual gamepad(s)";
		}
		if (words.Length >= 3 && int.TryParse(words[1], out int i) && i >= 0 && i < pads.Count)
		{
			for (int k = 2; k < words.Length; k++)
			{
				if (!Buttons.TryGetValue(words[k].ToLowerInvariant(), out int b)) return $"unknown button {words[k]}";
				queued[i].Enqueue(b);
			}
			return $"pad {i}: {string.Join(" ", words, 2, words.Length - 2)}";
		}
		return $"usage: pad attach <n> | pad <0..{pads.Count - 1}> <button>...";
	}

	private static bool Attach(int index)
	{
		RuntimeHelpers.RunClassConstructor(typeof(Game).Assembly.GetType("Microsoft.Xna.Framework.FNAPlatform", throwOnError: true).TypeHandle);
		byte[] name = System.Text.Encoding.UTF8.GetBytes($"Test pad {index + 1}\0");
		uint id;
		fixed (byte* namePtr = name)
		{
			var desc = new SDL.SDL_VirtualJoystickDesc
			{
				version = (uint)sizeof(SDL.SDL_VirtualJoystickDesc),
				type = (ushort)SDL.SDL_JoystickType.SDL_JOYSTICK_TYPE_GAMEPAD,
				naxes = 6,
				nbuttons = ButtonCount,
				name = namePtr,
			};
			id = SDL.SDL_AttachVirtualJoystick(ref desc);
		}
		if (id == 0)
		{
			Console.Error.WriteLine($"[pad] Couldn't create virtual gamepad {index + 1}: {SDL.SDL_GetError()}");
			return false;
		}
		pads.Add(SDL.SDL_OpenJoystick(id));
		queued.Add(new Queue<int>());
		held.Add(-1);
		frames.Add(0);
		// As TouchGamepad.Attach: FNA opens a gamepad on its added event (ProgramInit's step), so the game sees it at once
		MethodInfo addInstance = typeof(Game).Assembly.GetType("Microsoft.Xna.Framework.SDL3_FNAPlatform", throwOnError: true)
			.GetMethod("INTERNAL_AddInstance", BindingFlags.NonPublic | BindingFlags.Static);
		var evt = new SDL.SDL_Event[1];
		SDL.SDL_PumpEvents();
		while (SDL.SDL_PeepEvents(evt, 1, SDL.SDL_EventAction.SDL_GETEVENT, (uint)SDL.SDL_EventType.SDL_EVENT_GAMEPAD_ADDED, (uint)SDL.SDL_EventType.SDL_EVENT_GAMEPAD_ADDED) == 1)
		{
			addInstance.Invoke(null, new object[] { evt[0].gdevice.which });
		}
		// Triggers rest at the axis minimum (as TouchGamepad)
		SDL.SDL_SetJoystickVirtualAxis(pads[index], (int)SDL.SDL_GamepadAxis.SDL_GAMEPAD_AXIS_LEFT_TRIGGER, short.MinValue);
		SDL.SDL_SetJoystickVirtualAxis(pads[index], (int)SDL.SDL_GamepadAxis.SDL_GAMEPAD_AXIS_RIGHT_TRIGGER, short.MinValue);
		Console.WriteLine($"[pad] virtual gamepad {index + 1} attached");
		return true;
	}

	// The game's own reassignment (as TouchGamepad.ReassignInMenu): MInput's joysticks, then the players' inputs
	private static void Reassign(Game game)
	{
		try
		{
			const BindingFlags any = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static;
			Assembly tf = game.GetType().Assembly;
			tf.GetType("Monocle.MInput", throwOnError: true).GetMethod("UpdateJoysticks", any).Invoke(null, null);
			tf.GetType("TowerFall.PlayerInput", throwOnError: true).GetMethod("AssignInputs", any).Invoke(null, null);
		}
		catch (Exception e)
		{
			Console.Error.WriteLine($"[pad] Couldn't reassign the players' inputs: {e.Message}");
		}
	}

	// Each frame (game thread): a pad's queued presses, one at a time, held 8 frames and released 8
	public static void Update()
	{
		for (int i = 0; i < pads.Count; i++)
		{
			if (frames[i] > 0) { frames[i]--; if (frames[i] == 8 && held[i] >= 0) { SDL.SDL_SetJoystickVirtualButton(pads[i], held[i], false); held[i] = -1; } continue; }
			if (queued[i].Count == 0) continue;
			held[i] = queued[i].Dequeue();
			SDL.SDL_SetJoystickVirtualButton(pads[i], held[i], true);
			frames[i] = 16;
		}
	}
}
