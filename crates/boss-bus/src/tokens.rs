//! Bearer tokens for the thread bus.
//!
//! One token per (thread, participant). The token carries both ids in the
//! clear plus an HMAC-SHA256 over `thread:participant` keyed with the bus
//! secret, so the server can name the caller without a lookup table and
//! nobody can mint a token for another seat without the secret. Same
//! construction as `callerToken` in `src/main/thread-bus.ts`, with the ids
//! attached so `verify` can return a caller.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use boss_core::{BusAccess, BusCaller, ParticipantId, ThreadId};
use hmac::{Hmac, Mac};
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;

/// Mints and verifies per-participant bearer tokens with one shared secret.
#[derive(Clone)]
pub struct BusTokens {
    secret: [u8; 32],
}

impl std::fmt::Debug for BusTokens {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("BusTokens(<secret>)")
    }
}

impl BusTokens {
    /// Wrap a 32-byte secret. Generate it once per app run and keep it in memory.
    pub fn new(secret: [u8; 32]) -> Self {
        Self { secret }
    }

    /// Token for one seat: `b64url(thread).b64url(participant).b64url(mac)`.
    pub fn issue(&self, thread_id: &ThreadId, participant_id: &ParticipantId) -> String {
        let mac = self.mac(thread_id.as_str(), participant_id.as_str());
        format!(
            "{}.{}.{}",
            URL_SAFE_NO_PAD.encode(thread_id.as_str()),
            URL_SAFE_NO_PAD.encode(participant_id.as_str()),
            URL_SAFE_NO_PAD.encode(mac)
        )
    }

    /// Everything an engine needs to reach the bus as one participant.
    pub fn access(&self, url: &str, thread_id: ThreadId, participant_id: ParticipantId) -> BusAccess {
        BusAccess { url: url.to_owned(), token: self.issue(&thread_id, &participant_id), thread_id, participant_id }
    }

    /// Check a token and name its caller. The MAC comparison is constant-time.
    pub fn verify(&self, token: &str) -> Option<BusCaller> {
        let mut parts = token.split('.');
        let thread = decode_text(parts.next()?)?;
        let participant = decode_text(parts.next()?)?;
        let mac = URL_SAFE_NO_PAD.decode(parts.next()?).ok()?;
        if parts.next().is_some() || thread.is_empty() || participant.is_empty() {
            return None;
        }
        self.hmac(&thread, &participant).verify_slice(&mac).ok()?;
        Some(BusCaller { thread_id: ThreadId::from_raw(thread), participant_id: ParticipantId::from_raw(participant) })
    }

    fn mac(&self, thread: &str, participant: &str) -> Vec<u8> {
        self.hmac(thread, participant).finalize().into_bytes().to_vec()
    }

    fn hmac(&self, thread: &str, participant: &str) -> HmacSha256 {
        let mut hmac = HmacSha256::new_from_slice(&self.secret).expect("HMAC accepts any key length");
        hmac.update(thread.as_bytes());
        hmac.update(b":");
        hmac.update(participant.as_bytes());
        hmac
    }
}

fn decode_text(segment: &str) -> Option<String> {
    let bytes = URL_SAFE_NO_PAD.decode(segment).ok()?;
    String::from_utf8(bytes).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tokens() -> BusTokens {
        BusTokens::new([7u8; 32])
    }

    #[test]
    fn issued_token_verifies_to_its_caller() {
        let t = tokens();
        let thread = ThreadId::from_raw("thr_a");
        let who = ParticipantId::from_raw("who_b");
        let token = t.issue(&thread, &who);
        assert_eq!(t.verify(&token), Some(BusCaller { thread_id: thread, participant_id: who }));
    }

    #[test]
    fn token_is_url_safe() {
        let token = tokens().issue(&ThreadId::from_raw("thr/+="), &ParticipantId::from_raw("who:x"));
        assert!(token.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.'));
    }

    #[test]
    fn different_secret_rejects() {
        let token = tokens().issue(&ThreadId::from_raw("thr_a"), &ParticipantId::from_raw("who_b"));
        assert_eq!(BusTokens::new([8u8; 32]).verify(&token), None);
    }

    #[test]
    fn tampered_claims_reject() {
        let t = tokens();
        let token = t.issue(&ThreadId::from_raw("thr_a"), &ParticipantId::from_raw("who_b"));
        let mut parts: Vec<&str> = token.split('.').collect();
        let other = URL_SAFE_NO_PAD.encode("thr_z");
        parts[0] = &other;
        assert_eq!(t.verify(&parts.join(".")), None);
    }

    #[test]
    fn malformed_tokens_reject() {
        let t = tokens();
        for bad in ["", "abc", "a.b", "a.b.c.d", "!!.!!.!!", "..", "dGhy.d2hv."] {
            assert_eq!(t.verify(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn access_carries_token_and_ids() {
        let t = tokens();
        let access = t.access("http://127.0.0.1:1", ThreadId::from_raw("thr_a"), ParticipantId::from_raw("who_b"));
        assert_eq!(access.url, "http://127.0.0.1:1");
        assert_eq!(t.verify(&access.token).unwrap().thread_id.as_str(), "thr_a");
    }
}
