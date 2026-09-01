//! Wiring: the runtime on one side, the shell and transcript views on the
//! other. `BossApp` implements `ShellActions`, pumps engine events into
//! thread models, and owns the views behind each tab.

use crate::model::ThreadModel;
use crate::shell::actions::ShellActions;
use crate::shell::state::{AppState, TabId};
use crate::transcript::coalesce::{Batched, MAX_COMMITS_PER_SECOND, drive};
use crate::transcript::{ComposerEvent, ThreadPane};
use anyhow::Result;
use async_trait::async_trait;
use boss_browser::{BrowserBusTools, BrowserRegistry, BrowserTabId, BrowserView};
use boss_core::store::{Settings, Theme};
use boss_core::*;
use boss_runtime::Runtime;
use boss_runtime::sessions::{SessionEvent, SessionKey};
use boss_terminal::TerminalView;
use gpui::{
    AnyView, App, AppContext as _, AsyncApp, Entity, Global, PathPromptOptions, Subscription, WindowHandle,
};
use gpui_component::Root;
use serde_json::Value;
use std::cell::RefCell;
use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

/// Views behind open tabs, looked up by the shell when it renders a tab.
#[derive(Default)]
pub struct TabViews {
    pub views: HashMap<TabId, AnyView>,
}
impl Global for TabViews {}

/// Per-thread UI state the app keeps alive while a thread is open.
struct OpenThread {
    model: Entity<ThreadModel>,
    pane: Option<Entity<ThreadPane>>,
    sender: async_channel::Sender<Batched>,
    _drive: gpui::Task<()>,
    _subs: Vec<Subscription>,
}

pub struct BossApp {
    runtime: Arc<Runtime>,
    state: Entity<AppState>,
    window: RefCell<Option<WindowHandle<Root>>>,
    threads: RefCell<HashMap<ThreadId, OpenThread>>,
    browsers: RefCell<BrowserRegistry>,
}

impl BossApp {
    pub fn new(runtime: Arc<Runtime>, state: Entity<AppState>) -> Arc<Self> {
        Arc::new(Self {
            runtime,
            state,
            window: RefCell::new(None),
            threads: RefCell::new(HashMap::new()),
            browsers: RefCell::new(BrowserRegistry::new()),
        })
    }

    /// Build the shell state from the stores.
    pub fn initial_state(runtime: &Runtime) -> AppState {
        let mut state = AppState::empty();
        state.projects = runtime.state.projects();
        state.threads = runtime.state.threads();
        state.rooms = runtime.state.rooms();
        for t in &state.threads {
            if let ThreadKind::Chat { .. } = t.kind {
                if let Ok(p) = runtime.primary_participant(t) {
                    state.participants.insert(t.id.clone(), vec![p]);
                }
            }
        }
        state.settings = runtime.settings.get();
        state
    }

    /// Call once the main window exists. Starts the event pump and registers
    /// browser tools with the bus.
    pub fn attach_window(self: &Arc<Self>, window: WindowHandle<Root>, cx: &mut App) {
        *self.window.borrow_mut() = Some(window);
        let qa: Arc<dyn BusHandler> = Arc::new(QaBridge { tools: self.browsers.borrow().bus_tools() });
        self.runtime.bus_handler().set_qa_handler(qa);
        self.start_pump(cx);
    }

    fn start_pump(self: &Arc<Self>, cx: &mut App) {
        let rx = self.runtime.events();
        let app = self.clone();
        cx.spawn(async move |cx: &mut AsyncApp| {
            while let Ok(ev) = rx.recv().await {
                let app = app.clone();
                let _ = cx.update(move |cx| app.on_session_event(ev, cx));
            }
        })
        .detach();
    }

