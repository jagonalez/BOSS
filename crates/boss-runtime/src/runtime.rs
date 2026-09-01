//! The headless core of BOSS: stores, engines, the thread bus, and live
//! sessions. The UI holds one `Arc<Runtime>` and talks to it; agents reach
//! it through the bus.

use crate::bus_handler::RuntimeBusHandler;
use crate::sessions::{SessionEvent, SessionKey, SessionManager};
use anyhow::{Context, Result, anyhow};
use async_channel::Receiver;
use boss_bus::hub::{McpConfigPaths, McpHub, load_configs};
use boss_bus::server::BusServer;
use boss_core::store::{
    JsonFile, KeyringSecrets, Secrets, SettingsStore, StateStore, TranscriptStore,
};
use boss_core::*;
use boss_engines::claude::ClaudeEngine;
use boss_engines::codex::CodexEngine;
use boss_engines::opencode::OpencodeEngine;
use boss_engines::pi::PiEngine;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use time::OffsetDateTime;

/// Secret that signs bus tokens, kept on disk so tokens in generated plugin
/// files stay valid across restarts.
#[derive(Serialize, Deserialize)]
struct BusSecret {
    #[serde(with = "hex_bytes")]
    secret: [u8; 32],
}

mod hex_bytes {
    use serde::{Deserialize, Deserializer, Serialize, Serializer};
    pub fn serialize<S: Serializer>(v: &[u8; 32], s: S) -> Result<S::Ok, S::Error> {
        v.iter().map(|b| format!("{b:02x}")).collect::<String>().serialize(s)
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<[u8; 32], D::Error> {
        let text = String::deserialize(d)?;
        let bytes: Vec<u8> = (0..text.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&text[i..i + 2], 16).map_err(serde::de::Error::custom))
            .collect::<Result<_, _>>()?;
        bytes.try_into().map_err(|_| serde::de::Error::custom("secret must be 32 bytes"))
    }
}

pub struct Runtime {
    pub handle: tokio::runtime::Handle,
    pub data_dir: PathBuf,
    pub state: Arc<StateStore>,
    pub settings: Arc<SettingsStore>,
    pub transcripts: Arc<TranscriptStore>,
    pub secrets: Arc<dyn Secrets>,
    pub sessions: Arc<SessionManager>,
    pub bus: BusServer,
    pub hub: Arc<McpHub>,
    /// Threads with a busy session right now.
    busy: Mutex<HashSet<ThreadId>>,
    ui_rx: Receiver<SessionEvent>,
    handler: Arc<RuntimeBusHandler>,
    self_ref: OnceLock<std::sync::Weak<Runtime>>,
}

