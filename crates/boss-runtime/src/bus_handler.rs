//! Serves the thread tools to agents. Port of the tool half of
//! `src/main/thread-bus.ts`: peer fences, durable inter-thread messages,
//! and delegation of browser, computer, and MCP tools.

use crate::runtime::Runtime;
use crate::worktree::Worktrees;
use anyhow::{Result, anyhow, bail};
use async_trait::async_trait;
use boss_core::store::JsonFile;
use boss_core::*;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock, Weak};

const MAX_BODY: usize = 20_000;
const MAX_QUEUE_PER_THREAD: usize = 8;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum DeliveryStatus {
    Queued,
    Delivered,
    Failed,
}

/// A message one thread sent another. Durable: survives restarts.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BusMessage {
    pub id: String,
    pub root_id: String,
    pub from: ThreadId,
    pub to: ThreadId,
    pub body: String,
    pub created_at: i64,
    pub status: DeliveryStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reply_to: Option<String>,
    pub expects_reply: bool,
    pub hop_count: u32,
    pub max_turns: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Small string map persisted as JSON (native session ids).
pub struct KeyValueFile {
    file: JsonFile,
    map: Mutex<HashMap<String, String>>,
}

impl KeyValueFile {
    fn open(dir: &Path, name: &str) -> Result<Self> {
        let file = JsonFile::in_dir(Some(dir), name);
        let map = file.load_or_default::<HashMap<String, String>>()?;
        Ok(Self { file, map: Mutex::new(map) })
    }
    pub fn get(&self, key: &str) -> Option<String> {
        self.map.lock().unwrap().get(key).cloned()
    }
    pub fn set(&self, key: &str, value: String) {
        let mut map = self.map.lock().unwrap();
        map.insert(key.to_owned(), value);
        let _ = self.file.save(&*map);
    }
}

/// Opens a room thread for `boss_rooms_open`.
///
/// A trait rather than a call into the room coordinator, because the bus
/// handler is built before the coordinator exists and must not depend on the
/// app's wiring to compile or be tested.
#[async_trait]
pub trait RoomOpener: Send + Sync {
    /// Start a room in `project` with `shape`, titled `title`, and return
    /// its thread.
    async fn open_room(&self, project: &Project, shape: RoomShape, title: &str) -> Result<Thread>;
}

pub struct RuntimeBusHandler {
    runtime: OnceLock<Weak<Runtime>>,
    messages: Mutex<Vec<BusMessage>>,
    messages_file: JsonFile,
    delivery_locks: Mutex<HashSet<ThreadId>>,
    native_sessions: KeyValueFile,
    /// Browser and computer tools, provided by the app once the UI exists.
    qa: Mutex<Option<std::sync::Arc<dyn BusHandler>>>,
    /// Git worktrees for the worktree tools.
    worktrees: Worktrees,
    /// Room opener, provided by the app once rooms are wired.
    rooms: OnceLock<std::sync::Arc<dyn RoomOpener>>,
}

impl RuntimeBusHandler {
    pub fn new(data_dir: PathBuf) -> Result<Self> {
        let messages_file = JsonFile::in_dir(Some(&data_dir), "bus-messages.json");
        let messages = messages_file.load_or_default::<Vec<BusMessage>>()?;
        Ok(Self {
            runtime: OnceLock::new(),
            messages: Mutex::new(messages),
            messages_file,
            delivery_locks: Mutex::new(HashSet::new()),
            native_sessions: KeyValueFile::open(&data_dir, "native-sessions.json")?,
            qa: Mutex::new(None),
            // Beside the rest of this instance's data, so a test data dir
            // does not put checkouts in the real one.
            worktrees: Worktrees::with_root(data_dir.join("worktrees")),
            rooms: OnceLock::new(),
        })
    }

    /// The app sets this once the room coordinator exists.
    pub fn set_room_opener(&self, opener: std::sync::Arc<dyn RoomOpener>) {
        let _ = self.rooms.set(opener);
    }

    pub(crate) fn attach(&self, runtime: Weak<Runtime>) {
        let _ = self.runtime.set(runtime);
    }

    /// The app sets this once browser/computer tools exist.
    pub fn set_qa_handler(&self, qa: std::sync::Arc<dyn BusHandler>) {
        *self.qa.lock().unwrap() = Some(qa);
    }

