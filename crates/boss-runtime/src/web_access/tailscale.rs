//! Publishing the loopback server on the user's tailnet.
//!
//! Port of `tailscaleBin`, `tailscaleRun`, `startTailscale`, and
//! `stopTailscale` in `src/main/web-access.ts`. Nothing here opens a socket:
//! `tailscale serve` runs as a child process and the tailscale daemon does
//! the proxying, so this module is only ever shelling out and parsing.

use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::process::Command;

/// The TS gave the CLI ten seconds; a serve call that hangs longer than that
/// has hung for good, and the settings page needs an answer.
const TIMEOUT: Duration = Duration::from_secs(10);

/// Error text is truncated to this before it reaches the settings page, as in
/// the TS (`.slice(0, 300)`).
const MAX_ERROR_LEN: usize = 300;

/// Where a macOS install puts the CLI, in the order the TS looked.
const CANDIDATES: [&str; 3] = [
    "/usr/local/bin/tailscale",
    "/opt/homebrew/bin/tailscale",
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
];

/// What went wrong running the CLI.
#[derive(Debug, thiserror::Error)]
pub enum TailscaleError {
    /// No `tailscale` binary in any known location.
    #[error("Tailscale is not installed. Install it from tailscale.com, then re-enable.")]
    NotInstalled,
    /// The CLI ran and failed; the message is its own output, truncated.
    #[error("{0}")]
    Failed(String),
    /// The CLI did not answer within [`TIMEOUT`].
    #[error("Tailscale did not respond within {0} seconds.")]
    TimedOut(u64),
    /// The process could not be spawned or its output could not be read.
    #[error("{0}")]
    Spawn(String),
}

/// Runs the `tailscale` CLI. Holding the resolved path means an install that
/// disappears mid-session reports "not installed" the same way a missing one
/// does, instead of a confusing spawn error.
#[derive(Debug, Clone)]
pub struct Tailscale {
    bin: Option<PathBuf>,
}

impl Default for Tailscale {
    fn default() -> Self {
        Self::new()
    }
}

impl Tailscale {
    /// Look for the CLI in the locations a macOS install uses.
    pub fn new() -> Self {
        Self { bin: CANDIDATES.iter().map(Path::new).find(|p| p.exists()).map(Path::to_path_buf) }
    }

    /// Use a specific binary. Tests point this at a stub script.
    pub fn with_binary(bin: impl Into<PathBuf>) -> Self {
        Self { bin: Some(bin.into()) }
    }

    /// Whether a CLI was found.
    pub fn installed(&self) -> bool {
        self.bin.is_some()
    }

    /// Run the CLI and return its stdout.
    pub async fn run(&self, args: &[&str]) -> Result<String, TailscaleError> {
        let bin = self.bin.as_ref().ok_or(TailscaleError::NotInstalled)?;
        let run = Command::new(bin).args(args).kill_on_drop(true).output();
        let output = match tokio::time::timeout(TIMEOUT, run).await {
            Err(_) => return Err(TailscaleError::TimedOut(TIMEOUT.as_secs())),
            // An install uninstalled since startup spawns `NotFound`. That is
            // the same situation as never having had one, and the settings
            // page should say so rather than show a raw ENOENT.
            Ok(Err(e)) if e.kind() == std::io::ErrorKind::NotFound => {
                return Err(TailscaleError::NotInstalled);
            }
            Ok(Err(e)) => return Err(TailscaleError::Spawn(e.to_string())),
            Ok(Ok(output)) => output,
        };
        if output.status.success() {
            return Ok(String::from_utf8_lossy(&output.stdout).into_owned());
        }
        // The TS preferred stderr, fell back to stdout, then to the spawn
        // error. CLI flags vary across versions, so the message is verbatim.
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let text = if stderr.trim().is_empty() { stdout.trim() } else { stderr.trim() };
        let text = if text.is_empty() { "tailscale exited with an error" } else { text };
        Err(TailscaleError::Failed(text.chars().take(MAX_ERROR_LEN).collect()))
    }

    /// `tailscale serve --bg --http=80 <port>`, then read back the tailnet URL.
    ///
    /// Plain HTTP on port 80 rather than HTTPS, as in the TS: tailnet traffic
    /// is WireGuard-encrypted anyway, and HTTPS needs Let's Encrypt
    /// provisioning that hangs on some tailnets and macOS GUI builds.
    pub async fn enable(&self, port: u16) -> Result<Option<String>, TailscaleError> {
        self.run(&["serve", "--bg", "--http=80", &port.to_string()]).await?;
        self.status().await
    }

    /// `tailscale serve reset`, dropping every serve rule this machine has.
    pub async fn disable(&self) -> Result<(), TailscaleError> {
        self.run(&["serve", "reset"]).await.map(|_| ())
    }

    /// The tailnet URL for this machine, from `tailscale status --json`.
    /// `Ok(None)` means tailscale answered but has no DNS name for us yet.
    pub async fn status(&self) -> Result<Option<String>, TailscaleError> {
        Ok(tailnet_url(&self.run(&["status", "--json"]).await?))
    }
}

/// Just enough of `tailscale status --json` to find this machine's name.
#[derive(Debug, Deserialize)]
struct Status {
    #[serde(rename = "Self")]
    self_node: Option<Node>,
}

#[derive(Debug, Deserialize)]
struct Node {
    #[serde(rename = "DNSName")]
    dns_name: Option<String>,
}

