//! Lifecycle of one `opencode serve` process.
//!
//! Port of `src/main/opencode-server.ts`: pick a free port, spawn
//! `opencode serve --port N --hostname 127.0.0.1` with a random password,
//! poll `/global/health` until it answers, kill on stop. `BOSS_SERVER_URL` +
//! `BOSS_SERVER_PASSWORD` point at an external server instead of spawning.

use super::client::{Health, OpencodeClient};
use anyhow::{Context, Result};
use boss_core::BusAccess;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

/// Basic-auth username opencode expects (`OPENCODE_SERVER_USERNAME`).
pub const USERNAME: &str = "opencode";
/// How long to wait for the health probe before giving up.
pub const READY_TIMEOUT: Duration = Duration::from_secs(20);
const READY_POLL: Duration = Duration::from_millis(200);

/// Everything needed to spawn one server.
#[derive(Clone, Debug)]
pub struct ServerSpawn {
    /// `opencode` binary.
    pub executable: PathBuf,
    /// Working directory the server is started in.
    pub cwd: PathBuf,
    /// Thread bus, exported as `BOSS_THREAD_BUS_URL` / `BOSS_THREAD_BUS_TOKEN`.
    pub bus: Option<BusAccess>,
    /// `OPENCODE_CONFIG_DIR` holding the generated bus tools.
    pub config_dir: Option<PathBuf>,
}

/// A running (or external) opencode server plus the client bound to it.
#[derive(Debug)]
pub struct OpencodeServer {
    client: OpencodeClient,
    child: Mutex<Option<Child>>,
    health: Health,
    sessions: AtomicUsize,
}

impl OpencodeServer {
    /// Spawn and wait for readiness. Honors `BOSS_SERVER_URL`/`BOSS_SERVER_PASSWORD`.
    pub async fn start(spawn: ServerSpawn) -> Result<Self> {
        if let (Ok(url), Ok(password)) = (std::env::var("BOSS_SERVER_URL"), std::env::var("BOSS_SERVER_PASSWORD")) {
            tracing::debug!(%url, "opencode: connecting to external server");
            let client = OpencodeClient::new(url, USERNAME, password);
            let health = wait_for_health(&client, None).await?;
            return Ok(Self { client, child: Mutex::new(None), health, sessions: AtomicUsize::new(0) });
        }

        let port = free_port().await?;
        let password = format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple());
        let base_url = format!("http://127.0.0.1:{port}");
        let cwd = if spawn.cwd.is_dir() { spawn.cwd.clone() } else { dirs::home_dir().unwrap_or_else(|| PathBuf::from(".")) };

        let mut cmd = Command::new(&spawn.executable);
        cmd.args(["serve", "--port", &port.to_string(), "--hostname", "127.0.0.1"])
            .current_dir(&cwd)
            .env("OPENCODE_SERVER_PASSWORD", &password)
            .env("OPENCODE_SERVER_USERNAME", USERNAME)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        if let Some(bus) = &spawn.bus {
            cmd.env("BOSS_THREAD_BUS_URL", &bus.url).env("BOSS_THREAD_BUS_TOKEN", &bus.token);
        }
        if let Some(dir) = &spawn.config_dir {
            cmd.env("OPENCODE_CONFIG_DIR", dir);
        }
        tracing::debug!(bin = %spawn.executable.display(), port, cwd = %cwd.display(), "opencode: spawning server");
        let mut child = cmd.spawn().with_context(|| format!("spawn {}", spawn.executable.display()))?;
        if let Some(out) = child.stdout.take() {
            tokio::spawn(log_lines(out, "opencode:out"));
        }
        if let Some(err) = child.stderr.take() {
            tokio::spawn(log_lines(err, "opencode"));
        }

        let client = OpencodeClient::new(base_url, USERNAME, password);
        let health = match wait_for_health(&client, Some(&mut child)).await {
            Ok(h) => h,
            Err(e) => {
                child.start_kill().ok();
                return Err(e);
            }
        };
        Ok(Self { client, child: Mutex::new(Some(child)), health, sessions: AtomicUsize::new(0) })
    }

    /// Bind to an already-running server without spawning (tests, remote setups).
    pub fn external(base_url: impl Into<String>, password: impl Into<String>) -> Self {
        Self {
            client: OpencodeClient::new(base_url, USERNAME, password),
            child: Mutex::new(None),
            health: Health::default(),
            sessions: AtomicUsize::new(0),
        }
    }

    /// HTTP client for this server.
    pub fn client(&self) -> &OpencodeClient {
        &self.client
    }

    /// Health as reported at startup.
    pub fn health(&self) -> &Health {
        &self.health
    }

    /// Count one more session using this server.
    pub fn retain(&self) -> usize {
        self.sessions.fetch_add(1, Ordering::SeqCst) + 1
    }

    /// One session stopped using this server; returns how many remain.
    pub fn release(&self) -> usize {
        self.sessions
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| Some(n.saturating_sub(1)))
            .map(|prev| prev.saturating_sub(1))
            .unwrap_or(0)
    }

    /// Kill the child process, if we spawned one.
    pub async fn stop(&self) {
        if let Some(mut child) = self.child.lock().await.take() {
            child.start_kill().ok();
            let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
        }
    }
}

async fn free_port() -> Result<u16> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.context("bind free port")?;
    Ok(listener.local_addr()?.port())
}

async fn wait_for_health(client: &OpencodeClient, mut child: Option<&mut Child>) -> Result<Health> {
    let deadline = Instant::now() + READY_TIMEOUT;
    while Instant::now() < deadline {
        if let Some(h) = client.health().await {
            return Ok(h);
        }
        if let Some(child) = child.as_deref_mut()
            && let Ok(Some(status)) = child.try_wait()
        {
            anyhow::bail!("opencode serve exited before it was ready ({status})");
        }
        tokio::time::sleep(READY_POLL).await;
    }
    anyhow::bail!("opencode server at {} did not become healthy within {:?}", client.base_url(), READY_TIMEOUT)
}

async fn log_lines<R: tokio::io::AsyncRead + Unpin>(reader: R, tag: &'static str) {
    let mut lines = BufReader::new(reader).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        tracing::debug!(target: "boss_engines::opencode", "[{tag}] {line}");
    }
}

/// Resolve the `opencode` binary: `OPENCODE_BIN`, then an explicit override,
/// then `PATH`.
pub fn resolve_executable(override_path: Option<&Path>) -> Option<PathBuf> {
    if let Ok(bin) = std::env::var("OPENCODE_BIN")
        && !bin.is_empty()
    {
        return Some(PathBuf::from(bin));
    }
    crate::jsonl::resolve_executable(override_path, if cfg!(windows) { "opencode.exe" } else { "opencode" })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retain_release_counts_sessions() {
        let server = OpencodeServer::external("http://127.0.0.1:1", "pw");
        assert_eq!(server.retain(), 1);
        assert_eq!(server.retain(), 2);
        assert_eq!(server.release(), 1);
        assert_eq!(server.release(), 0);
        assert_eq!(server.release(), 0, "never underflows");
        assert_eq!(server.client().auth_header(), OpencodeClient::new("x", "opencode", "pw").auth_header());
    }

    #[tokio::test]
    async fn free_port_is_bindable() {
        let port = free_port().await.unwrap();
        assert!(port > 0);
    }
}
