//! Wire shapes shared with the relay and the phone. Port of the types in
//! `src/shared/relay.ts`, plus the stored config from `relay-client.ts`.
//!
//! The relay is a dumb pipe: it routes by room and never sees a pairing
//! secret, so every payload it forwards is an opaque `sealed` string and only
//! the envelope fields it needs for routing stay in the clear.

use super::buffer::BufferedEvent;
use super::crypto::{from_base64url, looks_like_key, random_bytes, to_base64url};
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::Path;
use std::time::Duration;

/// Version carried in the hello and the pairing payload.
pub const RELAY_PROTOCOL_VERSION: u32 = 1;

/// Frames larger than this are dropped by the relay and by both clients.
pub const RELAY_MAX_FRAME_BYTES: usize = 512_000;

/// The production relay.
pub const DEFAULT_RELAY_URL: &str = "wss://boss-relay.fly.dev";

/// Decrypted payload. This is what the relay must never be able to read.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum RelayMessage {
    /// Phone → desktop. `token` is the phone's own device token.
    Request {
        id: String,
        request: Value,
        #[serde(default)]
        token: String,
    },
    /// Desktop → phone. `ok: true` carries `result`; `ok: false` carries `error`.
    Response {
        id: String,
        ok: bool,
        #[serde(default, deserialize_with = "present_value", skip_serializing_if = "Option::is_none")]
        result: Option<Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    /// `seq` increases by one per event for the life of the desktop connection.
    Event { event: Value, seq: u64 },
    /// Phone → desktop on reconnect: "send me everything after `since`".
    Resume {
        #[serde(default)]
        since: i64,
        #[serde(default)]
        token: String,
    },
    /// Desktop → phone. `gap` means the phone must refetch instead.
    Resumed { events: Vec<BufferedEvent>, gap: bool, seq: u64 },
    /// One slice of a response too large for a single frame.
    Chunk { id: String, index: usize, total: usize, body: String },
    Ping,
    /// A phone proving it holds the pairing code.
    Claim {
        secret: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        label: Option<String>,
    },
    /// The desktop handing over the room secret and a device token.
    Claimed { secret: String, token: String, role: String },
}

/// Keep a present `null` as `Some(Null)`: an ok response always carries `result`.
fn present_value<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Option<Value>, D::Error> {
    Value::deserialize(deserializer).map(Some)
}

impl RelayMessage {
    /// A successful response. `result` is always present, as `null` when the
    /// handler returned nothing, matching `result ?? null` on the desktop.
    pub fn ok(id: impl Into<String>, result: Value) -> Self {
        RelayMessage::Response { id: id.into(), ok: true, result: Some(result), error: None }
    }

    /// A failed response.
    pub fn err(id: impl Into<String>, error: impl Into<String>) -> Self {
        RelayMessage::Response { id: id.into(), ok: false, result: None, error: Some(error.into()) }
    }
}

/// The relay-visible envelope a desktop sends: sealed payload plus an
/// optional addressee. No `to` fans out to every phone in the room.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct OutboundFrame {
    pub sealed: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to: Option<String>,
}

/// The signed hello that answers the relay's challenge.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hello {
    #[serde(rename = "type")]
    pub kind: String,
    pub side: String,
    pub peer_id: String,
    pub public_key: String,
    pub signature: String,
    pub v: u32,
}

impl Hello {
    /// A desktop hello.
    pub fn desktop(peer_id: &str, public_key: &str, signature: &str) -> Self {
        Self {
            kind: "hello".into(),
            side: "desktop".into(),
            peer_id: peer_id.into(),
            public_key: public_key.into(),
            signature: signature.into(),
            v: RELAY_PROTOCOL_VERSION,
        }
    }
}

/// A pairing payload, encoded into the QR code the desktop shows.
/// `s` is the one-time pairing secret and never reaches the relay.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PairingPayload {
    pub v: u32,
    /// Relay base URL, e.g. `wss://boss-relay.fly.dev`.
    pub r: String,
    /// The desktop's room id.
    pub d: String,
    /// One-time pairing secret, base64url.
    pub s: String,
}