impl Runtime {
    /// Open the stores, build the engines, start the bus, and begin pumping
    /// session events. `data_dir` defaults to `paths::user_data_dir()`.
    pub async fn start(data_dir: Option<PathBuf>, handle: tokio::runtime::Handle) -> Result<Arc<Self>> {
        let data_dir = data_dir.unwrap_or_else(paths::user_data_dir);
        std::fs::create_dir_all(&data_dir).with_context(|| format!("create {}", data_dir.display()))?;

        let state = Arc::new(StateStore::open(Some(&data_dir))?);
        let settings = Arc::new(SettingsStore::open(Some(&data_dir))?);
        let transcripts = Arc::new(TranscriptStore::open_in(Some(&data_dir))?);
        let secrets: Arc<dyn Secrets> = Arc::new(KeyringSecrets::new());

        let engines = build_engines(&settings.get());
        let sessions = SessionManager::new(engines, handle.clone());

        let secret_file = JsonFile::in_dir(Some(&data_dir), "bus-secret.json");
        let secret = match secret_file.load::<BusSecret>()? {
            Some(s) => s.secret,
            None => {
                let mut s = [0u8; 32];
                rand::Rng::fill(&mut rand::thread_rng(), &mut s);
                secret_file.save(&BusSecret { secret: s })?;
                s
            }
        };

        let hub = Arc::new(McpHub::new());
        let handler = Arc::new(RuntimeBusHandler::new(data_dir.clone())?);
        let bus = BusServer::start_with_instructions(
            handler.clone(),
            secret,
            boss_bus::tools::QA_GUIDANCE.to_string(),
        )
        .await
        .context("start thread bus")?;

        let (ui_tx, ui_rx) = async_channel::unbounded();
        let rt = Arc::new(Self {
            handle: handle.clone(),
            data_dir,
            state,
            settings,
            transcripts,
            secrets,
            sessions: sessions.clone(),
            bus,
            hub,
            busy: Mutex::new(HashSet::new()),
            ui_rx,
            handler: handler.clone(),
            self_ref: OnceLock::new(),
        });
        let _ = rt.self_ref.set(Arc::downgrade(&rt));
        handler.attach(Arc::downgrade(&rt));

        // Pump: observe busy flags and queued deliveries, then forward to the UI.
        let pump = rt.clone();
        let source = sessions.events();
        handle.spawn(async move {
            while let Ok(ev) = source.recv().await {
                pump.observe(&ev).await;
                if ui_tx.send(ev).await.is_err() {
                    break;
                }
            }
        });

        // Connect MCP servers in the background; failures are per-server statuses.
        let hub = rt.hub.clone();
        let configs = load_configs(&McpConfigPaths::discover(None));
        handle.spawn(async move {
            let statuses = hub.connect_all(configs).await;
            tracing::info!(count = statuses.len(), "mcp hub connected");
        });

        Ok(rt)
    }

    /// The bus handler, so the app can attach browser/computer tools.
    pub fn bus_handler(&self) -> &RuntimeBusHandler {
        &self.handler
    }

    /// Session events for the UI. Drain from one place.
    pub fn events(&self) -> Receiver<SessionEvent> {
        self.ui_rx.clone()
    }

    pub fn is_busy(&self, thread: &ThreadId) -> bool {
        self.busy.lock().unwrap().contains(thread)
    }

    async fn observe(&self, ev: &SessionEvent) {
        match &ev.event {
            EngineEvent::Status { busy } => {
                let went_idle = {
                    let mut set = self.busy.lock().unwrap();
                    if *busy {
                        set.insert(ev.key.thread_id.clone());
                        false
                    } else {
                        set.remove(&ev.key.thread_id)
                    }
                };
                if went_idle {
                    self.handler.flush(&ev.key.thread_id).await;
                }
            }
            EngineEvent::Closed => {
                self.busy.lock().unwrap().remove(&ev.key.thread_id);
            }
            _ => {}
        }
    }

    pub fn bus_access(&self, thread: &ThreadId, participant: &ParticipantId) -> BusAccess {
        self.bus.tokens().access(self.bus.url(), thread.clone(), participant.clone())
    }

    /// Build session options from settings, the thread, and the participant.
    pub fn session_options(&self, thread: &Thread, participant: &Participant, resume: bool) -> SessionOptions {
        let settings = self.settings.get();
        SessionOptions {
            thread_id: thread.id.clone(),
            participant_id: participant.id.clone(),
            cwd: thread.cwd.clone(),
            model: participant
                .model
                .clone()
                .or_else(|| settings.default_model(participant.engine).map(str::to_owned)),
            permission_mode: settings.permission_mode,
            resume: if resume { participant.native_session_id.clone() } else { None },
            append_system_prompt: None,
            system_prompt: None,
            allowed_tools: None,
            bus: Some(self.bus_access(&thread.id, &participant.id)),
        }
    }

    /// Start or resume the participant's session.
    pub async fn ensure_session(&self, thread: &Thread, participant: &Participant) -> Result<SessionKey> {
        let key = SessionKey { thread_id: thread.id.clone(), participant_id: participant.id.clone() };
        if self.sessions.get(&key).await.is_some() {
            return Ok(key);
        }
        let opts = self.session_options(thread, participant, participant.native_session_id.is_some());
        self.sessions.start(participant.engine, opts).await?;
        Ok(key)
    }

