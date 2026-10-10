using System;
using System.Net.Http;
using System.Net.WebSockets;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using HarmonyLib;

namespace TowerFallBrowser;

// A WebSocket over the page's, polled from whichever thread uses it (tfws_* in netplay/tfnet.js).
// Installed under every ClientWebSocket in place of .NET's browser WebSocket. That one completes
// its operations on the thread owning the page's JS context, our game thread, so TF.EX, which
// blocks the game thread until its lobby connection opens, deadlocked the page.
// Waiting happens on the calling thread (TF.EX connects and receives on thread-pool threads). Each
// tfws_* call waits for the page's main thread, so pollers first read the socket's signal, a counter
// the page bumps whenever it opens, gets a message or closes, and only call in when it moved: a
// receive loop polling every 2 ms otherwise cost the main thread ~800 calls a second all match.
internal sealed class PolledWebSocket : WebSocket
{
	[DllImport("Emscripten")] private static extern unsafe int tfws_open(string url, int* signal);
	[DllImport("Emscripten")] private static extern int tfws_state(int h);
	[DllImport("Emscripten")] private static extern unsafe int tfws_close_info(int h, byte* reason, nuint cap);
	[DllImport("Emscripten")] private static extern unsafe int tfws_send(int h, byte* data, nuint len, int text);
	[DllImport("Emscripten")] private static extern unsafe int tfws_peek(int h, int* type);
	[DllImport("Emscripten")] private static extern unsafe void tfws_take(int h, byte* buf);
	[DllImport("Emscripten")] private static extern void tfws_close(int h, int code, string reason);
	[DllImport("Emscripten")] private static extern void tfws_free(int h);

	private const int PollMs = 2;

	private int handle;
	// Bumped by the page (see above). Never freed: a poller on another thread may still read it after
	// Abort, and it's 4 bytes per connection.
	private readonly unsafe int* signal = (int*)NativeMemory.AllocZeroed(sizeof(int));
	private int refreshedAt = -1; // the signal when Refresh last asked the page
	private int peekedAt = -1; // ... and when ReceiveAsync last did
	private bool mayHaveMore; // the last peek found a message; another may be queued under the same signal
	private WebSocketState state = WebSocketState.None;
	private WebSocketCloseStatus? closeStatus;
	private string closeDescription;
	private byte[] pending; // the rest of a message larger than the caller's buffer
	private int pendingOffset;
	private WebSocketMessageType pendingType;
	private readonly object sendLock = new();

	private unsafe int Signal => Volatile.Read(ref *signal);

	public override WebSocketCloseStatus? CloseStatus => closeStatus;
	public override string CloseStatusDescription => closeDescription;
	public override string SubProtocol => null;
	public override WebSocketState State
	{
		get
		{
			Refresh();
			return state;
		}
	}

	// Replaces WebSocketHandle.ConnectAsync (System.Net.WebSockets.Client, browser build).
	public static void Install()
	{
		Type handleType = typeof(ClientWebSocket).Assembly.GetType("System.Net.WebSockets.WebSocketHandle", throwOnError: true);
		new Harmony("TowerFallBrowser.PolledWebSocket").Patch(
			handleType.GetMethod("ConnectAsync", BindingFlags.Public | BindingFlags.Instance),
			prefix: new HarmonyMethod(typeof(PolledWebSocket).GetMethod(nameof(ConnectPrefix), BindingFlags.NonPublic | BindingFlags.Static)));
	}

	private static bool ConnectPrefix(object __instance, Uri uri, CancellationToken cancellationToken, ref Task __result)
	{
		var socket = new PolledWebSocket();
		AccessTools.Property(__instance.GetType(), "WebSocket").SetValue(__instance, socket);
		__result = Task.Run(() => socket.Connect(uri, cancellationToken), cancellationToken);
		return false;
	}

	private unsafe void Connect(Uri uri, CancellationToken cancellationToken)
	{
		state = WebSocketState.Connecting;
		Console.WriteLine($"[netplay] connecting to {uri}");
		handle = tfws_open(uri.ToString(), signal);
		if (handle == 0)
		{
			state = WebSocketState.Closed;
			throw new WebSocketException(WebSocketError.Faulted, $"Invalid WebSocket URL {uri}");
		}
		int seen = 0; // nothing has happened yet
		while (true)
		{
			int now = Signal;
			int s = now == seen ? 0 : tfws_state(handle);
			seen = now;
			if (s == 1)
			{
				Console.WriteLine($"[netplay] connected to {uri}");
				state = WebSocketState.Open;
				return;
			}
			if (s == 3)
			{
				Refresh();
				throw new WebSocketException(WebSocketError.Faulted, $"Couldn't connect to {uri} ({(int?)closeStatus})");
			}
			if (cancellationToken.IsCancellationRequested)
			{
				Abort();
				cancellationToken.ThrowIfCancellationRequested();
			}
			Thread.Sleep(PollMs);
		}
	}