/// Encode a pairing code as an ordinary web URL pointing at the relay, with
/// the payload in the fragment so browsers never send it to the server. A
/// phone camera opens http(s) links and refuses custom schemes.
pub fn encode_pairing(payload: &PairingPayload) -> String {
    let json = serde_json::to_string(payload).expect("pairing payload serializes");
    let encoded = to_base64url(json.as_bytes());
    let base = payload.r.trim_end_matches('/');
    let base = if let Some(rest) = base.strip_prefix("wss://") {
        format!("https://{rest}")
    } else if let Some(rest) = base.strip_prefix("ws://") {
        format!("http://{rest}")
    } else {
        base.to_string()
    };
    format!("{base}/#p={encoded}")
}

/// Accepts the fragment form and the older `?p=` form.
pub fn decode_pairing(input: &str) -> Option<PairingPayload> {
    let trimmed = input.trim();
    let start = trimmed.find("#p=").or_else(|| trimmed.find("?p=")).or_else(|| trimmed.find("&p="))? + 3;
    let encoded: String = trimmed[start..]
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect();
    if encoded.is_empty() {
        return None;
    }
    let parsed: PairingPayload = serde_json::from_slice(&from_base64url(&encoded)?).ok()?;
    if parsed.v != RELAY_PROTOCOL_VERSION || parsed.r.is_empty() || parsed.d.is_empty() || parsed.s.is_empty() {
        return None;
    }
    Some(parsed)
}

/// The pairing code as a PNG QR image: 8-bit grayscale, 4 pixels per module,
/// with the standard 4-module quiet zone.
pub fn pairing_qr_png(code: &str) -> Result<Vec<u8>> {
    const SCALE: usize = 4;
    const QUIET: usize = 4;
    let qr = qrcode::QrCode::new(code.as_bytes()).context("encode pairing QR")?;
    let modules = qr.width();
    let side = (modules + 2 * QUIET) * SCALE;
    let colors = qr.to_colors();
    let mut pixels = vec![255u8; side * side];
    for (index, color) in colors.iter().enumerate() {
        if *color != qrcode::Color::Dark {
            continue;
        }
        let (mx, my) = (index % modules + QUIET, index / modules + QUIET);
        for dy in 0..SCALE {
            let row = (my * SCALE + dy) * side;
            pixels[row + mx * SCALE..row + (mx + 1) * SCALE].fill(0);
        }
    }
    let mut out = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut out, side as u32, side as u32);
        encoder.set_color(png::ColorType::Grayscale);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().context("png header")?;
        writer.write_image_data(&pixels).context("png data")?;
    }
    Ok(out)
}

/// Backoff for the desktop's outbound socket. Capped so a long outage still
/// reconnects promptly; jittered so a relay restart does not stampede.
pub fn reconnect_delay(attempt: u32) -> Duration {
    let base = (500u64 * 2u64.pow(attempt.min(6))).min(30_000) as f64;
    let jitter: f64 = rand::Rng::gen_range(&mut rand::thread_rng(), 0.5..1.0);
    Duration::from_millis((base * jitter).round() as u64)
}

/// Connection state of the desktop's outbound socket.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RelayState {
    Off,
    Connecting,
    Online,
    Error,
}

/// A paired phone as the settings page sees it. `id` is the phone's Ed25519
/// public key, base64url: the same phone forever, whatever peer id it picks.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteDevice {
    pub id: String,
    pub label: String,
    pub paired_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_seen_at: Option<i64>,
    pub online: bool,
}

/// A key seen in this desktop's room that has never completed pairing.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnknownDevice {
    pub id: String,
    pub first_seen_at: i64,
    pub last_seen_at: i64,
}

/// Stored form of a paired phone. `token_hash` lets the desktop verify a
/// phone without keeping the token itself.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredDevice {
    pub id: String,
    pub label: String,
    pub paired_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_seen_at: Option<i64>,
    #[serde(default)]
    pub online: bool,
    pub token_hash: String,
}

impl StoredDevice {
    /// The settings-page view: everything but the token hash.
    pub fn public(&self, online: bool) -> RemoteDevice {
        RemoteDevice {
            id: self.id.clone(),
            label: self.label.clone(),
            paired_at: self.paired_at,
            last_seen_at: self.last_seen_at,
            online,
        }
    }
}

/// Set while a pairing QR code is on screen.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingStatus {
    pub code: String,
    pub expires_at: i64,
}