    fn on_session_event(self: &Arc<Self>, ev: SessionEvent, cx: &mut App) {
        let thread_id = ev.key.thread_id.clone();
        let participant = ev.key.participant_id.clone();
        match &ev.event {
            EngineEvent::SessionReady { native_session_id } => {
                if let Some(t) = self.runtime.state.thread(&thread_id) {
                    if let Ok(p) = self.runtime.primary_participant(&t) {
                        if p.id == participant {
                            self.runtime.record_native_session(&thread_id, p.engine, native_session_id.clone());
                        }
                    }
                }
            }
            EngineEvent::Status { busy } => {
                let busy = *busy;
                self.state.update(cx, |s, cx| {
                    s.set_busy(&thread_id, busy);
                    cx.notify();
                });
            }
            EngineEvent::MessageCompleted { message_id, .. } => {
                self.persist_later(&thread_id, message_id.clone(), cx);
            }
            EngineEvent::Closed => {
                self.state.update(cx, |s, cx| {
                    s.set_busy(&thread_id, false);
                    cx.notify();
                });
            }
            _ => {}
        }
        self.ensure_thread(&thread_id, cx);
        if let Some(open) = self.threads.borrow().get(&thread_id) {
            let _ = open.sender.try_send((Some(participant), ev.event));
        }
    }

    /// Persist a message after the coalescer has applied its last events.
    fn persist_later(self: &Arc<Self>, thread: &ThreadId, message: MessageId, cx: &mut App) {
        let app = self.clone();
        let thread = thread.clone();
        cx.spawn(async move |cx: &mut AsyncApp| {
            cx.background_executor().timer(Duration::from_millis(400)).await;
            let _ = cx.update(|cx| {
                let model = app.threads.borrow().get(&thread).map(|o| o.model.clone());
                if let Some(model) = model {
                    if let Some(msg) = model.read(cx).message(&message).cloned() {
                        app.runtime.persist_message(msg);
                    }
                }
            });
        })
        .detach();
    }

    fn participants_for(&self, thread: &Thread) -> Vec<Participant> {
        match &thread.kind {
            ThreadKind::Room { room_id } => {
                self.runtime.state.room(room_id).map(|r| r.participants).unwrap_or_default()
            }
            _ => self.runtime.primary_participant(thread).map(|p| vec![p]).unwrap_or_default(),
        }
    }

    /// Make sure a model and coalescer exist for the thread.
    fn ensure_thread(self: &Arc<Self>, thread_id: &ThreadId, cx: &mut App) -> Option<Entity<ThreadModel>> {
        if let Some(open) = self.threads.borrow().get(thread_id) {
            return Some(open.model.clone());
        }
        let thread = self.runtime.state.thread(thread_id)?;
        let participants = self.participants_for(&thread);
        let messages = self.runtime.load_messages(thread_id);
        let model = cx.new(|_| ThreadModel::new(thread, participants, messages));
        let (tx, rx) = async_channel::unbounded::<Batched>();
        let task = drive(model.clone(), rx, MAX_COMMITS_PER_SECOND, cx);
        self.threads.borrow_mut().insert(
            thread_id.clone(),
            OpenThread { model: model.clone(), pane: None, sender: tx, _drive: task, _subs: Vec::new() },
        );
        Some(model)
    }

    /// Create the pane for a thread (once) and register it as the active tab's view.
    ///
    /// Shell actions run inside the window's own update, where
    /// `WindowHandle::update` reports "window not found", so pane creation
    /// is deferred to the end of the current update.
    fn mount_thread(self: &Arc<Self>, thread_id: &ThreadId, cx: &mut App) {
        let Some(model) = self.ensure_thread(thread_id, cx) else {
            tracing::warn!(%thread_id, "mount_thread: no model (thread not in store?)");
            return;
        };
        let existing = self.threads.borrow().get(thread_id).and_then(|o| o.pane.clone());
        if let Some(pane) = existing {
            self.register_active_tab_view(pane.into(), cx);
            return;
        }
        let Some(window) = *self.window.borrow() else {
            tracing::warn!("mount_thread: no window attached");
            return;
        };
        let app = self.clone();
        let tid = thread_id.clone();
        cx.defer(move |cx| {
            let pane = match window.update(cx, |_, window, cx| cx.new(|cx| ThreadPane::new(model.clone(), window, cx))) {
                Ok(pane) => pane,
                Err(e) => {
                    tracing::warn!(error = %e, "mount_thread: window update failed");
                    return;
                }
            };
            let sub_app = app.clone();
            let sub_tid = tid.clone();
            let sub = cx.subscribe(&pane, move |_pane, event: &ComposerEvent, cx| {
                sub_app.on_composer(&sub_tid, event.clone(), cx);
            });
            if let Some(open) = app.threads.borrow_mut().get_mut(&tid) {
                open.pane = Some(pane.clone());
                open._subs.push(sub);
            }
            app.register_active_tab_view(pane.into(), cx);
        });
    }

