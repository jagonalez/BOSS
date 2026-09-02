//! This desktop's relay identity: one Ed25519 keypair, generated on first use
//! and kept beside the remote-access config. Port of `src/main/relay-identity.ts`.
//!
//! The file is `{ "privateKey": base64url(pkcs8), "publicKey": base64url(raw) }`,
//! exactly what Node's WebCrypto exported, so a keypair written by the
//! Electron app keeps its room here and no phone has to re-pair.

use super::crypto::{challenge_message, from_base64url, to_base64url};
use anyhow::{Context, Result, anyhow};
use ed25519_dalek::{Signer, SigningKey};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// PKCS#8 v1 wrapper for an Ed25519 private key: a fixed 16-byte DER prefix
/// followed by the 32-byte seed. This is the only form WebCrypto exports.
const PKCS8_PREFIX: [u8; 16] = [
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
];

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredKeypair {
    private_key: String,
    public_key: String,
}

/// The seed inside a PKCS#8 Ed25519 private key, or `None` if the bytes are
/// not that exact shape.
pub fn seed_from_pkcs8(bytes: &[u8]) -> Option<[u8; 32]> {
    if bytes.len() != PKCS8_PREFIX.len() + 32 || bytes[..PKCS8_PREFIX.len()] != PKCS8_PREFIX {
        return None;
    }
    bytes[PKCS8_PREFIX.len()..].try_into().ok()
}

/// Wrap a seed the way WebCrypto's `exportKey('pkcs8')` does.
pub fn pkcs8_from_seed(seed: &[u8; 32]) -> Vec<u8> {
    let mut out = PKCS8_PREFIX.to_vec();
    out.extend_from_slice(seed);
    out
}

/// This desktop's Ed25519 keypair. Owns the room; the private half never
/// leaves the machine.
pub struct RelayIdentity {
    file: PathBuf,
    keys: Mutex<Option<(SigningKey, String)>>,
}

impl RelayIdentity {
    /// An identity stored at `file`. Nothing is read until first use.
    pub fn new(file: impl Into<PathBuf>) -> Self {
        Self { file: file.into(), keys: Mutex::new(None) }
    }

    /// Where the keypair lives.
    pub fn path(&self) -> &Path {
        &self.file
    }

    /// Load the stored keypair, or generate and store one. Generation happens
    /// once per file: the room id is the hash of the public key, so a key that
    /// changed would move the room and sign every phone out.
    fn load(&self) -> Result<(SigningKey, String)> {
        let mut guard = self.keys.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(keys) = guard.as_ref() {
            return Ok(keys.clone());
        }
        if let Some(keys) = self.read_stored() {
            *guard = Some(keys.clone());
            return Ok(keys);
        }
        let seed: [u8; 32] = super::crypto::random_bytes(32).try_into().expect("32 bytes");
        let signing = SigningKey::from_bytes(&seed);
        let public_key = to_base64url(&signing.verifying_key().to_bytes());
        let stored = StoredKeypair {
            private_key: to_base64url(&pkcs8_from_seed(&signing.to_bytes())),
            public_key: public_key.clone(),
        };
        // A damaged or unwritable file is worth a warning, not a refusal to
        // run: the desktop gets a new room every launch until it is fixed.
        if let Err(error) = self.write_stored(&stored) {
            tracing::warn!(file = %self.file.display(), error = %error, "relay identity not persisted");
        }
        *guard = Some((signing.clone(), public_key.clone()));
        Ok((signing, public_key))
    }

    fn read_stored(&self) -> Option<(SigningKey, String)> {
        let text = std::fs::read_to_string(&self.file).ok()?;
        let stored: StoredKeypair = serde_json::from_str(&text).ok()?;
        let seed = seed_from_pkcs8(&from_base64url(&stored.private_key)?)?;
        let signing = SigningKey::from_bytes(&seed);
        // Trust the private key over the recorded public one: they must agree,
        // and the relay derives the room from what we actually sign with.
        let public_key = to_base64url(&signing.verifying_key().to_bytes());
        if public_key != stored.public_key {
            tracing::warn!(file = %self.file.display(), "relay identity public key did not match its private key");
        }
        Some((signing, public_key))
    }

