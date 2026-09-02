//! The relay protocol's crypto, byte-compatible with `src/shared/relay.ts`
//! (WebCrypto on the desktop) and `mobile/src/crypto.ts` (`@noble` on the
//! phone): SHA-256 for every derivation, AES-256-GCM with a 12-byte IV and no
//! AAD for every frame, and base64url without padding for every encoding.
//!
//! The test vectors here were produced with Node's WebCrypto, which is what
//! the phone's own `crypto.test.mjs` checks itself against.

use aes_gcm::aead::Aead;
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::Serialize;
use sha2::{Digest, Sha256};

/// Raw AES-256 key, as both endpoints derive it from a shared secret.
pub type AesKey = [u8; 32];

/// Length of an AES-GCM IV on the wire.
pub const IV_BYTES: usize = 12;

/// base64url without padding, the encoding every wire field uses.
pub fn to_base64url(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

/// Decode base64url. Accepts padding and the `+`/`/` alphabet too, as the
/// TypeScript decoder does, so a lenient peer still round-trips.
pub fn from_base64url(value: &str) -> Option<Vec<u8>> {
    let cleaned: String = value
        .trim_end_matches('=')
        .chars()
        .map(|c| match c {
            '+' => '-',
            '/' => '_',
            other => other,
        })
        .collect();
    URL_SAFE_NO_PAD.decode(cleaned).ok()
}

/// SHA-256 of UTF-8 text.
pub fn sha256(input: &[u8]) -> [u8; 32] {
    Sha256::digest(input).into()
}

/// The AES key both endpoints derive from a secret: `SHA-256("boss-relay-key:" + secret)`.
pub fn derive_key(secret: &str) -> AesKey {
    sha256(format!("boss-relay-key:{secret}").as_bytes())
}

/// How a phone's token is stored: `base64url(SHA-256("boss-relay-token:" + token))`.
pub fn hash_token(token: &str) -> String {
    to_base64url(&sha256(format!("boss-relay-token:{token}").as_bytes()))
}

/// `n` bytes from the OS random source.
pub fn random_bytes(n: usize) -> Vec<u8> {
    let mut out = vec![0u8; n];
    rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut out);
    out
}

/// A fresh per-connection peer id: 8 random bytes, base64url.
pub fn new_peer_id() -> String {
    to_base64url(&random_bytes(8))
}

/// Seal plaintext with a caller-chosen IV. Only tests choose the IV; every
/// real frame goes through [`seal`], which draws a fresh one.
pub fn seal_with_iv(key: &AesKey, iv: &[u8; IV_BYTES], plaintext: &[u8]) -> String {
    let cipher = Aes256Gcm::new(key.into());
    let ciphertext = cipher.encrypt(Nonce::from_slice(iv), plaintext).expect("AES-GCM encrypt never fails");
    format!("{}.{}", to_base64url(iv), to_base64url(&ciphertext))
}

/// `base64url(iv) . base64url(ciphertext+tag)` of the message's JSON.
pub fn seal<T: Serialize + ?Sized>(key: &AesKey, message: &T) -> String {
    let iv: [u8; IV_BYTES] = random_bytes(IV_BYTES).try_into().expect("12 bytes");
    let plaintext = serde_json::to_vec(message).expect("relay messages serialize");
    seal_with_iv(key, &iv, &plaintext)
}

/// Decrypt a sealed frame to its plaintext bytes. A wrong key, a truncated
/// frame, or a tampered tag all yield `None`; the caller drops such frames.
pub fn open_bytes(key: &AesKey, sealed: &str) -> Option<Vec<u8>> {
    let (iv_part, body_part) = sealed.split_once('.')?;
    if iv_part.is_empty() || body_part.is_empty() {
        return None;
    }
    let iv = from_base64url(iv_part)?;
    if iv.len() != IV_BYTES {
        return None;
    }
    let body = from_base64url(body_part)?;
    let cipher = Aes256Gcm::new(key.into());
    cipher.decrypt(Nonce::from_slice(&iv), body.as_slice()).ok()
}

/// Decrypt and parse a sealed frame as JSON.
pub fn open(key: &AesKey, sealed: &str) -> Option<serde_json::Value> {
    serde_json::from_slice(&open_bytes(key, sealed)?).ok()
}

/// The room a public key owns: the first 16 bytes of `SHA-256(raw key)`,
/// base64url. Derived from the key on both the relay and the desktop, so it
/// never has to be exchanged.
pub fn room_id_for_key(public_key: &str) -> Option<String> {
    let raw = from_base64url(public_key)?;
    Some(to_base64url(&sha256(&raw)[..16]))
}

/// What a peer signs to join: the nonce, the room and the side are all bound
/// in, so a signature is good for one connection, one room, one role.
pub fn challenge_message(nonce: &str, room_id: &str, side: &str) -> Vec<u8> {
    format!("boss-relay-join {nonce} {room_id} {side}").into_bytes()
}