    fn register_active_tab_view(&self, view: AnyView, cx: &mut App) {
        let tab = self.state.read(cx).active_tab().map(|t| t.id);
        tracing::debug!(?tab, "register tab view");
        if let Some(id) = tab {
            if cx.try_global::<TabViews>().is_none() {
                cx.set_global(TabViews::default());
            }
            cx.global_mut::<TabViews>().views.insert(id, view);
            // The shell re-renders on state notifications only.
            self.state.update(cx, |_, cx| cx.notify());
        }
    }

    fn session_key(&self, thread: &Thread, recipient: Option<&ParticipantId>) -> Result<(SessionKey, Participant)> {
        let participants = self.participants_for(thread);
        let participant = match recipient {
            Some(r) => participants.iter().find(|p| &p.id == r).cloned(),
            None => None,
        }
        .or_else(|| participants.first().cloned())
        .ok_or_else(|| anyhow::anyhow!("no participant for thread"))?;
        Ok((SessionKey { thread_id: thread.id.clone(), participant_id: participant.id.clone() }, participant))
    }

    fn on_composer(self: &Arc<Self>, thread_id: &ThreadId, event: ComposerEvent, cx: &mut App) {
        let Some(thread) = self.runtime.state.thread(thread_id) else { return };
        let Some(model) = self.ensure_thread(thread_id, cx) else { return };
        let runtime = self.runtime.clone();
        match event {
            ComposerEvent::Send { text, recipient, attachments } => {
                let Ok((_, participant)) = self.session_key(&thread, recipient.as_ref()) else { return };
                let atts: Vec<AttachmentPart> = attachments
                    .iter()
                    .map(|p| AttachmentPart {
                        id: PartId::new(),
                        mime: mime_for(p),
                        source: p.display().to_string(),
                        name: p.file_name().map(|n| n.to_string_lossy().into_owned()),
                    })
                    .collect();
                let user_msg = model.update(cx, |m, cx| {
                    let id = m.push_user_message(text.clone(), recipient.clone(), atts);
                    m.busy = true;
                    cx.notify();
                    m.message(&id).cloned()
                });
                if let Some(msg) = user_msg {
                    runtime.persist_message(msg);
                }
                self.state.update(cx, |s, cx| {
                    s.set_busy(thread_id, true);
                    cx.notify();
                });
                let prompt = Prompt {
                    text,
                    attachments: attachments.into_iter().map(|p| Attachment { mime: mime_for(&p), path: p }).collect(),
                };
                let sender = self.threads.borrow().get(thread_id).map(|o| o.sender.clone());
                let pid = participant.id.clone();
                runtime.handle.clone().spawn(async move {
                    if let Err(e) = runtime.send(&thread, &participant, prompt).await {
                        if let Some(tx) = sender {
                            let _ = tx.send((Some(pid.clone()), EngineEvent::Error { message: e.to_string(), fatal: true })).await;
                            let _ = tx.send((Some(pid), EngineEvent::Status { busy: false })).await;
                        }
                    }
                });
            }
            ComposerEvent::Permission { request, decision, always } => {
                let participant = model.read(cx).pending.iter().find(|p| p.request_id() == &request).and_then(|p| match p {
                    crate::model::PendingRequest::Permission { participant, .. } => participant.clone(),
                    crate::model::PendingRequest::Question { participant, .. } => participant.clone(),
                });
                model.update(cx, |m, cx| {
                    m.resolve_request(&request);
                    cx.notify();
                });
                let Ok((key, _)) = self.session_key(&thread, participant.as_ref()) else { return };
                runtime.handle.clone().spawn(async move {
                    if always {
                        if let Some(s) = runtime.sessions.get(&key).await {
                            let _ = s.set_permission_mode(PermissionMode::AcceptEdits).await;
                        }
                    }
                    if let Err(e) = runtime.sessions.respond_permission(&key, request, decision).await {
                        tracing::warn!(error = %e, "permission response failed");
                    }
                });
            }
            ComposerEvent::Answer { request, option } => {
                let participant = model.read(cx).pending.iter().find(|p| p.request_id() == &request).and_then(|p| match p {
                    crate::model::PendingRequest::Permission { participant, .. } => participant.clone(),
                    crate::model::PendingRequest::Question { participant, .. } => participant.clone(),
                });
                model.update(cx, |m, cx| {
                    m.resolve_request(&request);
                    cx.notify();
                });
                let Ok((key, _)) = self.session_key(&thread, participant.as_ref()) else { return };
                runtime.handle.clone().spawn(async move {
                    if let Some(s) = runtime.sessions.get(&key).await {
                        if let Err(e) = s.respond_question(request, option).await {
                            tracing::warn!(error = %e, "question answer failed");
                        }
                    }
                });
            }
            ComposerEvent::Interrupt => {
                let Ok((key, _)) = self.session_key(&thread, None) else { return };
                runtime.handle.clone().spawn(async move {
                    let _ = runtime.sessions.interrupt(&key).await;
                });
            }
        }
    }

