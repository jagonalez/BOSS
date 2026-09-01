//! opencode adapter: drives `opencode serve` over HTTP + SSE.
//!
//! One server per working directory (and per bus token, since the generated
//! bus tools read the token from the server's environment). Sessions are
//! created through the REST API; their events arrive on the server's SSE
//! stream and are translated by `events::OpencodeTranslator`.

pub mod bus_tools;
pub mod client;
pub mod events;
pub mod plugin;
pub mod server;

use anyhow::{Context, Result};
use async_channel::{Receiver, Sender};
use async_trait::async_trait;
use boss_core::{
    Engine, EngineEvent, EngineId, EngineProbe, ModelInfo, PermissionDecision, PermissionMode, Prompt, RequestId, Session,
    SessionOptions,
};
use client::{models_from_providers, split_model};
use events::OpencodeTranslator;
use serde_json::{Value, json};
use server::{OpencodeServer, ServerSpawn};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

/// Which server a session shares: same checkout and same bus identity.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct ServerKey {
    cwd: PathBuf,
    bus: Option<(String, String)>,
}

type Servers = Arc<Mutex<HashMap<ServerKey, Arc<OpencodeServer>>>>;

/// The opencode engine. Owns every server it has started.
pub struct OpencodeEngine {
    executable: Option<PathBuf>,
    config_dir: PathBuf,
    servers: Servers,
}

impl Default for OpencodeEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl OpencodeEngine {
    /// Engine that finds `opencode` on `PATH` (or `OPENCODE_BIN`).
    pub fn new() -> Self {
        Self { executable: None, config_dir: plugin::default_config_dir(), servers: Default::default() }
    }

    /// Use this binary instead of searching `PATH`.
    pub fn with_executable(mut self, path: impl Into<PathBuf>) -> Self {
        self.executable = Some(path.into());
        self
    }

    /// Where to write the generated `OPENCODE_CONFIG_DIR` (default: user data dir).
    pub fn with_config_dir(mut self, dir: impl Into<PathBuf>) -> Self {
        self.config_dir = dir.into();
        self
    }

    fn resolve(&self) -> Result<PathBuf> {
        server::resolve_executable(self.executable.as_deref()).context("opencode is not installed (not found on PATH)")
    }

    /// The server for `cwd` + bus, starting one if needed. Bus sessions get the
    /// generated tools via `OPENCODE_CONFIG_DIR` unless the process already has
    /// one set, as the TS did.
    async fn server_for(&self, cwd: &Path, bus: Option<&boss_core::BusAccess>) -> Result<(ServerKey, Arc<OpencodeServer>)> {
        let key = ServerKey { cwd: cwd.to_path_buf(), bus: bus.map(|b| (b.url.clone(), b.token.clone())) };
        let mut servers = self.servers.lock().await;
        if let Some(existing) = servers.get(&key) {
            return Ok((key, existing.clone()));
        }
        let config_dir = match bus {
            Some(_) if std::env::var_os("OPENCODE_CONFIG_DIR").is_some() => {
                tracing::warn!("OPENCODE_CONFIG_DIR is already set; BOSS thread tools were not injected.");
                None
            }
            Some(_) => Some(plugin::write_config_dir(&self.config_dir)?),
            None => None,
        };
        let spawn = ServerSpawn { executable: self.resolve()?, cwd: cwd.to_path_buf(), bus: bus.cloned(), config_dir };
        let server = Arc::new(OpencodeServer::start(spawn).await?);
        servers.insert(key.clone(), server.clone());
        Ok((key, server))
    }

    /// Stop every server this engine started.
    pub async fn shutdown(&self) {
        let servers: Vec<_> = self.servers.lock().await.drain().map(|(_, s)| s).collect();
        for server in servers {
            server.stop().await;
        }
    }
}

#[async_trait]
impl Engine for OpencodeEngine {
    fn id(&self) -> EngineId {
        EngineId::Opencode
    }

    fn executable(&self) -> Option<PathBuf> {
        server::resolve_executable(self.executable.as_deref())
    }