    pub fn native_sessions(&self) -> &KeyValueFile {
        &self.native_sessions
    }

    fn runtime(&self) -> Result<std::sync::Arc<Runtime>> {
        self.runtime.get().and_then(|w| w.upgrade()).ok_or_else(|| anyhow!("BOSS is shutting down."))
    }

    fn save_messages(&self) {
        let msgs = self.messages.lock().unwrap();
        let _ = self.messages_file.save(&*msgs);
    }

    fn require_peer(&self, rt: &Runtime, caller: &Thread, target_id: &str) -> Result<Thread> {
        if target_id.is_empty() {
            bail!("A target thread id is required.");
        }
        if caller.id.as_str() == target_id {
            bail!("Choose a different thread.");
        }
        let target = rt.state.thread(&ThreadId::from(target_id)).ok_or_else(|| anyhow!("Target thread not found."))?;
        if caller.kind == ThreadKind::Assistant {
            return Ok(target);
        }
        if caller.project_id != target.project_id {
            bail!("Agent communication is limited to threads in the same project.");
        }
        if let (ThreadKind::Chat { engine: a }, ThreadKind::Chat { engine: b }) = (&caller.kind, &target.kind) {
            if a != b {
                bail!("Agent communication is limited to threads on the same backend.");
            }
        }
        Ok(target)
    }

    /// The project a thread belongs to.
    fn project_of(&self, rt: &Runtime, thread: &Thread) -> Result<Project> {
        rt.state
            .project(&thread.project_id)
            .ok_or_else(|| anyhow!("Projectless chats cannot use Git worktrees."))
    }

    /// Where a spawned thread or room goes: the caller's project, or the one
    /// it named.
    ///
    /// Only among projects the user opened. Accepting an arbitrary path would
    /// let a thread widen its own filesystem scope to a folder the user never
    /// put in BOSS.
    fn target_project(&self, rt: &Runtime, caller: &Thread, requested: &str) -> Result<Project> {
        let requested = requested.trim();
        if requested.is_empty() {
            return self.project_of(rt, caller);
        }
        let known = rt.state.projects();
        let path = Path::new(requested);
        if path.is_absolute() {
            let target = normalize(path);
            if let Some(found) = known.iter().find(|p| normalize(&p.root) == target) {
                return Ok(found.clone());
            }
        }
        let wanted = requested.to_lowercase();
        let matches: Vec<&Project> = known
            .iter()
            .filter(|p| {
                p.root.file_name().map(|n| n.to_string_lossy().to_lowercase()) == Some(wanted.clone())
            })
            .collect();
        match matches.len() {
            1 => Ok(matches[0].clone()),
            0 => {
                let available: Vec<String> =
                    known.iter().map(|p| p.root.file_name().unwrap_or_default().to_string_lossy().into_owned()).collect();
                let available = if available.is_empty() { "none".to_owned() } else { available.join(", ") };
                bail!("Project {requested} is not open in BOSS. Available projects: {available}.")
            }
            _ => {
                let paths: Vec<String> = matches.iter().map(|p| p.root.display().to_string()).collect();
                bail!("Project name {requested} is ambiguous. Use one of these full paths: {}.", paths.join(", "))
            }
        }
    }

    fn prompt(&self, rt: &Runtime, m: &BusMessage) -> String {
        let source = rt.state.thread(&m.from).map(|t| t.title).unwrap_or_else(|| m.from.to_string());
        let tail = if m.expects_reply {
            "A reply was requested. Use boss_threads_reply with this message id; do not simulate a reply in another thread."
        } else {
            "No reply is required. Reply only if it materially helps the sending thread."
        };
        format!(
            "[BOSS THREAD MESSAGE]\n\nFrom: {source} ({})\n\nMessage id: {}\n\nConversation turn: {} of {}\n\n{}\n\n{tail}",
            m.from, m.id, m.hop_count + 1, m.max_turns, m.body
        )
    }