fn is_base64url_of_len(value: &str, len: usize) -> bool {
    value.len() == len && value.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// A raw Ed25519 public key is 32 bytes, which is 43 base64url characters.
pub fn looks_like_key(value: &str) -> bool {
    is_base64url_of_len(value, 43)
}

/// An Ed25519 signature is 64 bytes, which is 86 base64url characters.
pub fn looks_like_signature(value: &str) -> bool {
    is_base64url_of_len(value, 86)
}

/// Compare secret-derived values without leaking their contents through timing.
pub fn same_secret(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const SECRET: &str = "a-shared-room-secret-for-the-test";

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    #[test]
    fn derive_key_matches_webcrypto() {
        // node: crypto.subtle.digest('SHA-256', 'boss-relay-key:' + SECRET)
        assert_eq!(hex(&derive_key(SECRET)), "f817549061365f25a6698b3f997472b46fe2ec015805abd3268d2f7137746b3d");
    }

    #[test]
    fn hash_token_matches_webcrypto() {
        assert_eq!(hash_token("device-token"), "kT2AjMHHpHE5oVZ7_9Ev2QPch9U6Br0xZzTttTICSEQ");
    }

    #[test]
    fn seal_matches_webcrypto_vector() {
        // node: AES-GCM, key = derive_key(SECRET), iv = 1..12, plaintext {"kind":"ping"}
        let iv = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
        let sealed = seal_with_iv(&derive_key(SECRET), &iv, br#"{"kind":"ping"}"#);
        assert_eq!(sealed, "AQIDBAUGBwgJCgsM.ewPsu24_gn_T8ycQacN095JWrZRr3s1TRtOyHn6BNQ");
    }

    #[test]
    fn open_reads_a_webcrypto_frame() {
        let opened = open(&derive_key(SECRET), "AQIDBAUGBwgJCgsM.ewPsu24_gn_T8ycQacN095JWrZRr3s1TRtOyHn6BNQ");
        assert_eq!(opened, Some(json!({ "kind": "ping" })));
    }

    #[test]
    fn a_sealed_message_round_trips_for_the_holder_of_the_secret() {
        let key = derive_key("secret-one");
        let message = json!({ "kind": "request", "id": "1", "request": { "type": "thread.list" }, "token": "device-token" });
        assert_eq!(open(&key, &seal(&key, &message)), Some(message));
    }

    #[test]
    fn a_different_secret_decrypts_to_nothing() {
        let mine = derive_key("secret-one");
        let theirs = derive_key("secret-two");
        let sealed = seal(&mine, &json!({ "kind": "event", "event": { "type": "message.updated" }, "seq": 1 }));
        assert_eq!(open(&theirs, &sealed), None);
    }

    #[test]
    fn a_tampered_frame_is_rejected() {
        let key = derive_key("secret-one");
        let sealed = seal(&key, &json!({ "kind": "ping" }));
        let (iv, body) = sealed.split_once('.').unwrap();
        let first = if body.starts_with('A') { 'B' } else { 'A' };
        let flipped = format!("{iv}.{first}{}", &body[1..]);
        assert_eq!(open(&key, &flipped), None);
        assert_eq!(open(&key, "no-dot"), None);
        assert_eq!(open(&key, ".x"), None);
        assert_eq!(open(&key, "AQID.x"), None, "a short iv is refused");
    }

    #[test]
    fn every_frame_uses_a_fresh_iv() {
        let key = derive_key("secret-one");
        assert_ne!(seal(&key, &json!({ "kind": "ping" })), seal(&key, &json!({ "kind": "ping" })));
    }

    #[test]
    fn base64url_round_trips_and_is_lenient_on_input() {
        let bytes = random_bytes(32);
        let encoded = to_base64url(&bytes);
        assert!(!encoded.contains(['+', '/', '=']));
        assert_eq!(from_base64url(&encoded).unwrap(), bytes);
        let padded = base64::engine::general_purpose::STANDARD.encode(&bytes);
        assert_eq!(from_base64url(&padded).unwrap(), bytes, "standard alphabet with padding still decodes");
        assert_eq!(from_base64url("!!!"), None);
    }

    #[test]
    fn room_id_is_the_hash_prefix_of_the_key() {
        // RFC 8032 test vector 1's public key; room id computed by node WebCrypto.
        let key = "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo";
        assert_eq!(room_id_for_key(key).as_deref(), Some("If4x36FUomFia_hUBG_SJw"));
        assert_eq!(room_id_for_key("not base64!"), None);
    }

    #[test]
    fn challenge_message_matches_every_client() {
        assert_eq!(challenge_message("n", "room", "phone"), b"boss-relay-join n room phone");
    }

    #[test]
    fn validators_reject_malformed_keys_and_signatures() {
        assert!(looks_like_key("11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo"));
        assert!(!looks_like_key("11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHUR"));
        assert!(!looks_like_key("11qYAYKxCrfVS+7TyWQHOg7hcvPapiMlrwIaaPcHURo"));
        assert!(looks_like_signature(&"a".repeat(86)));
        assert!(!looks_like_signature(&"a".repeat(64)));
    }

    #[test]
    fn same_secret_compares_whole_strings() {
        assert!(same_secret("abc", "abc"));
        assert!(!same_secret("abc", "abd"));
        assert!(!same_secret("abc", "ab"));
    }
}