    fn write_stored(&self, stored: &StoredKeypair) -> Result<()> {
        if let Some(parent) = self.file.parent() {
            std::fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
        }
        let json = serde_json::to_string_pretty(stored)?;
        std::fs::write(&self.file, json).with_context(|| format!("write {}", self.file.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&self.file, std::fs::Permissions::from_mode(0o600))?;
        }
        Ok(())
    }

    /// The raw public key, base64url. Published to the relay on every connection.
    pub fn public_key(&self) -> Result<String> {
        Ok(self.load()?.1)
    }

    /// The room this desktop owns: derived from the public key.
    pub fn room_id(&self) -> Result<String> {
        super::crypto::room_id_for_key(&self.public_key()?).ok_or_else(|| anyhow!("public key is not base64url"))
    }

    /// Sign a relay challenge. The room and side are bound into the message,
    /// so the result cannot be replayed into another room or as another side.
    pub fn sign(&self, nonce: &str, room_id: &str, side: &str) -> Result<String> {
        let (signing, _) = self.load()?;
        Ok(to_base64url(&signing.sign(&challenge_message(nonce, room_id, side)).to_bytes()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Verifier, VerifyingKey};

    // RFC 8032 test vector 1, wrapped the way WebCrypto exports it.
    const PKCS8_B64U: &str = "MC4CAQAwBQYDK2VwBCIEIJ1hsZ3v_VpguoRK9JLsLMREScVpezJpGXA7rAMcrn9g";
    const PUBLIC_B64U: &str = "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo";

    fn dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("boss-relay-identity-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_webcrypto_keypair_file_loads_and_signs_identically() {
        let file = dir().join("remote-access-key.json");
        std::fs::write(&file, format!(r#"{{"privateKey":"{PKCS8_B64U}","publicKey":"{PUBLIC_B64U}"}}"#)).unwrap();
        let identity = RelayIdentity::new(&file);
        assert_eq!(identity.public_key().unwrap(), PUBLIC_B64U);
        assert_eq!(identity.room_id().unwrap(), "If4x36FUomFia_hUBG_SJw");
        // node: crypto.subtle.sign('Ed25519', key, 'boss-relay-join nonce-123 If4x36FUomFia_hUBG_SJw desktop')
        assert_eq!(
            identity.sign("nonce-123", "If4x36FUomFia_hUBG_SJw", "desktop").unwrap(),
            "5QSZu4npXdvpmJuqb2MTTUUU9EWxS-22O_WmBNl-7eRWEDl8oQxlJP3E1XDxUmRc4w9PhADMrGZDo0LOf3lQBw"
        );
    }

    #[test]
    fn a_fresh_identity_is_generated_once_and_verifies() {
        let file = dir().join("remote-access-key.json");
        let identity = RelayIdentity::new(&file);
        let public_key = identity.public_key().unwrap();
        assert!(super::super::crypto::looks_like_key(&public_key));
        let signature = identity.sign("n", "r", "desktop").unwrap();
        assert!(super::super::crypto::looks_like_signature(&signature));

        let verifying = VerifyingKey::from_bytes(&from_base64url(&public_key).unwrap().try_into().unwrap()).unwrap();
        let sig = ed25519_dalek::Signature::from_slice(&from_base64url(&signature).unwrap()).unwrap();
        assert!(verifying.verify(&challenge_message("n", "r", "desktop"), &sig).is_ok());
        assert!(verifying.verify(&challenge_message("n", "r", "phone"), &sig).is_err(), "side is bound in");

        // The stored file is what WebCrypto would have written, and reloading gives the same key.
        let stored: StoredKeypair = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(stored.public_key, public_key);
        assert_eq!(from_base64url(&stored.private_key).unwrap().len(), 48);
        assert_eq!(RelayIdentity::new(&file).public_key().unwrap(), public_key);
    }

    #[test]
    fn a_damaged_file_is_replaced_rather_than_fatal() {
        let file = dir().join("remote-access-key.json");
        std::fs::write(&file, "{not json").unwrap();
        let identity = RelayIdentity::new(&file);
        assert!(super::super::crypto::looks_like_key(&identity.public_key().unwrap()));
    }

    #[test]
    fn pkcs8_wrapping_round_trips() {
        let seed = [7u8; 32];
        assert_eq!(seed_from_pkcs8(&pkcs8_from_seed(&seed)), Some(seed));
        assert_eq!(seed_from_pkcs8(&[0u8; 48]), None);
        assert_eq!(seed_from_pkcs8(&seed), None);
    }
}
