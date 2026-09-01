use crate::event::EngineEvent;
use crate::ids::*;
use async_channel::Receiver;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;

/// The agents BOSS can drive. Lab is gone.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EngineId {
    Claude,
    Codex,
    Opencode,
    Pi,
}

impl EngineId {
    pub const ALL: [EngineId; 4] = [EngineId::Claude, EngineId::Codex, EngineId::Opencode, EngineId::Pi];

    pub fn label(self) -> &'static str {
        match self {
            EngineId::Claude => "Claude Code",
            EngineId::Codex => "Codex",
            EngineId::Opencode => "OpenCode",
            EngineId::Pi => "pi",
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            EngineId::Claude => "claude",
            EngineId::Codex => "codex",
            EngineId::Opencode => "opencode",
            EngineId::Pi => "pi",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionMode {
    /// Ask on every tool the engine would ask about.
    Default,
    /// Auto-approve file edits.
    AcceptEdits,
    /// Approve everything.
    Bypass,
    /// Read-only planning.
    Plan,
}

/// Where the thread bus lives, so an engine can reach BOSS's tools.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BusAccess {
    pub url: String,
    pub token: String,
    pub thread_id: ThreadId,
    pub participant_id: ParticipantId,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SessionOptions {
    pub thread_id: ThreadId,
    pub participant_id: ParticipantId,
    pub cwd: PathBuf,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub permission_mode: PermissionMode,
    /// Resume this engine-native session instead of starting a new one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resume: Option<String>,
    /// Extra text appended to the engine's own system prompt.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub append_system_prompt: Option<String>,
    /// Full replacement of the system prompt (coordinator mode).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_prompt: Option<String>,
    /// Restrict the engine to these tools (coordinator mode). `None` = all.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allowed_tools: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bus: Option<BusAccess>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Attachment {
    pub mime: String,
    pub path: PathBuf,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Prompt {
    pub text: String,
    #[serde(default)]
    pub attachments: Vec<Attachment>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "decision", rename_all = "snake_case")]
pub enum PermissionDecision {
    Allow {
        /// Engines may accept an edited input.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        updated_input: Option<Value>,
    },
    Deny {
        #[serde(default)]
        reason: String,
    },
}

/// A running agent session. Dropping the handle ends the session.
#[async_trait]
pub trait Session: Send + Sync {
    fn engine(&self) -> EngineId;
    fn native_session_id(&self) -> Option<String>;
    /// Stream of events for this session. One receiver per session.
    fn events(&self) -> Receiver<EngineEvent>;
    async fn send(&self, prompt: Prompt) -> anyhow::Result<()>;
    async fn interrupt(&self) -> anyhow::Result<()>;
    async fn respond_permission(&self, request: RequestId, decision: PermissionDecision) -> anyhow::Result<()>;
    async fn set_model(&self, model: String) -> anyhow::Result<()>;
    async fn set_permission_mode(&self, mode: PermissionMode) -> anyhow::Result<()>;
    async fn close(&self) -> anyhow::Result<()>;
}

/// One agent engine (a CLI or local server). Stateless factory of sessions.
#[async_trait]
pub trait Engine: Send + Sync {
    fn id(&self) -> EngineId;
    /// Path or command that this engine will run, for the settings page.
    fn executable(&self) -> Option<PathBuf>;
    /// Is the engine installed and logged in? Cheap check, no session.
    async fn probe(&self) -> anyhow::Result<EngineProbe>;
    async fn list_models(&self) -> anyhow::Result<Vec<ModelInfo>>;
    async fn start_session(&self, opts: SessionOptions) -> anyhow::Result<Box<dyn Session>>;
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct EngineProbe {
    pub installed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth_error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ModelInfo {
    pub id: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
}
