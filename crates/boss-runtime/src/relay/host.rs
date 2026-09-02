//! Serves phone requests against the `Runtime`, and turns session events
//! into the old event JSON the phone applies.
//!
//! This is the trust boundary. The relay only ever sees ciphertext; this
//! module decrypts nothing itself but is what the client hands a decrypted,
//! token-checked request to. Agent credentials never travel: the phone sends
//! a request name and this machine performs it.

use super::protocol::now_ms;
use super::wire::{self, Attention, Request};
use crate::model::ThreadModel;
use crate::runtime::Runtime;
use crate::sessions::{SessionEvent, SessionKey};
use async_trait::async_trait;
use boss_core::*;
use serde::Serialize;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Weak};
use tokio::sync::{Mutex, broadcast};

/// What the relay client needs from the desktop: someone to run requests
/// and a stream of events to forward.
#[async_trait]
pub trait RelayHost: Send + Sync {
    /// Run one already-authenticated request. `Err` is the message the
    /// phone shows.
    async fn handle(&self, request: Value) -> Result<Value, String>;
    /// Every event in the old `{ type, properties }` envelope. The client
    /// filters to the forwarded set.
    fn events(&self) -> broadcast::Receiver<Value>;
}

/// A queued follow-up, in the phone's `QueuedFollowUp` shape.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct FollowUp {
    id: String,
    thread_id: String,
    text: String,
    attachments: Vec<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    options: Option<Value>,
    created_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    steered_at: Option<i64>,
}

#[derive(Default)]
struct HostState {
    /// Live fold of every thread touched, seeded from the transcript store.
    models: HashMap<ThreadId, ThreadModel>,
    /// Which session asked each pending request, so an answer reaches it.
    requests: HashMap<RequestId, SessionKey>,
    /// The session last seen per thread, for abort and mode changes.
    sessions: HashMap<ThreadId, SessionKey>,
    followups: HashMap<ThreadId, Vec<FollowUp>>,
    /// How a thread's last run ended. Pending requests outrank this.
    attention: HashMap<ThreadId, Attention>,
    /// Per-thread permission mode chosen from the phone.
    modes: HashMap<ThreadId, PermissionMode>,
}

/// The `RelayHost` backed by a `Runtime`.
pub struct RuntimeHost {
    runtime: Arc<Runtime>,
    state: Mutex<HostState>,
    events: broadcast::Sender<Value>,
}

impl RuntimeHost {
    /// Start observing the runtime's session events.
    pub fn new(runtime: Arc<Runtime>) -> Arc<Self> {
        let (events, _) = broadcast::channel(4096);
        let host = Arc::new(Self { runtime: runtime.clone(), state: Mutex::new(HostState::default()), events });
        let weak: Weak<Self> = Arc::downgrade(&host);
        let mut source = runtime.subscribe();
        runtime.handle.spawn(async move {
            loop {
                match source.recv().await {
                    Ok(event) => match weak.upgrade() {
                        Some(host) => host.observe(event).await,
                        None => break,
                    },
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        });
        host
    }

    fn emit(&self, event: Value) {
        let _ = self.events.send(event);
    }

    fn engine_for(&self, thread: &Thread) -> EngineId {
        match &thread.kind {
            ThreadKind::Chat { engine } => *engine,
            ThreadKind::Room { room_id } => self
                .runtime
                .state
                .room(room_id)
                .and_then(|r| r.participants.iter().find(|p| p.is_boss).map(|p| p.engine))
                .unwrap_or(self.runtime.settings.get().default_engine),
            ThreadKind::Assistant => self.runtime.settings.get().default_engine,
        }
    }

    fn model_for<'a>(&self, st: &'a mut HostState, id: &ThreadId) -> Option<&'a mut ThreadModel> {
        if !st.models.contains_key(id) {
            let thread = self.runtime.state.thread(id)?;
            let participants = match &thread.kind {
                ThreadKind::Room { room_id } => self.runtime.state.room(room_id).map(|r| r.participants).unwrap_or_default(),
                _ => vec![],
            };
            let messages = self.runtime.load_messages(id);
            st.models.insert(id.clone(), ThreadModel::new(thread, participants, messages));
        }
        st.models.get_mut(id)
    }