    fn open_new_thread(self: &Arc<Self>, thread: Thread, participants: Vec<Participant>, room: Option<Room>, cx: &mut App) {
        let id = thread.id.clone();
        self.state.update(cx, |s, cx| {
            match room {
                Some(room) => s.add_room(thread, room),
                None => s.add_thread(thread, participants),
            }
            s.open_thread(id.clone());
            cx.notify();
        });
        self.mount_thread(&id, cx);
    }
}

fn mime_for(path: &Path) -> String {
    match path.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).as_deref() {
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("pdf") => "application/pdf",
        Some("md") | Some("txt") => "text/plain",
        _ => "application/octet-stream",
    }
    .to_string()
}

impl ShellActions for BossApp {
    fn open_thread(&self, thread: &ThreadId, cx: &mut App) {
        // `self` is behind an Arc in practice; recover it for the helpers.
        let this = ARC.with(|a| a.borrow().clone());
        if let Some(app) = this {
            app.mount_thread(thread, cx);
        }
    }

    fn new_chat(&self, project: &ProjectId, engine: EngineId, cx: &mut App) {
        let Some(app) = ARC.with(|a| a.borrow().clone()) else { return };
        let Some(project) = app.runtime.state.project(project) else { return };
        match app.runtime.new_chat(&project, engine, None) {
            Ok(thread) => {
                let participants = app.participants_for(&thread);
                app.open_new_thread(thread, participants, None, cx);
            }
            Err(e) => tracing::error!(error = %e, "new chat failed"),
        }
    }

    fn new_room(&self, project: &ProjectId, shape: RoomShape, cx: &mut App) {
        let Some(app) = ARC.with(|a| a.borrow().clone()) else { return };
        let Some(project) = app.runtime.state.project(project) else { return };
        let now = time::OffsetDateTime::now_utc();
        let room_id = RoomId::new();
        let thread = Thread {
            id: ThreadId::new(),
            project_id: project.id.clone(),
            title: "New room".into(),
            kind: ThreadKind::Room { room_id: room_id.clone() },
            created_at: now,
            updated_at: now,
            cwd: project.root.clone(),
            archived: false,
        };
        let engine = app.runtime.settings.get().default_engine;
        let boss = Participant {
            id: ParticipantId::from_raw(format!("{}:boss", thread.id)),
            name: "BOSS".into(),
            engine,
            model: None,
            is_boss: true,
            native_session_id: None,
        };
        let room = Room { id: room_id, thread_id: thread.id.clone(), shape, participants: vec![boss] };
        if let Err(e) = app.runtime.state.upsert_thread(thread.clone()).and_then(|_| app.runtime.state.upsert_room(room.clone())) {
            tracing::error!(error = %e, "new room failed");
            return;
        }
        app.open_new_thread(thread, vec![], Some(room), cx);
    }

    fn archive_thread(&self, thread: &ThreadId, _cx: &mut App) {
        let Some(app) = ARC.with(|a| a.borrow().clone()) else { return };
        let _ = app.runtime.state.update_thread(thread, |t| t.archived = true);
        let key = thread.clone();
        let runtime = app.runtime.clone();
        runtime.handle.clone().spawn(async move {
            if let Some(t) = runtime.state.thread(&key) {
                if let Ok(p) = runtime.primary_participant(&t) {
                    let _ = runtime.sessions.close(&SessionKey { thread_id: key, participant_id: p.id }).await;
                }
            }
        });
    }

    fn rename_thread(&self, thread: &ThreadId, title: &str, _cx: &mut App) {
        let Some(app) = ARC.with(|a| a.borrow().clone()) else { return };
        let title = title.to_owned();
        let _ = app.runtime.state.update_thread(thread, move |t| t.title = title);
    }

