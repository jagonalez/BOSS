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
    room_pane: Option<Entity<crate::rooms::RoomPane>>,
    sender: async_channel::Sender<Batched>,
    _drive: gpui::Task<()>,
    _subs: Vec<Subscription>,
}

pub struct BossApp {
    runtime: Arc<Runtime>,
    state: Entity<AppState>,
    /// Mobile access through the relay (phone app).
    pub relay: boss_runtime::relay::RelayHandle,
    /// Tailscale-fronted web access (phone PWA).
    ///
    /// Behind a tokio mutex because `WebAccess::enable`/`disable` take
    /// `&mut self` and are awaited on the runtime, while `BossApp` is shared
    /// through an `Arc` on the UI thread.
    pub web_access: Arc<tokio::sync::Mutex<Option<boss_runtime::web_access::WebAccess>>>,
    window: RefCell<Option<WindowHandle<Root>>>,
    workspace: RefCell<Option<Entity<crate::shell::Workspace>>>,
    /// Held here so engine probes never read the workspace entity; the
    /// settings tab opens from inside a workspace update.
    probe_state: RefCell<Option<Entity<crate::shell::settings::ProbeState>>>,
    settings_subs: RefCell<Vec<Subscription>>,
    threads: RefCell<HashMap<ThreadId, OpenThread>>,
    browsers: RefCell<BrowserRegistry>,
    /// Views behind terminal and browser tabs, and their event
    /// subscriptions. Dropping an entry closes the tab's shell or page.
    tabs: RefCell<HashMap<TabId, TabPane>>,
    /// The release the update banner is offering, once a check found one.
    pending_update: RefCell<Option<boss_update::Release>>,
    /// Why web access could not start at launch, if it could not. Shown on
    /// the settings page instead of living only in the log.
    web_error: RefCell<Option<String>>,
}

/// A terminal or browser tab's view, kept alive with its subscriptions.
enum TabPane {
    Terminal {
        view: Entity<TerminalView>,
        /// Where the shell was started, so a dead one can be respawned there.
        cwd: std::path::PathBuf,
        _subs: Vec<Subscription>,
    },
    Browser {
        id: BrowserTabId,
        _subs: Vec<Subscription>,
    },
}