    /// Fold one session event and forward what the phone should see.
    async fn observe(&self, ev: SessionEvent) {
        let thread_id = ev.key.thread_id.clone();
        let mut st = self.state.lock().await;
        let Some(model) = self.model_for(&mut st, &thread_id) else { return };
        let was_busy = model.busy;
        model.apply(Some(&ev.key.participant_id), ev.event.clone());
        let out = wire::events_for(model, &ev.event);
        st.sessions.insert(thread_id.clone(), ev.key.clone());
        match &ev.event {
            EngineEvent::PermissionRequested { request, .. } | EngineEvent::QuestionAsked { request, .. } => {
                st.requests.insert(request.clone(), ev.key.clone());
            }
            EngineEvent::RequestWithdrawn { request } => {
                st.requests.remove(request);
            }
            EngineEvent::Error { message, .. } => {
                st.attention.insert(
                    thread_id.clone(),
                    Attention { kind: "error".into(), created_at: now_ms(), detail: Some(message.chars().take(240).collect()) },
                );
            }
            EngineEvent::Status { busy: true } => {
                st.attention.remove(&thread_id);
            }
            EngineEvent::Status { busy: false } | EngineEvent::Closed => {
                if was_busy && !st.attention.contains_key(&thread_id) {
                    st.attention.insert(thread_id.clone(), Attention { kind: "completed".into(), created_at: now_ms(), detail: None });
                }
                if let Some(next) = st.followups.get_mut(&thread_id).and_then(|q| (!q.is_empty()).then(|| q.remove(0))) {
                    self.emit(wire::followups_updated(thread_id.as_str(), &self.queue_json(&st, &thread_id)));
                    if let Err(error) = self.send_prompt(&mut st, &thread_id, next.text, next.options.as_ref()).await {
                        tracing::warn!(thread = %thread_id, error, "queued follow-up failed");
                    }
                }
            }
            _ => {}
        }
        drop(st);
        for event in out {
            self.emit(event);
        }
    }

    fn queue_json(&self, st: &HostState, thread: &ThreadId) -> Value {
        serde_json::to_value(st.followups.get(thread).cloned().unwrap_or_default()).unwrap_or(Value::Array(vec![]))
    }

    /// Record the user's turn and send it to the thread's primary participant.
    async fn send_prompt(&self, st: &mut HostState, thread_id: &ThreadId, text: String, options: Option<&Value>) -> Result<(), String> {
        let thread = self.runtime.state.thread(thread_id).ok_or("That thread no longer exists.")?;
        let participant = self.runtime.primary_participant(&thread).map_err(|e| e.to_string())?;
        let key = self.runtime.ensure_session(&thread, &participant).await.map_err(|e| e.to_string())?;
        if let Some(session) = self.runtime.sessions.get(&key).await {
            if let Some(model) = options.and_then(|o| o.get("model")).and_then(|m| m.get("modelID")).and_then(Value::as_str)
                && let Err(error) = session.set_model(model.into()).await
            {
                tracing::warn!(error = %error, "set model from phone failed");
            }
            let mode = options.and_then(|o| o.get("mode")).and_then(Value::as_str).and_then(wire::parse_mode).or_else(|| st.modes.get(thread_id).copied());
            if let Some(mode) = mode {
                st.modes.insert(thread_id.clone(), mode);
                if let Err(error) = session.set_permission_mode(mode).await {
                    tracing::warn!(error = %error, "set permission mode from phone failed");
                }
            }
        }
        if let Some(model) = self.model_for(st, thread_id) {
            let id = model.push_user_message(text.clone(), None, vec![]);
            if let Some(message) = model.message(&id) {
                self.runtime.persist_message(message.clone());
                // The desktop transcript learns about phone-sent turns the
                // same way it learns about room turns: as replayed events.
                let host: &dyn crate::rooms::RoomHost = self.runtime.as_ref();
                crate::rooms::show_message(host, message);
                self.emit(json!({ "type": "message.updated", "properties": { "info": wire::info_to_wire(message) } }));
            }
        }
        self.runtime.send(&thread, &participant, Prompt { text, attachments: vec![] }).await.map_err(|e| e.to_string())?;
        st.sessions.insert(thread_id.clone(), key);
        self.emit(json!({ "type": "session.status", "properties": { "sessionID": thread_id.as_str(), "status": { "type": "busy" } } }));
        Ok(())
    }

