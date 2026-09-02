//! Rooms made to run. `boss_core::rooms::RoomManager` decides what a room
//! does next and says so as [`RoomIntent`]s; [`RoomCoordinator`] executes
//! them: it starts and ends participant sessions on the [`SessionManager`],
//! delivers prompts, posts the collapsed system lines, and turns a finished
//! run into the next role's handover.
//!
//! State lives in `rooms-manager.json` next to the other stores. The
//! contract `Room` rows in [`StateStore`] are kept in sync so the sidebar
//! and the bus see the same seats.
//!
//! Lifecycle: [`RoomCoordinator::start`] loads the file and spawns two tokio
//! tasks — one that follows every session event (session ids, settled runs,
//! closed sessions) and one that retires idle seats every minute. `Runtime`
//! calls it during `Runtime::start`; tests call it with a fake [`RoomHost`].

use crate::sessions::{SessionEvent, SessionKey, SessionManager};
use anyhow::{Context as _, Result, anyhow, bail};
use async_trait::async_trait;
use boss_core::rooms::{
    JobNotes, JobNotesPatch, ParticipantState, ROOM_USER_ID, RoomContext, RoomIntent, RoomManager,
    RoomState, RoomTeam, assistant_id, is_everyone, is_thread_agent, suggested_roles,
    thread_agent_id,
};
use boss_core::store::{JsonFile, StateStore};
use boss_core::*;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;
use time::OffsetDateTime;
use tokio::sync::{Notify, broadcast};

/// File the manager's team and rooms are stored in, under the data dir.
pub const MANAGER_FILE: &str = "rooms-manager.json";
/// Participant id the coordinator's own system lines are injected under.
/// Not a seat: the UI shows them as machinery, never as speech.
pub const SYSTEM_AUTHOR: &str = "system";
/// How often idle seats are retired.
const RETIRE_EVERY: Duration = Duration::from_secs(60);

/// What the coordinator needs from the runtime. `Runtime` implements it;
/// tests stand in a fake so no engine process or port is needed.
#[async_trait]
pub trait RoomHost: Send + Sync {
    /// Live sessions.
    fn sessions(&self) -> Arc<SessionManager>;
    /// Projects, threads, and rooms.
    fn state(&self) -> Arc<StateStore>;
    /// Bus credentials for one seat, if the bus is up.
    fn bus_access(&self, thread: &ThreadId, participant: &ParticipantId) -> Option<BusAccess>;
    /// The engine BOSS and a default team run on when the user never chose.
    fn default_engine(&self) -> EngineId;
    /// A thread's transcript in stored order.
    fn load_messages(&self, thread: &ThreadId) -> Vec<Message>;
    /// Store a message.
    fn persist_message(&self, message: Message);
    /// Feed a synthetic event through the same pump the sessions use, so the
    /// UI folds it like any engine event.
    fn inject_event(&self, key: SessionKey, event: EngineEvent);
    /// Every session event, injected ones included.
    fn subscribe(&self) -> broadcast::Receiver<SessionEvent>;
    /// The agent a thread that is not a room talks to.
    fn primary_participant(&self, thread: &Thread) -> Result<Participant>;
    /// Send to a thread that is not a room, starting its session if needed.
    async fn send(&self, thread: &Thread, participant: &Participant, prompt: Prompt) -> Result<()>;
    /// How the user is named in catch-up text.
    fn user_label(&self) -> String {
        "User".to_owned()
    }
}

/// On-disk shape of `rooms-manager.json`.
#[derive(Default, Serialize, Deserialize)]
struct StoredRooms {
    #[serde(default)]
    team: Option<RoomTeam>,
    #[serde(default)]
    rooms: BTreeMap<ThreadId, RoomState>,
}

/// Which seats are mid-run, answering a broadcast, or being closed on
/// purpose. Kept beside the manager because the manager does not know
/// about sessions, only seats.
#[derive(Default)]
struct Tracking {
    /// Marked at send, cleared when the run settles.
    running: HashSet<SessionKey>,
    /// Settling must not advance the work: a question to everyone is not a
    /// finished job.
    broadcast: HashSet<SessionKey>,
    /// `Closed` for these is expected, not a crash.
    closing: HashSet<SessionKey>,
}

/// Runs rooms: owns the [`RoomManager`], executes its intents against the
/// host, and keeps the stored `Room` rows in step.
pub struct RoomCoordinator {
    host: Weak<dyn RoomHost>,
    handle: tokio::runtime::Handle,
    file: JsonFile,
    manager: Mutex<RoomManager>,
    /// One lock per room, so a finished run and a new message cannot
    /// interleave their transitions, and rooms never wait on each other.
    locks: Mutex<HashMap<ThreadId, Arc<tokio::sync::Mutex<()>>>>,
    tracking: Mutex<Tracking>,
    /// Woken whenever a run settles or a session closes.
    settled: Notify,
}

impl RoomCoordinator {
    /// Load `rooms-manager.json` from `data_dir` and start following session
    /// events. Seats saved with a session are marked stale: sessions do not
    /// survive a restart, and a participant is replaced, never resumed.
    pub fn start(
        host: Weak<dyn RoomHost>,
        data_dir: &Path,
        handle: tokio::runtime::Handle,
    ) -> Result<Arc<Self>> {
        let file = JsonFile::in_dir(Some(data_dir), MANAGER_FILE);
        let stored = file.load_or_default::<StoredRooms>().context("load rooms")?;
        let mut rooms = stored.rooms;
        for room in rooms.values_mut() {
            for seat in &mut room.participants {
                if seat.state != ParticipantState::Done {
                    seat.state = ParticipantState::Stale;
                    seat.participant.native_session_id = None;
                }
            }
        }
        let this = Arc::new(Self {
            host,
            handle,
            file,
            manager: Mutex::new(RoomManager::from_parts(stored.team, rooms)),
            locks: Mutex::new(HashMap::new()),
            tracking: Mutex::new(Tracking::default()),
            settled: Notify::new(),
        });
        this.persist();
        this.spawn_event_loop()?;
        this.spawn_retire_timer();
        Ok(this)
    }

    // ---- reading -------------------------------------------------------

    /// The user's team, once configured.
    pub fn team(&self) -> Option<RoomTeam> {
        self.manager.lock().unwrap().team().cloned()
    }

