//! The part of matchbox_socket 0.12's API that ggrs-ffi uses, for the browser: WebRTC and the
//! matchbox signaling protocol live in netplay/tfnet.js on the page's main thread; these are thin
//! wrappers over its functions. Signaling, peer roles and channel settings match matchbox, so
//! browser peers interoperate with desktop ones.
//!
//! Every tfnet_* call waits for the page's main thread, and ggrs-ffi polls these many hundreds of
//! times a second from several threads. So each socket shares two counters with the page, which
//! bumps the first when packets arrive and the second when anything else changes (peer events,
//! state, our id); a poll whose counter hasn't moved returns at once without calling the page.

use std::collections::HashSet;
use std::fmt;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicI32, Ordering};
use std::sync::Arc;
use std::task::{Context, Poll};

pub use uuid::Uuid;

/// A peer's id, assigned by the signaling server.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct PeerId(pub Uuid);

impl fmt::Display for PeerId {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		write!(f, "{}", self.0)
	}
}

pub type Packet = Box<[u8]>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PeerState {
	Connected,
	Disconnected,
}

/// Why the socket's message loop ended.
#[derive(Debug)]
pub enum Error {
	ConnectionFailed(String),
	Disconnected(String),
}

impl fmt::Display for Error {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		match self {
			Error::ConnectionFailed(e) => write!(f, "connection to the signaling server failed: {e}"),
			Error::Disconnected(e) => write!(f, "disconnected from the signaling server: {e}"),
		}
	}
}

impl std::error::Error for Error {}

#[derive(Debug)]
pub struct ChannelError;

#[derive(Debug)]
pub struct SendError(&'static str);

impl fmt::Display for SendError {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		f.write_str(self.0)
	}
}

extern "C" {
	fn tfnet_open(url: *const u8, len: usize, signal: *mut i32) -> i32;
	fn tfnet_close(h: i32);
	fn tfnet_state(h: i32) -> i32;
	fn tfnet_error(h: i32, buf: *mut u8, cap: usize) -> i32;
	fn tfnet_id(h: i32, out: *mut u8) -> i32;
	fn tfnet_next_event(h: i32, peer: *mut u8) -> i32;
	fn tfnet_send(h: i32, peer: *const u8, data: *const u8, len: usize) -> i32;
	fn tfnet_recv_all(h: i32, buf: *mut u8, cap: usize) -> i32;
}

const RECV_BUFFER: usize = 256 * 1024;
// A buffer with more room than this left after a receive was drained (WebRTC data channel
// messages are at most 64 KiB here).
const RECV_SLACK: usize = 64 * 1024 + 20;

/// The counters the page bumps (see the top): PACKETS when packets arrive, CHANGES for the rest.
/// Shared by a socket, its channel and its message loop future; the page stops writing at close.
type Signal = Arc<[AtomicI32; 2]>;
const PACKETS: usize = 0;
const CHANGES: usize = 1;

/// Tells whether a signal counter moved since the last call (true the first time).
struct Watch {
	counter: usize,
	seen: Option<i32>,
}

impl Watch {
	fn new(counter: usize) -> Self {
		Watch { counter, seen: None }
	}

	fn moved(&mut self, signal: &Signal) -> bool {
		let now = signal[self.counter].load(Ordering::Acquire);
		let moved = self.seen != Some(now);
		self.seen = Some(now);
		moved
	}
}

pub struct WebRtcSocket {
	handle: i32,
	signal: Signal,
	changes: Watch,
	state: i32, // tfnet_state's, as of the last change
	id: Option<PeerId>,
	id_changes: Watch,
	peers: HashSet<PeerId>,
	channel: Option<WebRtcChannel>,
	closed: bool,
}

/// Completes when the signaling connection ends (like matchbox's message loop future).
pub struct MessageLoopFuture {
	handle: i32,
	signal: Signal,
	changes: Watch,
	state: i32,
}

impl Future for MessageLoopFuture {
	type Output = Result<(), Error>;

	// Doesn't register a waker: ggrs-ffi polls this alongside a 10 ms timer, which drives it.
	fn poll(mut self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<Self::Output> {
		let this = &mut *self;
		if this.changes.moved(&this.signal) {
			this.state = unsafe { tfnet_state(this.handle) };
		}
		match this.state {
			0 => Poll::Pending,
			1 => Poll::Ready(Ok(())),
			2 => Poll::Ready(Err(Error::ConnectionFailed(error_of(this.handle)))),
			_ => Poll::Ready(Err(Error::Disconnected(error_of(this.handle)))),
		}
	}
}

fn error_of(handle: i32) -> String {
	let mut buf = vec![0u8; 512];
	let len = unsafe { tfnet_error(handle, buf.as_mut_ptr(), buf.len()) }.max(0) as usize;
	String::from_utf8_lossy(&buf[..len.min(buf.len())]).into_owned()
}

impl WebRtcSocket {
	/// A socket with one unreliable channel (unordered, no retransmits) in the given room.
	pub fn new_unreliable(room_url: impl Into<String>) -> (WebRtcSocket, MessageLoopFuture) {
		let url = room_url.into();
		let signal: Signal = Arc::new([AtomicI32::new(0), AtomicI32::new(0)]);
		let handle = unsafe { tfnet_open(url.as_ptr(), url.len(), signal.as_ptr() as *mut i32) };
		let channel = WebRtcChannel { handle, signal: signal.clone(), packets: Watch::new(PACKETS), buf: Vec::new() };
		(
			WebRtcSocket {
				handle,
				signal: signal.clone(),
				changes: Watch::new(CHANGES),
				state: 0,
				id: None,
				id_changes: Watch::new(CHANGES),
				peers: HashSet::new(),
				channel: Some(channel),
				closed: false,
			},
			MessageLoopFuture { handle, signal, changes: Watch::new(CHANGES), state: 0 },
		)
	}

