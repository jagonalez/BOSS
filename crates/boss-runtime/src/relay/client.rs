//! Outbound half of remote access. Port of `src/main/relay-client.ts`.
//!
//! The desktop dials the relay, so no inbound port is opened. The relay
//! speaks first with a nonce; this desktop answers with a signature over it,
//! the relay admits it to the room its key owns, and from then on every
//! payload in either direction is sealed with the room key the relay never
//! sees. A phone that only scanned the QR code holds a one-time pairing
//! secret; its claim is sealed with that instead and answered with the room
//! secret and a device token.

use super::buffer::EventBuffer;
use super::crypto::{AesKey, derive_key, hash_token, new_peer_id, open, random_bytes, same_secret, seal, to_base64url};
use super::host::{RelayHost, RuntimeHost};
use super::identity::RelayIdentity;
use super::protocol::{
    Hello, OutboundFrame, PairingPayload, PairingStatus, RELAY_MAX_FRAME_BYTES, RELAY_PROTOCOL_VERSION, RelayConfigFile,
    RelayMessage, RelayState, RemoteAccessStatus, StoredDevice, UnknownDevice, encode_pairing, new_secret, now_ms,
    pairing_qr_png, reconnect_delay,
};
use super::wire::{event_forwarded, relay_request_allowed};
use crate::runtime::Runtime;
use base64::Engine as _;
use futures::{SinkExt, StreamExt};
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{Mutex, broadcast, mpsc, watch};
use tokio_tungstenite::tungstenite::Message;

/// A pairing code is short-lived; an unused one must not stay valid.
const PAIRING_TTL: Duration = Duration::from_secs(5 * 60);

/// How many recent events are kept so a phone that slept can catch up.
/// A typical event is ~320 bytes, so this is roughly 0.3 MB.
const EVENT_BUFFER_SIZE: usize = 1000;

/// Ceiling on how many frames one response may take (~12 MB of payload).
const MAX_RESPONSE_CHUNKS: usize = 32;

/// The relay pings every 30 s. A socket silent for three of those is dead,
/// whatever the kernel thinks; drop it and reconnect.
const IDLE_TIMEOUT: Duration = Duration::from_secs(90);

/// Where the relay client keeps its files.
#[derive(Clone, Debug)]
pub struct RelayConfig {
    /// Directory holding `remote-access.json` and `remote-access-key.json`.
    pub data_dir: PathBuf,
    /// Relay URL to use instead of the stored one. `None` keeps what the
    /// config file says (or the default).
    pub url: Option<String>,
}

impl RelayConfig {
    /// Files under `data_dir`, stored relay URL.
    pub fn in_dir(data_dir: impl Into<PathBuf>) -> Self {
        Self { data_dir: data_dir.into(), url: None }
    }
}

/// The `remote.set` patch from the settings page.
#[derive(Clone, Debug, Default)]
pub struct RemotePatch {
    pub enabled: Option<bool>,
    pub relay_url: Option<String>,
    /// Forget and block one phone by its public key.
    pub forget_device_id: Option<String>,
    /// Rotate the room secret, signing every phone out at once.
    pub revoke_all: bool,
}

struct Pairing {
    secret: String,
    code: String,
    expires_at: i64,
}

enum Outbound {
    Text(String),
    Close,
}

struct Inner {
    config: RelayConfigFile,
    state: RelayState,
    last_error: Option<String>,
    attempt: u32,
    key: AesKey,
    device_id: Option<String>,
    peer_id: String,
    /// Sequencing is monotonic per desktop run; a restart resets it and the
    /// buffer reports a gap, so a phone refetches rather than trusting stale
    /// numbers.
    events: EventBuffer,
    pairing: Option<Pairing>,
    /// Who is in the room right now, as the relay reports it: peer id → public key.
    present: HashMap<String, String>,
    /// Keys seen in the room that never paired: key → (first, last) seen.
    unknown: HashMap<String, (i64, i64)>,
    /// Writer half of the live socket, if any.
    outbound: Option<mpsc::UnboundedSender<Outbound>>,
    connection: Option<tokio::task::JoinHandle<()>>,
    /// Bumped on every (re)start so a superseded connection loop exits.
    generation: u64,
    /// Stopping must not trigger the reconnect loop.
    closing: bool,
}

struct Shared {
    inner: Mutex<Inner>,
    host: Arc<dyn RelayHost>,
    identity: RelayIdentity,
    config_file: PathBuf,
    status: watch::Sender<RemoteAccessStatus>,
    handle: tokio::runtime::Handle,
}

/// Starts the relay client.
pub struct RelayClient;

impl RelayClient {
    /// Connect the desktop to the relay on behalf of `runtime`. Dials only if
    /// remote access is enabled in the stored config; the handle turns it on.
    pub fn start(runtime: Arc<Runtime>, config: RelayConfig) -> RelayHandle {
        let handle = runtime.handle.clone();
        let host = RuntimeHost::new(runtime);
        Self::start_with_host(host, config, handle)
    }