    /// A room's state: seats, notes, shape, and where the composer points.
    pub fn room(&self, thread: &ThreadId) -> RoomState {
        self.manager.lock().unwrap().room(thread)
    }

    /// Everyone in the room, BOSS first. BOSS is listed before it has a
    /// session, because a room opens with the user and BOSS.
    pub fn participants_for(&self, thread: &ThreadId) -> Vec<Participant> {
        let manager = self.manager.lock().unwrap();
        let room = manager.room(thread);
        let mut participants: Vec<Participant> =
            room.participants.iter().map(|seat| seat.participant.clone()).collect();
        if !participants.iter().any(|p| p.is_boss) {
            participants.insert(0, self.boss_seat_of(&manager, &room));
        }
        participants
    }

    /// The room's BOSS seat: the joined one, or the one that will join when
    /// first addressed.
    pub fn boss_seat(&self, thread: &ThreadId) -> Participant {
        let manager = self.manager.lock().unwrap();
        let room = manager.room(thread);
        self.boss_seat_of(&manager, &room)
    }

    fn boss_seat_of(&self, manager: &RoomManager, room: &RoomState) -> Participant {
        if let Some(seat) = room.find_participant(&assistant_id()) {
            return seat.participant.clone();
        }
        let role = manager.team().and_then(RoomTeam::assistant_role);
        Participant {
            id: assistant_id(),
            name: role.as_ref().map(|r| r.label.clone()).unwrap_or_else(|| "BOSS".to_owned()),
            engine: role
                .as_ref()
                .map(|r| r.engine)
                .or_else(|| self.host().ok().map(|h| h.default_engine()))
                .unwrap_or(EngineId::Claude),
            model: role.and_then(|r| r.model),
            is_boss: true,
            native_session_id: None,
        }
    }

    // ---- setup ---------------------------------------------------------

    /// Replace the team. Existing rooms keep their seats; BOSS's engine in
    /// the stored rows follows the new team.
    pub fn configure_team(&self, team: RoomTeam) {
        let threads: Vec<ThreadId> = self.manage(|m| {
            m.configure_team(team);
            m.rooms().keys().cloned().collect()
        });
        for thread in threads {
            self.sync_room_row(&thread);
        }
    }

    /// Choose how a job runs. Nobody starts until the first message.
    pub fn choose_shape(&self, thread: &ThreadId, shape: RoomShape) {
        self.manage(|m| {
            m.choose_shape(thread, shape);
        });
        self.sync_room_row(thread);
    }

    /// Point the composer at a participant. It stays there until changed.
    pub fn set_recipient(&self, thread: &ThreadId, participant: ParticipantId) {
        self.manage(|m| {
            m.set_recipient(thread, participant);
        });
    }

    /// Record what survives a participant's session (the `boss_notes_record`
    /// tool). Only the fields in the patch change.
    pub fn record_notes(&self, thread: &ThreadId, patch: JobNotesPatch) -> JobNotes {
        self.manage(|m| m.record_notes(thread, patch, now()))
    }

    /// Forget a room once its thread is gone.
    pub fn forget(&self, thread: &ThreadId) {
        self.manage(|m| m.forget(thread));
        self.locks.lock().unwrap().remove(thread);
    }

    /// Create a room in a project: a thread with the user and BOSS in it.
    /// With a shape (given, or the team's standing one) the composer aims at
    /// the room's own agent, so the first message brings in the opening
    /// role; without one it aims at BOSS, who asks. A team is configured
    /// from the default engine when the user never opened setup.
    pub fn open_room(
        &self,
        project: &Project,
        shape: Option<RoomShape>,
        title: Option<String>,
    ) -> Result<Thread> {
        let host = self.host()?;
        self.ensure_team(&host);
        let now = now();
        let thread = Thread {
            id: ThreadId::new(),
            project_id: project.id.clone(),
            title: title.unwrap_or_else(|| "New room".to_owned()),
            kind: ThreadKind::Room { room_id: RoomId::new() },
            created_at: now,
            updated_at: now,
            cwd: project.root.clone(),
            archived: false,
        };
        host.state().upsert_thread(thread.clone())?;
        self.manage(|m| {
            let shape = shape.or_else(|| m.standing_shape());
            match shape {
                Some(shape) => {
                    m.choose_shape(&thread.id, shape);
                    m.set_recipient(&thread.id, thread_agent_id());
                }
                None => {
                    m.set_recipient(&thread.id, assistant_id());
                }
            }
        });
        self.sync_room_row(&thread.id);
        Ok(thread)
    }

    // ---- sending -------------------------------------------------------

    /// Record the user's message and route it. `recipient` defaults to
    /// where the room's composer points. The message is persisted and shown
    /// in the UI through the event pump; the caller must not add it again.
    pub async fn send_user_message(
        &self,
        thread: &ThreadId,
        recipient: Option<ParticipantId>,
        prompt: Prompt,
    ) -> Result<MessageId> {
        let host = self.host()?;
        let thread = host.state().thread(thread).ok_or_else(|| anyhow!("thread {thread} not found"))?;
        let message = user_message(&thread.id, recipient, &prompt);
        let id = message.id.clone();
        show_message(host.as_ref(), &message);
        self.route(&host, &thread, prompt, Some(message)).await?;
        Ok(id)
    }

    /// Route a user message the caller already added to the transcript.
    /// `message.recipient` says who answers. It is persisted again with the
    /// recipient the room resolved, and excluded from the catch-up it
    /// triggers.
    pub async fn send_message(&self, message: Message) -> Result<()> {
        let host = self.host()?;
        let thread = host
            .state()
            .thread(&message.thread_id)
            .ok_or_else(|| anyhow!("thread {} not found", message.thread_id))?;
        let prompt = prompt_of(&message);
        self.route(&host, &thread, prompt, Some(message)).await
    }

    /// Route a prompt that is not a user message: a bus delivery. Nothing
    /// is recorded in the transcript.
    pub async fn send_prompt(
        &self,
        thread: &ThreadId,
        recipient: Option<ParticipantId>,
        prompt: Prompt,
    ) -> Result<()> {
        let host = self.host()?;
        let thread = host.state().thread(thread).ok_or_else(|| anyhow!("thread {thread} not found"))?;
        if !matches!(thread.kind, ThreadKind::Room { .. }) {
            let participant = host.primary_participant(&thread)?;
            return host.send(&thread, &participant, prompt).await;
        }
        let lock = self.room_lock(&thread.id);
        let _guard = lock.lock().await;
        self.route_room(&host, &thread, recipient, prompt, None).await
    }

