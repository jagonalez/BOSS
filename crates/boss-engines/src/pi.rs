//! pi adapter: drives `pi --mode rpc` (JSON lines on stdio).
//!
//! One child process per session. Commands are correlated by id in
//! `rpc::PiRpc`; streamed events are turned into `EngineEvent`s by
//! `translate::PiTranslator`. With a bus, the generated `extension::`
//! file is loaded via `--extension` and reaches BOSS over HTTP.

pub mod extension;
pub mod rpc;
pub mod translate;

use anyhow::{Context, Result};
use async_channel::{Receiver, Sender};
use async_trait::async_trait;
use boss_core::{
    Engine, EngineEvent, EngineId, EngineProbe, ModelInfo, PermissionDecision, PermissionMode, Prompt, RequestId, Session,
    SessionOptions,
};
use rpc::PiRpc;
use serde_json::{Value, json};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::task::JoinHandle;
use translate::{PiTranslator, models_from_rpc, parse_list_models, parse_model_spec, prompt_command, ui_response};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// The pi engine: spawns `pi --mode rpc` per session.
pub struct PiEngine {
    executable: Option<PathBuf>,
    extension_path: PathBuf,
}

impl Default for PiEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl PiEngine {
    /// Engine that finds `pi` on `PATH`.
    pub fn new() -> Self {
        Self { executable: None, extension_path: extension::default_extension_path() }
    }

    /// Use this binary instead of searching `PATH`.
    pub fn with_executable(mut self, path: impl Into<PathBuf>) -> Self {
        self.executable = Some(path.into());
        self
    }

    /// Where to write the generated bus extension (default: user data dir).
    pub fn with_extension_path(mut self, path: impl Into<PathBuf>) -> Self {
        self.extension_path = path.into();
        self
    }

    fn resolve(&self) -> Result<PathBuf> {
        self.executable().context("pi is not installed (not found on PATH)")
    }
}

/// Command line for `pi --mode rpc`, as `PiBackend` built it: `--approve`,
/// standing instructions appended (never replacing pi's own prompt unless a
/// full `system_prompt` is given), and the bus extension when there is a bus.
pub fn session_args(opts: &SessionOptions, session_id: &str, extension: Option<&std::path::Path>) -> Vec<String> {
    let mut args = vec!["--mode".into(), "rpc".into(), "--session-id".into(), session_id.into(), "--approve".into()];
    if let Some(system) = &opts.system_prompt {
        args.push("--system-prompt".into());
        args.push(system.clone());
    }
    if let Some(standing) = &opts.append_system_prompt {
        args.push("--append-system-prompt".into());
        args.push(standing.clone());
    }
    if let Some(path) = extension {
        args.push("--extension".into());
        args.push(path.to_string_lossy().to_string());
    }
    args
}

/// Environment for the child: bus URL/token plus `BOSS_NATIVE_THREAD_ID`.
pub fn session_env(opts: &SessionOptions, session_id: &str) -> Vec<(String, String)> {
    match &opts.bus {
        Some(bus) => vec![
            ("BOSS_THREAD_BUS_URL".into(), bus.url.clone()),
            ("BOSS_THREAD_BUS_TOKEN".into(), bus.token.clone()),
            ("BOSS_NATIVE_THREAD_ID".into(), session_id.to_string()),
        ],
        None => Vec::new(),
    }
}

#[async_trait]
impl Engine for PiEngine {
    fn id(&self) -> EngineId {
        EngineId::Pi
    }

    fn executable(&self) -> Option<PathBuf> {
        crate::jsonl::resolve_executable(self.executable.as_deref(), "pi")
    }

    async fn probe(&self) -> Result<EngineProbe> {
        let Some(bin) = self.executable() else {
            return Ok(EngineProbe::default());
        };
        let output = tokio::time::timeout(Duration::from_secs(5), tokio::process::Command::new(&bin).arg("--version").output()).await;
        Ok(match output {
            Ok(Ok(out)) if out.status.success() => EngineProbe {
                installed: true,
                version: Some(String::from_utf8_lossy(&out.stdout).trim().to_string()).filter(|v| !v.is_empty()),
                auth_error: None,
            },
            Ok(Ok(out)) => EngineProbe { installed: true, version: None, auth_error: Some(String::from_utf8_lossy(&out.stderr).trim().to_string()) },
            Ok(Err(err)) => EngineProbe { installed: false, version: None, auth_error: Some(err.to_string()) },
            Err(_) => EngineProbe { installed: true, version: None, auth_error: Some("pi --version timed out".into()) },
        })
    }

