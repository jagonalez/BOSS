//! Codex adapter: drives `codex app-server --stdio` (JSON-RPC 2.0 over JSONL).
//!
//! One app-server process per session. Flow: `initialize` → `thread/start`
//! (or `thread/resume`) → `turn/start` per prompt. Notifications are turned
//! into `EngineEvent`s by `translate`; approvals arrive as server requests
//! and are answered through `Session::respond_permission`. When the session
//! has bus access, the thread bus is registered as a streamable-HTTP MCP
//! server through `-c mcp_servers.*` config overrides, with the bearer token
//! passed in an environment variable rather than on the command line.

mod rpc;
mod translate;

pub use rpc::{Incoming, Reply, RpcClient, RpcError};
pub use translate::Translator;

use crate::jsonl::{self, JsonlChild};
use anyhow::{Context, Result, anyhow};
use async_channel::{Receiver, Sender};
use async_trait::async_trait;
use boss_core::{
    Engine, EngineEvent, EngineId, EngineProbe, ModelInfo, PermissionDecision, PermissionMode, Prompt, RequestId, Session,
    SessionOptions,
};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

/// Name under which the thread bus is registered in codex's MCP config.
pub const BUS_SERVER_NAME: &str = "boss_thread_bus";
/// Environment variable codex reads the bus bearer token from.
pub const BUS_TOKEN_ENV: &str = "BOSS_THREAD_BUS_TOKEN";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);

/// The codex engine: a factory for app-server sessions.
#[derive(Clone, Debug, Default)]
pub struct CodexEngine {
    executable: Option<PathBuf>,
}

impl CodexEngine {
    /// Use `codex` from PATH.
    pub fn new() -> Self {
        Self::default()
    }

    /// Use a specific codex binary.
    pub fn with_executable(path: PathBuf) -> Self {
        Self { executable: Some(path) }
    }

    fn binary(&self) -> Result<PathBuf> {
        self.executable().context("codex CLI not found on PATH")
    }
}

#[async_trait]
impl Engine for CodexEngine {
    fn id(&self) -> EngineId {
        EngineId::Codex
    }

    fn executable(&self) -> Option<PathBuf> {
        jsonl::resolve_executable(self.executable.as_deref(), "codex")
    }

    async fn probe(&self) -> Result<EngineProbe> {
        let Some(bin) = self.executable() else {
            return Ok(EngineProbe::default());
        };
        let run = tokio::process::Command::new(&bin).arg("--version").output();
        let version = match tokio::time::timeout(Duration::from_secs(5), run).await {
            Ok(Ok(output)) if output.status.success() => parse_version(&String::from_utf8_lossy(&output.stdout)),
            Ok(Ok(output)) => {
                let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
                return Ok(EngineProbe { installed: true, version: None, auth_error: Some(stderr) });
            }
            Ok(Err(err)) => return Ok(EngineProbe { installed: false, version: None, auth_error: Some(err.to_string()) }),
            Err(_) => None,
        };
        let auth_error =
            (!codex_home().join("auth.json").is_file()).then(|| "Not logged in. Run `codex login`.".to_owned());
        Ok(EngineProbe { installed: true, version, auth_error })
    }

    async fn list_models(&self) -> Result<Vec<ModelInfo>> {
        let bin = self.binary()?;
        let cwd = std::env::current_dir().unwrap_or_else(|_| std::env::temp_dir());
        let conn = Connection::open(&bin, &cwd, &[], &[]).await?;
        let result = conn.rpc.request("model/list", json!({ "limit": 100, "includeHidden": false })).await;
        conn.child.kill().await.ok();
        Ok(models_from(&result?))
    }

    async fn start_session(&self, opts: SessionOptions) -> Result<Box<dyn Session>> {
        Ok(Box::new(CodexSession::start(self.binary()?, opts).await?))
    }
}

/// `codex-cli 0.147.0` → `0.147.0`.
fn parse_version(stdout: &str) -> Option<String> {
    let line = stdout.lines().next()?.trim();
    let version = line.strip_prefix("codex-cli").map(str::trim).unwrap_or(line);
    (!version.is_empty()).then(|| version.to_owned())
}

/// `$CODEX_HOME`, else `~/.codex`.
fn codex_home() -> PathBuf {
    if let Some(home) = std::env::var_os("CODEX_HOME") {
        return PathBuf::from(home);
    }
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).unwrap_or_default();
    PathBuf::from(home).join(".codex")
}