/// Read `Self.DNSName` out of a status document and build the URL the
/// settings page shows. `DNSName` arrives fully qualified with a trailing dot.
pub fn tailnet_url(json: &str) -> Option<String> {
    let status: Status = serde_json::from_str(json).ok()?;
    let dns = status.self_node?.dns_name?;
    let dns = dns.trim_end_matches('.');
    if dns.is_empty() { None } else { Some(format!("http://{dns}")) }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Trimmed from a real `tailscale status --json`.
    const FIXTURE: &str = r#"{
      "Version": "1.78.1",
      "BackendState": "Running",
      "Self": {
        "ID": "n1234",
        "HostName": "jeremys-mbp",
        "DNSName": "jeremys-mbp.tail1234.ts.net.",
        "OS": "macOS",
        "TailscaleIPs": ["100.64.0.1"],
        "Online": true
      },
      "Peer": {
        "nABCD": { "DNSName": "phone.tail1234.ts.net.", "Online": true }
      },
      "MagicDNSSuffix": "tail1234.ts.net"
    }"#;

    #[test]
    fn reads_the_hostname_out_of_status_json() {
        assert_eq!(tailnet_url(FIXTURE).as_deref(), Some("http://jeremys-mbp.tail1234.ts.net"));
    }

    #[test]
    fn a_logged_out_node_has_no_url() {
        let json = r#"{"BackendState":"NeedsLogin","Self":null,"Peer":null}"#;
        assert_eq!(tailnet_url(json), None);
    }

    #[test]
    fn a_node_without_a_dns_name_has_no_url() {
        assert_eq!(tailnet_url(r#"{"Self":{"HostName":"x"}}"#), None);
        assert_eq!(tailnet_url(r#"{"Self":{"DNSName":""}}"#), None);
        // A bare dot trims to nothing rather than becoming "http://".
        assert_eq!(tailnet_url(r#"{"Self":{"DNSName":"."}}"#), None);
    }

    #[test]
    fn garbage_is_not_a_url() {
        assert_eq!(tailnet_url("not json"), None);
        assert_eq!(tailnet_url(""), None);
    }

    #[tokio::test]
    async fn a_missing_binary_says_how_to_install_it() {
        let ts = Tailscale { bin: None };
        assert!(!ts.installed());
        let error = ts.enable(4517).await.unwrap_err();
        assert!(matches!(error, TailscaleError::NotInstalled));
        assert!(error.to_string().contains("tailscale.com"), "{error}");
    }

    #[tokio::test]
    async fn a_binary_that_vanished_also_reads_as_not_installed() {
        // Tailscale uninstalled after startup: the path was found once and is
        // now gone, so spawning fails with NotFound rather than resolving to
        // no binary at all. The settings page must not show a raw ENOENT.
        let ts = Tailscale::with_binary("/nonexistent/tailscale");
        assert!(ts.installed());
        let error = ts.status().await.unwrap_err();
        assert!(matches!(error, TailscaleError::NotInstalled), "{error}");
        assert!(error.to_string().contains("tailscale.com"), "{error}");
    }

    /// Write a shell stub that answers like the CLI, so the command building
    /// is exercised without a tailnet.
    fn stub(dir: &Path, body: &str) -> PathBuf {
        let path = dir.join("tailscale");
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        path
    }

    #[tokio::test]
    async fn enable_passes_the_serve_flags_and_returns_the_url() {
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("args.txt");
        let ts = Tailscale::with_binary(stub(
            dir.path(),
            &format!(
                "echo \"$@\" >> {log}\n\
                 case \"$1\" in status) cat <<'EOF'\n{FIXTURE}\nEOF\n;; esac\nexit 0",
                log = log.display()
            ),
        ));
        assert_eq!(
            ts.enable(4517).await.unwrap().as_deref(),
            Some("http://jeremys-mbp.tail1234.ts.net")
        );
        let calls = std::fs::read_to_string(&log).unwrap();
        assert!(calls.contains("serve --bg --http=80 4517"), "{calls}");
        assert!(calls.contains("status --json"), "{calls}");
    }

    #[tokio::test]
    async fn disable_resets_the_serve_rules() {
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("args.txt");
        let ts = Tailscale::with_binary(stub(
            dir.path(),
            &format!("echo \"$@\" >> {}\nexit 0", log.display()),
        ));
        ts.disable().await.unwrap();
        assert_eq!(std::fs::read_to_string(&log).unwrap().trim(), "serve reset");
    }

    #[tokio::test]
    async fn a_cli_failure_surfaces_its_own_message() {
        let dir = tempfile::tempdir().unwrap();
        let ts =
            Tailscale::with_binary(stub(dir.path(), "echo 'serve: flag not supported' >&2\nexit 1"));
        let error = ts.enable(4517).await.unwrap_err();
        assert_eq!(error.to_string(), "serve: flag not supported");
    }

    #[tokio::test]
    async fn a_long_failure_is_truncated_for_the_settings_page() {
        let dir = tempfile::tempdir().unwrap();
        let ts = Tailscale::with_binary(stub(
            dir.path(),
            "printf 'x%.0s' $(seq 1 900) >&2\nexit 1",
        ));
        let error = ts.enable(4517).await.unwrap_err();
        assert_eq!(error.to_string().len(), MAX_ERROR_LEN);
    }
}