    fn row(&self, st: &HostState, thread: &Thread) -> wire::ThreadRow {
        let project = self.runtime.state.project(&thread.project_id);
        let attention = st
            .models
            .get(&thread.id)
            .and_then(|m| wire::attention_for_pending(&m.pending))
            .or_else(|| st.attention.get(&thread.id).cloned());
        let mode = st.modes.get(&thread.id).copied().unwrap_or(self.runtime.settings.get().permission_mode);
        wire::thread_row(thread, project.as_ref(), self.engine_for(thread), self.runtime.is_busy(&thread.id), attention, mode)
    }

    fn snapshot(&self, st: &HostState) -> Value {
        let mut threads: Vec<_> = self.runtime.state.threads().iter().map(|t| self.row(st, t)).collect();
        threads.sort_by_key(|t| std::cmp::Reverse(t.updated_at));
        json!({ "generatedAt": now_ms(), "threads": threads, "totals": wire::UsageTotals::default() })
    }

    fn thread(&self, id: &str) -> Result<Thread, String> {
        self.runtime.state.thread(&ThreadId::from_raw(id)).ok_or_else(|| "That thread no longer exists.".to_string())
    }

    fn info(&self, thread: &Thread) -> Value {
        let project = self.runtime.state.project(&thread.project_id);
        wire::session_info(thread, project.as_ref(), self.engine_for(thread), self.runtime.is_busy(&thread.id))
    }

