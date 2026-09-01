//! Newline-delimited JSON over a child process's stdio.
//!
//! Used by the claude, codex, and pi adapters. The child is spawned on the
//! tokio runtime; incoming lines are parsed and forwarded on an
//! `async_channel`, which any executor can await.

use anyhow::{Context, Result};
use async_channel::{Receiver, Sender};
use serde_json::Value;
use std::path::Path;
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::Mutex;

pub struct JsonlChild {
    child: Mutex<Child>,
    stdin: Mutex<ChildStdin>,
    lines: Receiver<Value>,
    /// Lines that were not valid JSON (banners, warnings), for logs.
    pub stderr: Receiver<String>,
}

impl JsonlChild {
    /// Spawn `program args...` in `cwd` with the given extra env vars.
    pub fn spawn(program: &Path, args: &[String], cwd: &Path, env: &[(String, String)]) -> Result<Self> {
        let mut cmd = Command::new(program);
        cmd.args(args)
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        for (k, v) in env {
            cmd.env(k, v);
        }
        let mut child = cmd.spawn().with_context(|| format!("spawn {}", program.display()))?;
        let stdin = child.stdin.take().context("child stdin")?;
        let stdout = child.stdout.take().context("child stdout")?;
        let stderr = child.stderr.take().context("child stderr")?;

        let (line_tx, line_rx) = async_channel::unbounded::<Value>();
        let (err_tx, err_rx) = async_channel::unbounded::<String>();

        let program_name = program.display().to_string();
        tokio::spawn(read_lines(stdout, line_tx, err_tx.clone(), program_name.clone()));
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = err_tx.send(line).await;
            }
        });

        Ok(Self { child: Mutex::new(child), stdin: Mutex::new(stdin), lines: line_rx, stderr: err_rx })
    }

    /// Parsed JSON lines from stdout. Closes when the child exits.
    pub fn lines(&self) -> Receiver<Value> {
        self.lines.clone()
    }

    /// Write one JSON value as a single line.
    pub async fn send(&self, value: &Value) -> Result<()> {
        let mut text = serde_json::to_string(value)?;
        text.push('\n');
        let mut stdin = self.stdin.lock().await;
        stdin.write_all(text.as_bytes()).await?;
        stdin.flush().await?;
        Ok(())
    }

    pub async fn kill(&self) -> Result<()> {
        let mut child = self.child.lock().await;
        child.start_kill().ok();
        let _ = child.wait().await;
        Ok(())
    }

    pub async fn id(&self) -> Option<u32> {
        self.child.lock().await.id()
    }
}

async fn read_lines(
    stdout: tokio::process::ChildStdout,
    tx: Sender<Value>,
    junk: Sender<String>,
    program: String,
) {
    let mut lines = BufReader::new(stdout).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        match serde_json::from_str::<Value>(trimmed) {
            Ok(v) => {
                if tx.send(v).await.is_err() {
                    break;
                }
            }
            Err(_) => {
                tracing::debug!(%program, line = %trimmed, "non-JSON line on stdout");
                let _ = junk.send(line).await;
            }
        }
    }
    tx.close();
}

/// Find an executable on PATH, or use an explicit override.
pub fn resolve_executable(override_path: Option<&Path>, name: &str) -> Option<std::path::PathBuf> {
    if let Some(p) = override_path {
        return Some(p.to_path_buf());
    }
    which::which(name).ok()
}
