using System;
using System.Reflection;
using HarmonyLib;
using Microsoft.Xna.Framework;
using System.Runtime.CompilerServices;
using System.Threading;
using SDL3;

namespace TowerFallBrowser;

// The on-screen controls (wwwroot/touch.js) as a gamepad: an SDL virtual joystick of the standard
// gamepad shape, so FNA, and through it the game, see an ordinary Xbox-style controller (analog
// aiming, controller prompts, rebindable in the game's options). The page sends the controls' state
// whenever it changes; the game thread, which SDL belongs to, applies it before each frame.
//
// While the controls show, the keyboard isn't a player. The game lists gamepads first and then
// the keyboard (PlayerInput.AssignInputs), so with the pad plugged in the keyboard was player 2. A
// postfix takes the keyboard back out of each list the game builds, as long as a gamepad is left;
// the game's menus still take keys, as they do when four pads are connected. Only lists the game
// built: in an online lobby TF.EX skips AssignInputs and seats remote players on KeyboardInputs
// of its own. Turning the controls on or off rebuilds the list the next time the main menu is up
// (in a match, the Level expects every player's input to stay).
public static unsafe class TouchGamepad
{
	// State bits: SDL_GamepadButton indices (0 = south/A ... 14 = d-pad right), plus the triggers.
	public const int LeftTriggerBit = 1 << 15;
	public const int RightTriggerBit = 1 << 16;
	private const int ButtonCount = 15;
	private const int AxisCount = 6; // left x/y, right x/y, left/right trigger (SDL_GamepadAxis order)

	public static bool Enabled;
	private static volatile bool shown;
	private static volatile bool reassign;
	private static bool attempted;
	private static IntPtr joystick;
	// Latest state from the page: buttons in the low 32 bits, then left stick x and y (16 bits each).
	private static long pending = Pack(0, 0, 0);
	private static long applied = Pack(0, 0, 0);

	public static long Pack(int buttons, int x, int y) => (uint)buttons | (long)(ushort)(short)x << 32 | (long)(ushort)(short)y << 48;

	public static void Set(int buttons, int x, int y) => Interlocked.Exchange(ref pending, Pack(buttons, x, y));

	// The page shows or hides the controls (any thread). Showing them plugs the pad in; it stays
	// plugged in when they're hidden.
	public static void Show(bool on)
	{
		if (on) Enabled = true;
		if (on != shown) reassign = game != null;
		shown = on;
	}

	private static Game game;
	private static FieldInfo playerInputs;
	private static PropertyInfo loaded;
	private static Type keyboardInput, xGamepadInput;
	private static MethodInfo assignInputs, updateJoysticks, updateMenuInputs, updateMenuButtons;
	private static bool patched;

	// Init() calls this after constructing the game, before its first frame (where TFGame.Load
	// first assigns the inputs). If the game isn't as expected, the keyboard just stays a player.
	public static void Init(Game tfGame)
	{
		AttachIfEnabled();
		try
		{
			// Public and not: FortRise makes some of these internal.
			const BindingFlags any = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static;
			Assembly tf = tfGame.GetType().Assembly;
			Type tfGameType = tf.GetType("TowerFall.TFGame", throwOnError: true);
			playerInputs = tfGameType.GetField("PlayerInputs", any) ?? throw new MissingMemberException("TFGame.PlayerInputs");
			loaded = tfGameType.GetProperty("Loaded", any) ?? throw new MissingMemberException("TFGame.Loaded");
			keyboardInput = tf.GetType("TowerFall.KeyboardInput", throwOnError: true);
			xGamepadInput = tf.GetType("TowerFall.XGamepadInput", throwOnError: true);
			assignInputs = tf.GetType("TowerFall.PlayerInput", throwOnError: true).GetMethod("AssignInputs", any) ?? throw new MissingMemberException("PlayerInput.AssignInputs");
			updateJoysticks = tf.GetType("Monocle.MInput", throwOnError: true).GetMethod("UpdateJoysticks", any) ?? throw new MissingMemberException("MInput.UpdateJoysticks");
			updateMenuInputs = tf.GetType("TowerFall.MenuInput", throwOnError: true).GetMethod("UpdateInputs", any) ?? throw new MissingMemberException("MenuInput.UpdateInputs");
			updateMenuButtons = tf.GetType("TowerFall.MenuButtons", throwOnError: true).GetMethod("Update", any) ?? throw new MissingMemberException("MenuButtons.Update");
			game = tfGame;
			if (shown) PatchAssignInputs();
		}
		catch (Exception e)
		{
			game = null;
			Console.Error.WriteLine($"[touch] The keyboard stays a player with the controls on: {e.Message}");
		}
	}

	private static void PatchAssignInputs()
	{
		if (patched) return;
		patched = true;
		const BindingFlags all = BindingFlags.NonPublic | BindingFlags.Static;
		new Harmony("TowerFallBrowser.TouchGamepad").Patch(assignInputs,
			prefix: new HarmonyMethod(typeof(TouchGamepad).GetMethod(nameof(AssignInputsPrefix), all)),
			postfix: new HarmonyMethod(typeof(TouchGamepad).GetMethod(nameof(AssignInputsPostfix), all)));
	}

	private static void AssignInputsPrefix(out object __state) => __state = playerInputs.GetValue(null);

	private static void AssignInputsPostfix(object __state)
	{
		if (!shown || playerInputs.GetValue(null) is not Array inputs || inputs == __state) return;
		bool gamepad = false;
		foreach (object input in inputs) gamepad |= xGamepadInput.IsInstanceOfType(input);
		if (!gamepad) return;
		int removed = 0;
		for (int i = 0; i < inputs.Length; i++)
		{
			if (!keyboardInput.IsInstanceOfType(inputs.GetValue(i))) continue;
			inputs.SetValue(null, i);
			removed++;
		}
		if (removed == 0) return;
		Console.WriteLine("[touch] On-screen controls on: the keyboard isn't a player");
		updateMenuInputs.Invoke(null, null);
		updateMenuButtons.Invoke(null, null);
	}

	// After the controls were turned on or off: the game's own reassignment, in the main menu.
	private static void ReassignInMenu()
	{
		if (game == null || game.GetType().GetProperty("Scene")?.GetValue(game)?.GetType().FullName != "TowerFall.MainMenu" || loaded.GetValue(null) is not true) return;
		reassign = false;
		try
		{
			if (shown) PatchAssignInputs();
			updateJoysticks.Invoke(null, null);
			assignInputs.Invoke(null, null);
		}
		catch (Exception e)
		{
			Console.Error.WriteLine($"[touch] Couldn't reassign the players' inputs: {e}");
		}
	}

	// Plugs the pad in once it's enabled (game thread). Init() calls this after constructing the game
	// (FNA has initialized SDL then) and before its first frame, so the game finds it like a
	// controller that was there at launch; enabled later, it's plugged in like a controller connected
	// mid-game. Without it the game still runs (keyboard, real gamepads).
	public static void AttachIfEnabled()
	{
		if (!Enabled || attempted) return;
		attempted = true;
		try
		{
			Attach();
		}
		catch (Exception e)
		{
			Console.Error.WriteLine($"[touch] Couldn't attach the virtual gamepad: {e}");
		}
	}

	private static void Attach()
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
		AttachIfEnabled();
		if (reassign) ReassignInMenu();
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