    async fn serve(&self, request: Request) -> Result<Value, String> {
        match request {
            Request::BackendList => {
                let probes = EngineId::ALL.map(|id| async move {
                    let probe = match self.runtime.sessions.engine(id) {
                        Some(engine) => engine.probe().await.unwrap_or_default(),
                        None => EngineProbe::default(),
                    };
                    wire::backend_descriptor(id, &probe)
                });
                Ok(Value::Array(futures::future::join_all(probes).await))
            }
            Request::SupervisionSnapshot => Ok(self.snapshot(&*self.state.lock().await)),
            Request::SupervisionSearch { query, limit, thread_id } => {
                let thread = thread_id.map(ThreadId::from_raw);
                let hits = self.runtime.transcripts.search(&query, limit.unwrap_or(40), thread.as_ref()).map_err(|e| e.to_string())?;
                Ok(Value::Array(
                    hits.into_iter()
                        .filter_map(|hit| {
                            let thread = self.runtime.state.thread(&hit.thread_id)?;
                            let project = self.runtime.state.project(&thread.project_id);
                            Some(json!({
                                "threadId": hit.thread_id.as_str(),
                                "messageId": hit.message_id.as_str(),
                                "backendId": self.engine_for(&thread).as_str(),
                                "title": thread.title,
                                "projectPath": project.map(|p| p.root.to_string_lossy().into_owned()).unwrap_or_default(),
                                "snippet": hit.snippet,
                                "role": if hit.role == Role::User { "user" } else { "assistant" },
                                "kind": "message",
                                "timestamp": wire::millis(hit.created_at)
                            }))
                        })
                        .collect(),
                ))
            }
            Request::SupervisionAcknowledge { thread_id } => {
                let mut st = self.state.lock().await;
                st.attention.remove(&ThreadId::from_raw(thread_id));
                Ok(self.snapshot(&st))
            }
            Request::ThreadList => {
                let st = self.state.lock().await;
                Ok(serde_json::to_value(self.runtime.state.threads().iter().map(|t| self.row(&st, t)).collect::<Vec<_>>()).unwrap_or_default())
            }
            Request::ThreadGet { thread_id } => Ok(self.info(&self.thread(&thread_id)?)),
            Request::ThreadMessages { thread_id, limit, trim_output } => {
                let mut st = self.state.lock().await;
                let id = ThreadId::from_raw(thread_id);
                let model = self.model_for(&mut st, &id).ok_or("That thread no longer exists.")?;
                let skip = limit.map(|n| model.messages.len().saturating_sub(n)).unwrap_or(0);
                let mut messages: Vec<_> = model.messages.iter().skip(skip).map(wire::message_to_wire).collect();
                if let Some(limit) = trim_output {
                    wire::trim_tool_output(&mut messages, limit);
                }
                Ok(serde_json::to_value(messages).unwrap_or_default())
            }
            Request::ThreadPart { thread_id, message_id, part_id } => {
                let mut st = self.state.lock().await;
                let id = ThreadId::from_raw(thread_id);
                let model = self.model_for(&mut st, &id).ok_or("That thread no longer exists.")?;
                let message = model.message(&MessageId::from_raw(&message_id)).ok_or("That message is gone.")?;
                let part = message.parts.iter().find(|p| p.id().as_str() == part_id).ok_or("That step is gone.")?;
                Ok(serde_json::to_value(wire::part_to_wire(id.as_str(), &message_id, part)).unwrap_or_default())
            }
            Request::ThreadSend { thread_id, parts, options } => {
                let id = ThreadId::from_raw(thread_id);
                if self.runtime.is_busy(&id) {
                    return Err("This thread is busy. Queue the message instead.".into());
                }
                let text = wire::prompt_text(&parts);
                if text.trim().is_empty() {
                    return Err("Nothing to send.".into());
                }
                let mut st = self.state.lock().await;
                self.send_prompt(&mut st, &id, text, options.as_ref()).await?;
                Ok(Value::Null)
            }
            Request::FollowupsList { thread_id } => Ok(self.queue_json(&*self.state.lock().await, &ThreadId::from_raw(thread_id))),
            Request::FollowupsAdd { thread_id, text, options } => {
                let id = ThreadId::from_raw(thread_id);
                let mut st = self.state.lock().await;
                let queued = st.followups.get(&id).is_some_and(|q| !q.is_empty());
                if !self.runtime.is_busy(&id) && !queued {
                    self.send_prompt(&mut st, &id, text, options.as_ref()).await?;
                    return Ok(self.queue_json(&st, &id));
                }
                st.followups.entry(id.clone()).or_default().push(FollowUp {
                    id: format!("fu_{}", uuid::Uuid::new_v4().simple()),
                    thread_id: id.to_string(),
                    text,
                    attachments: vec![],
                    options,
                    created_at: now_ms(),
                    steered_at: None,
                });
                let queue = self.queue_json(&st, &id);
                self.emit(wire::followups_updated(id.as_str(), &queue));
                Ok(queue)
            }
            Request::FollowupsUpdate { thread_id, follow_up_id, text } => {
                self.edit_queue(&thread_id, |queue| {
                    if let Some(item) = queue.iter_mut().find(|f| f.id == follow_up_id) {
                        item.text = text;
                    }
                })
                .await
            }
            Request::FollowupsRemove { thread_id, follow_up_id } => self.edit_queue(&thread_id, |queue| queue.retain(|f| f.id != follow_up_id)).await,
            Request::FollowupsMove { thread_id, follow_up_id, to_index } => {
                self.edit_queue(&thread_id, |queue| {
                    if let Some(from) = queue.iter().position(|f| f.id == follow_up_id) {
                        let item = queue.remove(from);
                        let to = to_index.min(queue.len());
                        queue.insert(to, item);
                    }
                })
                .await
            }
            Request::FollowupsSteer { thread_id, follow_up_id } => {
                let id = ThreadId::from_raw(&thread_id);
                let result = self
                    .edit_queue(&thread_id, |queue| {
                        if let Some(from) = queue.iter().position(|f| f.id == follow_up_id) {
                            let mut item = queue.remove(from);
                            item.steered_at = Some(now_ms());
                            queue.insert(0, item);
                        }
                    })
                    .await?;
                // Stop-and-redirect: the current run ends, and the idle that
                // follows delivers the steered message first.
                let key = self.state.lock().await.sessions.get(&id).cloned();
                if let Some(key) = key
                    && self.runtime.is_busy(&id)
                {
                    let _ = self.runtime.sessions.interrupt(&key).await;
                }
                Ok(result)
            }
            Request::ThreadAbort { thread_id } => {
                let key = self.state.lock().await.sessions.get(&ThreadId::from_raw(thread_id)).cloned();
                if let Some(key) = key {
                    self.runtime.sessions.interrupt(&key).await.map_err(|e| e.to_string())?;
                }
                Ok(Value::Null)
            }
            Request::ThreadTodos { thread_id } => {
                let mut st = self.state.lock().await;
                let todos = self.model_for(&mut st, &ThreadId::from_raw(thread_id)).map(|m| m.todos.clone()).unwrap_or_default();
                Ok(wire::todos_to_wire(&todos))
            }
            Request::ThreadPermission { thread_id, permission_id, response } => {
                let request = RequestId::from_raw(&permission_id);
                let mut st = self.state.lock().await;
                let key = st.requests.remove(&request).ok_or("That request is no longer waiting.")?;
                let decision = match response.as_str() {
                    "once" | "always" => PermissionDecision::Allow { updated_input: None },
                    _ => PermissionDecision::Deny { reason: "Rejected from the phone.".into() },
                };
                self.runtime.sessions.respond_permission(&key, request.clone(), decision).await.map_err(|e| e.to_string())?;
                let id = ThreadId::from_raw(&thread_id);
                if let Some(model) = st.models.get_mut(&id) {
                    model.resolve_request(&request);
                }
                drop(st);
                self.emit(wire::permission_replied(&thread_id, &permission_id, &response));
                Ok(Value::Null)
            }
            // The Rust runtime has no per-thread diff yet; an empty list keeps
            // the phone's Work panel usable rather than erroring.
            Request::ThreadDiff { .. } => Ok(json!([])),
            Request::AutomationList => Ok(json!({ "automations": [], "runs": [] })),
            Request::AutomationRun { .. } | Request::AutomationStop { .. } => Err("Automations are not available in this build.".into()),
            Request::ThreadCreate { backend_id, title, execution_path } => {
                let engine = wire::parse_engine(&backend_id).ok_or_else(|| format!("Unknown backend \"{backend_id}\"."))?;
                let project = match execution_path.as_deref() {
                    Some(path) => self.runtime.state.project_by_root(Path::new(path)),
                    None => self.runtime.state.projects().into_iter().next(),
                }
                .ok_or("Add a project on the desktop first.")?;
                let thread = self.runtime.new_chat(&project, engine, title).map_err(|e| e.to_string())?;
                let info = self.info(&thread);
                self.emit(json!({ "type": "session.created", "properties": { "info": info } }));
                Ok(info)
            }
            Request::ThreadModels { thread_id, backend_id } => {
                let engine = match (thread_id, backend_id) {
                    (Some(id), _) => self.engine_for(&self.thread(&id)?),
                    (None, Some(backend)) => wire::parse_engine(&backend).ok_or_else(|| format!("Unknown backend \"{backend}\"."))?,
                    (None, None) => self.runtime.settings.get().default_engine,
                };
                let engine = self.runtime.sessions.engine(engine).ok_or("That backend is not registered.")?;
                let models = engine.list_models().await.map_err(|e| e.to_string())?;
                Ok(wire::models_to_wire(&models))
            }
            Request::ThreadModeSet { thread_id, mode } => {
                let mode = wire::parse_mode(&mode).ok_or_else(|| format!("Unknown mode \"{mode}\"."))?;
                let id = ThreadId::from_raw(thread_id);
                let key = {
                    let mut st = self.state.lock().await;
                    st.modes.insert(id.clone(), mode);
                    st.sessions.get(&id).cloned()
                };
                if let Some(session) = match key {
                    Some(key) => self.runtime.sessions.get(&key).await,
                    None => None,
                } {
                    session.set_permission_mode(mode).await.map_err(|e| e.to_string())?;
                }
                Ok(Value::Null)
            }
            Request::ThreadArchive { thread_id, archived } => {
                let thread = self.runtime.state.update_thread(&ThreadId::from_raw(thread_id), |t| t.archived = archived).map_err(|e| e.to_string())?;
                let thread = thread.ok_or("That thread no longer exists.")?;
                let info = self.info(&thread);
                self.emit(json!({ "type": "session.updated", "properties": { "info": info } }));
                Ok(info)
            }
            Request::ThreadRename { thread_id, title } => {
                let thread = self.runtime.state.update_thread(&ThreadId::from_raw(thread_id), |t| t.title = title).map_err(|e| e.to_string())?;
                let thread = thread.ok_or("That thread no longer exists.")?;
                let info = self.info(&thread);
                self.emit(json!({ "type": "session.updated", "properties": { "info": info } }));
                Ok(info)
            }
            Request::ThreadDelete { thread_id } => {
                let id = ThreadId::from_raw(&thread_id);
                let thread = self.thread(&thread_id)?;
                let info = self.info(&thread);
                let key = {
                    let mut st = self.state.lock().await;
                    st.models.remove(&id);
                    st.followups.remove(&id);
                    st.attention.remove(&id);
                    st.modes.remove(&id);
                    st.sessions.remove(&id)
                };
                if let Some(key) = key {
                    let _ = self.runtime.sessions.close(&key).await;
                }
                self.runtime.state.remove_thread(&id).map_err(|e| e.to_string())?;
                if let Err(error) = self.runtime.transcripts.delete_thread(&id) {
                    tracing::warn!(error = %error, "delete transcript failed");
                }
                self.emit(json!({ "type": "session.deleted", "properties": { "info": info } }));
                Ok(Value::Null)
            }
        }
    }

    async fn edit_queue(&self, thread_id: &str, edit: impl FnOnce(&mut Vec<FollowUp>)) -> Result<Value, String> {
        let id = ThreadId::from_raw(thread_id);
        let mut st = self.state.lock().await;
        edit(st.followups.entry(id.clone()).or_default());
        let queue = self.queue_json(&st, &id);
        self.emit(wire::followups_updated(thread_id, &queue));
        Ok(queue)
    }
}

#[async_trait]
impl RelayHost for RuntimeHost {
    async fn handle(&self, request: Value) -> Result<Value, String> {
        let kind = request.get("type").and_then(Value::as_str).unwrap_or("").to_string();
        if !wire::relay_request_allowed(&kind) {
            return Err(format!("\"{kind}\" is not available over remote access."));
        }
        if kind.starts_with("assistant.") || kind == "thread.delegate" {
            return Err(format!("\"{kind}\" is not available in this build."));
        }
        let parsed: Request = serde_json::from_value(request).map_err(|_| "malformed request".to_string())?;
        self.serve(parsed).await
    }

    fn events(&self) -> broadcast::Receiver<Value> {
        self.events.subscribe()
    }
}
