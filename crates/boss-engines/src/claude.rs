//! Claude Code adapter: drives the `claude` CLI over stream-json on stdio.
//!
//! Replaces the in-process TypeScript `@anthropic-ai/claude-agent-sdk`. One
//! process per session, spawned with the same flags the SDK uses; permission
//! prompts, interrupts and mode changes travel as control requests on the
//! same stream as the messages. `protocol` holds every wire shape and the
//! stateful translation to `EngineEvent`s; `args` builds the command line.

pub mod args;
pub mod protocol;
#[cfg(test)]
mod tests;

use crate::jsonl::{JsonlChild, resolve_executable};
use anyhow::{Context, Result, bail};
use async_channel::{Receiver, Sender};
use async_trait::async_trait;
use base64::Engine as _;
use boss_core::{
    Attachment, Engine, EngineEvent, EngineId, EngineProbe, ModelInfo, PermissionDecision, PermissionMode, Prompt,
    RequestId, Session, SessionOptions,
};
use protocol::{ImageBlock, Translator};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

/// Name of the CLI on PATH.
pub const CLAUDE_BIN: &str = "claude";

/// The model aliases the CLI accepts. Claude Code resolves them to the
/// current release of each family, so the list does not carry dates.
pub fn static_models() -> Vec<ModelInfo> {
    [("sonnet", "Sonnet"), ("opus", "Opus"), ("fable", "Fable"), ("haiku", "Haiku")]
        .iter()
        .map(|(id, label)| ModelInfo { id: (*id).to_owned(), label: (*label).to_owned(), provider: Some("anthropic".into()) })
        .collect()
}

/// The version in `claude --version` output: the first line, trimmed.
pub fn parse_version(stdout: &str) -> Option<String> {
    stdout.lines().map(str::trim).find(|line| !line.is_empty()).map(String::from)
}

/// Factory for Claude Code sessions.
#[derive(Clone, Debug, Default)]
pub struct ClaudeEngine {
    override_path: Option<PathBuf>,
}

impl ClaudeEngine {
    /// An engine that runs `override_path`, or `claude` from PATH when `None`.
    pub fn new(override_path: Option<PathBuf>) -> Self {
        Self { override_path }
    }
}

#[async_trait]
impl Engine for ClaudeEngine {
    fn id(&self) -> EngineId {
        EngineId::Claude
    }

    fn executable(&self) -> Option<PathBuf> {
        resolve_executable(self.override_path.as_deref(), CLAUDE_BIN)
    }

    async fn probe(&self) -> Result<EngineProbe> {
        let Some(exe) = self.executable() else { return Ok(EngineProbe::default()) };
        let run = tokio::process::Command::new(&exe).arg("--version").kill_on_drop(true).output();
        match tokio::time::timeout(Duration::from_secs(5), run).await {
            Ok(Ok(out)) if out.status.success() => Ok(EngineProbe {
                installed: true,
                version: parse_version(&String::from_utf8_lossy(&out.stdout)),
                auth_error: None,
            }),
            Ok(Ok(out)) => {
                let stderr = String::from_utf8_lossy(&out.stderr).trim().to_owned();
                let detail = if stderr.is_empty() { out.status.to_string() } else { stderr };
                Ok(EngineProbe { installed: false, version: None, auth_error: Some(format!("claude --version failed: {detail}")) })
            }
            Ok(Err(err)) => Ok(EngineProbe { installed: false, version: None, auth_error: Some(err.to_string()) }),
            Err(_) => Ok(EngineProbe { installed: true, version: None, auth_error: Some("claude --version timed out".into()) }),
        }
    }

    async fn list_models(&self) -> Result<Vec<ModelInfo>> {
        Ok(static_models())
    }

    async fn start_session(&self, opts: SessionOptions) -> Result<Box<dyn Session>> {
        let exe = self.executable().context("Claude Code is not installed: no `claude` on PATH")?;
        Ok(Box::new(ClaudeSession::spawn(&exe, opts).await?))
    }
}

/// One running `claude` process. Dropping it kills the process.
pub struct ClaudeSession {
    child: Arc<JsonlChild>,
    events: Receiver<EngineEvent>,
    tx: Sender<EngineEvent>,
    state: Arc<Mutex<Translator>>,
    resume: Option<String>,
    seq: AtomicU64,
}