	/// Our id, once the signaling server has assigned it.
	pub fn id(&mut self) -> Option<PeerId> {
		if self.id.is_none() && self.id_changes.moved(&self.signal) {
			let mut bytes = [0u8; 16];
			if unsafe { tfnet_id(self.handle, bytes.as_mut_ptr()) } == 1 {
				self.id = Some(PeerId(Uuid::from_bytes(bytes)));
			}
		}
		self.id
	}

	/// Peers that connected or disconnected since the last call.
	pub fn update_peers(&mut self) -> Vec<(PeerId, PeerState)> {
		let mut changes = Vec::new();
		if !self.changes.moved(&self.signal) {
			return changes;
		}
		self.state = unsafe { tfnet_state(self.handle) };
		let mut bytes = [0u8; 16];
		loop {
			let event = unsafe { tfnet_next_event(self.handle, bytes.as_mut_ptr()) };
			let peer = PeerId(Uuid::from_bytes(bytes));
			match event {
				1 => {
					self.peers.insert(peer);
					changes.push((peer, PeerState::Connected));
				}
				2 => {
					self.peers.remove(&peer);
					changes.push((peer, PeerState::Disconnected));
				}
				_ => return changes,
			}
		}
	}

	pub fn try_update_peers(&mut self) -> Result<Vec<(PeerId, PeerState)>, Error> {
		let changes = self.update_peers();
		match self.state {
			0 => Ok(changes),
			1 => Err(Error::Disconnected("socket closed".into())),
			2 => Err(Error::ConnectionFailed(error_of(self.handle))),
			_ => Err(Error::Disconnected(error_of(self.handle))),
		}
	}

	pub fn connected_peers(&self) -> impl Iterator<Item = PeerId> + '_ {
		self.peers.iter().copied()
	}

	pub fn take_channel(&mut self, index: usize) -> Result<WebRtcChannel, ChannelError> {
		if index != 0 {
			return Err(ChannelError);
		}
		self.channel.take().ok_or(ChannelError)
	}

	pub fn channel_mut(&mut self, index: usize) -> &mut WebRtcChannel {
		assert_eq!(index, 0, "only channel 0 exists");
		self.channel.as_mut().expect("channel 0 was taken")
	}

	pub fn close(&mut self) {
		if !self.closed {
			self.closed = true;
			unsafe { tfnet_close(self.handle) };
		}
	}
}

impl Drop for WebRtcSocket {
	fn drop(&mut self) {
		self.close();
	}
}

/// A data channel to all peers of a socket.
pub struct WebRtcChannel {
	handle: i32,
	signal: Signal,
	packets: Watch,
	// Reused for every receive (it's called every tick).
	buf: Vec<u8>,
}

impl WebRtcChannel {
	pub fn try_send(&mut self, packet: Packet, peer: PeerId) -> Result<(), SendError> {
		let id = peer.0.into_bytes();
		match unsafe { tfnet_send(self.handle, id.as_ptr(), packet.as_ptr(), packet.len()) } {
			0 => Ok(()),
			-1 => Err(SendError("peer not connected")),
			_ => Err(SendError("data channel send failed")),
		}
	}

	pub fn receive(&mut self) -> Vec<(PeerId, Packet)> {
		let mut out = Vec::new();
		if !self.packets.moved(&self.signal) {
			return out;
		}
		if self.buf.len() != RECV_BUFFER {
			self.buf = vec![0u8; RECV_BUFFER];
		}
		let buf = &mut self.buf;
		loop {
			let written = unsafe { tfnet_recv_all(self.handle, buf.as_mut_ptr(), buf.len()) }.max(0) as usize;
			let mut at = 0;
			while at + 20 <= written {
				let peer = PeerId(Uuid::from_bytes(buf[at..at + 16].try_into().unwrap()));
				let len = u32::from_le_bytes(buf[at + 16..at + 20].try_into().unwrap()) as usize;
				let end = (at + 20 + len).min(written);
				out.push((peer, buf[at + 20..end].to_vec().into_boxed_slice()));
				at = end;
			}
			// tfnet_recv_all stops early only when the next packet doesn't fit; with this much
			// room left, everything waiting was read (packets are far smaller), so skip asking
			// again (each call is a round trip to the page's main thread).
			if written == 0 || RECV_BUFFER - written > RECV_SLACK {
				return out;
			}
		}
	}
}