    async fn list_models(&self) -> Result<Vec<ModelInfo>> {
        let bin = self.resolve()?;
        let out = tokio::time::timeout(
            Duration::from_secs(12),
            tokio::process::Command::new(&bin).args(["--offline", "--list-models"]).output(),
        )
        .await
        .context("pi --list-models timed out")?
        .context("run pi --list-models")?;
        if !out.status.success() {
            anyhow::bail!("pi --list-models failed: {}", String::from_utf8_lossy(&out.stderr).trim());
        }
        Ok(parse_list_models(&String::from_utf8_lossy(&out.stdout)))
    }

    async fn start_session(&self, opts: SessionOptions) -> Result<Box<dyn Session>> {
        let bin = self.resolve()?;
        let session_id = opts.resume.clone().unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let extension = match &opts.bus {
            Some(_) => Some(extension::write_extension(&self.extension_path)?),
            None => None,
        };
        let args = session_args(&opts, &session_id, extension.as_deref());
        let env = session_env(&opts, &session_id);
        let cwd = if opts.cwd.is_dir() { opts.cwd.clone() } else { std::env::current_dir()? };

        let (raw_tx, raw_rx) = async_channel::unbounded::<Value>();
        let rpc = Arc::new(PiRpc::spawn(&bin, &args, &cwd, &env, raw_tx)?);

        // Fail loudly before handing back a session whose process already died.
        let state = match rpc.request(json!({ "type": "get_state" }), REQUEST_TIMEOUT).await {
            Ok(state) => state,
            Err(err) => {
                let mut stderr = Vec::new();
                while let Ok(line) = rpc.stderr().try_recv() {
                    stderr.push(line);
                }
                rpc.kill().await;
                return Err(err.context(format!("pi did not start: {}", stderr.join("\n").trim())));
            }
        };
        let native_id = state.get("sessionId").and_then(Value::as_str).unwrap_or(&session_id).to_string();

        let (tx, rx) = async_channel::unbounded::<EngineEvent>();
        let _ = tx.try_send(EngineEvent::SessionReady { native_session_id: native_id.clone() });
        let translator = Arc::new(Mutex::new(PiTranslator::new()));
        let pump = {
            let tx = tx.clone();
            let translator = translator.clone();
            tokio::spawn(async move {
                while let Ok(raw) = raw_rx.recv().await {
                    let events = translator.lock().map(|mut t| t.translate(&raw)).unwrap_or_default();
                    for event in events {
                        if tx.try_send(event).is_err() {
                            return;
                        }
                    }
                }
                let _ = tx.try_send(EngineEvent::Closed);
                tx.close();
            })
        };

        let session = PiSession { rpc, native_id, translator, tx, rx, pump: Mutex::new(Some(pump)), closed: AtomicBool::new(false) };
        if let Some(model) = &opts.model {
            session.set_model(model.clone()).await?;
        }
        Ok(Box::new(session))
    }
}

/// One `pi --mode rpc` process.
pub struct PiSession {
    rpc: Arc<PiRpc>,
    native_id: String,
    translator: Arc<Mutex<PiTranslator>>,
    tx: Sender<EngineEvent>,
    rx: Receiver<EngineEvent>,
    pump: Mutex<Option<JoinHandle<()>>>,
    closed: AtomicBool,
}

impl PiSession {
    /// Models pi has configured, from `get_available_models`.
    pub async fn available_models(&self) -> Result<Vec<ModelInfo>> {
        let data = self.rpc.request(json!({ "type": "get_available_models" }), REQUEST_TIMEOUT).await?;
        Ok(models_from_rpc(&data))
    }

    fn is_busy(&self) -> bool {
        self.translator.lock().map(|t| t.busy).unwrap_or(false)
    }
}

#[async_trait]
impl Session for PiSession {
    fn engine(&self) -> EngineId {
        EngineId::Pi
    }

    fn native_session_id(&self) -> Option<String> {
        Some(self.native_id.clone())
    }

    fn events(&self) -> Receiver<EngineEvent> {
        self.rx.clone()
    }

    /// While the agent is streaming, the text is queued as a `steer` (pi rejects
    /// a bare `prompt` mid-run).
    async fn send(&self, prompt: Prompt) -> Result<()> {
        let command = prompt_command(&prompt, self.is_busy())?;
        self.rpc.request(command, REQUEST_TIMEOUT).await?;
        Ok(())
    }

    async fn interrupt(&self) -> Result<()> {
        self.rpc.request(json!({ "type": "abort" }), REQUEST_TIMEOUT).await?;
        Ok(())
    }