    async fn deliver(&self, rt: &Runtime, id: &str) {
        let m = match self.messages.lock().unwrap().iter().find(|m| m.id == id).cloned() {
            Some(m) => m,
            None => return,
        };
        self.delivery_locks.lock().unwrap().insert(m.to.clone());
        let result: Result<()> = async {
            let thread = rt.state.thread(&m.to).ok_or_else(|| anyhow!("Target thread not found."))?;
            let participant = rt.primary_participant(&thread)?;
            rt.send(&thread, &participant, Prompt { text: self.prompt(rt, &m), attachments: vec![] }).await?;
            Ok(())
        }
        .await;
        {
            let mut msgs = self.messages.lock().unwrap();
            if let Some(stored) = msgs.iter_mut().find(|x| x.id == id) {
                match result {
                    Ok(()) => {
                        stored.status = DeliveryStatus::Delivered;
                        stored.error = None;
                    }
                    Err(e) => {
                        stored.status = DeliveryStatus::Failed;
                        stored.error = Some(e.to_string());
                        self.delivery_locks.lock().unwrap().remove(&m.to);
                    }
                }
            }
        }
        self.save_messages();
    }

    /// Called when a thread goes idle: deliver the next queued message.
    pub async fn flush(&self, thread: &ThreadId) {
        self.delivery_locks.lock().unwrap().remove(thread);
        let Ok(rt) = self.runtime() else { return };
        if rt.is_busy(thread) {
            return;
        }
        let next = self
            .messages
            .lock()
            .unwrap()
            .iter()
            .find(|m| &m.to == thread && m.status == DeliveryStatus::Queued)
            .map(|m| m.id.clone());
        if let Some(id) = next {
            self.deliver(&rt, &id).await;
        }
    }

    async fn send(
        &self,
        rt: &Runtime,
        caller: &Thread,
        target_id: &str,
        body: &str,
        expects_reply: bool,
        max_turns: u32,
        reply_to: Option<&BusMessage>,
    ) -> Result<Value> {
        let target = self.require_peer(rt, caller, target_id)?;
        if body.is_empty() {
            bail!("A message is required.");
        }
        if body.len() > MAX_BODY {
            bail!("Messages are limited to {MAX_BODY} characters.");
        }
        let id = uuid::Uuid::new_v4().to_string();
        let m = BusMessage {
            id: id.clone(),
            root_id: reply_to.map(|r| r.root_id.clone()).unwrap_or_else(|| id.clone()),
            from: caller.id.clone(),
            to: target.id.clone(),
            body: body.to_owned(),
            created_at: <time::OffsetDateTime as OffsetDateTimeExt>::now_ms(),
            status: DeliveryStatus::Queued,
            reply_to: reply_to.map(|r| r.id.clone()),
            expects_reply,
            hop_count: reply_to.map(|r| r.hop_count + 1).unwrap_or(0),
            max_turns: max_turns.clamp(1, 8),
        error: None,
        };
        {
            let mut msgs = self.messages.lock().unwrap();
            let queued = msgs.iter().filter(|x| x.to == target.id && x.status == DeliveryStatus::Queued).count();
            if queued >= MAX_QUEUE_PER_THREAD {
                bail!("The target thread queue is full.");
            }
            msgs.push(m.clone());
        }
        self.save_messages();
        let locked = self.delivery_locks.lock().unwrap().contains(&target.id);
        if !rt.is_busy(&target.id) && !locked {
            self.deliver(rt, &id).await;
        }
        let stored = self.messages.lock().unwrap().iter().find(|x| x.id == id).cloned().unwrap_or(m);
        Ok(serde_json::to_value(stored)?)
    }

