//! The part of matchbox_socket 0.12's API that ggrs-ffi uses, for the browser: WebRTC and the
//! matchbox signaling protocol live in netplay/tfnet.js on the page's main thread; these are thin
//! wrappers over its functions. Signaling, peer roles and channel settings match matchbox, so
//! browser peers interoperate with desktop ones.

use std::collections::HashSet;
use std::fmt;
use std::future::Future;
use std::pin::Pin;
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
	fn tfnet_open(url: *const u8, len: usize) -> i32;
	fn tfnet_close(h: i32);
	fn tfnet_state(h: i32) -> i32;
	fn tfnet_error(h: i32, buf: *mut u8, cap: usize) -> i32;
	fn tfnet_id(h: i32, out: *mut u8) -> i32;
	fn tfnet_next_event(h: i32, peer: *mut u8) -> i32;
	fn tfnet_send(h: i32, peer: *const u8, data: *const u8, len: usize) -> i32;
	fn tfnet_recv_all(h: i32, buf: *mut u8, cap: usize) -> i32;
}

const RECV_BUFFER: usize = 256 * 1024;

pub struct WebRtcSocket {
	handle: i32,
	peers: HashSet<PeerId>,
	channel: Option<WebRtcChannel>,
	closed: bool,
}

/// Completes when the signaling connection ends (like matchbox's message loop future).
pub struct MessageLoopFuture {
	handle: i32,
}

impl Future for MessageLoopFuture {
	type Output = Result<(), Error>;

	// Doesn't register a waker: ggrs-ffi polls this alongside a 10 ms timer, which drives it.
	fn poll(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<Self::Output> {
		match unsafe { tfnet_state(self.handle) } {
			0 => Poll::Pending,
			1 => Poll::Ready(Ok(())),
			2 => Poll::Ready(Err(Error::ConnectionFailed(error_of(self.handle)))),
			_ => Poll::Ready(Err(Error::Disconnected(error_of(self.handle)))),
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
		let handle = unsafe { tfnet_open(url.as_ptr(), url.len()) };
		(
			WebRtcSocket { handle, peers: HashSet::new(), channel: Some(WebRtcChannel { handle }), closed: false },
			MessageLoopFuture { handle },
		)
	}

	/// Our id, once the signaling server has assigned it.
	pub fn id(&mut self) -> Option<PeerId> {
		let mut bytes = [0u8; 16];
		(unsafe { tfnet_id(self.handle, bytes.as_mut_ptr()) } == 1).then(|| PeerId(Uuid::from_bytes(bytes)))
	}

	/// Peers that connected or disconnected since the last call.
	pub fn update_peers(&mut self) -> Vec<(PeerId, PeerState)> {
		let mut changes = Vec::new();
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
		match unsafe { tfnet_state(self.handle) } {
			0 => Ok(self.update_peers()),
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
		let mut buf = vec![0u8; RECV_BUFFER];
		loop {
			let written = unsafe { tfnet_recv_all(self.handle, buf.as_mut_ptr(), buf.len()) }.max(0) as usize;
			if written == 0 {
				return out;
			}
			let mut at = 0;
			while at + 20 <= written {
				let peer = PeerId(Uuid::from_bytes(buf[at..at + 16].try_into().unwrap()));
				let len = u32::from_le_bytes(buf[at + 16..at + 20].try_into().unwrap()) as usize;
				let end = (at + 20 + len).min(written);
				out.push((peer, buf[at + 20..end].to_vec().into_boxed_slice()));
				at = end;
			}
		}
	}
}
