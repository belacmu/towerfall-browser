using System;
using System.Runtime.InteropServices;

namespace TowerFallBrowser.Netplay;

// The native functions TF.EX (the netplay mod, loaded at runtime) calls in ggrs_ffi, which the
// browser build links statically (tools/build-netplay.sh). WebAssembly needs the call glue for every
// P/Invoke signature generated at build time, from declarations it can see; TF.EX's own declarations
// only arrive with the mod. These mirror TF.EX's Externals/GGRSFFI.cs (same library, entry points
// and blittable layouts) and are never called from here.
internal static class GgrsFfiImports
{
	[StructLayout(LayoutKind.Sequential)]
	internal struct Status { public short is_ok; public IntPtr info; }

	[StructLayout(LayoutKind.Sequential)]
	internal struct SafeBytesFFI { public IntPtr ptr; public nuint size; }

	[StructLayout(LayoutKind.Sequential)]
	internal struct Events { public IntPtr data; public int len; public int cap; }

	[StructLayout(LayoutKind.Sequential)]
	internal struct Vector2f { public float X; public float Y; }

	// 64 bytes: 11 ints, two Vector2f, one int.
	[StructLayout(LayoutKind.Sequential)]
	internal struct Input
	{
		public int jump_check, jump_pressed, shoot_check, shoot_pressed, alt_shoot_check, alt_shoot_pressed,
			dodge_check, dodge_pressed, arrow_pressed, move_x, move_y;
		public Vector2f aim_axis, aim_right_axis;
		public int disconnected;
	}

	[StructLayout(LayoutKind.Sequential)]
	internal struct Inputs { public IntPtr data; public int len; }

	[StructLayout(LayoutKind.Sequential)]
	internal struct NetplayRequets { public IntPtr data; public int len; }

	[StructLayout(LayoutKind.Sequential)]
	internal struct ActionResult { public SafeBytesFFI Data; public Status Status; }

	[StructLayout(LayoutKind.Sequential)]
	internal struct NetworkStats { public uint send_queue_len, ping, kbps_sent; public int local_frames_behind, remote_frames_behind; }

	[StructLayout(LayoutKind.Sequential)]
	internal struct PingStats { public int rtt, spike, loss_percent, samples; }

	[DllImport("ggrs_ffi")] internal static extern Status netplay_init(SafeBytesFFI netplay_conf);
	[DllImport("ggrs_ffi")] internal static extern Status netplay_poll();
	[DllImport("ggrs_ffi")] internal static extern Status netplay_is_synchronized();
	[DllImport("ggrs_ffi")] internal static extern Status netplay_is_disconnected();
	[DllImport("ggrs_ffi")] internal static extern void status_info_free(IntPtr info);
	[DllImport("ggrs_ffi")] internal static extern Events netplay_events();
	[DllImport("ggrs_ffi")] internal static extern void netplay_events_free(Events events);
	[DllImport("ggrs_ffi")] internal static extern Status netplay_advance_frame(Input input);
	[DllImport("ggrs_ffi")] internal static extern Status netplay_set_test_inputs(Input[] inputs, int len);
	[DllImport("ggrs_ffi")] internal static extern NetplayRequets netplay_get_requests();
	[DllImport("ggrs_ffi")] internal static extern void netplay_requests_free(NetplayRequets requests);
	[DllImport("ggrs_ffi")] internal static extern Status netplay_save_game_state(SafeBytesFFI gameState);
	[DllImport("ggrs_ffi")] internal static extern Inputs netplay_advance_game_state();
	[DllImport("ggrs_ffi")] internal static extern ActionResult netplay_load_game_state();
	[DllImport("ggrs_ffi")] internal static extern void netplay_inputs_free(Inputs inputs);
	[DllImport("ggrs_ffi")] internal static extern Status netplay_network_stats(int playerHandle, out NetworkStats stats);
	[DllImport("ggrs_ffi")] internal static extern int netplay_frames_ahead();
	[DllImport("ggrs_ffi")] internal static extern void netplay_free_game_state(SafeBytesFFI safeByte);
	[DllImport("ggrs_ffi")] internal static extern int netplay_current_frame();
	[DllImport("ggrs_ffi")] internal static extern Status netplay_reset();
	[DllImport("ggrs_ffi")] internal static extern int netplay_local_player_handle();
	[DllImport("ggrs_ffi")] internal static extern int netplay_remote_player_handle();
	[DllImport("ggrs_ffi")] internal static extern int netplay_remote_player_handle_count();
	[DllImport("ggrs_ffi")] internal static extern int netplay_remote_player_handle_at(int index);
	[DllImport("ggrs_ffi")] internal static extern Status netplay_add_spectator([MarshalAs(UnmanagedType.LPUTF8Str)] string peerId);
	[DllImport("ggrs_ffi")] internal static extern int netplay_frames_behind();
	[DllImport("ggrs_ffi")] internal static extern Status ping_measurement_start([MarshalAs(UnmanagedType.LPUTF8Str)] string roomUrl);
	[DllImport("ggrs_ffi")] internal static extern void ping_measurement_stop();
	[DllImport("ggrs_ffi")] internal static extern void ping_measurement_stats([MarshalAs(UnmanagedType.LPUTF8Str)] string peerId, out PingStats stats);
}
