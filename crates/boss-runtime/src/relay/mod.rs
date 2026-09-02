//! Mobile access through the relay: the desktop side.
//!
//! Port of `src/main/relay-client.ts`, `src/shared/relay.ts`,
//! `src/shared/identity.ts`, `src/main/relay-identity.ts` and
//! `src/shared/event-buffer.ts`. The relay server (`relay/`) and the phone app
//! (`mobile/`) are unchanged, so every byte on the wire here must match what
//! they already speak.
//!
//! - `crypto`   — SHA-256 derivations, AES-256-GCM sealing, base64url.
//! - `identity` — this desktop's Ed25519 keypair and the room it owns.
//! - `buffer`   — sequenced replay buffer backing phone resume.
//! - `protocol` — frame and message shapes, pairing codes, stored config.
//! - `wire`     — old `MessageWithParts` / event JSON the phone expects.
//! - `host`     — serves phone requests against the `Runtime`.
//! - `client`   — the WebSocket connection, reconnects, pairing, presence.

pub mod buffer;
pub mod client;
pub mod crypto;
pub mod host;
pub mod identity;
pub mod protocol;
pub mod wire;

pub use buffer::{BufferedEvent, EventBuffer, ResumeResult};
pub use client::{RelayClient, RelayConfig, RelayHandle, RemotePatch};
pub use host::{RelayHost, RuntimeHost};
pub use identity::RelayIdentity;
pub use protocol::{
    DEFAULT_RELAY_URL, PairingPayload, RELAY_MAX_FRAME_BYTES, RELAY_PROTOCOL_VERSION, RelayMessage, RelayState,
    RemoteAccessStatus, RemoteDevice, StoredDevice, UnknownDevice, decode_pairing, encode_pairing, pairing_qr_png,
    reconnect_delay,
};