    async fn probe(&self) -> Result<EngineProbe> {
        let Some(bin) = self.executable() else {
            return Ok(EngineProbe::default());
        };
        let output = tokio::time::timeout(Duration::from_secs(5), tokio::process::Command::new(&bin).arg("--version").output()).await;
        match output {
            Ok(Ok(out)) if out.status.success() => Ok(EngineProbe {
                installed: true,
                version: Some(String::from_utf8_lossy(&out.stdout).trim().to_string()).filter(|v| !v.is_empty()),
                auth_error: None,
            }),
            Ok(Ok(out)) => Ok(EngineProbe {
                installed: true,
                version: None,
                auth_error: Some(String::from_utf8_lossy(&out.stderr).trim().to_string()),
            }),
            Ok(Err(err)) => Ok(EngineProbe { installed: false, version: None, auth_error: Some(err.to_string()) }),
            Err(_) => Ok(EngineProbe { installed: true, version: None, auth_error: Some("opencode --version timed out".into()) }),
        }
    }

    async fn list_models(&self) -> Result<Vec<ModelInfo>> {
        let cwd = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
        let (_, server) = self.server_for(&cwd, None).await?;
        let body = server.client().providers(Some(&cwd.to_string_lossy())).await?;
        Ok(models_from_providers(&body))
    }

    async fn start_session(&self, opts: SessionOptions) -> Result<Box<dyn Session>> {
        let (key, server) = self.server_for(&opts.cwd, opts.bus.as_ref()).await?;
        let directory = opts.cwd.to_string_lossy().to_string();
        let client = server.client().clone();
        let record = match &opts.resume {
            Some(id) => client.session_get(&directory, id).await?,
            None => client.session_create(&directory, None).await?,
        };
        let session_id = record.get("id").and_then(Value::as_str).context("OpenCode session record has no id")?.to_string();
        // Reads go to the scope opencode filed the session under; runs go to cwd.
        let stored_directory = record.get("directory").and_then(Value::as_str).unwrap_or(&directory).to_string();
        server.retain();

        let (tx, rx) = async_channel::unbounded::<EngineEvent>();
        let _ = tx.try_send(EngineEvent::SessionReady { native_session_id: session_id.clone() });
        let translator = Arc::new(std::sync::Mutex::new(OpencodeTranslator::new(session_id.clone())));
        let stream_task = {
            let tx = tx.clone();
            let translator = translator.clone();
            tokio::spawn(events::run_event_stream(client.clone(), move |raw| {
                let events = translator.lock().map(|mut t| t.translate(&raw)).unwrap_or_default();
                for event in events {
                    if tx.try_send(event).is_err() {
                        return false;
                    }
                }
                true
            }))
        };

        Ok(Box::new(OpencodeSession {
            server,
            servers: self.servers.clone(),
            key,
            session_id,
            directory,
            stored_directory,
            model: std::sync::Mutex::new(opts.model.clone()),
            system: opts.system_prompt.clone().or(opts.append_system_prompt.clone()),
            tx,
            rx,
            translator,
            stream_task: std::sync::Mutex::new(Some(stream_task)),
            closed: AtomicBool::new(false),
        }))
    }
}

/// One opencode session bound to a shared server.
pub struct OpencodeSession {
    server: Arc<OpencodeServer>,
    servers: Servers,
    key: ServerKey,
    session_id: String,
    /// Where prompts run (the thread's checkout).
    directory: String,
    /// Where opencode keeps the session's records; reads and replies use it.
    stored_directory: String,
    model: std::sync::Mutex<Option<String>>,
    system: Option<String>,
    tx: Sender<EngineEvent>,
    rx: Receiver<EngineEvent>,
    translator: Arc<std::sync::Mutex<OpencodeTranslator>>,
    stream_task: std::sync::Mutex<Option<JoinHandle<()>>>,
    closed: AtomicBool,
}

impl OpencodeSession {
    fn client(&self) -> &client::OpencodeClient {
        self.server.client()
    }

    fn stop_stream(&self) {
        if let Ok(mut guard) = self.stream_task.lock()
            && let Some(task) = guard.take()
        {
            task.abort();
        }
    }
}

/// Build the `parts` array for `/session/{id}/prompt_async`: text plus each
/// attachment as a `file` part with a data URL.
pub fn prompt_parts(prompt: &Prompt) -> Result<Vec<Value>> {
    use base64::Engine as _;
    let mut parts = Vec::new();
    if !prompt.text.is_empty() {
        parts.push(json!({ "type": "text", "text": prompt.text }));
    }
    for attachment in &prompt.attachments {
        let bytes = std::fs::read(&attachment.path).with_context(|| format!("read attachment {}", attachment.path.display()))?;
        let data = base64::engine::general_purpose::STANDARD.encode(bytes);
        let filename = attachment.path.file_name().map(|n| n.to_string_lossy().to_string());
        parts.push(json!({
            "type": "file",
            "mime": attachment.mime,
            "filename": filename,
            "url": format!("data:{};base64,{}", attachment.mime, data),
        }));
    }
    Ok(parts)
}