/// What the settings page shows.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteAccessStatus {
    pub enabled: bool,
    pub relay_url: String,
    pub state: RelayState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pairing: Option<PairingStatus>,
    pub devices: Vec<RemoteDevice>,
    pub unknown: Vec<UnknownDevice>,
}

/// The persisted config: `remote-access.json` in the Electron app's userData.
/// Same shape, so existing pairings survive the port.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayConfigFile {
    pub enabled: bool,
    pub relay_url: String,
    /// Long-lived room secret. Derives the transport key; rotating it moves
    /// this desktop to a new room and signs out every phone at once.
    pub secret: String,
    pub devices: Vec<StoredDevice>,
    /// Public keys that were forgotten and must not re-pair.
    #[serde(default)]
    pub blocked: Vec<String>,
}

impl RelayConfigFile {
    /// A fresh config with a new room secret.
    pub fn fresh() -> Self {
        Self {
            enabled: false,
            relay_url: DEFAULT_RELAY_URL.into(),
            secret: new_secret(),
            devices: vec![],
            blocked: vec![],
        }
    }

    /// Parse the file's text the way the TypeScript loader does: a usable
    /// secret keeps the config, devices not keyed by a public key are dropped,
    /// and anything damaged falls back to a fresh secret.
    pub fn parse(text: &str) -> Self {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Loose {
            #[serde(default)]
            enabled: bool,
            #[serde(default)]
            relay_url: Option<String>,
            #[serde(default)]
            secret: Option<String>,
            #[serde(default)]
            devices: Vec<Value>,
            #[serde(default)]
            blocked: Vec<Value>,
        }
        let Ok(parsed) = serde_json::from_str::<Loose>(text) else { return Self::fresh() };
        let Some(secret) = parsed.secret.filter(|s| s.len() >= 32) else { return Self::fresh() };
        Self {
            enabled: parsed.enabled,
            relay_url: parsed.relay_url.filter(|u| !u.is_empty()).unwrap_or_else(|| DEFAULT_RELAY_URL.into()),
            secret,
            devices: parsed
                .devices
                .into_iter()
                .filter_map(|d| serde_json::from_value::<StoredDevice>(d).ok())
                .filter(|d| looks_like_key(&d.id))
                .collect(),
            blocked: parsed
                .blocked
                .into_iter()
                .filter_map(|b| b.as_str().map(str::to_owned))
                .filter(|b| looks_like_key(b))
                .collect(),
        }
    }

    /// Load from disk; a missing or damaged file yields a fresh config.
    pub fn load(path: &Path) -> Self {
        match std::fs::read_to_string(path) {
            Ok(text) => Self::parse(&text),
            Err(_) => Self::fresh(),
        }
    }

    /// Write pretty JSON, as the TypeScript client did.
    pub fn save(&self, path: &Path) -> Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
        }
        std::fs::write(path, serde_json::to_string_pretty(self)?).with_context(|| format!("write {}", path.display()))
    }
}

/// A new room secret: 32 random bytes, base64url.
pub fn new_secret() -> String {
    to_base64url(&random_bytes(32))
}