impl ClaudeSession {
    async fn spawn(exe: &Path, opts: SessionOptions) -> Result<Self> {
        let args = args::build_args(&opts);
        let env = args::spawn_env();
        let child = Arc::new(JsonlChild::spawn(exe, &args, &opts.cwd, &env)?);
        let (tx, events) = async_channel::unbounded();
        let state = Arc::new(Mutex::new(Translator::new()));
        tokio::spawn(pump(child.clone(), state.clone(), tx.clone()));
        let stderr = child.stderr.clone();
        tokio::spawn(async move {
            while let Ok(line) = stderr.recv().await {
                tracing::debug!(target: "boss_engines::claude", %line, "claude stderr");
            }
        });
        let session = Self { child, events, tx, state, resume: opts.resume.clone(), seq: AtomicU64::new(0) };
        let init = protocol::initialize_request(
            &session.next_request_id(),
            opts.system_prompt.as_deref(),
            opts.append_system_prompt.as_deref(),
        );
        session.child.send(&init).await.context("send initialize to claude")?;
        Ok(session)
    }

    fn next_request_id(&self) -> String {
        let n = self.seq.fetch_add(1, Ordering::SeqCst) + 1;
        let nonce = uuid::Uuid::new_v4().simple().to_string();
        format!("req_{n}_{}", &nonce[..8])
    }

    fn state(&self) -> MutexGuard<'_, Translator> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// Forward stdout lines through the translator until the process ends.
async fn pump(child: Arc<JsonlChild>, state: Arc<Mutex<Translator>>, tx: Sender<EngineEvent>) {
    let lines = child.lines();
    while let Ok(line) = lines.recv().await {
        let reply = protocol::auto_reply(&line);
        let events = state.lock().unwrap_or_else(PoisonError::into_inner).translate(line);
        for event in events {
            if tx.send(event).await.is_err() {
                return;
            }
        }
        if let Some(reply) = reply
            && let Err(err) = child.send(&reply).await
        {
            tracing::warn!(target: "boss_engines::claude", %err, "could not answer a control request");
        }
    }
    let _ = tx.send(EngineEvent::Closed).await;
}

/// Read image attachments into base64 blocks; name everything else.
async fn read_attachments(attachments: &[Attachment]) -> (Vec<ImageBlock>, Vec<String>) {
    let mut images = Vec::new();
    let mut unreadable = Vec::new();
    for attachment in attachments {
        let name = attachment
            .path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| attachment.mime.clone());
        if !attachment.mime.starts_with("image/") {
            unreadable.push(name);
            continue;
        }
        match tokio::fs::read(&attachment.path).await {
            Ok(bytes) => images.push(ImageBlock {
                media_type: attachment.mime.clone(),
                data: base64::engine::general_purpose::STANDARD.encode(bytes),
            }),
            Err(err) => {
                tracing::warn!(target: "boss_engines::claude", path = %attachment.path.display(), %err, "attachment unreadable");
                unreadable.push(name);
            }
        }
    }
    (images, unreadable)
}

#[async_trait]
impl Session for ClaudeSession {
    fn engine(&self) -> EngineId {
        EngineId::Claude
    }

    fn native_session_id(&self) -> Option<String> {
        self.state().session_id().map(String::from).or_else(|| self.resume.clone())
    }

    fn events(&self) -> Receiver<EngineEvent> {
        self.events.clone()
    }

    async fn send(&self, prompt: Prompt) -> Result<()> {
        let (images, unreadable) = read_attachments(&prompt.attachments).await;
        let content = protocol::user_content(&prompt.text, &images, &unreadable);
        if content.is_empty() {
            bail!("empty prompt");
        }
        let session_id = self.native_session_id();
        let message: Value = protocol::user_message(content, session_id.as_deref());
        self.child.send(&message).await.context("send prompt to claude")?;
        let _ = self.tx.send(EngineEvent::Status { busy: true }).await;
        Ok(())
    }

    async fn interrupt(&self) -> Result<()> {
        self.state().set_interrupted(true);
        self.child.send(&protocol::interrupt_request(&self.next_request_id())).await
    }

    async fn respond_permission(&self, request: RequestId, decision: PermissionDecision) -> Result<()> {
        let pending = self.state().take_pending(&request).context("Claude Code is no longer waiting for this approval.")?;
        self.child.send(&protocol::permission_response(&pending, &decision)).await
    }

    async fn set_model(&self, model: String) -> Result<()> {
        self.child.send(&protocol::set_model_request(&self.next_request_id(), &model)).await
    }

    async fn set_permission_mode(&self, mode: PermissionMode) -> Result<()> {
        self.child.send(&protocol::set_permission_mode_request(&self.next_request_id(), mode)).await
    }

    async fn close(&self) -> Result<()> {
        self.child.kill().await
    }
}