impl BossApp {
    pub fn new(
        runtime: Arc<Runtime>,
        state: Entity<AppState>,
        relay: boss_runtime::relay::RelayHandle,
        web_access: Option<boss_runtime::web_access::WebAccess>,
        web_error: Option<String>,
    ) -> Arc<Self> {
        Arc::new(Self {
            runtime,
            state,
            relay,
            web_access: Arc::new(tokio::sync::Mutex::new(web_access)),
            window: RefCell::new(None),
            workspace: RefCell::new(None),
            probe_state: RefCell::new(None),
            settings_subs: RefCell::new(Vec::new()),
            threads: RefCell::new(HashMap::new()),
            browsers: RefCell::new(BrowserRegistry::new()),
            tabs: RefCell::new(HashMap::new()),
            pending_update: RefCell::new(None),
            web_error: RefCell::new(web_error),
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
    pub fn attach_window(self: &Arc<Self>, window: WindowHandle<Root>, workspace: Entity<crate::shell::Workspace>, cx: &mut App) {
        *self.window.borrow_mut() = Some(window);
        let settings_page = workspace.read(cx).settings_page().clone();
        let banner = workspace.read(cx).update_banner().clone();
        *self.probe_state.borrow_mut() = Some(workspace.read(cx).probe_state().clone());
        *self.workspace.borrow_mut() = Some(workspace);
        let app = self.clone();
        let sub = cx.subscribe(&settings_page, move |_page, event: &crate::shell::settings::SettingsEvent, cx| {
            app.on_settings_event(event, cx);
        });
        self.settings_subs.borrow_mut().push(sub);
        let app = self.clone();
        let banner_sub = cx.subscribe(&banner, move |_banner, event: &crate::shell::UpdateBannerEvent, cx| {
            app.on_update_banner_event(event, cx);
        });
        self.settings_subs.borrow_mut().push(banner_sub);
        self.probe_engines(cx);
        self.report_web_access(cx);
        self.check_for_updates(cx);
        let qa: Arc<dyn BusHandler> = Arc::new(QaBridge { tools: self.browsers.borrow().bus_tools() });
        self.runtime.bus_handler().set_qa_handler(qa);
        self.runtime.bus_handler().set_room_opener(Arc::new(RoomOpenerBridge { runtime: self.runtime.clone() }));
        self.start_pump(cx);
    }

    fn on_settings_event(self: &Arc<Self>, event: &crate::shell::settings::SettingsEvent, cx: &mut App) {
        use crate::shell::settings::SettingsEvent;
        match event {
            SettingsEvent::EnableRemote(on) => {
                let on = *on;
                let relay = self.relay.clone();
                self.runtime.handle.clone().spawn(async move {
                    let status = relay
                        .apply(boss_runtime::relay::RemotePatch { enabled: Some(on), relay_url: None, forget_device_id: None, revoke_all: false })
                        .await;
                    tracing::info!(?status, "relay access toggled");
                });
                self.set_web_access(on, cx);
            }
            SettingsEvent::ShowPairing => {
                let relay = self.relay.clone();
                let page = self.workspace.borrow().as_ref().map(|w| w.read(cx).settings_page().clone());
                let (tx, rx) = futures::channel::oneshot::channel::<(Option<String>, Option<Vec<u8>>)>();
                self.runtime.handle.clone().spawn(async move {
                    let _ = relay.apply(boss_runtime::relay::RemotePatch { enabled: Some(true), relay_url: None, forget_device_id: None, revoke_all: false }).await;
                    relay.begin_pairing().await;
                    let _ = tx.send((relay.pairing_payload(), relay.pairing_qr_png()));
                });
                cx.spawn(async move |cx: &mut AsyncApp| {
                    if let Ok((code, png)) = rx.await {
                        if let Some(page) = page {
                            let _ = page.update(cx, |p, cx| p.set_pairing(code, png, cx));
                        }
                    }
                })
                .detach();
            }
        }
    }

    /// The settings page, when a window is attached.
    fn settings_page(&self, cx: &App) -> Option<Entity<crate::shell::settings::SettingsPage>> {
        self.workspace.borrow().as_ref().map(|w| w.read(cx).settings_page().clone())
    }

    /// Start or stop the Tailscale-fronted web server behind the
    /// remote-access switch, and tell the settings page what happened.
    ///
    /// Turning it on when nothing is listening starts a server; turning it
    /// on when one is already up only re-publishes it to the tailnet.
    fn set_web_access(self: &Arc<Self>, on: bool, cx: &mut App) {
        let web = self.web_access.clone();
        let runtime = self.runtime.clone();
        // Whatever happened at launch is now history; this attempt's own
        // outcome is what the page will show.
        *self.web_error.borrow_mut() = None;
        let (tx, rx) = futures::channel::oneshot::channel::<crate::shell::settings::RemoteStatus>();
        self.runtime.handle.clone().spawn(async move {
            let mut slot = web.lock().await;
            if !on {
                if let Some(access) = slot.take() {
                    access.stop().await;
                }
                let _ = tx.send(crate::shell::settings::RemoteStatus::default());
                return;
            }
            if slot.is_none() {
                *slot = match start_web_access(&runtime).await {
                    Ok(access) => Some(access),
                    Err(error) => {
                        // The usual cause is a second BOSS holding the port.
                        // This used to be a log line only.
                        tracing::warn!(%error, "web access did not start");
                        let _ = tx.send(crate::shell::settings::RemoteStatus {
                            error: Some(error),
                            ..Default::default()
                        });
                        return;
                    }
                };
            }
            if let Some(access) = slot.as_mut() {
                access.enable().await;
                if let Err(e) = access.save() {
                    tracing::warn!(error = %e, "could not persist mobile-access.json");
                }
                let _ = tx.send(remote_status(access));
            }
        });
        let page = self.settings_page(cx);
        cx.spawn(async move |cx: &mut AsyncApp| {
            if let (Ok(status), Some(page)) = (rx.await, page) {
                let _ = page.update(cx, |p, cx| p.set_remote_status(status, cx));
            }
        })
        .detach();
    }

    /// Show what web access is doing without changing it. Called once the
    /// window is up so a server that failed to bind at launch is visible.
    fn report_web_access(self: &Arc<Self>, cx: &mut App) {
        let web = self.web_access.clone();
        let launch_error = self.web_error.borrow().clone();
        let (tx, rx) = futures::channel::oneshot::channel::<crate::shell::settings::RemoteStatus>();
        self.runtime.handle.clone().spawn(async move {
            let slot = web.lock().await;
            let status = match slot.as_ref() {
                Some(access) => remote_status(access),
                // Nothing is listening: either it was never asked for, or
                // the bind at launch failed and that is worth saying.
                None => crate::shell::settings::RemoteStatus {
                    error: launch_error,
                    ..Default::default()
                },
            };
            let _ = tx.send(status);
        });
        let page = self.settings_page(cx);
        cx.spawn(async move |cx: &mut AsyncApp| {
            if let (Ok(status), Some(page)) = (rx.await, page) {
                let _ = page.update(cx, |p, cx| p.set_remote_status(status, cx));
            }
        })
        .detach();
    }

    /// Ask GitHub for a newer release on the user's channel and, if there is
    /// one, raise the bar at the top of the workspace.
    fn check_for_updates(self: &Arc<Self>, cx: &mut App) {
        let channel = self.runtime.settings.get().update_channel;
        let (tx, rx) = futures::channel::oneshot::channel::<Option<boss_update::Release>>();
        self.runtime.handle.clone().spawn(async move {
            let updater = boss_update::Updater::new(env!("CARGO_PKG_VERSION"));
            let found = match updater.check(channel).await {
                Ok(Some(release)) => {
                    tracing::info!(version = %release.version, "update available");
                    Some(release)
                }
                Ok(None) => {
                    tracing::info!("no update available");
                    None
                }
                Err(e) => {
                    // A check that cannot reach GitHub is not worth a banner:
                    // the user did not ask for it.
                    tracing::debug!(error = %e, "update check failed");
                    None
                }
            };
            let _ = tx.send(found);
        });
        let app = self.clone();
        cx.spawn(async move |cx: &mut AsyncApp| {
            let Ok(Some(release)) = rx.await else { return };
            let version = release.version.clone();
            *app.pending_update.borrow_mut() = Some(release);
            let Some(banner) = cx.update(|cx| app.update_banner(cx)) else { return };
            let _ = banner.update(cx, |b, cx| b.offer(version, cx));
        })
        .detach();
    }

    fn update_banner(&self, cx: &App) -> Option<Entity<crate::shell::UpdateBanner>> {
        self.workspace.borrow().as_ref().map(|w| w.read(cx).update_banner().clone())
    }

    /// Download and apply the release the banner is offering, reporting each
    /// step back to it. Everything but the state changes runs on the tokio
    /// runtime: `download` streams hundreds of megabytes and `apply` swaps
    /// the `.app` bundle, neither of which belongs on the UI thread.
    fn install_update(self: &Arc<Self>, cx: &mut App) {
        let Some(release) = self.pending_update.borrow().clone() else {
            tracing::warn!("install_update with no release offered");
            return;
        };
        let Some(banner) = self.update_banner(cx) else { return };
        let channel_banner = banner.downgrade();
        // Progress is coalesced by the banner's own repaint; the channel is
        // bounded so a fast download cannot outrun the UI thread.
        let (progress_tx, progress_rx) = async_channel::bounded::<(u64, u64)>(4);
        let (done_tx, done_rx) = futures::channel::oneshot::channel::<crate::shell::UpdateStage>();
        self.runtime.handle.clone().spawn(async move {
            let updater = boss_update::Updater::new(env!("CARGO_PKG_VERSION"));
            let file = match updater.download(&release, |done, total| {
                let _ = progress_tx.try_send((done, total));
            }).await {
                Ok(path) => path,
                Err(e) => {
                    let _ = done_tx.send(crate::shell::UpdateStage::Failed { error: e.to_string() });
                    return;
                }
            };
            let stage = match tokio::task::spawn_blocking(move || boss_update::apply(&file)).await {
                Ok(Ok(boss_update::Installed::Replaced { .. })) => crate::shell::UpdateStage::Restart,
                Ok(Ok(boss_update::Installed::OpenManually { path, message })) => {
                    crate::shell::UpdateStage::OpenManually { path, message }
                }
                Ok(Err(e)) => crate::shell::UpdateStage::Failed { error: e.to_string() },
                Err(e) => crate::shell::UpdateStage::Failed { error: e.to_string() },
            };
            let _ = done_tx.send(stage);
        });
        cx.spawn(async move |cx: &mut AsyncApp| {
            while let Ok((done, total)) = progress_rx.recv().await {
                // A closed window drops the banner; stop rather than
                // pumping progress into nothing for the rest of the download.
                let Some(banner) = channel_banner.upgrade() else { return };
                banner.update(cx, |b, cx| b.set_progress(done, total, cx));
            }
        })
        .detach();
        cx.spawn(async move |cx: &mut AsyncApp| {
            // The download stage sits until the install starts, so the bar
            // does not look stuck at 100% while ditto unpacks.
            let Ok(stage) = done_rx.await else { return };
            let _ = banner.update(cx, |b, cx| b.set_stage(stage, cx));
        })
        .detach();
    }

    fn on_update_banner_event(self: &Arc<Self>, event: &crate::shell::UpdateBannerEvent, cx: &mut App) {
        use crate::shell::UpdateBannerEvent;
        match event {
            UpdateBannerEvent::Install => self.install_update(cx),
            UpdateBannerEvent::Restart => {
                // `apply` already spawned the new bundle with `open -n`; this
                // copy has to leave so the user is not looking at the old one.
                let runtime = self.runtime.clone();
                runtime.handle.clone().block_on(async { runtime.shutdown().await });
                cx.quit();
            }
            UpdateBannerEvent::Reveal(path) => {
                boss_update::open_manually(path);
            }
            UpdateBannerEvent::Dismiss => {}
        }
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
        let room_pane = self.threads.borrow().get(&thread_id).and_then(|o| o.room_pane.clone());
        if let Some(pane) = room_pane {
            let participants = self.runtime.rooms().room(&thread_id).participants;
            pane.update(cx, |p, cx| p.set_participants(participants, cx));
        }
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
            ThreadKind::Room { .. } => self.runtime.rooms().participants_for(&thread.id),
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
            OpenThread { model: model.clone(), pane: None, room_pane: None, sender: tx, _drive: task, _subs: Vec::new() },
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
        let existing_room = self.threads.borrow().get(thread_id).and_then(|o| o.room_pane.clone());
        if let Some(pane) = existing_room {
            self.register_active_tab_view(pane.into(), cx);
            return;
        }
        let is_room = self.runtime.state.thread(thread_id).map(|t| matches!(t.kind, ThreadKind::Room { .. })).unwrap_or(false);
        if is_room {
            self.mount_room(thread_id, model, cx);
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

    /// Re-read a room after the coordinator changed it: the team bar above
    /// the transcript and the row the sidebar draws its card from.
    fn refresh_room(self: &Arc<Self>, thread: &ThreadId, cx: &mut App) {
        let participants = self.runtime.rooms().room(thread).participants;
        let pane = self.threads.borrow().get(thread).and_then(|o| o.room_pane.clone());
        if let Some(pane) = pane {
            pane.update(cx, |p, cx| p.set_participants(participants, cx));
        }
        let row = self.runtime.state.room_for_thread(thread);
        self.state.update(cx, |s, cx| {
            if let Some(room) = row
                && let Some(r) = s.rooms.iter_mut().find(|r| r.id == room.id)
            {
                *r = room;
            }
            cx.notify();
        });
    }

    /// Room tabs: team bar + transcript, or team setup until a shape exists.
    fn mount_room(self: &Arc<Self>, thread_id: &ThreadId, model: Entity<ThreadModel>, cx: &mut App) {
        let Some(window) = *self.window.borrow() else { return };
        let app = self.clone();
        let tid = thread_id.clone();
        cx.defer(move |cx| {
            let rooms = app.runtime.rooms();
            let room = rooms.room(&tid);
            let setup = if room.shape.is_none() {
                let team = rooms.team().unwrap_or_else(|| boss_core::rooms::RoomTeam {
                    roles: boss_core::rooms::manager::suggested_roles(&[app.runtime.settings.get().default_engine]),
                    ask_shape: true,
                    default_shape: RoomShape::Direct,
                });
                Some((team, Vec::new()))
            } else {
                None
            };
            let participants = room.participants.clone();
            let pane = match window.update(cx, |_, window, cx| {
                cx.new(|cx| crate::rooms::RoomPane::new(model.clone(), participants, setup, window, cx))
            }) {
                Ok(p) => p,
                Err(e) => {
                    tracing::warn!(error = %e, "mount_room: window update failed");
                    return;
                }
            };
            let a = app.clone();
            let t = tid.clone();
            let composer_sub = cx.subscribe(&pane, move |_p, event: &ComposerEvent, cx| a.on_composer(&t, event.clone(), cx));
            let a = app.clone();
            let t = tid.clone();
            let room_sub = cx.subscribe(&pane, move |_p, event: &crate::rooms::RoomPaneEvent, cx| {
                let rooms = a.runtime.rooms();
                match event {
                    crate::rooms::RoomPaneEvent::Start { shape, team } => {
                        rooms.configure_team(team.clone());
                        rooms.choose_shape(&t, *shape);
                    }
                    crate::rooms::RoomPaneEvent::AddRole { role, engine } => {
                        if let Some(mut team) = rooms.team() {
                            if let Some(r) = team.roles.iter_mut().find(|r| &r.id == role) {
                                r.engine = *engine;
                            }
                            rooms.configure_team(team);
                        }
                    }
                    crate::rooms::RoomPaneEvent::RemoveRole { participant } => {
                        // Closing the seat's session is async, so the refresh
                        // waits for it: reading the room now would still show
                        // the participant that is on its way out.
                        let app = a.clone();
                        let thread = t.clone();
                        let participant = participant.clone();
                        let runtime = a.runtime.clone();
                        let (tx, rx) = futures::channel::oneshot::channel::<()>();
                        runtime.handle.clone().spawn(async move {
                            if let Err(e) = runtime.rooms().remove_participant(&thread, &participant).await {
                                tracing::warn!(%participant, error = %e, "remove participant failed");
                            }
                            let _ = tx.send(());
                        });
                        let thread = t.clone();
                        cx.spawn(async move |cx: &mut AsyncApp| {
                            let _ = rx.await;
                            let _ = cx.update(|cx| app.refresh_room(&thread, cx));
                        })
                        .detach();
                        return;
                    }
                    crate::rooms::RoomPaneEvent::Reply { parent, text } => {
                        a.send_reply(&t, parent.clone(), text.clone(), cx);
                        return;
                    }
                    crate::rooms::RoomPaneEvent::Cancel => {}
                }
                let _ = rooms;
                a.refresh_room(&t, cx);
            });
            if let Some(open) = app.threads.borrow_mut().get_mut(&tid) {
                open.room_pane = Some(pane.clone());
                open._subs.push(composer_sub);
                open._subs.push(room_sub);
            }
            app.register_active_tab_view(pane.into(), cx);
        });
    }

    fn register_active_tab_view(&self, view: AnyView, cx: &mut App) {
        let tab = self.state.read(cx).active_tab().map(|t| t.id);
        tracing::debug!(?tab, "register tab view");
        if let Some(id) = tab {
            self.register_tab_view(id, view, cx);
        }
    }

    /// Put a view behind a specific tab. Terminal and browser panes use this
    /// rather than [`Self::register_active_tab_view`] because they are built
    /// in a `cx.defer`, by which point the user may have moved on.
    fn register_tab_view(&self, tab: TabId, view: AnyView, cx: &mut App) {
        if cx.try_global::<TabViews>().is_none() {
            cx.set_global(TabViews::default());
        }
        cx.global_mut::<TabViews>().views.insert(tab, view);
        // The shell re-renders on state notifications only.
        self.state.update(cx, |_, cx| cx.notify());
    }

    /// Spawn a shell for `tab` in `cwd` and wire its events to the tab.
    ///
    /// Also used to bring a tab back after its shell exited, which is why it
    /// clears the exit marker rather than assuming the tab is fresh.
    fn spawn_terminal(self: &Arc<Self>, tab: TabId, cwd: std::path::PathBuf, cx: &mut App) {
        let view = match TerminalView::try_new(Some(cwd.clone()), None, cx) {
            Ok(view) => view,
            Err(e) => {
                tracing::error!(error = %e, cwd = %cwd.display(), "terminal failed to start");
                return;
            }
        };
        // Multi-line pastes are held back for a confirmation now that there
        // is somewhere to show one; see `on_terminal_event`.
        view.update(cx, |term, _| term.set_confirm_multiline_paste(true));
        let app = self.clone();
        let sub = cx.subscribe(&view, move |view, event: &boss_terminal::TerminalEvent, cx| {
            app.on_terminal_event(tab, &view, event, cx);
        });
        self.tabs.borrow_mut().insert(tab, TabPane::Terminal { view: view.clone(), cwd, _subs: vec![sub] });
        self.state.update(cx, |s, cx| {
            s.set_terminal_exited(tab, None);
            s.set_terminal_title(tab, view.read(cx).title());
            cx.notify();
        });
        self.register_tab_view(tab, view.into(), cx);
    }

    /// Start a fresh shell in a tab whose last one exited.
    fn restart_terminal(self: &Arc<Self>, tab: TabId, cx: &mut App) {
        let cwd = match self.tabs.borrow().get(&tab) {
            Some(TabPane::Terminal { cwd, .. }) => cwd.clone(),
            _ => return,
        };
        // Drop the dead view first: its `Drop` kills the old child.
        self.tabs.borrow_mut().remove(&tab);
        self.spawn_terminal(tab, cwd, cx);
    }

    fn on_terminal_event(
        self: &Arc<Self>,
        tab: TabId,
        view: &Entity<TerminalView>,
        event: &boss_terminal::TerminalEvent,
        cx: &mut App,
    ) {
        use boss_terminal::TerminalEvent;
        match event {
            TerminalEvent::TitleChanged(title) => {
                let title = title.clone();
                self.state.update(cx, |s, cx| {
                    s.set_terminal_title(tab, title);
                    cx.notify();
                });
            }
            TerminalEvent::Exit(code) => {
                let code = *code;
                self.state.update(cx, |s, cx| {
                    s.set_terminal_exited(tab, Some(code));
                    cx.notify();
                });
            }
            TerminalEvent::ConfirmPaste { text } => self.confirm_paste(tab, view.clone(), text.clone(), cx),
            TerminalEvent::RestartRequested => {
                // Replacing the entity that is emitting this would drop the
                // subscription mid-callback, so it waits for the update.
                let app = self.clone();
                cx.defer(move |cx| app.restart_terminal(tab, cx));
            }
            TerminalEvent::Bell => {}
        }
    }

    /// Ask before a paste that spans several lines runs as several commands.
    fn confirm_paste(self: &Arc<Self>, tab: TabId, view: Entity<TerminalView>, text: String, cx: &mut App) {
        let Some(window) = *self.window.borrow() else {
            // With no window there is nothing to ask through, and silently
            // dropping the paste would look like a broken Cmd+V.
            view.update(cx, |term, cx| term.paste_confirmed(&text, cx));
            return;
        };
        let lines = text.trim_end_matches(['\r', '\n']).lines().count();
        let preview = paste_preview(&text);
        // A dialog opened from inside the terminal's own update would
        // re-enter the window; defer as the panes do.
        cx.defer(move |cx| {
            let _ = window.update(cx, |_, window, cx| {
                use gpui_component::WindowExt as _;
                window.open_alert_dialog(cx, move |alert, _, _| {
                    let view = view.clone();
                    let text = text.clone();
                    alert
                        .confirm()
                        .title("Paste several lines?")
                        .description(format!(
                            "This paste is {lines} lines and will run as {lines} commands.\n\n{preview}"
                        ))
                        .on_ok(move |_, _, cx| {
                            view.update(cx, |term, cx| term.paste_confirmed(&text, cx));
                            true
                        })
                });
            });
        });
        let _ = tab;
    }

    fn on_browser_event(
        self: &Arc<Self>,
        tab: TabId,
        view: &Entity<BrowserView>,
        event: &boss_browser::BrowserEvent,
        cx: &mut App,
    ) {
        use boss_browser::BrowserEvent;
        match event {
            BrowserEvent::Navigated(state) => {
                let (title, url) = (state.title.clone(), state.url.clone());
                self.state.update(cx, |s, cx| {
                    s.set_browser_page(tab, title, url);
                    cx.notify();
                });
            }
            BrowserEvent::TitleChanged(title) => {
                let (title, url) = (title.clone(), view.read(cx).state().url.clone());
                self.state.update(cx, |s, cx| {
                    s.set_browser_page(tab, title, url);
                    cx.notify();
                });
            }
            BrowserEvent::OpenExternal(url) => cx.open_url(url),
            BrowserEvent::AgentActivity => {}
        }
    }

    /// Forget a tab's pane. Dropping the entry kills the shell or closes the
    /// page, and a browser tab also leaves the registry so agents stop
    /// seeing it in `boss_browser_tabs`.
    fn close_tab_pane(&self, tab: TabId) {
        if let Some(TabPane::Browser { id, .. }) = self.tabs.borrow_mut().remove(&tab) {
            self.browsers.borrow_mut().close(&id);
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

    /// Send a branch reply: a message under `parent`, addressed to whoever
    /// wrote that turn. It never enters the main transcript, and the answer
    /// joins it there because the model keeps the branch open until that
    /// participant settles.
    fn send_reply(self: &Arc<Self>, thread_id: &ThreadId, parent: MessageId, text: String, cx: &mut App) {
        let Some(model) = self.ensure_thread(thread_id, cx) else { return };
        // A reply answers the turn's author. A user turn has none, so the
        // reply goes wherever that turn was addressed; failing both, the
        // room routes it as it would any unaddressed message.
        let recipient = model.read(cx).message(&parent).and_then(|m| match m.role {
            Role::User => m.recipient.clone(),
            _ => m.author.clone(),
        });
        let mut msg = Message::new(thread_id.clone(), Role::User);
        msg.status = MessageStatus::Complete;
        msg.recipient = recipient.clone();
        msg.branch_of = Some(parent.clone());
        msg.parts.push(Part::Text(TextPart { id: PartId::new(), text }));
        model.update(cx, |m, cx| {
            m.push_message(msg.clone());
            if let Some(who) = recipient.clone() {
                m.open_branch(who, parent);
            }
            m.busy = true;
            cx.notify();
        });
        self.state.update(cx, |s, cx| {
            s.set_busy(thread_id, true);
            cx.notify();
        });
        let sender = self.threads.borrow().get(thread_id).map(|o| o.sender.clone());
        let runtime = self.runtime.clone();
        runtime.handle.clone().spawn(async move {
            if let Err(e) = runtime.rooms().send_message(msg).await
                && let Some(tx) = sender
            {
                let _ = tx.send((None, EngineEvent::Error { message: e.to_string(), fatal: true })).await;
                let _ = tx.send((None, EngineEvent::Status { busy: false })).await;
            }
        });
    }

    fn on_composer(self: &Arc<Self>, thread_id: &ThreadId, event: ComposerEvent, cx: &mut App) {
        let Some(thread) = self.runtime.state.thread(thread_id) else { return };
        let Some(model) = self.ensure_thread(thread_id, cx) else { return };
        let runtime = self.runtime.clone();
        match event {
            ComposerEvent::Send { text, recipient, attachments } => {
                let prompt = Prompt {
                    text: text.clone(),
                    attachments: attachments.iter().map(|p| Attachment { mime: mime_for(p), path: p.clone() }).collect(),
                };
                let is_room = matches!(thread.kind, ThreadKind::Room { .. });
                let msg = boss_runtime::rooms::user_message(&thread.id, recipient.clone(), &prompt);
                model.update(cx, |m, cx| {
                    m.push_message(msg.clone());
                    m.busy = true;
                    cx.notify();
                });
                self.state.update(cx, |s, cx| {
                    s.set_busy(thread_id, true);
                    cx.notify();
                });
                let sender = self.threads.borrow().get(thread_id).map(|o| o.sender.clone());
                if is_room {
                    // The coordinator persists the message with the resolved
                    // recipient and routes it per the room's shape.
                    runtime.handle.clone().spawn(async move {
                        if let Err(e) = runtime.rooms().send_message(msg).await {
                            if let Some(tx) = sender {
                                let _ = tx.send((None, EngineEvent::Error { message: e.to_string(), fatal: true })).await;
                                let _ = tx.send((None, EngineEvent::Status { busy: false })).await;
                            }
                        }
                    });
                } else {
                    let Ok((_, participant)) = self.session_key(&thread, recipient.as_ref()) else { return };
                    runtime.persist_message(msg);
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

/// Lines of a multi-line paste shown in the confirmation.
const PASTE_PREVIEW_LINES: usize = 6;

/// The first few lines of a paste, for the confirmation dialog.
///
/// Trailing whitespace-only lines are dropped: the interesting thing is what
/// would run, and a trailing newline is what a copied block always ends with.
pub fn paste_preview(text: &str) -> String {
    let lines: Vec<&str> = text.trim_end_matches(['\r', '\n']).lines().collect();
    let mut preview: Vec<String> = lines.iter().take(PASTE_PREVIEW_LINES).map(|l| l.to_string()).collect();
    if lines.len() > PASTE_PREVIEW_LINES {
        preview.push(format!("… and {} more", lines.len() - PASTE_PREVIEW_LINES));
    }
    preview.join("\n")
}

/// How many ports past the configured one to try when the first is taken.
///
/// One other BOSS is the case that happens; a handful covers a stale server
/// or two without turning a misconfiguration into a port scan.
const WEB_ACCESS_PORT_TRIES: u16 = 5;

/// Start the phone web server, walking forward a few ports when the
/// configured one is already held.
///
/// Another BOSS on this Mac holds 4517, and the old behaviour — one attempt,
/// one log line — left the user with a switch that did nothing. The port
/// actually used is written back to `mobile-access.json` by the caller, and
/// reported on the settings page, because a `tailscale serve` rule points at
/// a specific port.
async fn start_web_access(runtime: &Arc<Runtime>) -> Result<boss_runtime::web_access::WebAccess, String> {
    let base = boss_runtime::web_access::WebAccessConfig::load(&runtime.data_dir);
    let mut last = String::new();
    for offset in 0..WEB_ACCESS_PORT_TRIES {
        let mut config = base.clone();
        config.enabled = true;
        let port = base.port.saturating_add(offset);
        if offset > 0 && !config.set_port(port) {
            break;
        }
        match boss_runtime::web_access::WebAccess::start(runtime.clone(), config).await {
            Ok(access) => {
                if offset > 0 {
                    tracing::info!(port, "web access moved to a free port");
                }
                return Ok(access);
            }
            Err(e) => last = format!("port {port}: {e}"),
        }
    }
    Err(if last.is_empty() { "no free port".to_string() } else { last })
}

/// Turn a running server's status into what the settings page renders.
fn remote_status(access: &boss_runtime::web_access::WebAccess) -> crate::shell::settings::RemoteStatus {
    let status = access.status();
    crate::shell::settings::RemoteStatus {
        running: status.running,
        url: status.url,
        error: status.error,
        tailscale_url: status.tailscale_url,
        tailscale_error: status.tailscale_error,
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

    fn new_chat(&self, project: Option<&ProjectId>, engine: EngineId, cx: &mut App) {
        let Some(app) = ARC.with(|a| a.borrow().clone()) else { return };
        let project = project.and_then(|id| app.runtime.state.project(id));
        match app.runtime.new_chat(project.as_ref(), engine, None) {
            Ok(thread) => {
                let participants = app.participants_for(&thread);
                app.open_new_thread(thread, participants, None, cx);
            }
            Err(e) => tracing::error!(error = %e, "new chat failed"),
        }
    }

    fn new_room(&self, project: Option<&ProjectId>, shape: RoomShape, cx: &mut App) {
        let Some(app) = ARC.with(|a| a.borrow().clone()) else { return };
        let project = project.and_then(|id| app.runtime.state.project(id));
        match app.runtime.rooms().open_room(project.as_ref(), Some(shape), None) {
            Ok(thread) => {
                let room = app.runtime.state.room_for_thread(&thread.id);
                app.open_new_thread(thread, vec![], room, cx);
            }
            Err(e) => tracing::error!(error = %e, "new room failed"),
        }
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

    fn new_terminal(&self, cwd: &Path, tab: TabId, cx: &mut App) {
        let Some(app) = ARC.with(|a| a.borrow().clone()) else { return };
        // A tab that already has its shell (a re-activation, or a reopen of a
        // tab that never closed) keeps it rather than spawning a second one.
        if app.tabs.borrow().contains_key(&tab) {
            return;
        }
        app.spawn_terminal(tab, cwd.to_path_buf(), cx);
    }

    fn new_browser(&self, url: &str, tab: TabId, cx: &mut App) {
        let Some(app) = ARC.with(|a| a.borrow().clone()) else { return };
        if app.tabs.borrow().contains_key(&tab) {
            return;
        }
        let Some(window) = *app.window.borrow() else { return };
        let url = url.to_owned();
        // Pane creation runs inside the window's own update, where
        // `WindowHandle::update` reports "window not found"; defer it.
        cx.defer(move |cx| {
            let id = BrowserTabId::new();
            let view = match window.update(cx, |_, window, cx| {
                cx.new(|cx| BrowserView::new(id.clone(), Some(&url), window, cx))
            }) {
                Ok(v) => v,
                Err(e) => {
                    tracing::warn!(error = %e, "new_browser: window update failed");
                    return;
                }
            };
            app.browsers.borrow_mut().open(view.clone(), cx);
            let watcher = app.clone();
            let sub = cx.subscribe(&view, move |view, event: &boss_browser::BrowserEvent, cx| {
                watcher.on_browser_event(tab, &view, event, cx);
            });
            app.tabs.borrow_mut().insert(tab, TabPane::Browser { id: id.clone(), _subs: vec![sub] });
            // The id agents drive this tab by is only meaningful once the
            // strip can show it, so it lands with the first state.
            let state = view.read(cx).state().clone();
            app.state.update(cx, |s, cx| {
                s.set_browser_agent_id(tab, id.0.clone());
                s.set_browser_page(tab, state.title.clone(), state.url.clone());
                cx.notify();
            });
            app.register_tab_view(tab, view.into(), cx);
        });
    }

    fn restart_terminal(&self, tab: TabId, cx: &mut App) {
        let Some(app) = ARC.with(|a| a.borrow().clone()) else { return };
        app.restart_terminal(tab, cx);
    }

    fn close_tab(&self, tab: TabId, cx: &mut App) {
        let Some(app) = ARC.with(|a| a.borrow().clone()) else { return };
        app.close_tab_pane(tab);
        if cx.has_global::<TabViews>() {
            cx.global_mut::<TabViews>().views.remove(&tab);
        }
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

    fn probe_engines(&self, cx: &mut App) {
        let Some(app) = ARC.with(|a| a.borrow().clone()) else { return };
        let Some(probe_state) = app.probe_state.borrow().clone() else { return };
        for engine in app.runtime.sessions.engines().cloned().collect::<Vec<_>>() {
            let id = engine.id();
            let (tx, rx) = futures::channel::oneshot::channel::<(Result<EngineProbe>, Result<Vec<ModelInfo>>)>();
            app.runtime.handle.clone().spawn(async move {
                let probe = engine.probe().await;
                let models = if probe.as_ref().map(|p| p.installed).unwrap_or(false) {
                    engine.list_models().await
                } else {
                    Ok(Vec::new())
                };
                let _ = tx.send((probe, models));
            });
            let state = probe_state.clone();
            cx.spawn(async move |cx: &mut AsyncApp| {
                if let Ok((probe, models)) = rx.await {
                    let _ = state.update(cx, |state, cx| {
                        match probe {
                            Ok(p) => state.set_probe(id, p, cx),
                            Err(e) => state.set_probe_error(id, e.to_string(), cx),
                        }
                        if let Ok(models) = models {
                            if !models.is_empty() {
                                state.set_models(id, models, cx);
                            }
                        }
                    });
                }
            })
            .detach();
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

/// Lets agents open rooms through the bus.
struct RoomOpenerBridge {
    runtime: Arc<Runtime>,
}

#[async_trait]
impl boss_runtime::bus_handler::RoomOpener for RoomOpenerBridge {
    async fn open_room(&self, project: Option<&Project>, shape: RoomShape, title: &str) -> Result<Thread> {
        let title = if title.trim().is_empty() { None } else { Some(title.to_string()) };
        self.runtime.rooms().open_room(project, Some(shape), title)
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
        // `boss_computer` never arrives here: the runtime's bus handler owns
        // the cua-driver and answers it before delegating, so the screenshot
        // it returns keeps its image content.
        self.tools.call(name, &args).await
    }
}