#[async_trait]
impl Session for OpencodeSession {
    fn engine(&self) -> EngineId {
        EngineId::Opencode
    }

    fn native_session_id(&self) -> Option<String> {
        Some(self.session_id.clone())
    }

    fn events(&self) -> Receiver<EngineEvent> {
        self.rx.clone()
    }

    async fn send(&self, prompt: Prompt) -> Result<()> {
        let mut body = json!({ "parts": prompt_parts(&prompt)? });
        let model = self.model.lock().map(|m| m.clone()).unwrap_or(None);
        if let Some(model) = model.as_deref() {
            match split_model(model) {
                Some(pair) => body["model"] = pair,
                None => tracing::warn!(%model, "opencode: model has no provider prefix; using the server default"),
            }
        }
        if let Some(system) = &self.system {
            body["system"] = Value::String(system.clone());
        }
        self.client().prompt_async(&self.directory, &self.session_id, &body).await?;
        let _ = self.tx.try_send(EngineEvent::Status { busy: true });
        Ok(())
    }

    async fn interrupt(&self) -> Result<()> {
        self.client().abort(&self.stored_directory, &self.session_id).await
    }

    async fn respond_permission(&self, request: RequestId, decision: PermissionDecision) -> Result<()> {
        let is_question = self.translator.lock().map(|t| t.is_question(request.as_str())).unwrap_or(false);
        if is_question {
            let result = match &decision {
                PermissionDecision::Allow { updated_input } => {
                    let answer = match updated_input {
                        Some(Value::String(s)) => vec![s.clone()],
                        Some(Value::Array(items)) => items.iter().filter_map(Value::as_str).map(str::to_string).collect(),
                        _ => Vec::new(),
                    };
                    self.client().question_reply(&self.stored_directory, request.as_str(), &[answer]).await
                }
                PermissionDecision::Deny { .. } => self.client().question_reject(&self.stored_directory, request.as_str()).await,
            };
            if let Ok(mut t) = self.translator.lock() {
                t.forget_question(request.as_str());
            }
            return result;
        }
        let response = match decision {
            PermissionDecision::Allow { .. } => "once",
            PermissionDecision::Deny { .. } => "reject",
        };
        self.client().permission_respond(&self.stored_directory, &self.session_id, request.as_str(), response).await
    }

    async fn set_model(&self, model: String) -> Result<()> {
        if split_model(&model).is_none() {
            anyhow::bail!("OpenCode models are named provider/model; got {model:?}");
        }
        if let Ok(mut m) = self.model.lock() {
            *m = Some(model);
        }
        Ok(())
    }

    async fn set_permission_mode(&self, _mode: PermissionMode) -> Result<()> {
        // opencode has no per-session permission mode over HTTP; permissions
        // are answered one by one through `respond_permission`.
        Ok(())
    }

    async fn close(&self) -> Result<()> {
        if self.closed.swap(true, Ordering::SeqCst) {
            return Ok(());
        }
        self.stop_stream();
        let _ = self.tx.try_send(EngineEvent::Closed);
        self.tx.close();
        if self.server.release() == 0 {
            let removed = self.servers.lock().await.remove(&self.key);
            if let Some(server) = removed {
                server.stop().await;
            }
        }
        Ok(())
    }
}