/// `model/list` response → model infos.
fn models_from(result: &Value) -> Vec<ModelInfo> {
    result
        .get("data")
        .and_then(Value::as_array)
        .map(|models| {
            models
                .iter()
                .filter_map(|m| {
                    let id = m.get("id").and_then(Value::as_str)?.to_owned();
                    let label = m.get("displayName").and_then(Value::as_str).filter(|s| !s.is_empty()).unwrap_or(&id).to_owned();
                    Some(ModelInfo { id, label, provider: Some("openai".to_owned()) })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Who reviews codex approval requests. codex defaults to `user`, but a
/// user's `~/.codex/config.toml` may set `approvals_reviewer` to a subagent
/// that answers them itself; BOSS then never sees a `PermissionRequested`
/// and the turn escapes its sandbox silently. Pin it so approvals always
/// reach the app.
pub const APPROVALS_REVIEWER: &str = "user";

/// codex `approvalPolicy` for a BOSS permission mode.
fn approval_policy(mode: PermissionMode) -> &'static str {
    match mode {
        PermissionMode::Bypass => "never",
        PermissionMode::Default | PermissionMode::AcceptEdits | PermissionMode::Plan => "on-request",
    }
}

/// codex `sandbox` (thread/start) for a BOSS permission mode.
fn sandbox_mode(mode: PermissionMode) -> &'static str {
    match mode {
        PermissionMode::Plan => "read-only",
        PermissionMode::Bypass => "danger-full-access",
        PermissionMode::Default | PermissionMode::AcceptEdits => "workspace-write",
    }
}

/// codex `sandboxPolicy` (turn/start) for a BOSS permission mode.
fn sandbox_policy(mode: PermissionMode, cwd: &Path) -> Value {
    match mode {
        PermissionMode::Plan => json!({ "type": "readOnly", "networkAccess": false }),
        PermissionMode::Bypass => json!({ "type": "dangerFullAccess" }),
        PermissionMode::Default | PermissionMode::AcceptEdits => json!({
            "type": "workspaceWrite",
            "writableRoots": [cwd],
            "networkAccess": true,
            "excludeTmpdirEnvVar": false,
            "excludeSlashTmp": false,
        }),
    }
}

/// A TOML basic string literal (JSON string syntax is a subset of TOML's).
fn toml_string(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| format!("\"{value}\""))
}

/// Extra `codex app-server` arguments: MCP config overrides for the thread bus.
fn spawn_args(opts: &SessionOptions) -> Vec<String> {
    let mut args = Vec::new();
    let Some(bus) = &opts.bus else { return args };
    let mut set = |key: &str, value: String| {
        args.push("-c".to_owned());
        args.push(format!("mcp_servers.{BUS_SERVER_NAME}.{key}={value}"));
    };
    set("url", toml_string(&bus.url));
    set("bearer_token_env_var", toml_string(BUS_TOKEN_ENV));
    if let Some(tools) = &opts.allowed_tools {
        let list = tools.iter().map(|t| toml_string(t)).collect::<Vec<_>>().join(", ");
        set("enabled_tools", format!("[{list}]"));
    }
    args
}

/// Extra environment for the child: the bus bearer token, off the command line.
fn spawn_env(opts: &SessionOptions) -> Vec<(String, String)> {
    opts.bus.iter().map(|bus| (BUS_TOKEN_ENV.to_owned(), bus.token.clone())).collect()
}

/// `turn/start` input items for a prompt. Images ride as `localImage`; other
/// attachments are named in the text, which is all codex can take.
fn user_input(prompt: &Prompt) -> Value {
    let mut text = prompt.text.clone();
    let mut items = Vec::new();
    for attachment in &prompt.attachments {
        if attachment.mime.starts_with("image/") {
            items.push(json!({ "type": "localImage", "path": attachment.path }));
        } else {
            if !text.is_empty() {
                text.push('\n');
            }
            text.push_str(&format!("[Attached file: {}]", attachment.path.display()));
        }
    }
    if !text.is_empty() {
        items.insert(0, json!({ "type": "text", "text": text, "text_elements": [] }));
    }
    Value::Array(items)
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// A live app-server: the child, its RPC client, and the server-initiated traffic.
struct Connection {
    child: Arc<JsonlChild>,
    rpc: Arc<RpcClient>,
    /// Server requests and notifications, in order. Closes when the child exits.
    inbound: Receiver<Incoming>,
}

impl Connection {
    async fn open(bin: &Path, cwd: &Path, args: &[String], env: &[(String, String)]) -> Result<Self> {
        let mut all_args = vec!["app-server".to_owned(), "--stdio".to_owned()];
        all_args.extend_from_slice(args);
        let child = Arc::new(JsonlChild::spawn(bin, &all_args, cwd, env)?);
        let rpc = Arc::new(RpcClient::new(child.clone(), REQUEST_TIMEOUT));
        let (tx, inbound) = async_channel::unbounded();
        tokio::spawn(pump(child.clone(), rpc.clone(), tx));
        rpc.request(
            "initialize",
            json!({
                "clientInfo": { "name": "boss_native", "title": "BOSS", "version": env!("CARGO_PKG_VERSION") },
                "capabilities": { "experimentalApi": true, "requestAttestation": false },
            }),
        )
        .await
        .context("codex initialize")?;
        rpc.notify("initialized", json!({})).await?;
        Ok(Self { child, rpc, inbound })
    }
}

/// Read the child's stdout: responses settle requests, everything else is forwarded.
async fn pump(child: Arc<JsonlChild>, rpc: Arc<RpcClient>, tx: Sender<Incoming>) {
    let lines = child.lines();
    while let Ok(value) = lines.recv().await {
        match rpc::classify(value) {
            Some(Incoming::Response { id, result }) => {
                if !rpc.handle_response(&id, result) {
                    tracing::debug!(%id, "codex response without a waiting request");
                }
            }
            Some(other) => {
                let _ = tx.send(other).await;
            }
            None => {}
        }
    }
    rpc.fail_all();
    tx.close();
}

/// Turn settings that apply from the next `turn/start` on.
#[derive(Clone)]
struct TurnSettings {
    mode: PermissionMode,
    model: Option<String>,
}

/// One codex thread on its own app-server process.
pub struct CodexSession {
    child: Arc<JsonlChild>,
    rpc: Arc<RpcClient>,
    thread_id: String,
    cwd: PathBuf,
    state: Arc<Mutex<Translator>>,
    settings: Mutex<TurnSettings>,
    events_tx: Sender<EngineEvent>,
    events_rx: Receiver<EngineEvent>,
}

impl CodexSession {
    async fn start(bin: PathBuf, opts: SessionOptions) -> Result<Self> {
        let Connection { child, rpc, inbound } = Connection::open(&bin, &opts.cwd, &spawn_args(&opts), &spawn_env(&opts)).await?;

        let mut params = json!({
            "cwd": opts.cwd,
            "approvalPolicy": approval_policy(opts.permission_mode),
            "approvalsReviewer": APPROVALS_REVIEWER,
            "sandbox": sandbox_mode(opts.permission_mode),
        });
        if let Some(model) = &opts.model {
            params["model"] = json!(model);
        }
        if let Some(system) = &opts.system_prompt {
            params["baseInstructions"] = json!(system);
        }
        if let Some(extra) = &opts.append_system_prompt {
            params["developerInstructions"] = json!(extra);
        }
        let method = match &opts.resume {
            Some(thread_id) => {
                params["threadId"] = json!(thread_id);
                "thread/resume"
            }
            None => "thread/start",
        };
        let result = rpc.request(method, params).await.with_context(|| format!("codex {method}"))?;
        let thread_id = result.pointer("/thread/id").and_then(Value::as_str).context("codex thread id missing")?.to_owned();
        let model = result.get("model").and_then(Value::as_str).map(str::to_owned).or_else(|| opts.model.clone());

        let state = Arc::new(Mutex::new(Translator::new(opts.permission_mode, model.clone())));
        let (events_tx, events_rx) = async_channel::unbounded();
        events_tx.send(EngineEvent::SessionReady { native_session_id: thread_id.clone() }).await?;
        tokio::spawn(consume(inbound, rpc.clone(), state.clone(), events_tx.clone()));

        Ok(Self {
            child,
            rpc,
            thread_id,
            cwd: opts.cwd,
            state,
            settings: Mutex::new(TurnSettings { mode: opts.permission_mode, model }),
            events_tx,
            events_rx,
        })
    }
}

/// Feed server traffic through the translator; answer server requests; report the end.
async fn consume(inbound: Receiver<Incoming>, rpc: Arc<RpcClient>, state: Arc<Mutex<Translator>>, events: Sender<EngineEvent>) {
    while let Ok(message) = inbound.recv().await {
        let (batch, reply) = {
            let mut translator = lock(&state);
            match message {
                Incoming::Request { id, method, params } => translator.server_request(id, &method, &params),
                Incoming::Notification { method, params } => (translator.notification(&method, &params), None),
                Incoming::Response { .. } => (Vec::new(), None),
            }
        };
        for event in batch {
            if events.send(event).await.is_err() {
                return;
            }
        }
        if let Some(reply) = reply
            && let Err(err) = rpc.reply(&reply).await
        {
            tracing::warn!(%err, "codex: could not answer server request");
        }
    }
    let _ = events.send(EngineEvent::Closed).await;
}

#[async_trait]
impl Session for CodexSession {
    fn engine(&self) -> EngineId {
        EngineId::Codex
    }

    fn native_session_id(&self) -> Option<String> {
        Some(self.thread_id.clone())
    }

    fn events(&self) -> Receiver<EngineEvent> {
        self.events_rx.clone()
    }

    async fn send(&self, prompt: Prompt) -> Result<()> {
        let TurnSettings { mode, model } = lock(&self.settings).clone();
        let mut params = json!({
            "threadId": self.thread_id,
            "cwd": self.cwd,
            "input": user_input(&prompt),
            "approvalPolicy": approval_policy(mode),
            "approvalsReviewer": APPROVALS_REVIEWER,
            "sandboxPolicy": sandbox_policy(mode, &self.cwd),
        });
        if let Some(model) = model {
            params["model"] = json!(model);
        }
        let result = self.rpc.request("turn/start", params).await.context("codex turn/start")?;
        if let Some(turn_id) = result.pointer("/turn/id").and_then(Value::as_str) {
            let batch = lock(&self.state).turn_accepted(turn_id);
            for event in batch {
                self.events_tx.send(event).await.ok();
            }
        }
        Ok(())
    }

    async fn interrupt(&self) -> Result<()> {
        let Some(turn_id) = lock(&self.state).active_turn().map(str::to_owned) else {
            return Ok(());
        };
        self.rpc.request("turn/interrupt", json!({ "threadId": self.thread_id, "turnId": turn_id })).await.context("codex turn/interrupt")?;
        Ok(())
    }

    async fn respond_permission(&self, request: RequestId, decision: PermissionDecision) -> Result<()> {
        let reply = lock(&self.state).resolve(&request, &decision).ok_or_else(|| anyhow!("no pending codex approval {request}"))?;
        self.rpc.reply(&reply).await
    }

    async fn set_model(&self, model: String) -> Result<()> {
        lock(&self.settings).model = Some(model.clone());
        lock(&self.state).set_model(Some(model));
        Ok(())
    }

    async fn set_permission_mode(&self, mode: PermissionMode) -> Result<()> {
        lock(&self.settings).mode = mode;
        lock(&self.state).set_mode(mode);
        Ok(())
    }

    async fn close(&self) -> Result<()> {
        self.child.kill().await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use boss_core::{Attachment, BusAccess, ParticipantId, ThreadId};

    fn options(bus: Option<BusAccess>) -> SessionOptions {
        SessionOptions {
            thread_id: ThreadId::from_raw("thr_1"),
            participant_id: ParticipantId::from_raw("who_1"),
            cwd: PathBuf::from("/repo"),
            model: None,
            permission_mode: PermissionMode::Default,
            resume: None,
            append_system_prompt: None,
            system_prompt: None,
            allowed_tools: None,
            bus,
        }
    }

    fn bus() -> BusAccess {
        BusAccess {
            url: "http://127.0.0.1:43123/mcp".into(),
            token: "secret-token".into(),
            thread_id: ThreadId::from_raw("thr_1"),
            participant_id: ParticipantId::from_raw("who_1"),
        }
    }

    #[test]
    fn permission_modes_map_to_codex_policies() {
        assert_eq!(approval_policy(PermissionMode::Default), "on-request");
        assert_eq!(approval_policy(PermissionMode::AcceptEdits), "on-request");
        assert_eq!(approval_policy(PermissionMode::Plan), "on-request");
        assert_eq!(approval_policy(PermissionMode::Bypass), "never");

        assert_eq!(sandbox_mode(PermissionMode::Default), "workspace-write");
        assert_eq!(sandbox_mode(PermissionMode::Plan), "read-only");
        assert_eq!(sandbox_mode(PermissionMode::Bypass), "danger-full-access");

        let cwd = Path::new("/repo");
        assert_eq!(sandbox_policy(PermissionMode::Plan, cwd), json!({ "type": "readOnly", "networkAccess": false }));
        assert_eq!(sandbox_policy(PermissionMode::Bypass, cwd), json!({ "type": "dangerFullAccess" }));
        let write = sandbox_policy(PermissionMode::Default, cwd);
        assert_eq!(write["type"], "workspaceWrite");
        assert_eq!(write["writableRoots"], json!(["/repo"]));
        assert_eq!(write["networkAccess"], true);
        assert_eq!(sandbox_policy(PermissionMode::AcceptEdits, cwd), write);
    }

    #[test]
    fn bus_is_registered_as_an_mcp_server_with_the_token_in_the_environment() {
        let opts = options(None);
        assert!(spawn_args(&opts).is_empty());
        assert!(spawn_env(&opts).is_empty());

        let mut opts = options(Some(bus()));
        let args = spawn_args(&opts);
        assert_eq!(
            args,
            vec![
                "-c",
                "mcp_servers.boss_thread_bus.url=\"http://127.0.0.1:43123/mcp\"",
                "-c",
                "mcp_servers.boss_thread_bus.bearer_token_env_var=\"BOSS_THREAD_BUS_TOKEN\"",
            ]
        );
        assert!(!args.iter().any(|a| a.contains("secret-token")), "the token must not be on the command line");
        assert_eq!(spawn_env(&opts), vec![("BOSS_THREAD_BUS_TOKEN".to_owned(), "secret-token".to_owned())]);

        opts.allowed_tools = Some(vec!["boss_threads_list".into(), "boss_threads_reply".into()]);
        let args = spawn_args(&opts);
        assert_eq!(args[5], "mcp_servers.boss_thread_bus.enabled_tools=[\"boss_threads_list\", \"boss_threads_reply\"]");
    }

    #[test]
    fn approvals_are_reviewed_by_the_user_not_a_subagent() {
        // `approvals_reviewer = "guardian_subagent"` in the user's config makes
        // codex answer its own approvals, so BOSS never sees a
        // `PermissionRequested` and a turn can write outside its sandbox
        // unasked. Both `thread/start` and `turn/start` must pin `user`.
        assert_eq!(APPROVALS_REVIEWER, "user");
        let source = include_str!("codex.rs");
        assert_eq!(
            source.matches("\"approvalsReviewer\": APPROVALS_REVIEWER").count(),
            2,
            "thread/start and turn/start must both send approvalsReviewer"
        );
    }

    #[test]
    fn prompt_becomes_turn_input() {
        let prompt = Prompt { text: "Look at this".into(), attachments: vec![] };
        assert_eq!(user_input(&prompt), json!([{ "type": "text", "text": "Look at this", "text_elements": [] }]));

        let prompt = Prompt {
            text: "Look at this".into(),
            attachments: vec![
                Attachment { mime: "image/png".into(), path: PathBuf::from("/tmp/shot.png") },
                Attachment { mime: "application/pdf".into(), path: PathBuf::from("/tmp/spec.pdf") },
            ],
        };
        assert_eq!(
            user_input(&prompt),
            json!([
                { "type": "text", "text": "Look at this\n[Attached file: /tmp/spec.pdf]", "text_elements": [] },
                { "type": "localImage", "path": "/tmp/shot.png" },
            ])
        );
        assert_eq!(user_input(&Prompt { text: String::new(), attachments: vec![] }), json!([]));
    }

    #[test]
    fn model_list_response_maps_to_model_infos() {
        let response = json!({ "data": [
            { "id": "gpt-5.6-codex", "model": "gpt-5.6-codex", "displayName": "GPT-5.6 Codex", "description": "", "hidden": false, "isDefault": true,
              "defaultReasoningEffort": "medium", "supportedReasoningEfforts": [{ "reasoningEffort": "low", "description": "" }] },
            { "id": "gpt-5.6", "model": "gpt-5.6", "displayName": "", "description": "", "hidden": false, "isDefault": false,
              "defaultReasoningEffort": "medium", "supportedReasoningEfforts": [] },
            { "model": "no-id" }
        ], "nextCursor": null });
        assert_eq!(
            models_from(&response),
            vec![
                ModelInfo { id: "gpt-5.6-codex".into(), label: "GPT-5.6 Codex".into(), provider: Some("openai".into()) },
                ModelInfo { id: "gpt-5.6".into(), label: "gpt-5.6".into(), provider: Some("openai".into()) },
            ]
        );
        assert!(models_from(&json!({})).is_empty());
    }

    #[test]
    fn version_output_is_trimmed() {
        assert_eq!(parse_version("codex-cli 0.147.0\n"), Some("0.147.0".into()));
        assert_eq!(parse_version("0.150.0"), Some("0.150.0".into()));
        assert_eq!(parse_version(""), None);
    }

    #[test]
    fn engine_reports_its_identity_and_override() {
        let engine = CodexEngine::with_executable(PathBuf::from("/opt/codex/bin/codex"));
        assert_eq!(engine.id(), EngineId::Codex);
        assert_eq!(engine.executable(), Some(PathBuf::from("/opt/codex/bin/codex")));
    }
}