    /// Answers an `extension_ui_request` dialog (pi has no built-in tool
    /// permission prompts; `--approve` trusts project files at start).
    async fn respond_permission(&self, request: RequestId, decision: PermissionDecision) -> Result<()> {
        let ui = self.translator.lock().ok().and_then(|t| t.ui_request(request.as_str()).cloned());
        let Some(ui) = ui else {
            anyhow::bail!("pi has no pending dialog {}", request.as_str());
        };
        self.rpc.notify(&ui_response(request.as_str(), &ui, &decision)).await?;
        if let Ok(mut t) = self.translator.lock() {
            t.forget_ui_request(request.as_str());
        }
        Ok(())
    }

    /// `provider/model[:thinking]`; a bare id is looked up in pi's model list.
    async fn set_model(&self, model: String) -> Result<()> {
        let spec = match parse_model_spec(&model) {
            Some(spec) => spec,
            None => {
                let known = self.available_models().await?;
                let found = known.iter().find(|m| m.id == model).and_then(|m| m.provider.clone());
                let provider = found.with_context(|| format!("pi does not know a model named {model:?}; use provider/model"))?;
                translate::ModelSpec { provider, model, thinking: None }
            }
        };
        self.rpc
            .request(json!({ "type": "set_model", "provider": spec.provider, "modelId": spec.model }), REQUEST_TIMEOUT)
            .await?;
        if let Some(level) = spec.thinking {
            self.rpc.request(json!({ "type": "set_thinking_level", "level": level }), REQUEST_TIMEOUT).await?;
        }
        Ok(())
    }

    async fn set_permission_mode(&self, _mode: PermissionMode) -> Result<()> {
        // pi's RPC has no permission mode; tools run as pi decides.
        Ok(())
    }

    async fn close(&self) -> Result<()> {
        if self.closed.swap(true, Ordering::SeqCst) {
            return Ok(());
        }
        self.rpc.kill().await;
        if let Ok(mut guard) = self.pump.lock()
            && let Some(task) = guard.take()
        {
            task.abort();
        }
        let _ = self.tx.try_send(EngineEvent::Closed);
        self.tx.close();
        Ok(())
    }
}

impl Drop for PiSession {
    fn drop(&mut self) {
        if self.closed.load(Ordering::SeqCst) {
            return;
        }
        // `JsonlChild` is spawned with kill_on_drop; aborting the pump lets the
        // Arc<PiRpc> drop and the child die with it.
        if let Ok(mut guard) = self.pump.lock()
            && let Some(task) = guard.take()
        {
            task.abort();
        }
        self.tx.close();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use boss_core::BusAccess;

    fn opts(bus: bool) -> SessionOptions {
        SessionOptions {
            thread_id: "thr_1".into(),
            participant_id: "who_1".into(),
            cwd: PathBuf::from("/tmp"),
            model: None,
            permission_mode: PermissionMode::Default,
            resume: None,
            append_system_prompt: Some("You are the reviewer.".into()),
            system_prompt: None,
            allowed_tools: None,
            bus: bus.then(|| BusAccess { url: "http://127.0.0.1:9/bus".into(), token: "tok".into(), thread_id: "thr_1".into(), participant_id: "who_1".into() }),
        }
    }

    #[test]
    fn standing_instructions_are_appended_not_replacing() {
        let args = session_args(&opts(false), "sid", None);
        assert_eq!(args, vec!["--mode", "rpc", "--session-id", "sid", "--approve", "--append-system-prompt", "You are the reviewer."]);
        assert!(!args.iter().any(|a| a == "--system-prompt"));
        let mut full = opts(false);
        full.system_prompt = Some("coordinator".into());
        let args = session_args(&full, "sid", Some(std::path::Path::new("/x/boss_threads.ts")));
        assert!(args.windows(2).any(|w| w == ["--system-prompt", "coordinator"]));
        assert!(args.windows(2).any(|w| w == ["--extension", "/x/boss_threads.ts"]));
    }

    #[test]
    fn bus_env_is_exported_only_with_a_bus() {
        assert!(session_env(&opts(false), "sid").is_empty());
        assert_eq!(
            session_env(&opts(true), "sid"),
            vec![
                ("BOSS_THREAD_BUS_URL".to_string(), "http://127.0.0.1:9/bus".to_string()),
                ("BOSS_THREAD_BUS_TOKEN".to_string(), "tok".to_string()),
                ("BOSS_NATIVE_THREAD_ID".to_string(), "sid".to_string()),
            ]
        );
    }

    #[tokio::test]
    async fn missing_binary_is_reported_not_spawned() {
        let engine = PiEngine::new().with_executable("/nonexistent/pi-binary");
        let probe = engine.probe().await.unwrap();
        assert!(!probe.installed);
        assert!(engine.start_session(opts(false)).await.is_err());
    }
}
