//! The Electron app's on-disk shapes, only as much of each as the import
//! reads. Everything is `Option` or `#[serde(default)]`: these files were
//! written by several versions of the TS app and a missing field must not
//! lose a whole thread.

use serde::Deserialize;
use serde_json::Value;
use std::collections::BTreeMap;

/// `state.json` — the project list is a bare list of paths.
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct State {
    pub project_path: Option<String>,
    pub projects: Vec<String>,
}

/// `backend-threads.json`, the thread index.
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct BackendThreads {
    pub threads: Vec<BackendThread>,
}

/// One row of `backend-threads.json`. `projectId` is `"global"` for a
/// thread the user started without a project.
#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct BackendThread {
    pub id: String,
    pub backend_id: String,
    pub native_session_id: Option<String>,
    pub project_id: Option<String>,
    /// Empty string for a project-less thread.
    pub project_path: Option<String>,
    /// Where the agent ran: a worktree, the project root, or the scratch dir.
    pub execution_path: Option<String>,
    pub title: Option<String>,
    /// Epoch milliseconds.
    pub created_at: Option<i64>,
    pub updated_at: Option<i64>,
    pub archived: Option<bool>,
}

/// `claude-threads.json` holds `{ sessions: { <id>: ClaudeSession } }`. The
/// user's copy is 129 MB, so it is only ever read through a streaming
/// reader, one session at a time; there is no whole-file struct.
#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ClaudeSession {
    pub title: Option<String>,
    pub project_path: Option<String>,
    pub created_at: Option<i64>,
    pub updated_at: Option<i64>,
    pub messages: Vec<ClaudeMessage>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct ClaudeMessage {
    pub info: MessageInfo,
    pub parts: Vec<Value>,
}

/// The `info` object shared by `claude-threads.json` and the
/// `transcript_messages.data_json` column.
#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct MessageInfo {
    pub id: Option<String>,
    #[serde(rename = "sessionID")]
    pub session_id: Option<String>,
    pub role: Option<String>,
    pub time: MessageTime,
    /// `{}` on most rows; `{ "modelID": ... }` when the engine reported one.
    pub model: Value,
    pub error: Option<Value>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct MessageTime {
    pub created: Option<i64>,
    pub completed: Option<i64>,
}

impl MessageInfo {
    /// The model name, wherever this version of the app put it.
    pub fn model_name(&self) -> Option<String> {
        for key in ["modelID", "model_id", "id", "name"] {
            if let Some(s) = self.model.get(key).and_then(Value::as_str) {
                return Some(s.to_string());
            }
        }
        None
    }
}

/// `mcp-connections.json`.
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct McpConnections {
    pub connections: Vec<McpConnectionRow>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct McpConnectionRow {
    pub id: Option<String>,
    pub name: String,
    pub slug: Option<String>,
    pub enabled: Option<bool>,
    /// `"stdio"` or `"http"`.
    pub transport: Option<String>,
    pub command: Option<String>,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
    pub url: Option<String>,
    pub auth_scheme: Option<String>,
    pub headers: BTreeMap<String, String>,
    /// Epoch milliseconds.
    pub created_at: Option<i64>,
    /// True when `authToken` and header values are `safeStorage` ciphertext.
    /// Those cannot be decrypted outside Electron, so they are dropped.
    pub secrets_encrypted: Option<bool>,
    pub auth_token: Option<String>,
}