    fn new_terminal(&self, cwd: &Path, cx: &mut App) {
        let Some(app) = ARC.with(|a| a.borrow().clone()) else { return };
        match TerminalView::try_new(Some(cwd.to_path_buf()), None, cx) {
            Ok(term) => app.register_active_tab_view(term.into(), cx),
            Err(e) => tracing::error!(error = %e, "terminal failed to start"),
        }
    }

    fn new_browser(&self, url: &str, cx: &mut App) {
        let Some(app) = ARC.with(|a| a.borrow().clone()) else { return };
        let Some(window) = *app.window.borrow() else { return };
        let url = url.to_owned();
        cx.defer(move |cx| {
            let view = match window.update(cx, |_, window, cx| {
                cx.new(|cx| BrowserView::new(BrowserTabId::new(), Some(&url), window, cx))
            }) {
                Ok(v) => v,
                Err(e) => {
                    tracing::warn!(error = %e, "new_browser: window update failed");
                    return;
                }
            };
            app.browsers.borrow_mut().open(view.clone(), cx);
            app.register_active_tab_view(view.into(), cx);
        });
    }

    fn open_settings(&self, cx: &mut App) {
        self.probe_engines(cx);
    }

    fn open_project_picker(&self, cx: &mut App) {
        let Some(app) = ARC.with(|a| a.borrow().clone()) else { return };
        let rx = cx.prompt_for_paths(PathPromptOptions { files: false, directories: true, multiple: false, prompt: Some("Add project".into()) });
        let state = app.state.clone();
        let runtime = app.runtime.clone();
        cx.spawn(async move |cx: &mut AsyncApp| {
            if let Ok(Ok(Some(paths))) = rx.await {
                for root in paths {
                    match runtime.state.add_project(root, None) {
                        Ok(project) => {
                            let _ = state.update(cx, |s, cx| {
                                if !s.projects.iter().any(|p| p.id == project.id) {
                                    s.projects.push(project);
                                }
                                cx.notify();
                            });
                        }
                        Err(e) => tracing::error!(error = %e, "add project failed"),
                    }
                }
            }
        })
        .detach();
    }

    fn set_theme(&self, theme: Theme, _cx: &mut App) {
        let Some(app) = ARC.with(|a| a.borrow().clone()) else { return };
        let _ = app.runtime.settings.update(|s| s.theme = theme);
    }

    fn save_settings(&self, settings: &Settings, _cx: &mut App) {
        let Some(app) = ARC.with(|a| a.borrow().clone()) else { return };
        let _ = app.runtime.settings.replace(settings.clone());
    }

    fn probe_engines(&self, _cx: &mut App) {
        let Some(app) = ARC.with(|a| a.borrow().clone()) else { return };
        for engine in app.runtime.sessions.engines().cloned().collect::<Vec<_>>() {
            app.runtime.handle.clone().spawn(async move {
                match engine.probe().await {
                    Ok(p) => tracing::info!(engine = ?engine.id(), installed = p.installed, version = ?p.version, "probe"),
                    Err(e) => tracing::warn!(engine = ?engine.id(), error = %e, "probe failed"),
                }
            });
        }
    }
}

thread_local! {
    /// The single app instance, so `ShellActions` methods (which take `&self`)
    /// can reach the `Arc` the helpers need.
    static ARC: RefCell<Option<Arc<BossApp>>> = const { RefCell::new(None) };
}

impl BossApp {
    /// Register this instance as the process-wide app.
    pub fn install(self: &Arc<Self>) {
        ARC.with(|a| *a.borrow_mut() = Some(self.clone()));
    }
}

/// Serves browser tools to the bus from the UI's browser registry.
struct QaBridge {
    tools: BrowserBusTools,
}

#[async_trait]
impl BusHandler for QaBridge {
    async fn list_tools(&self, _caller: &BusCaller) -> Vec<BusTool> {
        self.tools.definitions()
    }
    async fn call_tool(&self, _caller: &BusCaller, name: &str, args: Value) -> BusToolResult {
        if name == "boss_computer" {
            return BusToolResult::error("boss_computer is not available yet in this build of BOSS.");
        }
        self.tools.call(name, &args).await
    }
}