    /// One path for every user turn. A thread that is not a room goes to
    /// its own agent. In a room the manager routes.
    async fn route(
        &self,
        host: &Arc<dyn RoomHost>,
        thread: &Thread,
        prompt: Prompt,
        record: Option<Message>,
    ) -> Result<()> {
        if !matches!(thread.kind, ThreadKind::Room { .. }) {
            // One agent, no seats: the recipient can only be that agent.
            if let Some(message) = record {
                host.persist_message(message);
            }
            let participant = host.primary_participant(thread)?;
            return host.send(thread, &participant, prompt).await;
        }
        let lock = self.room_lock(&thread.id);
        let _guard = lock.lock().await;
        let recipient = record.as_ref().and_then(|m| m.recipient.clone());
        self.route_room(host, thread, recipient, prompt, record).await
    }

    /// Route inside a room, under its lock. `recipient` defaults to where
    /// the composer points; a message the manager cannot place goes to
    /// BOSS, who is always there. `record` is the user turn being routed:
    /// it is stored with the recipient the room resolved, and left out of
    /// the catch-up it triggers.
    async fn route_room(
        &self,
        host: &Arc<dyn RoomHost>,
        thread: &Thread,
        recipient: Option<ParticipantId>,
        prompt: Prompt,
        record: Option<Message>,
    ) -> Result<()> {
        let now = now();
        let _ = host.state().update_thread(&thread.id, |t| t.updated_at = now);
        self.ensure_team(host);
        let recipient = recipient.unwrap_or_else(|| self.room(&thread.id).recipient);
        let exclude = record.as_ref().map(|m| m.id.clone());
        let messages: Vec<Message> = host
            .load_messages(&thread.id)
            .into_iter()
            .filter(|m| m.role != Role::System && Some(&m.id) != exclude.as_ref())
            .collect();
        let label = host.user_label();
        let ctx = RoomContext { cwd: &thread.cwd, messages: &messages, user_label: &label, now };
        let routed = self.manage(|m| {
            m.set_recipient(&thread.id, recipient.clone());
            match m.route_message(&thread.id, &recipient, prompt.clone(), ctx) {
                Some(intents) => Some((intents, is_everyone(&recipient))),
                None => m
                    .route_message(&thread.id, &assistant_id(), prompt.clone(), ctx)
                    .map(|intents| (intents, false)),
            }
        });
        if let Some(mut message) = record {
            // The room's own agent resolves to whoever opened it, and a message
            // nobody could place went to BOSS. Store where it actually went.
            message.recipient = Some(match &routed {
                Some(_) if is_thread_agent(&recipient) => self.room(&thread.id).recipient,
                Some(_) => recipient.clone(),
                None => assistant_id(),
            });
            host.persist_message(message);
        }
        let Some((intents, broadcast)) = routed else {
            bail!("nobody in this room can answer; set up a team first");
        };
        self.execute(thread, intents, broadcast).await
    }

    // ---- executing -----------------------------------------------------