    async fn call(&self, caller: &BusCaller, name: &str, args: Value) -> Result<Value> {
        let rt = self.runtime()?;
        let thread = rt.state.thread(&caller.thread_id).ok_or_else(|| anyhow!("BOSS could not identify the calling thread."))?;
        let s = |k: &str| args.get(k).and_then(Value::as_str).unwrap_or("").to_owned();
        let b = |k: &str, d: bool| args.get(k).and_then(Value::as_bool).unwrap_or(d);
        let n = |k: &str, d: f64| args.get(k).and_then(Value::as_f64).unwrap_or(d);

        if name.starts_with("boss_browser_") || name == "boss_computer" {
            let qa = self.qa.lock().unwrap().clone().ok_or_else(|| anyhow!("BOSS QA tools are not ready."))?;
            let r = qa.call_tool(caller, name, args).await;
            return if r.is_error { Err(anyhow!(text_of(&r))) } else { Ok(Value::String(text_of(&r))) };
        }
        if name.starts_with(boss_bus::hub::MCP_TOOL_PREFIX) {
            let r = rt.hub.call_tool(name, args).await;
            return if r.is_error { Err(anyhow!(text_of(&r))) } else { Ok(Value::String(text_of(&r))) };
        }
        match name {
            "boss_git_create_change_request" => {
                let mut cmd = tokio::process::Command::new("gh");
                cmd.current_dir(&thread.cwd).arg("pr").arg("create");
                let title = s("title");
                let body = s("body");
                if title.is_empty() && body.is_empty() {
                    cmd.arg("--fill");
                } else {
                    cmd.args(["--title", &title, "--body", &body]);
                }
                let base = s("baseBranch");
                if !base.is_empty() {
                    cmd.args(["--base", &base]);
                }
                if b("draft", false) {
                    cmd.arg("--draft");
                }
                let out = cmd.output().await?;
                if !out.status.success() {
                    bail!(String::from_utf8_lossy(&out.stderr).trim().to_string());
                }
                Ok(json!({ "url": String::from_utf8_lossy(&out.stdout).trim() }))
            }
            "boss_threads_list" => {
                let all = thread.kind == ThreadKind::Assistant;
                let list: Vec<Value> = rt
                    .state
                    .threads()
                    .into_iter()
                    .filter(|t| !t.archived && (all || t.project_id == thread.project_id))
                    .filter(|t| all || same_engine(&thread, t))
                    .map(|t| {
                        json!({
                            "id": t.id, "title": t.title, "busy": rt.is_busy(&t.id), "current": t.id == thread.id,
                            "project": t.cwd,
                        })
                    })
                    .collect();
                Ok(Value::Array(list))
            }
            "boss_threads_read" => {
                let target = self.require_peer(&rt, &thread, &s("threadId"))?;
                let limit = n("limit", 8.0).clamp(1.0, 20.0) as usize;
                let msgs = rt.load_messages(&target.id);
                let start = msgs.len().saturating_sub(limit);
                let transcript: Vec<String> = msgs[start..]
                    .iter()
                    .map(|m| {
                        let who = match m.role {
                            Role::User => "User".to_string(),
                            Role::Assistant => m.author.as_ref().map(|a| a.to_string()).unwrap_or_else(|| "Assistant".into()),
                            Role::System => "System".into(),
                        };
                        format!("{who}: {}", m.text())
                    })
                    .collect();
                let text = transcript.join("\n\n");
                Ok(json!({
                    "thread": { "id": target.id, "title": target.title, "busy": rt.is_busy(&target.id) },
                    "transcript": if text.is_empty() { "(No messages yet.)".to_string() } else { text },
                }))
            }
            "boss_threads_send" => {
                self.send(&rt, &thread, &s("threadId"), &s("message"), b("expectsReply", true), n("maxTurns", 4.0) as u32, None).await
            }
            "boss_threads_reply" => {
                let reply_to = self.messages.lock().unwrap().iter().find(|m| m.id == s("messageId")).cloned();
                let reply_to = match reply_to {
                    Some(m) if m.to == thread.id => m,
                    _ => bail!("That message is not addressed to this thread."),
                };
                if reply_to.hop_count + 1 >= reply_to.max_turns {
                    bail!("This conversation reached its configured turn limit.");
                }
                let already = self.messages.lock().unwrap().iter().any(|m| m.reply_to.as_deref() == Some(&reply_to.id) && m.from == thread.id);
                if already {
                    bail!("This thread already replied to that message.");
                }
                let to = reply_to.from.to_string();
                self.send(&rt, &thread, &to, &s("message"), b("expectsReply", false), reply_to.max_turns, Some(&reply_to)).await
            }
            "boss_threads_use_worktree" => {
                let project = self.project_of(&rt, &thread)?;
                if thread.cwd != project.root {
                    bail!("This thread already has its own worktree.");
                }
                let info = self.worktrees.create(&project.root, &thread.title).await?;
                // Only the cwd: the next message starts a session there, and
                // restarting one mid-turn would drop the agent's context for
                // the tool call it is answering right now.
                rt.state.update_thread(&thread.id, |t| t.cwd = info.path.clone())?;
                Ok(json!({ "path": info.path, "branch": info.branch }))
            }
            "boss_threads_leave_worktree" => {
                let project = self.project_of(&rt, &thread)?;
                if thread.cwd == project.root {
                    bail!("This thread is not on a worktree.");
                }
                let worktree = thread.cwd.clone();
                let branch = crate::worktree::branch_of(&worktree).await.unwrap_or_default();
                // Moved back first: git refuses a removal that would lose
                // work, and the thread should still return home when it does.
                rt.state.update_thread(&thread.id, |t| t.cwd = project.root.clone())?;
                self.worktrees.remove(&worktree).await?;
                Ok(json!({ "path": project.root, "branch": branch }))
            }
            "boss_threads_spawn_worktree" => {
                let instruction = s("instruction");
                if instruction.trim().is_empty() {
                    bail!("An implementation instruction is required.");
                }
                if instruction.len() > MAX_BODY {
                    bail!("Instructions are limited to {MAX_BODY} characters.");
                }
                let engine = match s("agent").as_str() {
                    "" => match thread.kind {
                        ThreadKind::Chat { engine } => engine,
                        _ => rt.settings.get().default_engine,
                    },
                    requested => rooms::parse_engine(requested).ok_or_else(|| {
                        anyhow!("Agent must be one of: {}.", EngineId::ALL.map(EngineId::as_str).join(", "))
                    })?,
                };
                let project = self.target_project(&rt, &thread, &s("project"))?;
                let title = first_line(&instruction);
                let info = self.worktrees.create(&project.root, &title).await?;
                let created = match rt.new_chat(&project, engine, Some(title.clone())) {
                    Ok(created) => created,
                    Err(e) => {
                        let _ = self.worktrees.remove(&info.path).await;
                        return Err(e);
                    }
                };
                let created = rt
                    .state
                    .update_thread(&created.id, |t| t.cwd = info.path.clone())?
                    .ok_or_else(|| anyhow!("The worktree thread could not be registered."))?;
                let participant = rt.primary_participant(&created)?;
                // Sending starts the session, so the new thread is already
                // working when this call returns.
                rt.send(&created, &participant, Prompt { text: instruction, attachments: vec![] }).await?;
                Ok(json!({ "id": created.id, "title": created.title, "path": info.path, "branch": info.branch }))
            }
            "boss_rooms_open" => {
                let instruction = s("instruction");
                if instruction.trim().is_empty() {
                    bail!("Say what the job is.");
                }
                if instruction.len() > MAX_BODY {
                    bail!("Instructions are limited to {MAX_BODY} characters.");
                }
                let shape = s("shape");
                let shape = rooms::parse_room_shape(&shape).ok_or_else(|| {
                    anyhow!("Shape must be one of: {}.", rooms::ROOM_SHAPES.map(rooms::room_shape_name).join(", "))
                })?;
                let opener =
                    self.rooms.get().ok_or_else(|| anyhow!("BOSS cannot open rooms in this build."))?.clone();
                let project = self.target_project(&rt, &thread, &s("project"))?;
                let opened = opener.open_room(&project, shape, &instruction).await?;
                Ok(json!({ "id": opened.id, "title": opened.title }))
            }
            "boss_reports_create" | "boss_reports_update" | "boss_notes_record" | "boss_presence_set" => {
                bail!("{name} is not available yet in this build of BOSS.")
            }
            _ if name.starts_with("boss_workflow_") => bail!("Workflows are not available."),
            _ => bail!("Unknown BOSS thread tool."),
        }
    }
}