    /// The same, against any host. Tests use a fake.
    pub fn start_with_host(host: Arc<dyn RelayHost>, config: RelayConfig, handle: tokio::runtime::Handle) -> RelayHandle {
        let config_file = config.data_dir.join("remote-access.json");
        let identity = RelayIdentity::new(config.data_dir.join("remote-access-key.json"));
        let mut stored = RelayConfigFile::load(&config_file);
        if let Some(url) = config.url.filter(|u| !u.trim().is_empty()) {
            stored.relay_url = url.trim().to_string();
        }
        let key = derive_key(&stored.secret);
        let inner = Inner {
            config: stored,
            state: RelayState::Off,
            last_error: None,
            attempt: 0,
            key,
            device_id: None,
            peer_id: new_peer_id(),
            events: EventBuffer::new(EVENT_BUFFER_SIZE),
            pairing: None,
            present: HashMap::new(),
            unknown: HashMap::new(),
            outbound: None,
            connection: None,
            generation: 0,
            closing: false,
        };
        let (status, _) = watch::channel(status_of(&inner));
        let shared = Arc::new(Shared { inner: Mutex::new(inner), host, identity, config_file, status, handle: handle.clone() });

        // Forward events for the life of the handle.
        let weak = Arc::downgrade(&shared);
        let mut events = shared.host.events();
        handle.spawn(async move {
            loop {
                match events.recv().await {
                    Ok(event) => {
                        if !event_forwarded(&event) {
                            continue;
                        }
                        let Some(shared) = weak.upgrade() else { break };
                        shared.broadcast(event).await;
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        });

        let enabled = shared.status.borrow().enabled;
        if enabled {
            let shared = shared.clone();
            handle.spawn(async move { shared.open_socket().await });
        }
        RelayHandle { shared }
    }
}

fn status_of(inner: &Inner) -> RemoteAccessStatus {
    let online = inner.state == RelayState::Online;
    let now = now_ms();
    RemoteAccessStatus {
        enabled: inner.config.enabled,
        relay_url: inner.config.relay_url.clone(),
        state: inner.state,
        error: inner.last_error.clone(),
        pairing: inner
            .pairing
            .as_ref()
            .filter(|p| p.expires_at >= now)
            .map(|p| PairingStatus { code: p.code.clone(), expires_at: p.expires_at }),
        devices: inner.config.devices.iter().map(|d| d.public(online && d.online)).collect(),
        unknown: if online {
            inner.unknown.iter().map(|(id, (first, last))| UnknownDevice { id: id.clone(), first_seen_at: *first, last_seen_at: *last }).collect()
        } else {
            vec![]
        },
    }
}

impl Shared {
    fn notify(&self, inner: &Inner) {
        self.status.send_replace(status_of(inner));
    }

    fn save(&self, inner: &Inner) {
        // Remote access keeps working in memory if persistence is unavailable.
        if let Err(error) = inner.config.save(&self.config_file) {
            tracing::warn!(error = %error, "remote access config not saved");
        }
    }

    /// Dial the relay. Every failure path retries, because the common
    /// causes — no network, a sleeping laptop, a redeploying relay — all
    /// resolve on their own.
    async fn open_socket(self: &Arc<Self>) {
        let generation = {
            let mut inner = self.inner.lock().await;
            if inner.connection.as_ref().is_some_and(|c| !c.is_finished()) || inner.closing {
                return;
            }
            inner.state = RelayState::Connecting;
            inner.last_error = None;
            inner.key = derive_key(&inner.config.secret);
            inner.device_id = self.identity.room_id().ok();
            inner.generation += 1;
            self.notify(&inner);
            inner.generation
        };
        let shared = self.clone();
        let task = self.handle.spawn(async move { shared.run_connection(generation).await });
        self.inner.lock().await.connection = Some(task);
    }

    async fn run_connection(self: Arc<Self>, generation: u64) {
        loop {
            let url = {
                let mut inner = self.inner.lock().await;
                if inner.closing || !inner.config.enabled || inner.generation != generation {
                    inner.state = RelayState::Off;
                    self.notify(&inner);
                    return;
                }
                inner.state = RelayState::Connecting;
                self.notify(&inner);
                inner.config.relay_url.clone()
            };

            let delay = match tokio_tungstenite::connect_async(url.as_str()).await {
                Err(error) => {
                    let mut inner = self.inner.lock().await;
                    inner.state = RelayState::Error;
                    inner.last_error = Some(error.to_string());
                    let delay = reconnect_delay(inner.attempt);
                    inner.attempt += 1;
                    self.notify(&inner);
                    delay
                }
                Ok((socket, _)) => {
                    let (mut sink, mut stream) = socket.split();
                    let (tx, mut rx) = mpsc::unbounded_channel::<Outbound>();
                    {
                        let mut inner = self.inner.lock().await;
                        inner.attempt = 0;
                        inner.outbound = Some(tx);
                    }
                    let writer = self.handle.spawn(async move {
                        while let Some(out) = rx.recv().await {
                            match out {
                                Outbound::Text(text) => {
                                    if sink.send(Message::Text(text.into())).await.is_err() {
                                        break;
                                    }
                                }
                                Outbound::Close => {
                                    let _ = sink.send(Message::Close(None)).await;
                                    break;
                                }
                            }
                        }
                    });

                    // No hello here. The relay speaks first with a nonce, and
                    // receive() answers it. Pongs to the relay's pings are
                    // written by tungstenite while reading.
                    loop {
                        match tokio::time::timeout(IDLE_TIMEOUT, stream.next()).await {
                            Ok(Some(Ok(Message::Text(text)))) => self.receive(text.as_str()).await,
                            Ok(Some(Ok(Message::Close(_)))) | Ok(None) => break,
                            Ok(Some(Ok(_))) => {}
                            Ok(Some(Err(error))) => {
                                self.inner.lock().await.last_error = Some(error.to_string());
                                break;
                            }
                            Err(_) => {
                                self.inner.lock().await.last_error = Some("relay went silent".into());
                                break;
                            }
                        }
                    }
                    writer.abort();

                    let mut inner = self.inner.lock().await;
                    inner.outbound = None;
                    // Presence came from the relay over this socket. Without it
                    // we know nothing, and a device left showing "connected"
                    // would be a lie.
                    inner.present.clear();
                    inner.unknown.clear();
                    for device in &mut inner.config.devices {
                        device.online = false;
                    }
                    if inner.closing || !inner.config.enabled || inner.generation != generation {
                        inner.state = RelayState::Off;
                        self.notify(&inner);
                        return;
                    }
                    inner.state = RelayState::Connecting;
                    let delay = reconnect_delay(inner.attempt);
                    inner.attempt += 1;
                    self.notify(&inner);
                    delay
                }
            };
            tokio::time::sleep(delay).await;
        }
    }

    fn send_raw(inner: &Inner, text: String) -> bool {
        match &inner.outbound {
            Some(tx) => tx.send(Outbound::Text(text)).is_ok(),
            None => false,
        }
    }

    /// Seal and send one frame, or report that it was too large to send. The
    /// relay closes the whole socket on an oversized frame, so the caller
    /// answers with something the phone can render instead.
    fn send_locked(inner: &Inner, to: Option<&str>, message: &RelayMessage, key: Option<&AesKey>) -> bool {
        if inner.outbound.is_none() {
            return false;
        }
        let sealed = seal(key.unwrap_or(&inner.key), message);
        let frame = serde_json::to_string(&OutboundFrame { sealed, to: to.map(str::to_owned) }).expect("frame serializes");
        if frame.len() > RELAY_MAX_FRAME_BYTES {
            return false;
        }
        Self::send_raw(inner, frame)
    }

    /// `to` of `None` fans out to every paired phone; that is how events flow.
    async fn send_to(&self, to: Option<&str>, message: &RelayMessage, key: Option<&AesKey>) -> bool {
        Self::send_locked(&*self.inner.lock().await, to, message, key)
    }

    /// Answer the relay's challenge. The room id is derived locally from the
    /// public key, so both sides compute the same room without exchanging it.
    async fn greet(&self, nonce: &str) {
        let mut inner = self.inner.lock().await;
        let hello = self.identity.room_id().and_then(|room| {
            inner.device_id = Some(room.clone());
            let public_key = self.identity.public_key()?;
            let signature = self.identity.sign(nonce, &room, "desktop")?;
            Ok(Hello::desktop(&inner.peer_id, &public_key, &signature))
        });
        match hello {
            Ok(hello) => {
                Self::send_raw(&inner, serde_json::to_string(&hello).expect("hello serializes"));
            }
            Err(error) => {
                // Without a usable key this desktop can never join, so surface
                // it rather than reconnecting in a loop that cannot succeed.
                inner.last_error = Some(error.to_string());
                self.notify(&inner);
            }
        }
    }

    async fn receive(self: &Arc<Self>, raw: &str) {
        let Ok(frame) = serde_json::from_str::<Value>(raw) else { return };
        let kind = frame.get("type").and_then(Value::as_str);
        if kind == Some("challenge") {
            if let Some(nonce) = frame.get("nonce").and_then(Value::as_str) {
                self.greet(nonce).await;
            }
            return;
        }
        // Relay control frames carry no user content.
        if let Some(kind) = kind.filter(|k| *k != "frame") {
            let mut inner = self.inner.lock().await;
            match kind {
                "error" => {
                    inner.last_error = Some(frame.get("message").and_then(Value::as_str).unwrap_or("relay error").to_string());
                }
                "phone.online" => {
                    if let (Some(key), Some(peer)) = (frame.get("publicKey").and_then(Value::as_str), frame.get("peerId").and_then(Value::as_str)) {
                        Self::note_presence(&mut inner, key, peer);
                    }
                }
                "phone.offline" => {
                    if let Some(peer) = frame.get("peerId").and_then(Value::as_str) {
                        inner.present.remove(peer);
                    }
                    if let Some(key) = frame.get("publicKey").and_then(Value::as_str)
                        && let Some(device) = inner.config.devices.iter_mut().find(|d| d.id == key)
                    {
                        device.online = false;
                    }
                }
                "welcome" => {
                    // Online only once the relay has accepted the signature.
                    inner.state = RelayState::Online;
                    inner.last_error = None;
                }
                _ => {}
            }
            self.notify(&inner);
            return;
        }

        let Some(sealed) = frame.get("sealed").and_then(Value::as_str) else { return };
        let peer_id = frame.get("peerId").and_then(Value::as_str).unwrap_or("").to_string();

        let (message, key) = {
            let inner = self.inner.lock().await;
            let mut opened = open(&inner.key, sealed).map(|m| (m, inner.key));
            // A phone that has only scanned the QR code holds the one-time
            // pairing secret, so its claim is sealed with a different key. Try
            // that too, but only while a code is live.
            if opened.is_none()
                && let Some(pairing) = inner.pairing.as_ref().filter(|p| p.expires_at >= now_ms())
            {
                let pairing_key = derive_key(&pairing.secret);
                opened = open(&pairing_key, sealed).map(|m| (m, pairing_key));
            }
            // A frame we cannot decrypt is not from a paired phone. Drop it
            // silently: an error reply would tell a prober the room is live.
            let Some((message, key)) = opened else { return };
            (message, key)
        };
        let Ok(message) = serde_json::from_value::<RelayMessage>(message) else { return };
        match message {
            RelayMessage::Claim { secret, label } => self.complete_claim(&peer_id, &secret, label.as_deref(), &key).await,
            RelayMessage::Resume { since, token } => self.resume(&peer_id, since, &token).await,
            RelayMessage::Request { id, request, token } => {
                // Serve off the reader so a slow request never blocks the socket.
                let shared = self.clone();
                self.handle.spawn(async move { shared.serve(&peer_id, id, request, token).await });
            }
            _ => {}
        }
    }

    /// Record a phone the relay admitted to this room. A paired key is marked
    /// online; an unknown key is held as a sighting for the settings page.
    fn note_presence(inner: &mut Inner, public_key: &str, peer_id: &str) {
        inner.present.insert(peer_id.to_string(), public_key.to_string());
        let now = now_ms();
        if let Some(device) = inner.config.devices.iter_mut().find(|d| d.id == public_key) {
            device.online = true;
            device.last_seen_at = Some(now);
            inner.unknown.remove(public_key);
        } else {
            let first = inner.unknown.get(public_key).map(|(first, _)| *first).unwrap_or(now);
            inner.unknown.insert(public_key.to_string(), (first, now));
        }
    }

    /// A phone proves it holds the pairing code by sealing a claim with the
    /// key derived from it. It gets the long-lived secret back, sealed with
    /// that same pairing key, and its own device token.
    async fn complete_claim(&self, peer_id: &str, secret: &str, label: Option<&str>, opened_with: &AesKey) {
        let mut inner = self.inner.lock().await;
        let Some(pairing) = inner.pairing.as_ref() else {
            tracing::warn!("relay claim arrived but no pairing code is active");
            return;
        };
        if pairing.expires_at < now_ms() {
            tracing::warn!("relay claim arrived but the pairing code had expired");
            return;
        }
        if !same_secret(secret, &pairing.secret) {
            tracing::warn!("relay claim arrived with a secret that does not match the shown code");
            return;
        }
        let pairing_key = derive_key(&pairing.secret);
        if opened_with != &pairing_key {
            // Sealed with the room key by a phone that already holds it, yet
            // claiming again: refuse rather than mint a token for a stale flow.
            tracing::warn!("relay claim was not sealed with the pairing key");
            return;
        }
        // Identity is the key the relay verified, learned from presence and
        // correlated by peer id. A phone picks a fresh peer id every pairing.
        let Some(public_key) = inner.present.get(peer_id).cloned() else {
            tracing::warn!("relay claim arrived from a peer the relay never announced");
            return;
        };
        if inner.config.blocked.contains(&public_key) {
            tracing::warn!("relay claim refused: this device was forgotten");
            return;
        }

        // Each phone gets its own token, so revoking one does not sign out the rest.
        let token = to_base64url(&random_bytes(24));
        let now = now_ms();
        let previous = inner.config.devices.iter().find(|d| d.id == public_key).map(|d| d.paired_at);
        let device = StoredDevice {
            id: public_key.clone(),
            label: label.filter(|l| !l.is_empty()).unwrap_or("Phone").chars().take(40).collect(),
            // Re-pairing the same phone keeps its original pairing date.
            paired_at: previous.unwrap_or(now),
            last_seen_at: Some(now),
            online: true,
            token_hash: hash_token(&token),
        };
        inner.unknown.remove(&public_key);
        inner.config.devices.retain(|d| d.id != public_key);
        inner.config.devices.push(device);
        self.save(&inner);
        let reply = RelayMessage::Claimed { secret: inner.config.secret.clone(), token, role: "control".into() };
        Self::send_locked(&inner, Some(peer_id), &reply, Some(&pairing_key));
        // A pairing code is single-use: consuming it here stops a second scan.
        inner.pairing = None;
        self.notify(&inner);
    }

    /// The token must match a phone still on the paired list.
    fn device_index(inner: &Inner, token: &str) -> Option<usize> {
        if token.is_empty() {
            return None;
        }
        let hash = hash_token(token);
        inner.config.devices.iter().position(|d| same_secret(&d.token_hash, &hash))
    }

    /// Run one request locally, under the shared relay allowlist.
    async fn serve(&self, peer_id: &str, id: String, request: Value, token: String) {
        let result: Result<Value, String> = async {
            {
                let mut inner = self.inner.lock().await;
                // A revoked phone still holds the room key, so this check —
                // not the decryption — is what actually ends its access.
                let index = Self::device_index(&inner, &token).ok_or("This device is no longer paired. Scan the QR code again.")?;
                let device = &mut inner.config.devices[index];
                device.last_seen_at = Some(now_ms());
                device.online = true;
            }
            let kind = request.get("type").and_then(Value::as_str).ok_or("malformed request")?;
            if !relay_request_allowed(kind) {
                return Err(format!("\"{kind}\" is not available over remote access."));
            }
            self.host.handle(request).await
        }
        .await;

        match result {
            Ok(result) => {
                if self.send_to(Some(peer_id), &RelayMessage::ok(&id, result.clone()), None).await {
                    return;
                }
                // Too large for one frame, so send it in several.
                if self.send_chunked(peer_id, &id, &result).await {
                    return;
                }
                let error = "This is too large to load over the relay. Open it on your desktop, or over Tailscale.";
                self.send_to(Some(peer_id), &RelayMessage::err(&id, error), None).await;
            }
            Err(error) => {
                self.send_to(Some(peer_id), &RelayMessage::err(&id, error), None).await;
            }
        }
    }

    /// Send one response as a sequence of chunks. The payload is base64
    /// before cutting, so any cut is safe; each piece is sealed on its own.
    async fn send_chunked(&self, peer_id: &str, id: &str, result: &Value) -> bool {
        let payload = serde_json::json!({ "ok": true, "result": result });
        let encoded = base64::engine::general_purpose::STANDARD.encode(serde_json::to_vec(&payload).expect("payload serializes"));
        // Room for the chunk envelope, and for seal() growing what it is given
        // by a further third when it base64s the ciphertext.
        let slice = (RELAY_MAX_FRAME_BYTES - 2_000) * 3 / 4;
        let total = encoded.len().div_ceil(slice);
        if total > MAX_RESPONSE_CHUNKS {
            return false;
        }
        for index in 0..total {
            let end = ((index + 1) * slice).min(encoded.len());
            let body = encoded[index * slice..end].to_string();
            let chunk = RelayMessage::Chunk { id: id.to_string(), index, total, body };
            if !self.send_to(Some(peer_id), &chunk, None).await {
                return false;
            }
        }
        true
    }

    /// Number and retain an event, then fan it out. Only while online: the
    /// TypeScript client subscribed at `welcome` and unsubscribed on close.
    async fn broadcast(&self, event: Value) {
        let mut inner = self.inner.lock().await;
        if inner.state != RelayState::Online {
            return;
        }
        let seq = inner.events.push(event.clone());
        Self::send_locked(&inner, None, &RelayMessage::Event { event, seq }, None);
    }

    /// Answer a reconnecting phone. A gap is reported rather than a partial
    /// stream: a visible refetch beats a thread quietly missing messages.
    async fn resume(&self, peer_id: &str, since: i64, token: &str) {
        let inner = self.inner.lock().await;
        if Self::device_index(&inner, token).is_none() {
            return;
        }
        let result = inner.events.since(since.max(0) as u64);
        let reply = RelayMessage::Resumed { events: result.events, gap: result.gap, seq: result.seq };
        Self::send_locked(&inner, Some(peer_id), &reply, None);
    }

    /// Start pairing. The code carries the relay address, this desktop's room
    /// id and a one-time secret; the long-lived secret is handed over only
    /// after the phone proves it holds that code.
    async fn begin_pairing(self: &Arc<Self>) -> RemoteAccessStatus {
        let mut inner = self.inner.lock().await;
        let secret = to_base64url(&random_bytes(18));
        let device_id = match inner.device_id.clone().or_else(|| self.identity.room_id().ok()) {
            Some(id) => id,
            None => {
                inner.last_error = Some("relay identity is unusable".into());
                self.notify(&inner);
                return status_of(&inner);
            }
        };
        inner.device_id = Some(device_id.clone());
        let expires_at = now_ms() + PAIRING_TTL.as_millis() as i64;
        let code = encode_pairing(&PairingPayload { v: RELAY_PROTOCOL_VERSION, r: inner.config.relay_url.clone(), d: device_id, s: secret.clone() });
        inner.pairing = Some(Pairing { secret: secret.clone(), code, expires_at });
        self.notify(&inner);
        drop(inner);

        let shared = self.clone();
        self.handle.spawn(async move {
            tokio::time::sleep(PAIRING_TTL).await;
            let mut inner = shared.inner.lock().await;
            if inner.pairing.as_ref().is_some_and(|p| p.secret == secret) {
                inner.pairing = None;
                shared.notify(&inner);
            }
        });
        self.status.borrow().clone()
    }

    async fn stop_locked(&self, inner: &mut Inner) {
        inner.closing = true;
        if let Some(tx) = inner.outbound.take() {
            let _ = tx.send(Outbound::Close);
        }
        if let Some(task) = inner.connection.take() {
            // Give the writer a moment to put the close frame on the wire.
            tokio::time::sleep(Duration::from_millis(20)).await;
            task.abort();
        }
        inner.present.clear();
        inner.unknown.clear();
        for device in &mut inner.config.devices {
            device.online = false;
        }
        inner.state = RelayState::Off;
        inner.closing = false;
        self.notify(inner);
    }
}

/// The running relay client. Cloneable; the client stops when every handle
/// is dropped or `stop` is called.
#[derive(Clone)]
pub struct RelayHandle {
    shared: Arc<Shared>,
}

impl RelayHandle {
    /// What the settings page shows right now.
    pub fn status(&self) -> RemoteAccessStatus {
        self.shared.status.borrow().clone()
    }

    /// A watch that changes whenever the status does.
    pub fn watch(&self) -> watch::Receiver<RemoteAccessStatus> {
        self.shared.status.subscribe()
    }

    /// Apply a settings change: enable or disable, change the relay, forget a
    /// phone, or sign every phone out. Restarts the socket when needed.
    pub async fn apply(&self, patch: RemotePatch) -> RemoteAccessStatus {
        let shared = &self.shared;
        let restart = {
            let mut inner = shared.inner.lock().await;
            if let Some(url) = patch.relay_url.as_deref().map(str::trim).filter(|u| !u.is_empty()) {
                inner.config.relay_url = url.to_string();
            }
            if let Some(enabled) = patch.enabled {
                inner.config.enabled = enabled;
            }
            if let Some(id) = patch.forget_device_id.as_deref() {
                // Block as well as remove. The phone still holds the room
                // secret, so deleting the row alone would let it re-pair.
                inner.config.devices.retain(|d| d.id != id);
                if !inner.config.blocked.iter().any(|b| b == id) {
                    inner.config.blocked.push(id.to_string());
                }
                inner.unknown.remove(id);
            }
            if patch.revoke_all {
                // Rotating the secret moves this desktop to a new room, which
                // signs out every phone at once and empties the block list.
                inner.config.secret = new_secret();
                inner.key = derive_key(&inner.config.secret);
                inner.config.devices.clear();
                inner.config.blocked.clear();
                inner.unknown.clear();
            }
            shared.save(&inner);
            let restart = patch.enabled.is_some() || patch.relay_url.is_some() || patch.revoke_all;
            if restart {
                shared.stop_locked(&mut inner).await;
            }
            shared.notify(&inner);
            restart && inner.config.enabled
        };
        if restart {
            shared.open_socket().await;
        }
        self.status()
    }

    /// Show a pairing code. Works before the socket has ever connected: the
    /// room is derived from the keypair, not learned from the relay.
    pub async fn begin_pairing(&self) -> RemoteAccessStatus {
        self.shared.begin_pairing().await
    }

    /// Take the pairing code off screen.
    pub async fn cancel_pairing(&self) -> RemoteAccessStatus {
        let mut inner = self.shared.inner.lock().await;
        inner.pairing = None;
        self.shared.notify(&inner);
        status_of(&inner)
    }

    /// The live pairing code — the URL the phone scans — if one is on screen.
    pub fn pairing_payload(&self) -> Option<String> {
        self.status().pairing.map(|p| p.code)
    }

    /// The live pairing code as a PNG QR image, for the settings page.
    pub fn pairing_qr_png(&self) -> Option<Vec<u8>> {
        pairing_qr_png(&self.pairing_payload()?).ok()
    }

    /// This desktop's room id (the hash of its public key).
    pub fn room_id(&self) -> Option<String> {
        self.shared.identity.room_id().ok()
    }

    /// Close the socket and stop reconnecting. `apply` with `enabled` can start it again.
    pub async fn stop(&self) {
        let mut inner = self.shared.inner.lock().await;
        self.shared.stop_locked(&mut inner).await;
    }

    #[cfg(test)]
    async fn inner(&self) -> tokio::sync::MutexGuard<'_, Inner> {
        self.shared.inner.lock().await
    }

    #[cfg(test)]
    async fn feed(&self, raw: &str) {
        self.shared.receive(raw).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::relay::crypto::{challenge_message, from_base64url, room_id_for_key};
    use async_trait::async_trait;
    use ed25519_dalek::{Verifier, VerifyingKey};
    use serde_json::json;

    struct FakeHost {
        events: broadcast::Sender<Value>,
    }

    #[async_trait]
    impl RelayHost for FakeHost {
        async fn handle(&self, request: Value) -> Result<Value, String> {
            match request["type"].as_str() {
                Some("thread.list") => Ok(json!([{ "threadId": "t1" }])),
                Some("supervision.snapshot") => Ok(json!({ "threads": [], "big": "x".repeat(700_000) })),
                Some("thread.abort") => Err("nothing running".into()),
                other => Err(format!("unexpected {other:?}")),
            }
        }
        fn events(&self) -> broadcast::Receiver<Value> {
            self.events.subscribe()
        }
    }

    struct Harness {
        handle: RelayHandle,
        host_events: broadcast::Sender<Value>,
        rx: mpsc::UnboundedReceiver<Outbound>,
        dir: PathBuf,
    }

    async fn harness() -> Harness {
        let dir = std::env::temp_dir().join(format!("boss-relay-client-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        let (host_events, _) = broadcast::channel(64);
        let host: Arc<dyn RelayHost> = Arc::new(FakeHost { events: host_events.clone() });
        let handle = RelayClient::start_with_host(host, RelayConfig { data_dir: dir.clone(), url: Some("wss://relay.test".into()) }, tokio::runtime::Handle::current());
        // Stand in for the socket writer: everything "sent" lands here.
        let (tx, rx) = mpsc::unbounded_channel();
        handle.inner().await.outbound = Some(tx);
        Harness { handle, host_events, rx, dir }
    }

    async fn next_text(rx: &mut mpsc::UnboundedReceiver<Outbound>) -> String {
        match tokio::time::timeout(Duration::from_secs(2), rx.recv()).await.expect("a frame within 2s").expect("channel open") {
            Outbound::Text(text) => text,
            Outbound::Close => panic!("unexpected close"),
        }
    }

    fn sealed_frame(key: &AesKey, peer: &str, message: &RelayMessage) -> String {
        json!({ "deviceId": "room", "from": "phone", "peerId": peer, "sealed": seal(key, message) }).to_string()
    }

    async fn opened(rx: &mut mpsc::UnboundedReceiver<Outbound>, key: &AesKey) -> (Option<String>, RelayMessage) {
        let frame: OutboundFrame = serde_json::from_str(&next_text(rx).await).unwrap();
        let message = serde_json::from_value(open(key, &frame.sealed).expect("opens with the expected key")).unwrap();
        (frame.to, message)
    }

    const PHONE_KEY: &str = "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo";

    #[tokio::test]
    async fn a_pairing_code_names_the_room_and_expires_on_cancel() {
        let h = harness().await;
        assert_eq!(h.handle.status().state, RelayState::Off);
        assert!(!h.handle.status().enabled);
        let status = h.handle.begin_pairing().await;
        let code = status.pairing.as_ref().unwrap().code.clone();
        let payload = crate::relay::protocol::decode_pairing(&code).unwrap();
        assert_eq!(payload.r, "wss://relay.test");
        assert_eq!(payload.d, h.handle.room_id().unwrap());
        assert_eq!(payload.s.len(), 24, "18 random bytes");
        assert!(code.starts_with("https://relay.test/#p="));
        assert_eq!(h.handle.pairing_payload().as_deref(), Some(code.as_str()));
        assert!(h.handle.pairing_qr_png().unwrap().starts_with(b"\x89PNG"));
        h.handle.cancel_pairing().await;
        assert!(h.handle.pairing_payload().is_none());
    }

    #[tokio::test]
    async fn handshake_pairing_requests_events_and_resume_match_the_protocol() {
        let mut h = harness().await;
        h.handle.inner().await.config.enabled = true;

        // The relay speaks first; the answer is a signed hello for our room.
        h.handle.feed(r#"{"type":"challenge","nonce":"nonce-1"}"#).await;
        let hello: Hello = serde_json::from_str(&next_text(&mut h.rx).await).unwrap();
        assert_eq!((hello.kind.as_str(), hello.side.as_str(), hello.v), ("hello", "desktop", 1));
        let room = room_id_for_key(&hello.public_key).unwrap();
        assert_eq!(room, h.handle.room_id().unwrap());
        let verifying = VerifyingKey::from_bytes(&from_base64url(&hello.public_key).unwrap().try_into().unwrap()).unwrap();
        let signature = ed25519_dalek::Signature::from_slice(&from_base64url(&hello.signature).unwrap()).unwrap();
        assert!(verifying.verify(&challenge_message("nonce-1", &room, "desktop"), &signature).is_ok());
        assert_eq!(h.handle.status().state, RelayState::Off, "not online until the relay says welcome");

        h.handle.feed(r#"{"type":"welcome","deviceId":"room","peerId":"me","desktopOnline":true}"#).await;
        assert_eq!(h.handle.status().state, RelayState::Online);

        // An unpaired phone in the room is a sighting, not a device.
        h.handle.feed(&json!({ "type": "phone.online", "publicKey": PHONE_KEY, "peerId": "p1" }).to_string()).await;
        let status = h.handle.status();
        assert!(status.devices.is_empty());
        assert_eq!(status.unknown.len(), 1);
        assert_eq!(status.unknown[0].id, PHONE_KEY);

        // A claim before any code is shown is ignored; one sealed with the
        // pairing key while a code is live completes pairing.
        let room_key = h.handle.inner().await.key;
        let pairing = h.handle.begin_pairing().await.pairing.unwrap();
        let secret = crate::relay::protocol::decode_pairing(&pairing.code).unwrap().s;
        let pairing_key = derive_key(&secret);
        h.handle.feed(&sealed_frame(&room_key, "p1", &RelayMessage::Claim { secret: "wrong".into(), label: None })).await;
        h.handle.feed(&sealed_frame(&pairing_key, "p1", &RelayMessage::Claim { secret: secret.clone(), label: Some("iPhone".into()) })).await;
        let (to, claimed) = opened(&mut h.rx, &pairing_key).await;
        assert_eq!(to.as_deref(), Some("p1"));
        let RelayMessage::Claimed { secret: handed, token, role } = claimed else { panic!("expected claimed, got {claimed:?}") };
        assert_eq!(role, "control");
        assert_eq!(derive_key(&handed), room_key, "the phone is handed the long-lived room secret");
        let status = h.handle.status();
        assert!(status.pairing.is_none(), "a pairing code is single-use");
        assert_eq!(status.devices.len(), 1);
        assert_eq!(status.devices[0].label, "iPhone");
        assert!(status.devices[0].online);
        assert!(status.unknown.is_empty());
        let stored = RelayConfigFile::load(&h.dir.join("remote-access.json"));
        assert_eq!(stored.devices[0].id, PHONE_KEY);
        assert_eq!(stored.devices[0].token_hash, hash_token(&token));

        // A request with the device token is served through the host.
        let request = RelayMessage::Request { id: "1".into(), request: json!({ "type": "thread.list" }), token: token.clone() };
        h.handle.feed(&sealed_frame(&room_key, "p1", &request)).await;
        let (to, response) = opened(&mut h.rx, &room_key).await;
        assert_eq!(to.as_deref(), Some("p1"));
        assert_eq!(response, RelayMessage::ok("1", json!([{ "threadId": "t1" }])));

        // A wrong token, a disallowed type and a host error all come back as errors.
        let bad = RelayMessage::Request { id: "2".into(), request: json!({ "type": "thread.list" }), token: "nope".into() };
        h.handle.feed(&sealed_frame(&room_key, "p1", &bad)).await;
        assert_eq!(opened(&mut h.rx, &room_key).await.1, RelayMessage::err("2", "This device is no longer paired. Scan the QR code again."));
        let fork = RelayMessage::Request { id: "3".into(), request: json!({ "type": "thread.fork" }), token: token.clone() };
        h.handle.feed(&sealed_frame(&room_key, "p1", &fork)).await;
        assert_eq!(opened(&mut h.rx, &room_key).await.1, RelayMessage::err("3", "\"thread.fork\" is not available over remote access."));
        let abort = RelayMessage::Request { id: "4".into(), request: json!({ "type": "thread.abort" }), token: token.clone() };
        h.handle.feed(&sealed_frame(&room_key, "p1", &abort)).await;
        assert_eq!(opened(&mut h.rx, &room_key).await.1, RelayMessage::err("4", "nothing running"));

        // A large result is chunked; the pieces reassemble to {ok, result}.
        let big = RelayMessage::Request { id: "5".into(), request: json!({ "type": "supervision.snapshot" }), token: token.clone() };
        h.handle.feed(&sealed_frame(&room_key, "p1", &big)).await;
        let mut parts: Vec<(usize, String)> = vec![];
        loop {
            let (_, chunk) = opened(&mut h.rx, &room_key).await;
            let RelayMessage::Chunk { id, index, total, body } = chunk else { panic!("expected chunk") };
            assert_eq!(id, "5");
            assert!(total >= 2, "700 KB needs more than one frame");
            parts.push((index, body));
            if parts.len() == total {
                break;
            }
        }
        parts.sort_by_key(|(i, _)| *i);
        let joined: String = parts.into_iter().map(|(_, b)| b).collect();
        let payload: Value = serde_json::from_slice(&base64::engine::general_purpose::STANDARD.decode(joined).unwrap()).unwrap();
        assert_eq!(payload["ok"], true);
        assert_eq!(payload["result"]["big"].as_str().unwrap().len(), 700_000);

        // Forwarded events are numbered and fanned out; others are dropped.
        h.host_events.send(json!({ "type": "todo.updated", "properties": {} })).unwrap();
        h.host_events.send(json!({ "type": "session.idle", "properties": { "sessionID": "t1" } })).unwrap();
        let (to, event) = opened(&mut h.rx, &room_key).await;
        assert_eq!(to, None, "events fan out to every phone");
        assert_eq!(event, RelayMessage::Event { event: json!({ "type": "session.idle", "properties": { "sessionID": "t1" } }), seq: 1 });

        // Resume replays from the buffer; an unknown token gets nothing.
        h.handle.feed(&sealed_frame(&room_key, "p1", &RelayMessage::Resume { since: 0, token: token.clone() })).await;
        let (_, resumed) = opened(&mut h.rx, &room_key).await;
        assert_eq!(resumed, RelayMessage::Resumed { events: vec![], gap: false, seq: 1 });
        h.handle.feed(&sealed_frame(&room_key, "p1", &RelayMessage::Resume { since: 5, token: token.clone() })).await;
        let (_, resumed) = opened(&mut h.rx, &room_key).await;
        assert!(matches!(resumed, RelayMessage::Resumed { gap: true, seq: 1, .. }));
        h.handle.feed(&sealed_frame(&room_key, "p1", &RelayMessage::Resume { since: 0, token: "nope".into() })).await;
        assert!(tokio::time::timeout(Duration::from_millis(100), h.rx.recv()).await.is_err());

        // Presence leaving marks the device offline.
        h.handle.feed(&json!({ "type": "phone.offline", "publicKey": PHONE_KEY, "peerId": "p1" }).to_string()).await;
        assert!(!h.handle.status().devices[0].online);

        // Forgetting blocks the key: a re-claim with a fresh code is refused.
        h.handle.apply(RemotePatch { forget_device_id: Some(PHONE_KEY.into()), ..Default::default() }).await;
        assert!(h.handle.status().devices.is_empty());
        assert_eq!(RelayConfigFile::load(&h.dir.join("remote-access.json")).blocked, vec![PHONE_KEY.to_string()]);
        h.handle.inner().await.outbound = Some({
            let (tx, rx) = mpsc::unbounded_channel();
            h.rx = rx;
            tx
        });
        h.handle.inner().await.state = RelayState::Online;
        h.handle.feed(&json!({ "type": "phone.online", "publicKey": PHONE_KEY, "peerId": "p2" }).to_string()).await;
        let pairing = h.handle.begin_pairing().await.pairing.unwrap();
        let secret = crate::relay::protocol::decode_pairing(&pairing.code).unwrap().s;
        h.handle.feed(&sealed_frame(&derive_key(&secret), "p2", &RelayMessage::Claim { secret, label: None })).await;
        assert!(tokio::time::timeout(Duration::from_millis(100), h.rx.recv()).await.is_err(), "a forgotten phone gets no reply");

        // Revoking all rotates the secret and clears the block list.
        let before = h.handle.inner().await.config.secret.clone();
        h.handle.apply(RemotePatch { revoke_all: true, ..Default::default() }).await;
        let stored = RelayConfigFile::load(&h.dir.join("remote-access.json"));
        assert_ne!(stored.secret, before);
        assert!(stored.blocked.is_empty() && stored.devices.is_empty());
    }

    #[tokio::test]
    async fn a_stored_electron_config_keeps_its_pairings_and_key() {
        let dir = std::env::temp_dir().join(format!("boss-relay-client-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("remote-access.json"),
            json!({
                "enabled": false, "relayUrl": "wss://custom.example",
                "secret": "0123456789abcdef0123456789abcdef0123456789a",
                "devices": [{ "id": PHONE_KEY, "label": "Pixel", "pairedAt": 5, "online": true, "tokenHash": hash_token("tok") }],
                "blocked": []
            })
            .to_string(),
        )
        .unwrap();
        std::fs::write(
            dir.join("remote-access-key.json"),
            r#"{"privateKey":"MC4CAQAwBQYDK2VwBCIEIJ1hsZ3v_VpguoRK9JLsLMREScVpezJpGXA7rAMcrn9g","publicKey":"11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo"}"#,
        )
        .unwrap();
        let (events, _) = broadcast::channel(8);
        let host: Arc<dyn RelayHost> = Arc::new(FakeHost { events });
        let handle = RelayClient::start_with_host(host, RelayConfig::in_dir(&dir), tokio::runtime::Handle::current());
        let status = handle.status();
        assert_eq!(status.relay_url, "wss://custom.example");
        assert_eq!(status.devices.len(), 1);
        assert_eq!(status.devices[0].label, "Pixel");
        assert!(!status.devices[0].online, "offline until the relay reports presence");
        assert_eq!(handle.room_id().as_deref(), Some("If4x36FUomFia_hUBG_SJw"));
        assert_eq!(Shared::device_index(&*handle.inner().await, "tok"), Some(0));
        assert_eq!(Shared::device_index(&*handle.inner().await, "other"), None);
    }

    /// Dials a real relay. Binding and connecting are blocked in the sandbox;
    /// run with `RELAY_URL=wss://boss-relay.fly.dev cargo test -- --ignored`.
    #[tokio::test]
    #[ignore]
    async fn connects_to_a_live_relay() {
        let Ok(url) = std::env::var("RELAY_URL") else { return };
        let dir = std::env::temp_dir().join(format!("boss-relay-live-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        let (events, _) = broadcast::channel(8);
        let host: Arc<dyn RelayHost> = Arc::new(FakeHost { events });
        let handle = RelayClient::start_with_host(host, RelayConfig { data_dir: dir, url: Some(url) }, tokio::runtime::Handle::current());
        handle.apply(RemotePatch { enabled: Some(true), ..Default::default() }).await;
        let mut watch = handle.watch();
        let online = tokio::time::timeout(Duration::from_secs(20), async {
            loop {
                if watch.borrow().state == RelayState::Online {
                    return true;
                }
                if watch.changed().await.is_err() {
                    return false;
                }
            }
        })
        .await
        .unwrap_or(false);
        assert!(online, "status: {:?}", handle.status());
        handle.stop().await;
        assert_eq!(handle.status().state, RelayState::Off);
    }
}