/// Milliseconds since the epoch, the `Date.now()` the wire uses.
pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn relay_messages_serialize_to_the_shapes_the_phone_parses() {
        let cases: Vec<(RelayMessage, Value)> = vec![
            (
                RelayMessage::ok("1", Value::Null),
                json!({ "kind": "response", "id": "1", "ok": true, "result": null }),
            ),
            (
                RelayMessage::err("2", "nope"),
                json!({ "kind": "response", "id": "2", "ok": false, "error": "nope" }),
            ),
            (
                RelayMessage::Event { event: json!({ "type": "session.idle" }), seq: 3 },
                json!({ "kind": "event", "event": { "type": "session.idle" }, "seq": 3 }),
            ),
            (
                RelayMessage::Resumed { events: vec![], gap: true, seq: 9 },
                json!({ "kind": "resumed", "events": [], "gap": true, "seq": 9 }),
            ),
            (
                RelayMessage::Chunk { id: "4".into(), index: 0, total: 2, body: "QUJD".into() },
                json!({ "kind": "chunk", "id": "4", "index": 0, "total": 2, "body": "QUJD" }),
            ),
            (RelayMessage::Ping, json!({ "kind": "ping" })),
            (
                RelayMessage::Claimed { secret: "s".into(), token: "t".into(), role: "control".into() },
                json!({ "kind": "claimed", "secret": "s", "token": "t", "role": "control" }),
            ),
        ];
        for (message, expected) in cases {
            assert_eq!(serde_json::to_value(&message).unwrap(), expected);
            assert_eq!(serde_json::from_value::<RelayMessage>(expected).unwrap(), message);
        }
    }

    #[test]
    fn phone_messages_parse() {
        let claim: RelayMessage = serde_json::from_value(json!({ "kind": "claim", "secret": "one-time", "label": "iPhone" })).unwrap();
        assert_eq!(claim, RelayMessage::Claim { secret: "one-time".into(), label: Some("iPhone".into()) });
        let resume: RelayMessage = serde_json::from_value(json!({ "kind": "resume", "since": 12, "token": "t" })).unwrap();
        assert_eq!(resume, RelayMessage::Resume { since: 12, token: "t".into() });
        let request: RelayMessage =
            serde_json::from_value(json!({ "kind": "request", "id": "7", "request": { "type": "thread.list" }, "token": "t" })).unwrap();
        assert!(matches!(request, RelayMessage::Request { id, .. } if id == "7"));
    }

    #[test]
    fn outbound_frames_omit_an_absent_addressee() {
        let fanout = OutboundFrame { sealed: "x.y".into(), to: None };
        assert_eq!(serde_json::to_string(&fanout).unwrap(), r#"{"sealed":"x.y"}"#);
        let direct = OutboundFrame { sealed: "x.y".into(), to: Some("p1".into()) };
        assert_eq!(serde_json::to_string(&direct).unwrap(), r#"{"sealed":"x.y","to":"p1"}"#);
    }

    #[test]
    fn hello_has_the_fields_the_relay_checks() {
        let hello = Hello::desktop("peer", "key", "sig");
        assert_eq!(
            serde_json::to_value(&hello).unwrap(),
            json!({ "type": "hello", "side": "desktop", "peerId": "peer", "publicKey": "key", "signature": "sig", "v": 1 })
        );
    }

    #[test]
    fn a_pairing_code_matches_the_typescript_encoding_exactly() {
        // node: encodePairing({ v: 1, r: 'wss://boss-relay.fly.dev', d: 'If4x36FUomFia_hUBG_SJw', s: 'secret-1' })
        let payload = PairingPayload { v: 1, r: "wss://boss-relay.fly.dev".into(), d: "If4x36FUomFia_hUBG_SJw".into(), s: "secret-1".into() };
        assert_eq!(
            encode_pairing(&payload),
            "https://boss-relay.fly.dev/#p=eyJ2IjoxLCJyIjoid3NzOi8vYm9zcy1yZWxheS5mbHkuZGV2IiwiZCI6IklmNHgzNkZVb21GaWFfaFVCR19TSnciLCJzIjoic2VjcmV0LTEifQ"
        );
        assert_eq!(decode_pairing(&encode_pairing(&payload)), Some(payload));
    }

    #[test]
    fn the_pairing_code_is_a_web_url_with_the_secret_in_the_fragment() {
        let code = encode_pairing(&PairingPayload { v: 1, r: "wss://relay.example/".into(), d: "d1".into(), s: "the-secret".into() });
        assert!(code.starts_with("https://relay.example/#p="));
        let (before, fragment) = code.split_once('#').unwrap();
        assert!(!before.contains("p="));
        assert!(fragment.starts_with("p="));
        assert_eq!(decode_pairing(&code).unwrap().s, "the-secret");
    }

    #[test]
    fn a_ws_relay_maps_to_http_so_a_local_test_pairs_too() {
        let code = encode_pairing(&PairingPayload { v: 1, r: "ws://192.168.1.84:8080".into(), d: "d1".into(), s: "s1".into() });
        assert!(code.starts_with("http://192.168.1.84:8080/#p="));
        assert_eq!(decode_pairing(&code).unwrap().r, "ws://192.168.1.84:8080");
        assert_eq!(decode_pairing("boss://pair?p=eyJ2IjoxLCJyIjoid3NzOi8vYm9zcy1yZWxheS5mbHkuZGV2IiwiZCI6IklmNHgzNkZVb21GaWFfaFVCR19TSnciLCJzIjoic2VjcmV0LTEifQ").map(|p| p.s), Some("secret-1".to_string()));
    }

    #[test]
    fn a_malformed_or_wrong_version_pairing_code_is_refused() {
        assert_eq!(decode_pairing("not a pairing code"), None);
        assert_eq!(decode_pairing("boss://pair?p=!!!!"), None);
        let wrong = encode_pairing(&PairingPayload { v: 2, r: "https://r".into(), d: "d".into(), s: "s".into() });
        assert_eq!(decode_pairing(&wrong), None);
    }

    #[test]
    fn the_qr_png_decodes_as_a_square_grayscale_image() {
        let png_bytes = pairing_qr_png("https://boss-relay.fly.dev/#p=abc").unwrap();
        let decoder = png::Decoder::new(std::io::Cursor::new(png_bytes));
        let mut reader = decoder.read_info().unwrap();
        let info = reader.info();
        assert_eq!(info.width, info.height);
        assert_eq!(info.color_type, png::ColorType::Grayscale);
        let mut buf = vec![0; reader.output_buffer_size()];
        let frame = reader.next_frame(&mut buf).unwrap();
        let pixels = &buf[..frame.buffer_size()];
        assert!(pixels.contains(&0) && pixels.contains(&255), "both dark and light modules are drawn");
        // The quiet zone is blank: the first row is all white.
        assert!(pixels[..frame.width as usize].iter().all(|p| *p == 255));
    }

    #[test]
    fn reconnect_backoff_grows_and_then_stays_bounded() {
        for attempt in 0..12 {
            let delay = reconnect_delay(attempt).as_millis();
            assert!((250..=30_000).contains(&delay), "attempt {attempt} waited {delay}ms");
        }
        let early = (0..40).map(|_| reconnect_delay(0)).max().unwrap();
        let late = (0..40).map(|_| reconnect_delay(8)).min().unwrap();
        assert!(early < late, "later attempts must wait longer");
    }

    #[test]
    fn config_files_written_by_the_electron_app_load_with_their_pairings() {
        let text = r#"{
  "enabled": true,
  "relayUrl": "wss://boss-relay.fly.dev",
  "secret": "0123456789abcdef0123456789abcdef0123456789a",
  "devices": [
    { "id": "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo", "label": "iPhone", "pairedAt": 1700000000000, "lastSeenAt": 1700000001000, "online": true, "tokenHash": "kT2AjMHHpHE5oVZ7_9Ev2QPch9U6Br0xZzTttTICSEQ" },
    { "id": "legacy-peer-id", "label": "Old", "pairedAt": 1, "online": false, "tokenHash": "x" }
  ],
  "blocked": ["11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo", "junk"]
}"#;
        let config = RelayConfigFile::parse(text);
        assert!(config.enabled);
        assert_eq!(config.devices.len(), 1, "devices keyed by a peer id are dropped");
        assert_eq!(config.devices[0].label, "iPhone");
        assert_eq!(config.blocked, vec!["11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo".to_string()]);

        let round = RelayConfigFile::parse(&serde_json::to_string_pretty(&config).unwrap());
        assert_eq!(round, config);
    }

    #[test]
    fn a_short_secret_or_damaged_file_yields_a_fresh_config() {
        let short = RelayConfigFile::parse(r#"{"enabled":true,"secret":"short"}"#);
        assert!(!short.enabled);
        assert_eq!(short.secret.len(), 43);
        assert_eq!(short.relay_url, DEFAULT_RELAY_URL);
        assert_ne!(RelayConfigFile::parse("{").secret, RelayConfigFile::parse("{").secret, "each fresh config draws its own secret");
    }

    #[test]
    fn status_serializes_camel_case_for_the_settings_page() {
        let status = RemoteAccessStatus {
            enabled: true,
            relay_url: "wss://r".into(),
            state: RelayState::Online,
            error: None,
            pairing: Some(PairingStatus { code: "c".into(), expires_at: 5 }),
            devices: vec![RemoteDevice { id: "k".into(), label: "P".into(), paired_at: 1, last_seen_at: None, online: true }],
            unknown: vec![],
        };
        assert_eq!(
            serde_json::to_value(&status).unwrap(),
            json!({
                "enabled": true, "relayUrl": "wss://r", "state": "online",
                "pairing": { "code": "c", "expiresAt": 5 },
                "devices": [{ "id": "k", "label": "P", "pairedAt": 1, "online": true }],
                "unknown": []
            })
        );
    }
}