/// A thread title from an instruction: its first non-empty line, trimmed to
/// something a sidebar can show.
fn first_line(instruction: &str) -> String {
    let line = instruction.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("").trim();
    let title: String = line.chars().take(80).collect();
    if title.is_empty() { "Worktree thread".to_owned() } else { title }
}

/// Drop `.` and resolve `..` without touching the filesystem, so comparing a
/// requested path to an open project does not depend on either existing.
fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for part in path.components() {
        match part {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                out.pop();
            }
            other => out.push(other),
        }
    }
    out
}

fn same_engine(a: &Thread, b: &Thread) -> bool {
    match (&a.kind, &b.kind) {
        (ThreadKind::Chat { engine: x }, ThreadKind::Chat { engine: y }) => x == y,
        _ => true,
    }
}

fn text_of(r: &BusToolResult) -> String {
    r.content
        .iter()
        .filter_map(|c| match c {
            BusContent::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

trait OffsetDateTimeExt {
    fn now_ms() -> i64;
}
impl OffsetDateTimeExt for time::OffsetDateTime {
    fn now_ms() -> i64 {
        (time::OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000) as i64
    }
}

#[async_trait]
impl BusHandler for RuntimeBusHandler {
    async fn list_tools(&self, _caller: &BusCaller) -> Vec<BusTool> {
        let mut tools = boss_bus::tools::tool_definitions();
        if let Ok(rt) = self.runtime() {
            tools.extend(rt.hub.tool_definitions().await);
        }
        tools
    }

    async fn call_tool(&self, caller: &BusCaller, name: &str, args: Value) -> BusToolResult {
        match self.call(caller, name, args).await {
            Ok(Value::String(s)) => BusToolResult::text(s),
            Ok(v) => BusToolResult::text(serde_json::to_string_pretty(&v).unwrap_or_default()),
            Err(e) => BusToolResult::error(e.to_string()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    struct FakeRooms {
        opened: Mutex<Vec<(PathBuf, RoomShape, String)>>,
    }

    #[async_trait]
    impl RoomOpener for FakeRooms {
        async fn open_room(&self, project: &Project, shape: RoomShape, title: &str) -> Result<Thread> {
            self.opened.lock().unwrap().push((project.root.clone(), shape, title.to_owned()));
            let now = time::OffsetDateTime::now_utc();
            Ok(Thread {
                id: ThreadId::from("thr_room"),
                project_id: project.id.clone(),
                title: "Ship the thing".into(),
                kind: ThreadKind::Room { room_id: RoomId::new() },
                created_at: now,
                updated_at: now,
                cwd: project.root.clone(),
                archived: false,
            })
        }
    }

    /// A git repository with one commit, for the worktree tools.
    async fn repo(at: PathBuf) -> PathBuf {
        std::fs::create_dir_all(&at).unwrap();
        for args in [
            vec!["init", "--initial-branch=main", "."],
            vec!["config", "user.email", "test@example.com"],
            vec!["config", "user.name", "Test"],
            vec!["config", "commit.gpgsign", "false"],
        ] {
            let out = tokio::process::Command::new("git").arg("-C").arg(&at).args(&args).output().await.unwrap();
            assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        }
        std::fs::write(at.join("README.md"), "hello\n").unwrap();
        for args in [vec!["add", "."], vec!["commit", "-m", "first"]] {
            let out = tokio::process::Command::new("git").arg("-C").arg(&at).args(&args).output().await.unwrap();
            assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        }
        at
    }

    struct Fixture {
        _dir: tempfile::TempDir,
        rt: Arc<Runtime>,
        rooms: Arc<FakeRooms>,
        project: Project,
        thread: Thread,
    }

    impl Fixture {
        async fn call(&self, name: &str, args: Value) -> Result<Value> {
            let caller = BusCaller {
                thread_id: self.thread.id.clone(),
                participant_id: ParticipantId::from("who_test"),
            };
            self.rt.bus_handler().call(&caller, name, args).await
        }

        fn thread(&self) -> Thread {
            self.rt.state.thread(&self.thread.id).unwrap()
        }
    }

    /// A runtime on a temp data dir with one project, one chat thread, and a
    /// fake room opener. Binds a loopback port for the bus.
    async fn fixture() -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("data");
        let rt = Runtime::start(Some(data), tokio::runtime::Handle::current()).await.unwrap();
        let root = repo(dir.path().join("acme")).await;
        let project = rt.state.add_project(root, None).unwrap();
        let thread = rt.new_chat(&project, EngineId::Pi, Some("Fix the login bug".into())).unwrap();
        let rooms = Arc::new(FakeRooms { opened: Mutex::new(vec![]) });
        rt.bus_handler().set_room_opener(rooms.clone());
        Fixture { _dir: dir, rt, rooms, project, thread }
    }

    #[tokio::test]
    async fn use_worktree_moves_the_thread_and_leave_brings_it_back() {
        let f = fixture().await;
        let used = f.call("boss_threads_use_worktree", json!({})).await.unwrap();
        let path = PathBuf::from(used["path"].as_str().unwrap());
        let branch = used["branch"].as_str().unwrap().to_owned();
        assert!(branch.starts_with("boss/fix-the-login-bug-"), "branch was {branch}");
        assert!(path.join("README.md").is_file());
        assert_eq!(f.thread().cwd, path);

        // A second call would orphan the first checkout.
        let again = f.call("boss_threads_use_worktree", json!({})).await.unwrap_err().to_string();
        assert!(again.contains("already has its own worktree"), "message was {again}");

        let left = f.call("boss_threads_leave_worktree", json!({})).await.unwrap();
        assert_eq!(left["path"].as_str().unwrap(), f.project.root.to_string_lossy());
        assert_eq!(left["branch"].as_str().unwrap(), branch);
        assert!(!path.exists());
        assert_eq!(f.thread().cwd, f.project.root);

        let twice = f.call("boss_threads_leave_worktree", json!({})).await.unwrap_err().to_string();
        assert!(twice.contains("not on a worktree"), "message was {twice}");
    }

    #[tokio::test]
    async fn leave_worktree_refuses_to_lose_uncommitted_work() {
        let f = fixture().await;
        let used = f.call("boss_threads_use_worktree", json!({})).await.unwrap();
        let path = PathBuf::from(used["path"].as_str().unwrap());
        std::fs::write(path.join("draft.txt"), "half a change\n").unwrap();

        let e = f.call("boss_threads_leave_worktree", json!({})).await.unwrap_err().to_string();
        assert!(e.contains("uncommitted or untracked"), "message was {e}");
        assert!(path.join("draft.txt").is_file());
        // The thread still went home; the checkout is simply still there.
        assert_eq!(f.thread().cwd, f.project.root);
    }

    #[tokio::test]
    async fn rooms_open_validates_then_hands_the_job_to_the_opener() {
        let f = fixture().await;
        let bad = f.call("boss_rooms_open", json!({ "instruction": "go", "shape": "sideways" })).await;
        assert!(bad.unwrap_err().to_string().contains("Shape must be one of"));
        let empty = f.call("boss_rooms_open", json!({ "instruction": "  ", "shape": "full" })).await;
        assert!(empty.unwrap_err().to_string().contains("Say what the job is"));

        let opened =
            f.call("boss_rooms_open", json!({ "instruction": "Ship the thing", "shape": "reviewed" })).await.unwrap();
        assert_eq!(opened["id"], "thr_room");
        assert_eq!(opened["title"], "Ship the thing");
        let seen = f.rooms.opened.lock().unwrap().clone();
        assert_eq!(seen, vec![(f.project.root.clone(), RoomShape::Reviewed, "Ship the thing".to_owned())]);
    }

    #[tokio::test]
    async fn tools_refuse_a_project_the_user_never_opened() {
        let f = fixture().await;
        let e = f
            .call("boss_rooms_open", json!({ "instruction": "go", "shape": "direct", "project": "/elsewhere/secret" }))
            .await
            .unwrap_err()
            .to_string();
        assert!(e.contains("is not open in BOSS"), "message was {e}");
        assert!(e.contains("acme"), "message should list what is open: {e}");
        assert!(f.rooms.opened.lock().unwrap().is_empty());

        // The folder name of an open project is enough.
        assert!(f.call("boss_rooms_open", json!({ "instruction": "go", "shape": "direct", "project": "ACME" })).await.is_ok());
        // So is its full path.
        let by_path = json!({ "instruction": "go", "shape": "direct", "project": f.project.root });
        assert!(f.call("boss_rooms_open", by_path).await.is_ok());
    }

    #[tokio::test]
    async fn spawn_worktree_checks_its_arguments_before_making_a_checkout() {
        let f = fixture().await;
        let empty = f.call("boss_threads_spawn_worktree", json!({ "instruction": " \n " })).await;
        assert!(empty.unwrap_err().to_string().contains("instruction is required"));

        let long = f.call("boss_threads_spawn_worktree", json!({ "instruction": "x".repeat(MAX_BODY + 1) })).await;
        assert!(long.unwrap_err().to_string().contains("limited to"));

        let agent = f.call("boss_threads_spawn_worktree", json!({ "instruction": "go", "agent": "hal" })).await;
        assert!(agent.unwrap_err().to_string().contains("Agent must be one of"));

        // Nothing was created by any of those.
        assert_eq!(f.rt.state.threads().len(), 1);
        assert!(!f.rt.bus_handler().worktrees.root().exists());
    }

    #[test]
    fn a_title_is_the_first_line_of_the_instruction() {
        assert_eq!(first_line("\n\n  Add a retry to the uploader  \nwhy: it flakes"), "Add a retry to the uploader");
        assert_eq!(first_line("   "), "Worktree thread");
        assert_eq!(first_line(&"z".repeat(200)).len(), 80);
    }
}