    /// Execute intents in order. A `SendToParticipant` followed by more
    /// intents waits for that run to settle first, which is what makes a
    /// broadcast reach one participant at a time. `broadcast` keeps those
    /// runs from advancing the work when they settle. A seat whose session
    /// fails is marked stale (so the next address starts it fresh), told to
    /// the room as a system line, and skipped; the first error is returned
    /// after the rest ran.
    pub async fn execute(
        &self,
        thread: &Thread,
        intents: Vec<RoomIntent>,
        broadcast: bool,
    ) -> Result<()> {
        let host = self.host()?;
        let sessions = host.sessions();
        let mut remaining = intents
            .iter()
            .filter(|i| matches!(i, RoomIntent::SendToParticipant { .. }))
            .count();
        if broadcast {
            let mut tracking = self.tracking.lock().unwrap();
            for intent in &intents {
                if let RoomIntent::SendToParticipant { thread_id, participant, .. } = intent {
                    tracking.broadcast.insert(session_key(thread_id, participant));
                }
            }
        }
        let mut failed: HashSet<ParticipantId> = HashSet::new();
        let mut first_error: Option<anyhow::Error> = None;
        for intent in intents {
            match intent {
                RoomIntent::StartSession { engine, mut options } => {
                    let key = session_key(&options.thread_id, &options.participant_id);
                    options.bus = host.bus_access(&key.thread_id, &key.participant_id);
                    if sessions.get(&key).await.is_some() {
                        // A session lingering from a seat that was replaced.
                        self.tracking.lock().unwrap().closing.insert(key.clone());
                        let _ = sessions.close(&key).await;
                    }
                    if let Err(error) = sessions.start(engine, options).await {
                        self.seat_failed(&host, &key, &error);
                        failed.insert(key.participant_id);
                        first_error.get_or_insert(error);
                    }
                }
                RoomIntent::SendToParticipant { thread_id, participant, context, prompt } => {
                    remaining -= 1;
                    let key = session_key(&thread_id, &participant);
                    if failed.contains(&participant) {
                        continue;
                    }
                    let text = match context {
                        Some(context) => format!("{context}\n\n{}", prompt.text),
                        None => prompt.text,
                    };
                    self.tracking.lock().unwrap().running.insert(key.clone());
                    let sent = match sessions.get(&key).await {
                        Some(session) => {
                            session.send(Prompt { text, attachments: prompt.attachments }).await
                        }
                        None => Err(anyhow!("{participant} has no session")),
                    };
                    if let Err(error) = sent {
                        self.seat_failed(&host, &key, &error);
                        failed.insert(participant);
                        first_error.get_or_insert(error);
                        continue;
                    }
                    if remaining > 0 {
                        self.wait_settled(&key).await;
                    }
                }
                RoomIntent::EndSession { thread_id, participant, .. } => {
                    let key = session_key(&thread_id, &participant);
                    self.tracking.lock().unwrap().closing.insert(key.clone());
                    if sessions.get(&key).await.is_some() {
                        if let Err(error) = sessions.close(&key).await {
                            tracing::warn!(%participant, %error, "close session failed");
                        }
                    } else {
                        self.tracking.lock().unwrap().closing.remove(&key);
                    }
                }
                RoomIntent::Notify { thread_id, text } => self.notify(host.as_ref(), &thread_id, text),
            }
        }
        self.sync_room_row(&thread.id);
        match first_error {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }

    /// A seat's session could not start or take a prompt. The room is told,
    /// the UI is released, and the seat goes stale so the next address
    /// brings in a fresh one.
    fn seat_failed(&self, host: &Arc<dyn RoomHost>, key: &SessionKey, error: &anyhow::Error) {
        let label = self
            .room(&key.thread_id)
            .find_participant(&key.participant_id)
            .map(|seat| seat.label().to_owned())
            .unwrap_or_else(|| key.participant_id.to_string());
        tracing::warn!(participant = %key.participant_id, %error, "room seat failed");
        {
            let mut tracking = self.tracking.lock().unwrap();
            tracking.running.remove(key);
            tracking.broadcast.remove(key);
        }
        self.manage(|m| m.touch(&key.thread_id, &key.participant_id, Some(ParticipantState::Stale), now()));
        self.notify(host.as_ref(), &key.thread_id, format!("{label} could not start: {error}"));
        host.inject_event(key.clone(), EngineEvent::Error { message: error.to_string(), fatal: true });
        host.inject_event(key.clone(), EngineEvent::Status { busy: false });
    }

    /// A collapsed system line in the room's transcript.
    fn notify(&self, host: &dyn RoomHost, thread: &ThreadId, text: String) {
        let mut message = Message::new(thread.clone(), Role::System);
        message.status = MessageStatus::Complete;
        message.parts.push(Part::Text(TextPart { id: PartId::new(), text }));
        host.persist_message(message.clone());
        show_message(host, &message);
    }

    /// Wait until the participant's run settles: a `Status { busy: false }`,
    /// a fatal error, or the session closing.
    async fn wait_settled(&self, key: &SessionKey) {
        loop {
            let notified = self.settled.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if !self.tracking.lock().unwrap().running.contains(key) {
                return;
            }
            notified.await;
        }
    }

    // ---- session lifecycle ---------------------------------------------

    fn spawn_event_loop(self: &Arc<Self>) -> Result<()> {
        let mut rx = self.host()?.subscribe();
        let weak = Arc::downgrade(self);
        self.handle.spawn(async move {
            loop {
                let event = match rx.recv().await {
                    Ok(event) => event,
                    Err(broadcast::error::RecvError::Lagged(missed)) => {
                        tracing::warn!(missed, "room coordinator lagged behind session events");
                        continue;
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                };
                let Some(this) = weak.upgrade() else { break };
                this.on_event(event);
            }
        });
        Ok(())
    }

    fn spawn_retire_timer(self: &Arc<Self>) {
        let weak = Arc::downgrade(self);
        self.handle.spawn(async move {
            let mut ticks = tokio::time::interval(RETIRE_EVERY);
            loop {
                ticks.tick().await;
                let Some(this) = weak.upgrade() else { break };
                let threads: Vec<ThreadId> = this.manager.lock().unwrap().rooms().keys().cloned().collect();
                for thread in threads {
                    if let Err(error) = this.retire_stale(&thread).await {
                        tracing::warn!(%thread, %error, "retire stale seats failed");
                    }
                }
            }
        });
    }

    /// Drop the sessions of seats idle beyond the threshold in one room.
    pub async fn retire_stale(&self, thread: &ThreadId) -> Result<()> {
        let host = self.host()?;
        let Some(thread) = host.state().thread(thread) else { return Ok(()) };
        let lock = self.room_lock(&thread.id);
        let _guard = lock.lock().await;
        let intents = self.manage(|m| m.retire_stale(&thread.id, now()));
        if intents.is_empty() {
            return Ok(());
        }
        self.execute(&thread, intents, false).await
    }

    /// Bookkeeping for one session event. Only seats the manager knows
    /// count; a plain chat's session is not a room's business.
    fn on_event(self: &Arc<Self>, event: SessionEvent) {
        let key = event.key;
        let seat = self
            .manager
            .lock()
            .unwrap()
            .room_ref(&key.thread_id)
            .and_then(|room| room.find_participant(&key.participant_id).cloned());
        let Some(seat) = seat else { return };
        match event.event {
            EngineEvent::SessionReady { native_session_id } => {
                self.manage(|m| m.session_ready(&key.thread_id, &key.participant_id, native_session_id));
                self.sync_room_row(&key.thread_id);
            }
            EngineEvent::Status { busy: true } => {
                self.tracking.lock().unwrap().running.insert(key);
            }
            EngineEvent::Error { fatal: true, .. } => {
                // The run is over but nothing finished; nobody is handed the work.
                self.tracking.lock().unwrap().running.remove(&key);
                self.settled.notify_waiters();
            }
            EngineEvent::Status { busy: false } => {
                let (was_running, in_broadcast) = {
                    let mut tracking = self.tracking.lock().unwrap();
                    (tracking.running.remove(&key), tracking.broadcast.remove(&key))
                };
                self.settled.notify_waiters();
                if !was_running || seat.state != ParticipantState::Working {
                    return;
                }
                if in_broadcast {
                    self.manage(|m| {
                        m.touch(&key.thread_id, &key.participant_id, Some(ParticipantState::Active), now());
                    });
                    return;
                }
                let this = self.clone();
                self.handle.spawn(async move { this.finish(key).await });
            }
            EngineEvent::Closed => {
                let intended = {
                    let mut tracking = self.tracking.lock().unwrap();
                    tracking.running.remove(&key);
                    tracking.broadcast.remove(&key);
                    tracking.closing.remove(&key)
                };
                self.settled.notify_waiters();
                if !intended && seat.state != ParticipantState::Done {
                    // The process went away on its own. The seat stays
                    // listed; addressing it starts a fresh session.
                    self.manage(|m| {
                        m.touch(&key.thread_id, &key.participant_id, Some(ParticipantState::Stale), now());
                    });
                    self.sync_room_row(&key.thread_id);
                }
            }
            _ => {}
        }
    }

    /// A participant's run settled outside a broadcast: hand over to the
    /// next role under the room's shape, if there is one.
    async fn finish(self: Arc<Self>, key: SessionKey) {
        let Ok(host) = self.host() else { return };
        let Some(thread) = host.state().thread(&key.thread_id) else { return };
        let lock = self.room_lock(&thread.id);
        let _guard = lock.lock().await;
        let messages: Vec<Message> = host
            .load_messages(&thread.id)
            .into_iter()
            .filter(|m| m.role != Role::System)
            .collect();
        let label = host.user_label();
        let ctx = RoomContext { cwd: &thread.cwd, messages: &messages, user_label: &label, now: now() };
        let intents = self.manage(|m| m.finish(&thread.id, &key.participant_id, ctx));
        if let Err(error) = self.execute(&thread, intents, false).await {
            tracing::warn!(thread = %thread.id, %error, "handover failed");
        }
    }

    // ---- plumbing ------------------------------------------------------

    fn host(&self) -> Result<Arc<dyn RoomHost>> {
        self.host.upgrade().ok_or_else(|| anyhow!("BOSS is shutting down."))
    }

    fn room_lock(&self, thread: &ThreadId) -> Arc<tokio::sync::Mutex<()>> {
        self.locks.lock().unwrap().entry(thread.clone()).or_default().clone()
    }

    /// Change the manager and write it out.
    fn manage<T>(&self, edit: impl FnOnce(&mut RoomManager) -> T) -> T {
        let mut manager = self.manager.lock().unwrap();
        let out = edit(&mut manager);
        self.save(&manager);
        out
    }

    fn persist(&self) {
        self.save(&self.manager.lock().unwrap());
    }

    fn save(&self, manager: &RoomManager) {
        let (team, rooms) = manager.clone().into_parts();
        if let Err(error) = self.file.save(&StoredRooms { team, rooms }) {
            tracing::warn!(%error, "save rooms failed");
        }
    }

    /// A team from the default engine, for a user who never opened setup.
    fn ensure_team(&self, host: &Arc<dyn RoomHost>) {
        if self.manager.lock().unwrap().team().is_some() {
            return;
        }
        let engine = host.default_engine();
        tracing::info!(?engine, "no team configured; using the suggested roles");
        self.manage(|m| {
            m.configure_team(RoomTeam {
                roles: suggested_roles(&[engine]),
                ask_shape: true,
                default_shape: RoomShape::Reviewed,
            });
        });
    }

    /// Write the contract `Room` row for a thread from the manager's state.
    /// The row needs a shape; until the user chooses one it carries the
    /// team's default.
    fn sync_room_row(&self, thread: &ThreadId) {
        let Ok(host) = self.host() else { return };
        let Some(entry) = host.state().thread(thread) else { return };
        let ThreadKind::Room { room_id } = &entry.kind else { return };
        let (shape, participants) = {
            let manager = self.manager.lock().unwrap();
            let room = manager.room(thread);
            let shape = room
                .shape
                .or_else(|| manager.team().map(|team| team.default_shape))
                .unwrap_or(RoomShape::Reviewed);
            let mut participants: Vec<Participant> =
                room.participants.iter().map(|seat| seat.participant.clone()).collect();
            if !participants.iter().any(|p| p.is_boss) {
                participants.insert(0, self.boss_seat_of(&manager, &room));
            }
            (shape, participants)
        };
        let row = Room { id: room_id.clone(), thread_id: thread.clone(), shape, participants };
        if let Err(error) = host.state().upsert_room(row) {
            tracing::warn!(%thread, %error, "save room row failed");
        }
    }
}

/// A user turn as a stored message.
pub fn user_message(thread: &ThreadId, recipient: Option<ParticipantId>, prompt: &Prompt) -> Message {
    let mut message = Message::new(thread.clone(), Role::User);
    message.status = MessageStatus::Complete;
    message.recipient = recipient;
    message.parts.push(Part::Text(TextPart { id: PartId::new(), text: prompt.text.clone() }));
    message.parts.extend(prompt.attachments.iter().map(|a| {
        Part::Attachment(AttachmentPart {
            id: PartId::new(),
            mime: a.mime.clone(),
            source: a.path.display().to_string(),
            name: a.path.file_name().map(|n| n.to_string_lossy().into_owned()),
        })
    }));
    message
}

/// The prompt a stored user message carries.
fn prompt_of(message: &Message) -> Prompt {
    Prompt {
        text: message.text(),
        attachments: message
            .parts
            .iter()
            .filter_map(|part| match part {
                Part::Attachment(a) => {
                    Some(Attachment { mime: a.mime.clone(), path: PathBuf::from(&a.source) })
                }
                _ => None,
            })
            .collect(),
    }
}

/// Show a stored message in the UI by replaying it as engine events.
/// Used for user turns that did not come from the desktop composer
/// (rooms, the phone) and for system lines.
pub fn show_message(host: &dyn RoomHost, message: &Message) {
    let author = match message.role {
        Role::User => ROOM_USER_ID,
        _ => SYSTEM_AUTHOR,
    };
    let key = session_key(&message.thread_id, &ParticipantId::from(author));
    host.inject_event(
        key.clone(),
        EngineEvent::MessageStarted { message_id: message.id.clone(), role: message.role },
    );
    for part in &message.parts {
        if let Part::Text(text) = part {
            host.inject_event(
                key.clone(),
                EngineEvent::TextDelta {
                    message_id: message.id.clone(),
                    part_id: text.id.clone(),
                    delta: text.text.clone(),
                },
            );
        }
    }
    host.inject_event(
        key,
        EngineEvent::MessageCompleted { message_id: message.id.clone(), usage: None, model: None },
    );
}

fn session_key(thread: &ThreadId, participant: &ParticipantId) -> SessionKey {
    SessionKey { thread_id: thread.clone(), participant_id: participant.clone() }
}

fn now() -> OffsetDateTime {
    OffsetDateTime::now_utc()
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_channel::{Receiver, Sender};
    use boss_core::rooms::{HANDOVER_PROMPT, RoomRole, coordinator_allowed_tools};
    use boss_core::store::TranscriptStore;

    /// What the fake engine saw: every session start and every prompt.
    #[derive(Default)]
    struct Recorder {
        starts: Mutex<Vec<SessionOptions>>,
        prompts: Mutex<Vec<(ParticipantId, String)>>,
    }

    impl Recorder {
        fn starts(&self) -> Vec<SessionOptions> {
            self.starts.lock().unwrap().clone()
        }
        fn prompts(&self) -> Vec<(ParticipantId, String)> {
            self.prompts.lock().unwrap().clone()
        }
        fn prompts_to(&self, who: &str) -> Vec<String> {
            self.prompts()
                .into_iter()
                .filter(|(id, _)| id.as_str() == who)
                .map(|(_, text)| text)
                .collect()
        }
        fn start_for(&self, who: &str) -> Option<SessionOptions> {
            self.starts().into_iter().find(|o| o.participant_id.as_str() == who)
        }
    }

    /// Echoes each prompt back as one assistant message, busy around it.
    struct FakeSession {
        id: EngineId,
        participant: ParticipantId,
        recorder: Arc<Recorder>,
        tx: Sender<EngineEvent>,
        rx: Receiver<EngineEvent>,
    }

    #[async_trait]
    impl Session for FakeSession {
        fn engine(&self) -> EngineId {
            self.id
        }
        fn native_session_id(&self) -> Option<String> {
            Some(format!("native-{}", self.participant))
        }
        fn events(&self) -> Receiver<EngineEvent> {
            self.rx.clone()
        }
        async fn send(&self, prompt: Prompt) -> Result<()> {
            self.recorder.prompts.lock().unwrap().push((self.participant.clone(), prompt.text.clone()));
            let message_id = MessageId::new();
            let tx = &self.tx;
            tx.send(EngineEvent::Status { busy: true }).await?;
            tx.send(EngineEvent::MessageStarted { message_id: message_id.clone(), role: Role::Assistant }).await?;
            tx.send(EngineEvent::TextDelta { message_id: message_id.clone(), part_id: PartId::new(), delta: prompt.text })
                .await?;
            tx.send(EngineEvent::MessageCompleted { message_id, usage: None, model: None }).await?;
            tx.send(EngineEvent::Status { busy: false }).await?;
            Ok(())
        }
        async fn interrupt(&self) -> Result<()> {
            Ok(())
        }
        async fn respond_permission(&self, _: RequestId, _: PermissionDecision) -> Result<()> {
            Ok(())
        }
        async fn set_model(&self, _: String) -> Result<()> {
            Ok(())
        }
        async fn set_permission_mode(&self, _: PermissionMode) -> Result<()> {
            Ok(())
        }
        async fn close(&self) -> Result<()> {
            self.tx.send(EngineEvent::Closed).await?;
            Ok(())
        }
    }

    struct FakeEngine {
        id: EngineId,
        recorder: Arc<Recorder>,
    }

    #[async_trait]
    impl Engine for FakeEngine {
        fn id(&self) -> EngineId {
            self.id
        }
        fn executable(&self) -> Option<PathBuf> {
            None
        }
        async fn probe(&self) -> Result<EngineProbe> {
            Ok(EngineProbe { installed: true, ..Default::default() })
        }
        async fn list_models(&self) -> Result<Vec<ModelInfo>> {
            Ok(vec![])
        }
        async fn start_session(&self, opts: SessionOptions) -> Result<Box<dyn Session>> {
            self.recorder.starts.lock().unwrap().push(opts.clone());
            let (tx, rx) = async_channel::unbounded();
            let session = FakeSession {
                id: self.id,
                participant: opts.participant_id,
                recorder: self.recorder.clone(),
                tx: tx.clone(),
                rx,
            };
            tx.send(EngineEvent::SessionReady { native_session_id: session.native_session_id().unwrap() })
                .await?;
            Ok(Box::new(session))
        }
    }

    /// The runtime, minus engines and the bus: real session manager, real
    /// stores, and a tap that replays injected events like the pump does.
    struct FakeHost {
        sessions: Arc<SessionManager>,
        state: Arc<StateStore>,
        transcripts: TranscriptStore,
        taps: broadcast::Sender<SessionEvent>,
        injected: Mutex<Vec<SessionEvent>>,
        plain: Mutex<Vec<(ThreadId, ParticipantId, String)>>,
    }

    impl FakeHost {
        fn new(dir: &Path, recorder: &Arc<Recorder>) -> Arc<Self> {
            let engines: Vec<Arc<dyn Engine>> = [EngineId::Claude, EngineId::Codex]
                .into_iter()
                .map(|id| Arc::new(FakeEngine { id, recorder: recorder.clone() }) as Arc<dyn Engine>)
                .collect();
            let sessions = SessionManager::new(engines, tokio::runtime::Handle::current());
            let (taps, _) = broadcast::channel(1024);
            let source = sessions.events();
            let pump = taps.clone();
            tokio::spawn(async move {
                while let Ok(event) = source.recv().await {
                    let _ = pump.send(event);
                }
            });
            Arc::new(Self {
                sessions,
                state: Arc::new(StateStore::open(Some(dir)).unwrap()),
                transcripts: TranscriptStore::open_in_memory().unwrap(),
                taps,
                injected: Mutex::new(Vec::new()),
                plain: Mutex::new(Vec::new()),
            })
        }

        fn injected(&self) -> Vec<SessionEvent> {
            self.injected.lock().unwrap().clone()
        }
    }

    #[async_trait]
    impl RoomHost for FakeHost {
        fn sessions(&self) -> Arc<SessionManager> {
            self.sessions.clone()
        }
        fn state(&self) -> Arc<StateStore> {
            self.state.clone()
        }
        fn bus_access(&self, thread: &ThreadId, participant: &ParticipantId) -> Option<BusAccess> {
            Some(BusAccess {
                url: "http://127.0.0.1:1/mcp".into(),
                token: "tok".into(),
                thread_id: thread.clone(),
                participant_id: participant.clone(),
            })
        }
        fn default_engine(&self) -> EngineId {
            EngineId::Claude
        }
        fn load_messages(&self, thread: &ThreadId) -> Vec<Message> {
            self.transcripts.messages_for_thread(thread).unwrap()
        }
        fn persist_message(&self, message: Message) {
            self.transcripts.upsert_message(&message).unwrap();
        }
        fn inject_event(&self, key: SessionKey, event: EngineEvent) {
            let event = SessionEvent { key, event };
            self.injected.lock().unwrap().push(event.clone());
            let _ = self.taps.send(event);
        }
        fn subscribe(&self) -> broadcast::Receiver<SessionEvent> {
            self.taps.subscribe()
        }
        fn primary_participant(&self, thread: &Thread) -> Result<Participant> {
            let ThreadKind::Chat { engine } = &thread.kind else { bail!("not a chat") };
            Ok(Participant {
                id: ParticipantId::from("agent"),
                name: engine.label().to_owned(),
                engine: *engine,
                model: None,
                is_boss: false,
                native_session_id: None,
            })
        }
        async fn send(&self, thread: &Thread, participant: &Participant, prompt: Prompt) -> Result<()> {
            self.plain.lock().unwrap().push((thread.id.clone(), participant.id.clone(), prompt.text));
            Ok(())
        }
    }

    struct Harness {
        host: Arc<FakeHost>,
        rooms: Arc<RoomCoordinator>,
        recorder: Arc<Recorder>,
        project: Project,
        dir: tempfile::TempDir,
    }

    async fn harness() -> Harness {
        let dir = tempfile::tempdir().unwrap();
        let recorder = Arc::new(Recorder::default());
        let host = FakeHost::new(dir.path(), &recorder);
        let weak: Weak<FakeHost> = Arc::downgrade(&host);
        let weak: Weak<dyn RoomHost> = weak;
        let rooms = RoomCoordinator::start(weak, dir.path(), tokio::runtime::Handle::current()).unwrap();
        let project = host.state.add_project(dir.path().join("repo"), Some("repo".into())).unwrap();
        Harness { host, rooms, recorder, project, dir }
    }

    /// BOSS and the reviewer on Claude, the builder on Codex.
    fn team() -> RoomTeam {
        RoomTeam {
            roles: vec![
                RoomRole::new("boss", "BOSS", EngineId::Claude, Some(PermissionMode::Plan)),
                RoomRole::new("builder", "Builder", EngineId::Codex, Some(PermissionMode::Bypass)),
                RoomRole::new("reviewer", "Reviewer", EngineId::Claude, Some(PermissionMode::Plan)),
            ],
            ask_shape: true,
            default_shape: RoomShape::Reviewed,
        }
    }

    fn prompt(text: &str) -> Prompt {
        Prompt { text: text.to_owned(), attachments: Vec::new() }
    }

    async fn wait_for(what: &str, check: impl Fn() -> bool) {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        while !check() {
            assert!(tokio::time::Instant::now() < deadline, "timed out waiting for {what}");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    #[tokio::test]
    async fn the_first_message_into_a_direct_room_starts_the_builder_with_bus_cwd_and_brief() {
        let h = harness().await;
        h.rooms.configure_team(team());
        let thread = h.rooms.open_room(&h.project, Some(RoomShape::Direct), None).unwrap();
        assert_eq!(h.rooms.room(&thread.id).recipient, thread_agent_id());
        assert_eq!(
            h.rooms.participants_for(&thread.id).iter().map(|p| p.id.as_str()).collect::<Vec<_>>(),
            vec!["boss"],
            "a room opens with the user and BOSS"
        );

        h.rooms.send_user_message(&thread.id, None, prompt("fix the bug")).await.unwrap();

        let starts = h.recorder.starts();
        assert_eq!(starts.len(), 1, "one session for the builder");
        let opts = &starts[0];
        assert_eq!(opts.participant_id.as_str(), "builder");
        assert_eq!(opts.thread_id, thread.id);
        assert_eq!(opts.cwd, h.project.root);
        assert_eq!(opts.permission_mode, PermissionMode::Bypass);
        let bus = opts.bus.as_ref().expect("bus access filled in");
        assert_eq!(bus.thread_id, thread.id);
        assert_eq!(bus.participant_id.as_str(), "builder");
        assert!(opts.system_prompt.is_none(), "a role keeps the engine's own prompt");
        assert!(opts.append_system_prompt.as_deref().unwrap_or("").contains("You are the builder"));
        assert_eq!(h.recorder.prompts_to("builder"), vec!["fix the bug".to_owned()]);

        let row = h.host.state.room_for_thread(&thread.id).expect("room row");
        assert_eq!(row.shape, RoomShape::Direct);
        assert_eq!(row.participants.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(), vec!["boss", "builder"]);
        assert_eq!(h.rooms.room(&thread.id).recipient.as_str(), "builder", "the chip follows the opener");
    }

    #[tokio::test]
    async fn boss_runs_as_the_coordinator_with_its_brief_and_only_bus_tools() {
        let h = harness().await;
        let thread = h.rooms.open_room(&h.project, None, Some("Ask".into())).unwrap();
        assert_eq!(h.rooms.room(&thread.id).recipient, assistant_id(), "no shape: BOSS asks");
        assert!(h.rooms.team().is_some(), "a team is suggested when none was set up");

        h.rooms.send_user_message(&thread.id, None, prompt("what is this repo?")).await.unwrap();

        let opts = h.recorder.start_for("boss").expect("BOSS started");
        assert_eq!(opts.thread_id, thread.id);
        assert_eq!(opts.permission_mode, PermissionMode::Plan);
        assert_eq!(opts.allowed_tools, Some(coordinator_allowed_tools()));
        assert!(opts.append_system_prompt.is_none());
        assert!(opts.system_prompt.as_deref().unwrap_or("").contains("You coordinate this room"));
        assert!(opts.bus.is_some());
        assert_eq!(h.recorder.prompts_to("boss"), vec!["what is this repo?".to_owned()]);
        let boss = h.rooms.boss_seat(&thread.id);
        assert!(boss.is_boss);
        assert_eq!(boss.engine, EngineId::Claude);
    }

    #[tokio::test]
    async fn a_finished_builder_in_a_reviewed_room_brings_in_the_reviewer() {
        let h = harness().await;
        h.rooms.configure_team(team());
        let thread = h.rooms.open_room(&h.project, Some(RoomShape::Reviewed), None).unwrap();
        h.rooms.send_user_message(&thread.id, None, prompt("add a search box")).await.unwrap();

        let recorder = h.recorder.clone();
        wait_for("the reviewer to be asked", || !recorder.prompts_to("reviewer").is_empty()).await;

        let reviewer = h.recorder.start_for("reviewer").expect("reviewer started");
        assert_eq!(reviewer.permission_mode, PermissionMode::Plan);
        assert!(reviewer.append_system_prompt.as_deref().unwrap_or("").contains("You are the reviewer"));
        let handover = &h.recorder.prompts_to("reviewer")[0];
        assert!(handover.ends_with(HANDOVER_PROMPT), "handover: {handover}");
        assert!(handover.contains("User (to builder): add a search box"), "catches up on the room: {handover}");
        assert!(!handover.contains("Builder joined"), "system lines are machinery, not speech");
        let builder = h.recorder.start_for("builder").unwrap();
        assert_eq!(h.recorder.starts().len(), 2);
        assert_ne!(builder.participant_id, reviewer.participant_id);

        let room = h.rooms.room(&thread.id);
        assert_eq!(room.find_participant(&ParticipantId::from("builder")).unwrap().state, ParticipantState::Active);
        assert_eq!(
            room.find_participant(&ParticipantId::from("builder")).unwrap().participant.native_session_id.as_deref(),
            Some("native-builder"),
            "session ids are recorded from SessionReady"
        );
        let row = h.host.state.room_for_thread(&thread.id).unwrap();
        assert_eq!(row.participants.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(), vec!["boss", "builder", "reviewer"]);
    }

    #[tokio::test]
    async fn joining_is_a_system_line_in_the_transcript_and_on_screen() {
        let h = harness().await;
        h.rooms.configure_team(team());
        let thread = h.rooms.open_room(&h.project, Some(RoomShape::Direct), None).unwrap();
        let user = h.rooms.send_user_message(&thread.id, None, prompt("go")).await.unwrap();

        let stored = h.host.load_messages(&thread.id);
        let system: Vec<&Message> = stored.iter().filter(|m| m.role == Role::System).collect();
        assert_eq!(system.len(), 1);
        assert_eq!(system[0].text(), "Builder joined");
        assert_eq!(system[0].status, MessageStatus::Complete);
        let recorded = stored.iter().find(|m| m.id == user).expect("user turn stored");
        assert_eq!(recorded.role, Role::User);
        assert_eq!(recorded.recipient.as_ref().map(ParticipantId::as_str), Some("builder"), "stored with who answered");

        let injected = h.host.injected();
        let started: Vec<&SessionEvent> = injected
            .iter()
            .filter(|e| matches!(e.event, EngineEvent::MessageStarted { role: Role::System, .. }))
            .collect();
        assert_eq!(started.len(), 1);
        assert_eq!(started[0].key.participant_id.as_str(), SYSTEM_AUTHOR);
        assert!(injected.iter().any(|e| matches!(
            &e.event,
            EngineEvent::TextDelta { delta, .. } if delta == "Builder joined"
        )));
        assert!(
            injected.iter().any(|e| matches!(e.event, EngineEvent::MessageStarted { role: Role::User, .. })),
            "the user's own turn is shown through the same pump"
        );
    }

    #[tokio::test]
    async fn a_broadcast_reaches_everyone_and_advances_nobody() {
        let h = harness().await;
        h.rooms.configure_team(team());
        let thread = h.rooms.open_room(&h.project, Some(RoomShape::Reviewed), None).unwrap();
        h.rooms.send_user_message(&thread.id, None, prompt("build it")).await.unwrap();
        let recorder = h.recorder.clone();
        wait_for("the reviewer to join", || !recorder.prompts_to("reviewer").is_empty()).await;
        wait_for("the reviewer to settle", || {
            h.rooms.room(&thread.id).find_participant(&ParticipantId::from("reviewer")).unwrap().state
                == ParticipantState::Active
        })
        .await;

        h.rooms
            .send_user_message(&thread.id, Some(ParticipantId::from("everyone")), prompt("status?"))
            .await
            .unwrap();

        assert_eq!(h.recorder.prompts_to("builder").last().unwrap(), "status?");
        assert!(h.recorder.prompts_to("reviewer").last().unwrap().ends_with("status?"));
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(h.recorder.starts().len(), 2, "nobody new was brought in");
        let room = h.rooms.room(&thread.id);
        for id in ["builder", "reviewer"] {
            assert_eq!(room.find_participant(&ParticipantId::from(id)).unwrap().state, ParticipantState::Active);
        }
        assert_eq!(room.recipient.as_str(), "everyone", "the chip stays where the user left it");
    }

    #[tokio::test]
    async fn a_restart_replaces_seats_rather_than_resuming_them() {
        let h = harness().await;
        h.rooms.configure_team(team());
        let thread = h.rooms.open_room(&h.project, Some(RoomShape::Direct), None).unwrap();
        h.rooms.send_user_message(&thread.id, None, prompt("first")).await.unwrap();
        let recorder = h.recorder.clone();
        wait_for("the builder's session id", || {
            recorder.starts().len() == 1
                && h.rooms.room(&thread.id).find_participant(&ParticipantId::from("builder")).unwrap()
                    .participant.native_session_id.is_some()
        })
        .await;
        drop(h.rooms);

        let weak: Weak<FakeHost> = Arc::downgrade(&h.host);
        let weak: Weak<dyn RoomHost> = weak;
        let rooms = RoomCoordinator::start(weak, h.dir.path(), tokio::runtime::Handle::current()).unwrap();
        let room = rooms.room(&thread.id);
        assert_eq!(room.shape, Some(RoomShape::Direct));
        let builder = room.find_participant(&ParticipantId::from("builder")).unwrap();
        assert_eq!(builder.state, ParticipantState::Stale);
        assert_eq!(builder.participant.native_session_id, None);
        assert!(rooms.team().is_some());

        rooms.send_user_message(&thread.id, Some(ParticipantId::from("builder")), prompt("again")).await.unwrap();
        let starts = h.recorder.starts();
        assert_eq!(starts.len(), 2, "a fresh session, never a resume");
        assert_eq!(starts[1].resume, None);
        assert_eq!(h.recorder.prompts_to("builder").len(), 2);
    }

    #[tokio::test]
    async fn a_plain_chat_goes_to_its_own_agent() {
        let h = harness().await;
        let now = now();
        let chat = Thread {
            id: ThreadId::new(),
            project_id: h.project.id.clone(),
            title: "chat".into(),
            kind: ThreadKind::Chat { engine: EngineId::Codex },
            created_at: now,
            updated_at: now,
            cwd: h.project.root.clone(),
            archived: false,
        };
        h.host.state.upsert_thread(chat.clone()).unwrap();
        h.rooms.send_user_message(&chat.id, None, prompt("hello")).await.unwrap();
        assert_eq!(h.host.plain.lock().unwrap().as_slice(), &[(chat.id.clone(), ParticipantId::from("agent"), "hello".to_owned())]);
        assert!(h.recorder.starts().is_empty(), "the room machinery stays out of it");
        assert_eq!(h.host.load_messages(&chat.id).len(), 1, "the user turn is still recorded");
    }
}