	private unsafe void Refresh()
	{
		if (handle == 0 || state is WebSocketState.Closed or WebSocketState.Aborted) return;
		int now = Signal;
		if (now == refreshedAt) return;
		refreshedAt = now;
		int s = tfws_state(handle);
		if (s == 3)
		{
			byte* reason = stackalloc byte[256];
			int code = tfws_close_info(handle, reason, 256);
			closeStatus = (WebSocketCloseStatus)code;
			closeDescription = Marshal.PtrToStringUTF8((IntPtr)reason);
			// Messages that arrived before the close are still delivered by ReceiveAsync.
			state = state == WebSocketState.CloseSent ? WebSocketState.Closed : WebSocketState.CloseReceived;
		}
	}

	public override unsafe Task SendAsync(ArraySegment<byte> buffer, WebSocketMessageType messageType, bool endOfMessage, CancellationToken cancellationToken)
	{
		// TF.EX sends whole messages; fragments would need buffering here.
		lock (sendLock)
		{
			fixed (byte* p = buffer.Array)
			{
				if (tfws_send(handle, p + buffer.Offset, (nuint)buffer.Count, messageType == WebSocketMessageType.Text ? 1 : 0) != 0)
				{
					return Task.FromException(new WebSocketException(WebSocketError.InvalidState, "The WebSocket isn't open."));
				}
			}
		}
		return Task.CompletedTask;
	}

	public override unsafe Task<WebSocketReceiveResult> ReceiveAsync(ArraySegment<byte> buffer, CancellationToken cancellationToken)
	{
		while (pending == null)
		{
			int now = Signal;
			if (now != peekedAt || mayHaveMore)
			{
				peekedAt = now;
				int type;
				int length = tfws_peek(handle, &type);
				mayHaveMore = length >= 0;
				if (length >= 0)
				{
					pending = new byte[length];
					fixed (byte* p = pending)
					{
						tfws_take(handle, p);
					}
					pendingOffset = 0;
					pendingType = type == 1 ? WebSocketMessageType.Text : WebSocketMessageType.Binary;
					break;
				}
				Refresh();
				if (state is WebSocketState.CloseReceived or WebSocketState.Closed)
				{
					state = WebSocketState.Closed;
					return Task.FromResult(new WebSocketReceiveResult(0, WebSocketMessageType.Close, true, closeStatus, closeDescription));
				}
			}
			if (cancellationToken.IsCancellationRequested) return Task.FromCanceled<WebSocketReceiveResult>(cancellationToken);
			Thread.Sleep(PollMs);
		}
		int count = Math.Min(buffer.Count, pending.Length - pendingOffset);
		Buffer.BlockCopy(pending, pendingOffset, buffer.Array, buffer.Offset, count);
		pendingOffset += count;
		bool end = pendingOffset == pending.Length;
		WebSocketMessageType messageType = pendingType;
		if (end) pending = null;
		return Task.FromResult(new WebSocketReceiveResult(count, messageType, end));
	}

	public override Task CloseAsync(WebSocketCloseStatus closeStatus, string statusDescription, CancellationToken cancellationToken)
	{
		CloseOutput(closeStatus, statusDescription);
		return Task.Run(() =>
		{
			for (int i = 0, seen = -1; i < 2500; i++, Thread.Sleep(PollMs))
			{
				int now = Signal;
				if (now != seen && tfws_state(handle) == 3) break;
				seen = now;
			}
			Refresh();
			state = WebSocketState.Closed;
		}, cancellationToken);
	}

	public override Task CloseOutputAsync(WebSocketCloseStatus closeStatus, string statusDescription, CancellationToken cancellationToken)
	{
		CloseOutput(closeStatus, statusDescription);
		return Task.CompletedTask;
	}

	private void CloseOutput(WebSocketCloseStatus status, string description)
	{
		if (handle == 0 || state is WebSocketState.Closed or WebSocketState.Aborted or WebSocketState.CloseSent) return;
		tfws_close(handle, (int)status, description);
		state = state == WebSocketState.CloseReceived ? WebSocketState.Closed : WebSocketState.CloseSent;
	}

	public override void Abort()
	{
		if (handle != 0) tfws_free(handle);
		handle = 0;
		state = WebSocketState.Aborted;
	}

	public override void Dispose()
	{
		if (handle != 0) tfws_free(handle);
		handle = 0;
		if (state != WebSocketState.Aborted) state = WebSocketState.Closed;
	}
}
