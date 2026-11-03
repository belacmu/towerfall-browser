using System;
using System.Runtime.CompilerServices;
using SDL3;

namespace TowerFallBrowser;

// Physical controllers as SDL virtual gamepads. The browser's Gamepad API only exists on the page,
// not in the game's worker, so wwwroot/pads.js polls up to 8 pads and sends their state (already
// in SDL's gamepad layout); the game thread plugs one virtual gamepad in per pad the first time it
// reports, and removes it when the pad goes, so FNA and the game see ordinary controllers.
public static unsafe class PadBridge
{
	public const int MaxPads = 8;
	private const int ButtonCount = 15;
	private const int AxisCount = 6;

	private sealed class Slot
	{
		public readonly object Lock = new();
		public int[] State = new int[7]; // buttons, lx, ly, rx, ry, lt, rt
		public bool Present, Dirty;
		public IntPtr Joystick;
		public uint Id;
		public int[] Applied = new int[7];
	}

	private static readonly Slot[] slots = MakeSlots();
	private static Slot[] MakeSlots()
	{
		var s = new Slot[MaxPads];
		for (int i = 0; i < s.Length; i++) s[i] = new Slot();
		return s;
	}

	public static void Set(int slot, int buttons, int lx, int ly, int rx, int ry, int lt, int rt)
	{
		if ((uint)slot >= MaxPads) return;
		Slot s = slots[slot];
		lock (s.Lock)
		{
			s.State = new[] { buttons, lx, ly, rx, ry, lt, rt };
			s.Present = true;
			s.Dirty = true;
		}
	}

	public static void Release(int slot)
	{
		if ((uint)slot >= MaxPads) return;
		Slot s = slots[slot];
		lock (s.Lock) { s.Present = false; s.Dirty = true; }
	}

	// Game thread, before each frame.
	public static void Update()
	{
		for (int i = 0; i < MaxPads; i++)
		{
			Slot s = slots[i];
			int[] now;
			bool present;
			lock (s.Lock)
			{
				if (!s.Dirty) continue;
				s.Dirty = false;
				now = s.State;
				present = s.Present;
			}
			try
			{
				if (!present) Detach(i, s);
				else
				{
					if (s.Joystick == IntPtr.Zero && !Attach(i, s)) continue;
					Apply(s, now);
				}
			}
			catch (Exception e)
			{
				Console.Error.WriteLine($"[pad] Slot {i}: {e.Message}");
			}
		}
	}

	private static bool Attach(int slot, Slot s)
	{
		RuntimeHelpers.RunClassConstructor(typeof(Microsoft.Xna.Framework.Game).Assembly.GetType("Microsoft.Xna.Framework.FNAPlatform", throwOnError: true).TypeHandle);
		byte[] name = System.Text.Encoding.UTF8.GetBytes($"Controller {slot + 1}\0");
		uint id;
		fixed (byte* namePtr = name)
		{
			var desc = new SDL.SDL_VirtualJoystickDesc
			{
				version = (uint)sizeof(SDL.SDL_VirtualJoystickDesc),
				type = (ushort)SDL.SDL_JoystickType.SDL_JOYSTICK_TYPE_GAMEPAD,
				naxes = AxisCount,
				nbuttons = ButtonCount,
				name = namePtr,
			};
			id = SDL.SDL_AttachVirtualJoystick(ref desc);
		}
		if (id == 0)
		{
			Console.Error.WriteLine($"[pad] Couldn't create a virtual gamepad: {SDL.SDL_GetError()}");
			return false;
		}
		s.Id = id;
		s.Joystick = SDL.SDL_OpenJoystick(id);
		s.Applied = new int[7];
		// A controller connected mid-game: FNA picks up its added event during the next frame.
		Console.WriteLine($"[pad] Controller {slot + 1} connected");
		return true;
	}

	private static void Detach(int slot, Slot s)
	{
		if (s.Joystick == IntPtr.Zero) return;
		SDL.SDL_CloseJoystick(s.Joystick);
		SDL.SDL_DetachVirtualJoystick(s.Id);
		s.Joystick = IntPtr.Zero;
		Console.WriteLine($"[pad] Controller {slot + 1} disconnected");
	}

	private static void Apply(Slot s, int[] now)
	{
		int buttons = now[0], was = s.Applied[0];
		for (int i = 0; i < ButtonCount; i++)
		{
			if (((buttons ^ was) & (1 << i)) != 0) SDL.SDL_SetJoystickVirtualButton(s.Joystick, i, (buttons & (1 << i)) != 0);
		}
		SDL.SDL_SetJoystickVirtualAxis(s.Joystick, (int)SDL.SDL_GamepadAxis.SDL_GAMEPAD_AXIS_LEFTX, (short)now[1]);
		SDL.SDL_SetJoystickVirtualAxis(s.Joystick, (int)SDL.SDL_GamepadAxis.SDL_GAMEPAD_AXIS_LEFTY, (short)now[2]);
		SDL.SDL_SetJoystickVirtualAxis(s.Joystick, (int)SDL.SDL_GamepadAxis.SDL_GAMEPAD_AXIS_RIGHTX, (short)now[3]);
		SDL.SDL_SetJoystickVirtualAxis(s.Joystick, (int)SDL.SDL_GamepadAxis.SDL_GAMEPAD_AXIS_RIGHTY, (short)now[4]);
		// Triggers rest at the axis minimum.
		SDL.SDL_SetJoystickVirtualAxis(s.Joystick, (int)SDL.SDL_GamepadAxis.SDL_GAMEPAD_AXIS_LEFT_TRIGGER, (short)(now[5] * 2 - 32768));
		SDL.SDL_SetJoystickVirtualAxis(s.Joystick, (int)SDL.SDL_GamepadAxis.SDL_GAMEPAD_AXIS_RIGHT_TRIGGER, (short)(now[6] * 2 - 32768));
		s.Applied = now;
	}
}
