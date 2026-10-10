using System;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Threading;
using SDL3;

namespace TowerFallBrowser;

// The on-screen controls (wwwroot/touch.js) as a gamepad: an SDL virtual joystick of the standard
// gamepad shape, so FNA, and through it the game, see an ordinary Xbox-style controller (analog
// aiming, controller prompts, rebindable in the game's options). The page sends the controls' state
// whenever it changes; the game thread, which SDL belongs to, applies it before each frame.
public static unsafe class TouchGamepad
{
	// State bits: SDL_GamepadButton indices (0 = south/A ... 14 = d-pad right), plus the triggers.
	public const int LeftTriggerBit = 1 << 15;
	public const int RightTriggerBit = 1 << 16;
	private const int ButtonCount = 15;
	private const int AxisCount = 6; // left x/y, right x/y, left/right trigger (SDL_GamepadAxis order)

	public static bool Enabled;
	private static IntPtr joystick;
	// Latest state from the page: buttons in the low 32 bits, then left stick x and y (16 bits each).
	private static long pending = Pack(0, 0, 0);
	private static long applied = Pack(0, 0, 0);

	public static long Pack(int buttons, int x, int y) => (uint)buttons | (long)(ushort)(short)x << 32 | (long)(ushort)(short)y << 48;

	public static void Set(int buttons, int x, int y) => Interlocked.Exchange(ref pending, Pack(buttons, x, y));

	// Plugs the pad in. Call on the game thread after the game is constructed (FNA has initialized
	// SDL then) and before its first frame, so the game finds it like a controller that was there at
	// launch.
	public static void Attach()
	{
		RuntimeHelpers.RunClassConstructor(typeof(Microsoft.Xna.Framework.Game).Assembly.GetType("Microsoft.Xna.Framework.FNAPlatform", throwOnError: true).TypeHandle);
		byte[] name = System.Text.Encoding.UTF8.GetBytes("Touch controls\0");
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
			Console.Error.WriteLine($"[touch] Couldn't create the virtual gamepad: {SDL.SDL_GetError()}");
			return;
		}
		joystick = SDL.SDL_OpenJoystick(id);
		// FNA opens the gamepads that are present when it starts (SDL3_FNAPlatform.ProgramInit), and
		// later ones as their events come in during frames. Do what ProgramInit does, so the pad is
		// connected before the game's Initialize looks for controllers.
		MethodInfo addInstance = typeof(Microsoft.Xna.Framework.Game).Assembly
			.GetType("Microsoft.Xna.Framework.SDL3_FNAPlatform", throwOnError: true)
			.GetMethod("INTERNAL_AddInstance", BindingFlags.NonPublic | BindingFlags.Static);
		var evt = new SDL.SDL_Event[1];
		SDL.SDL_PumpEvents();
		while (SDL.SDL_PeepEvents(evt, 1, SDL.SDL_EventAction.SDL_GETEVENT, (uint)SDL.SDL_EventType.SDL_EVENT_GAMEPAD_ADDED, (uint)SDL.SDL_EventType.SDL_EVENT_GAMEPAD_ADDED) == 1)
		{
			addInstance.Invoke(null, new object[] { evt[0].gdevice.which });
		}
		Console.WriteLine($"[touch] Virtual gamepad attached ({SDL.SDL_GetJoystickNameForID(id)})");
	}

	// Applies the page's latest state to the virtual pad (game thread, before a frame).
	public static void Update()
	{
		if (joystick == IntPtr.Zero) return;
		long now = Interlocked.Read(ref pending);
		if (now == applied) return;
		int buttons = (int)(uint)now, was = (int)(uint)applied;
		for (int i = 0; i < ButtonCount; i++)
		{
			if (((buttons ^ was) & (1 << i)) != 0)
			{
				SDL.SDL_SetJoystickVirtualButton(joystick, i, (buttons & (1 << i)) != 0);
			}
		}
		SDL.SDL_SetJoystickVirtualAxis(joystick, (int)SDL.SDL_GamepadAxis.SDL_GAMEPAD_AXIS_LEFTX, (short)(now >> 32));
		SDL.SDL_SetJoystickVirtualAxis(joystick, (int)SDL.SDL_GamepadAxis.SDL_GAMEPAD_AXIS_LEFTY, (short)(now >> 48));
		// Triggers rest at the axis minimum.
		SDL.SDL_SetJoystickVirtualAxis(joystick, (int)SDL.SDL_GamepadAxis.SDL_GAMEPAD_AXIS_LEFT_TRIGGER, (buttons & LeftTriggerBit) != 0 ? short.MaxValue : short.MinValue);
		SDL.SDL_SetJoystickVirtualAxis(joystick, (int)SDL.SDL_GamepadAxis.SDL_GAMEPAD_AXIS_RIGHT_TRIGGER, (buttons & RightTriggerBit) != 0 ? short.MaxValue : short.MinValue);
		applied = now;
	}
}