    /// Send a prompt into a thread, starting the session when needed. Also
    /// records the user turn.
    pub async fn send(&self, thread: &Thread, participant: &Participant, prompt: Prompt) -> Result<SessionKey> {
        let key = self.ensure_session(thread, participant).await?;
        self.sessions.send(&key, prompt).await?;
        self.state.update_thread(&thread.id, |t| t.updated_at = OffsetDateTime::now_utc())?;
        Ok(key)
    }

    /// The participant a plain chat talks to, or the room's BOSS seat.
    pub fn primary_participant(&self, thread: &Thread) -> Result<Participant> {
        match &thread.kind {
            ThreadKind::Chat { engine } => Ok(Participant {
                id: ParticipantId::from_raw(format!("{}:{}", thread.id, engine.as_str())),
                name: engine.label().to_string(),
                engine: *engine,
                model: None,
                is_boss: false,
                native_session_id: self.native_session(&thread.id, engine),
            }),
            ThreadKind::Room { room_id } => {
                let room = self.state.room(room_id).ok_or_else(|| anyhow!("room {room_id} not found"))?;
                room.participants.iter().find(|p| p.is_boss).cloned().ok_or_else(|| anyhow!("room has no BOSS seat"))
            }
            ThreadKind::Assistant => Ok(Participant {
                id: ParticipantId::from_raw(format!("{}:assistant", thread.id)),
                name: "BOSS".into(),
                engine: self.settings.get().default_engine,
                model: None,
                is_boss: true,
                native_session_id: self.native_session(&thread.id, &self.settings.get().default_engine),
            }),
        }
    }

    fn native_session(&self, thread: &ThreadId, engine: &EngineId) -> Option<String> {
        self.handler.native_sessions().get(&format!("{thread}:{}", engine.as_str()))
    }

    /// Remember an engine's native session id so the thread resumes later.
    pub fn record_native_session(&self, thread: &ThreadId, engine: EngineId, native: String) {
        self.handler.native_sessions().set(&format!("{thread}:{}", engine.as_str()), native);
    }

    /// Store a message. Runs the sqlite write off the caller's thread.
    pub fn persist_message(self: &Arc<Self>, message: Message) {
        let rt = self.clone();
        self.handle.spawn_blocking(move || {
            if let Err(e) = rt.transcripts.upsert_message(&message) {
                tracing::warn!(error = %e, "persist message failed");
            }
        });
    }

    pub fn load_messages(&self, thread: &ThreadId) -> Vec<Message> {
        self.transcripts.messages_for_thread(thread).unwrap_or_default()
    }

    /// Create a chat thread in a project.
    pub fn new_chat(&self, project: &Project, engine: EngineId, title: Option<String>) -> Result<Thread> {
        let now = OffsetDateTime::now_utc();
        let thread = Thread {
            id: ThreadId::new(),
            project_id: project.id.clone(),
            title: title.unwrap_or_else(|| format!("New {} chat", engine.label())),
            kind: ThreadKind::Chat { engine },
            created_at: now,
            updated_at: now,
            cwd: project.root.clone(),
            archived: false,
        };
        self.state.upsert_thread(thread.clone())?;
        Ok(thread)
    }

    pub async fn shutdown(&self) {
        self.sessions.close_all().await;
    }
}

fn build_engines(settings: &boss_core::store::Settings) -> Vec<Arc<dyn Engine>> {
    let mut codex = CodexEngine::new();
    if let Some(p) = settings.engine_executable(EngineId::Codex) {
        codex = CodexEngine::with_executable(p.to_path_buf());
    }
    let mut opencode = OpencodeEngine::new();
    if let Some(p) = settings.engine_executable(EngineId::Opencode) {
        opencode = opencode.with_executable(p);
    }
    let mut pi = PiEngine::new();
    if let Some(p) = settings.engine_executable(EngineId::Pi) {
        pi = pi.with_executable(p);
    }
    vec![
        Arc::new(ClaudeEngine::new(settings.engine_executable(EngineId::Claude).map(|p| p.to_path_buf()))),
        Arc::new(codex),
        Arc::new(opencode),
        Arc::new(pi),
    ]
}
