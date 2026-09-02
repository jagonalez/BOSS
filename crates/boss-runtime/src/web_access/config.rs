//! `mobile-access.json`, the same shape the Electron app wrote.
//!
//! Port of `MobileAccessConfig` and the `load`/`save` pair in
//! `src/main/web-access.ts`. The file is read on an upgraded install, so the
//! field names and the token length rule are fixed by what is already on disk.

use rand::Rng;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// Fixed default so `tailscale serve` rules survive restarts.
pub const DEFAULT_PORT: u16 = 4517;

/// Shortest token the loader will accept from disk. Anything shorter is
/// treated as a corrupt file and the whole config is regenerated, exactly as
/// the TypeScript did.
const MIN_TOKEN_LEN: usize = 32;

/// The settings the phone server reads, persisted as `mobile-access.json`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WebAccessConfig {
    /// Whether the loopback server should be running.
    #[serde(default)]
    pub enabled: bool,
    /// Fixed port so tailscale serve rules survive restarts.
    #[serde(default = "default_port")]
    pub port: u16,
    /// Full-control credential.
    pub token: String,
    /// Separate credential that can inspect threads but cannot send, stop,
    /// approve, or run anything.
    #[serde(rename = "viewerToken")]
    pub viewer_token: String,
    /// Run `tailscale serve` automatically so the site is on the tailnet.
    #[serde(default = "default_true")]
    pub tailscale: bool,
}

fn default_port() -> u16 {
    DEFAULT_PORT
}

fn default_true() -> bool {
    true
}

impl Default for WebAccessConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            port: DEFAULT_PORT,
            token: new_token(),
            viewer_token: new_token(),
            tailscale: true,
        }
    }
}

impl WebAccessConfig {
    /// Read `mobile-access.json` from `data_dir`, or build a fresh config with
    /// new tokens when the file is missing, unreadable, or short a token.
    pub fn load(data_dir: &Path) -> Self {
        let Ok(text) = std::fs::read_to_string(Self::path(data_dir)) else {
            return Self::default();
        };
        let Ok(mut config) = serde_json::from_str::<Self>(&text) else {
            return Self::default();
        };
        // A token too short to be one is the signal the TS used for a corrupt
        // or pre-token file, and it regenerated everything rather than run
        // with a guessable credential.
        if config.token.len() < MIN_TOKEN_LEN {
            return Self::default();
        }
        if config.viewer_token.len() < MIN_TOKEN_LEN {
            config.viewer_token = new_token();
        }
        if config.port <= 1024 {
            config.port = DEFAULT_PORT;
        }
        config
    }

    /// Write `mobile-access.json`. Failures are returned, not swallowed; the
    /// caller decides whether the toggle still works in memory.
    pub fn save(&self, data_dir: &Path) -> std::io::Result<()> {
        std::fs::create_dir_all(data_dir)?;
        let text = serde_json::to_string_pretty(self).map_err(std::io::Error::other)?;
        std::fs::write(Self::path(data_dir), text)
    }

    /// Where the config lives inside the data directory.
    pub fn path(data_dir: &Path) -> PathBuf {
        data_dir.join("mobile-access.json")
    }

    /// Mint a new control token.
    pub fn regenerate_token(&mut self) {
        self.token = new_token();
    }

    /// Mint a new read-only token.
    pub fn regenerate_viewer_token(&mut self) {
        self.viewer_token = new_token();
    }

    /// Accept a port only in the range the TS accepted.
    pub fn set_port(&mut self, port: u16) -> bool {
        if port > 1024 {
            self.port = port;
            true
        } else {
            false
        }
    }
}

/// 24 random bytes in base64url, matching `randomBytes(24).toString('base64url')`.
fn new_token() -> String {
    let mut bytes = [0u8; 24];
    rand::thread_rng().fill(&mut bytes[..]);
    base64url(&bytes)
}

/// base64url without padding, so tokens survive a query string untouched.
fn base64url(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        let symbols = match chunk.len() {
            1 => 2,
            2 => 3,
            _ => 4,
        };
        for i in 0..symbols {
            out.push(ALPHABET[((n >> (18 - 6 * i)) & 0x3f) as usize] as char);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fresh_config_is_disabled_with_two_long_tokens() {
        let config = WebAccessConfig::default();
        assert!(!config.enabled);
        assert_eq!(config.port, DEFAULT_PORT);
        assert!(config.tailscale);
        assert_eq!(config.token.len(), 32);
        assert_eq!(config.viewer_token.len(), 32);
        assert_ne!(config.token, config.viewer_token);
    }

    #[test]
    fn round_trips_through_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let config = WebAccessConfig { enabled: true, port: 5000, ..Default::default() };
        config.save(dir.path()).unwrap();
        assert_eq!(WebAccessConfig::load(dir.path()), config);
    }

    #[test]
    fn reads_the_typescript_field_names() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            WebAccessConfig::path(dir.path()),
            r#"{"enabled":true,"port":4517,"token":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","viewerToken":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","tailscale":false}"#,
        )
        .unwrap();
        let config = WebAccessConfig::load(dir.path());
        assert!(config.enabled);
        assert!(!config.tailscale);
        assert_eq!(config.token, "a".repeat(32));
        assert_eq!(config.viewer_token, "b".repeat(32));
    }

    #[test]
    fn writes_the_typescript_field_names() {
        let dir = tempfile::tempdir().unwrap();
        WebAccessConfig::default().save(dir.path()).unwrap();
        let text = std::fs::read_to_string(WebAccessConfig::path(dir.path())).unwrap();
        assert!(text.contains("\"viewerToken\""), "{text}");
    }

    #[test]
    fn a_short_token_regenerates_the_whole_config() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            WebAccessConfig::path(dir.path()),
            r#"{"enabled":true,"port":4517,"token":"short","viewerToken":"short","tailscale":true}"#,
        )
        .unwrap();
        let config = WebAccessConfig::load(dir.path());
        assert!(!config.enabled, "a corrupt config must not come back enabled");
        assert_eq!(config.token.len(), 32);
    }

    #[test]
    fn a_missing_viewer_token_is_minted_without_rotating_the_control_token() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            WebAccessConfig::path(dir.path()),
            r#"{"enabled":true,"port":4517,"token":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","viewerToken":"","tailscale":true}"#,
        )
        .unwrap();
        let config = WebAccessConfig::load(dir.path());
        assert_eq!(config.token, "a".repeat(32));
        assert_eq!(config.viewer_token.len(), 32);
    }

    #[test]
    fn a_missing_file_gives_defaults() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!WebAccessConfig::load(dir.path()).enabled);
    }

    #[test]
    fn base64url_matches_node() {
        // Node: Buffer.from([0,1,2,...]).toString('base64url')
        assert_eq!(base64url(&[0, 1, 2]), "AAEC");
        assert_eq!(base64url(&[255, 255, 255]), "____");
        assert_eq!(base64url(&[251, 255, 191]), "-_-_");
        // Unpadded: 24 bytes is a clean 32 symbols, but check a ragged tail.
        assert_eq!(base64url(&[0]), "AA");
        assert_eq!(base64url(&[0, 0]), "AAA");
    }

    #[test]
    fn a_low_port_is_refused() {
        let mut config = WebAccessConfig::default();
        assert!(!config.set_port(80));
        assert_eq!(config.port, DEFAULT_PORT);
        assert!(config.set_port(5555));
        assert_eq!(config.port, 5555);
    }
}