impl Drop for OpencodeSession {
    fn drop(&mut self) {
        if self.closed.load(Ordering::SeqCst) {
            return;
        }
        self.stop_stream();
        self.tx.close();
        if self.server.release() == 0
            && let Ok(handle) = tokio::runtime::Handle::try_current()
        {
            let servers = self.servers.clone();
            let key = self.key.clone();
            handle.spawn(async move {
                let removed = servers.lock().await.remove(&key);
                if let Some(server) = removed {
                    server.stop().await;
                }
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::Router;
    use axum::body::Body;
    use axum::extract::{Path as AxPath, Query, State};
    use axum::http::{HeaderMap, StatusCode};
    use axum::response::{IntoResponse, Response};
    use axum::routing::{get, post};
    use boss_core::Attachment;
    use std::collections::HashMap as StdMap;
    use std::sync::Mutex as StdMutex;

    /// (method, path, `directory` query, JSON body)
    type Call = (String, String, Option<String>, Value);

    #[derive(Clone, Default)]
    struct Stub {
        calls: Arc<StdMutex<Vec<Call>>>,
    }

    impl Stub {
        fn record(&self, method: &str, path: &str, q: &StdMap<String, String>, body: Value) {
            self.calls.lock().unwrap().push((method.into(), path.into(), q.get("directory").cloned(), body));
        }
    }

    async fn stub_server() -> (String, Stub) {
        let stub = Stub::default();
        let app = Router::new()
            .route("/global/health", get(|| async { axum::Json(json!({ "healthy": true, "version": "1.18.18" })) }))
            .route(
                "/session",
                post(|State(s): State<Stub>, Query(q): Query<StdMap<String, String>>, axum::Json(body): axum::Json<Value>| async move {
                    s.record("POST", "/session", &q, body);
                    axum::Json(json!({ "id": "ses_1", "directory": "/tmp/project", "title": "t" }))
                }),
            )
            .route(
                "/session/{id}/prompt_async",
                post(|State(s): State<Stub>, AxPath(id): AxPath<String>, Query(q): Query<StdMap<String, String>>, axum::Json(body): axum::Json<Value>| async move {
                    s.record("POST", &format!("/session/{id}/prompt_async"), &q, body);
                    StatusCode::NO_CONTENT
                }),
            )
            .route(
                "/session/{id}/abort",
                post(|State(s): State<Stub>, AxPath(id): AxPath<String>, Query(q): Query<StdMap<String, String>>| async move {
                    s.record("POST", &format!("/session/{id}/abort"), &q, Value::Null);
                    axum::Json(json!(true))
                }),
            )
            .route(
                "/session/{id}/permissions/{pid}",
                post(|AxPath((_id, _pid)): AxPath<(String, String)>| async { StatusCode::NOT_FOUND }),
            )
            .route(
                "/permission/{rid}/reply",
                post(|State(s): State<Stub>, AxPath(rid): AxPath<String>, Query(q): Query<StdMap<String, String>>, axum::Json(body): axum::Json<Value>| async move {
                    s.record("POST", &format!("/permission/{rid}/reply"), &q, body);
                    axum::Json(json!(true))
                }),
            )
            .route(
                "/config/providers",
                get(|| async { axum::Json(json!({ "providers": [{ "id": "anthropic", "models": { "m": { "id": "m", "name": "M" } } }] })) }),
            )
            .route("/global/event", get(|headers: HeaderMap| async move {
                assert!(headers.get("authorization").unwrap().to_str().unwrap().starts_with("Basic "));
                let body = "data: {\"directory\":\"/tmp/project\",\"payload\":{\"type\":\"session.status\",\"properties\":{\"sessionID\":\"ses_1\",\"status\":{\"type\":\"busy\"}}}}\n\n\
                            data: {\"type\":\"message.updated\",\"properties\":{\"info\":{\"id\":\"msg_1\",\"sessionID\":\"ses_1\",\"role\":\"assistant\",\"time\":{\"created\":1}}}}\n\n\
                            data: {\"type\":\"message.part.updated\",\"properties\":{\"part\":{\"id\":\"p1\",\"sessionID\":\"ses_1\",\"messageID\":\"msg_1\",\"type\":\"text\",\"text\":\"hi\"}}}\n\n";
                Response::builder().header("content-type", "text/event-stream").body(Body::from(body)).unwrap().into_response()
            }))
            .with_state(stub.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (format!("http://{addr}"), stub)
    }

    async fn engine_with_external(base_url: &str, cwd: &Path) -> OpencodeEngine {
        let engine = OpencodeEngine::new();
        let key = ServerKey { cwd: cwd.to_path_buf(), bus: None };
        let server = Arc::new(OpencodeServer::external(base_url, "pw"));
        engine.servers.lock().await.insert(key, server);
        engine
    }

    fn opts(cwd: &Path) -> SessionOptions {
        SessionOptions {
            thread_id: "thr_1".into(),
            participant_id: "who_1".into(),
            cwd: cwd.to_path_buf(),
            model: Some("anthropic/claude-opus-4-5".into()),
            permission_mode: PermissionMode::Default,
            resume: None,
            append_system_prompt: Some("You are the reviewer.".into()),
            system_prompt: None,
            allowed_tools: None,
            bus: None,
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn session_round_trip_against_stub_server() {
        let (base, stub) = stub_server().await;
        let dir = tempfile::tempdir().unwrap();
        let engine = engine_with_external(&base, dir.path()).await;

        let session = engine.start_session(opts(dir.path())).await.unwrap();
        assert_eq!(session.native_session_id().as_deref(), Some("ses_1"));
        let events = session.events();

        let image = dir.path().join("shot.png");
        std::fs::write(&image, b"\x89PNG").unwrap();
        session
            .send(Prompt { text: "go".into(), attachments: vec![Attachment { mime: "image/png".into(), path: image }] })
            .await
            .unwrap();
        session.interrupt().await.unwrap();
        session.respond_permission("per_1".into(), PermissionDecision::Allow { updated_input: None }).await.unwrap();
        session.set_model("openai/gpt-5".into()).await.unwrap();
        assert!(session.set_model("no-provider".into()).await.is_err());

        // Events: ready, then whatever the SSE stub streamed, then the optimistic busy.
        let mut got = Vec::new();
        while let Ok(Ok(ev)) = tokio::time::timeout(Duration::from_secs(3), events.recv()).await {
            got.push(ev);
            if got.len() >= 5 {
                break;
            }
        }
        assert_eq!(got[0], EngineEvent::SessionReady { native_session_id: "ses_1".into() });
        assert!(got.contains(&EngineEvent::Status { busy: true }));
        assert!(got.contains(&EngineEvent::MessageStarted { message_id: "msg_1".into(), role: boss_core::Role::Assistant }));
        assert!(got.contains(&EngineEvent::TextDelta { message_id: "msg_1".into(), part_id: "p1".into(), delta: "hi".into() }));

        let calls = stub.calls.lock().unwrap().clone();
        let cwd = dir.path().to_string_lossy().to_string();
        assert_eq!(calls[0].1, "/session");
        assert_eq!(calls[0].2.as_deref(), Some(cwd.as_str()));
        let prompt = calls.iter().find(|c| c.1 == "/session/ses_1/prompt_async").expect("prompt sent");
        assert_eq!(prompt.2.as_deref(), Some(cwd.as_str()), "runs go to the thread's checkout");
        assert_eq!(prompt.3["model"], json!({ "providerID": "anthropic", "modelID": "claude-opus-4-5" }));
        assert_eq!(prompt.3["system"], json!("You are the reviewer."));
        assert_eq!(prompt.3["parts"][0], json!({ "type": "text", "text": "go" }));
        assert_eq!(prompt.3["parts"][1]["type"], json!("file"));
        assert_eq!(prompt.3["parts"][1]["url"], json!("data:image/png;base64,iVBORw=="));
        let abort = calls.iter().find(|c| c.1 == "/session/ses_1/abort").expect("abort sent");
        assert_eq!(abort.2.as_deref(), Some("/tmp/project"), "reads use the stored scope");
        let reply = calls.iter().find(|c| c.1 == "/permission/per_1/reply").expect("v2 fallback after 404");
        assert_eq!(reply.3, json!({ "reply": "once" }));

        session.close().await.unwrap();
        assert!(engine.servers.lock().await.is_empty(), "last session stops the server");
        let last = loop {
            match events.recv().await {
                Ok(EngineEvent::Closed) => break EngineEvent::Closed,
                Ok(_) => continue,
                Err(_) => panic!("channel closed before Closed"),
            }
        };
        assert_eq!(last, EngineEvent::Closed);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn list_models_reads_providers() {
        let (base, _stub) = stub_server().await;
        let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
        let engine = engine_with_external(&base, &home).await;
        let models = engine.list_models().await.unwrap();
        assert_eq!(models, vec![ModelInfo { id: "m".into(), label: "M".into(), provider: Some("anthropic".into()) }]);
    }

    #[test]
    fn prompt_parts_text_only() {
        let parts = prompt_parts(&Prompt { text: "hello".into(), attachments: vec![] }).unwrap();
        assert_eq!(parts, vec![json!({ "type": "text", "text": "hello" })]);
    }
}
