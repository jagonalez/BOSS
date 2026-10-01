//! Serves the thread tools to agents. Port of the tool half of
//! `src/main/thread-bus.ts`: peer fences, durable inter-thread messages,
//! and delegation of browser, computer, and MCP tools.

use crate::automations::{
    EventPattern, Workflow, WorkflowApprovalMode, WorkflowInput, WorkflowOverlapPolicy, WorkflowPatch,
    WorkflowRun, WorkflowSource, WorkflowTrigger,
};
use crate::runtime::Runtime;
use crate::worktree::Worktrees;
use anyhow::{Result, anyhow, bail};
use async_trait::async_trait;
use boss_core::store::{AgentReportInput, AgentReportPatch, JsonFile, Presence};
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
    /// Start a room in `project` (or with no project, when the caller has
    /// none) with `shape`, titled `title`, and return its thread.
    async fn open_room(&self, project: Option<&Project>, shape: RoomShape, title: &str) -> Result<Thread>;
}

pub struct RuntimeBusHandler {
    runtime: OnceLock<Weak<Runtime>>,
    messages: Mutex<Vec<BusMessage>>,
    messages_file: JsonFile,
    delivery_locks: Mutex<HashSet<ThreadId>>,
    native_sessions: KeyValueFile,
    /// Browser tools, provided by the app once the UI exists.
    qa: Mutex<Option<std::sync::Arc<dyn BusHandler>>>,
    /// The embedded cua-driver. Owned here rather than by the app: it is a
    /// child process and a socket, with no window behind it, so it needs
    /// nothing the UI has and is testable without one.
    computer: crate::computer_use::ComputerUse,
    /// Per-thread QA policy, which decides whether an acting call goes through.
    qa_policies: Mutex<crate::computer_use::QaPolicies>,
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
            computer: crate::computer_use::ComputerUse::in_data_dir(&data_dir),
            qa_policies: Mutex::new(crate::computer_use::QaPolicies::open(&data_dir)),
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

    /// The app sets this once browser tools exist.
    pub fn set_qa_handler(&self, qa: std::sync::Arc<dyn BusHandler>) {
        *self.qa.lock().unwrap() = Some(qa);
    }

    /// The embedded cua-driver, for the settings UI: status, the enable
    /// toggle, the permission checks, and the emergency stop.
    pub fn computer(&self) -> &crate::computer_use::ComputerUse {
        &self.computer
    }

    /// The QA policy for one thread, falling back to the global default.
    pub fn qa_policy(&self, thread: &ThreadId) -> crate::computer_use::QaPolicy {
        self.qa_policies.lock().unwrap().policy(&thread.0)
    }

    /// Set one thread's QA policy, or `None` to follow the global default.
    pub fn set_qa_policy(&self, thread: &ThreadId, policy: Option<crate::computer_use::QaPolicy>) {
        self.qa_policies.lock().unwrap().set_policy(&thread.0, policy);
    }

    pub fn qa_default_policy(&self) -> crate::computer_use::QaPolicy {
        self.qa_policies.lock().unwrap().default_policy()
    }

    pub fn set_qa_default_policy(&self, policy: crate::computer_use::QaPolicy) {
        self.qa_policies.lock().unwrap().set_default(policy);
    }

    /// Git worktrees, shared with the automation host so an unattended run
    /// makes its checkouts in the same place a thread tool does.
    pub fn worktrees(&self) -> &Worktrees {
        &self.worktrees
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

    /// The project a thread belongs to. A scratch thread has none, so the
    /// worktree tools stop here rather than checking out into a home folder.
    fn project_of(&self, rt: &Runtime, thread: &Thread) -> Result<Project> {
        thread
            .project_id
            .as_ref()
            .and_then(|id| rt.state.project(id))
            .ok_or_else(|| anyhow!("Projectless chats cannot use Git worktrees."))
    }

    /// A thread's project path as a report records it: the project root, or
    /// `""` for a scratch thread. Matches the Electron file, where a global
    /// automation report also carries an empty `projectPath`.
    fn project_path_of(&self, rt: &Runtime, thread: &Thread) -> String {
        thread
            .project_id
            .as_ref()
            .and_then(|id| rt.state.project(id))
            .map(|p| p.root.to_string_lossy().into_owned())
            .unwrap_or_default()
    }

    /// The engine a report's `backendId` records: the seat's engine in a
    /// room, the thread's engine in a chat, and the default otherwise. Each
    /// seat in a room can run on a different engine, so asking the thread
    /// alone would attribute a reviewer's report to the builder's engine.
    fn backend_id_of(&self, rt: &Runtime, thread: &Thread, caller: &BusCaller) -> &'static str {
        if let ThreadKind::Chat { engine } = thread.kind {
            return engine.as_str();
        }
        rt.rooms()
            .participants_for(&thread.id)
            .into_iter()
            .find(|p| p.id == caller.participant_id)
            .map(|p| p.engine)
            .unwrap_or_else(|| rt.settings.get().default_engine)
            .as_str()
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

    /// The `boss_workflow_*` tools. Port of `runWorkflowTool` in
    /// `src/main/thread-bus.ts`.
    ///
    /// A thread sees its own project's workflows plus global ones, which is
    /// what keeps one project's agent from running another's workflow.
    async fn workflow_tool(&self, rt: &Runtime, thread: &Thread, name: &str, args: &Value) -> Result<Value> {
        let engine = rt.workflows();
        let project_path = self.project_path_of(rt, thread);
        let visible = |workflow: &Workflow| workflow.project_path == project_path || workflow.project_path.is_empty();
        let workflows = engine.store().workflows();
        let runs = engine.store().runs();
        let approval_mode = engine.store().approval_mode();
        let auto_approve = approval_mode == WorkflowApprovalMode::Auto;

        let text = |key: &str| args.get(key).and_then(Value::as_str);
        let require_workflow = |id: Option<&str>| -> Result<Workflow> {
            let id = id.unwrap_or_default().trim();
            if id.is_empty() {
                bail!("A workflow id is required.");
            }
            workflows
                .iter()
                .find(|w| w.id == id)
                .filter(|w| visible(w))
                .cloned()
                .ok_or_else(|| anyhow!("Workflow not found in this project."))
        };

        match name {
            "boss_workflow_list" => {
                let list: Vec<Value> = workflows
                    .iter()
                    .filter(|w| visible(w))
                    .map(|workflow| {
                        let latest = runs
                            .iter()
                            .filter(|run| run.workflow_id == workflow.id)
                            .max_by_key(|run| run.started_at);
                        let mut item = json!({
                            "id": workflow.id,
                            "name": workflow.name,
                            "description": workflow.description.clone().unwrap_or_default(),
                            "enabled": workflow.enabled,
                            "source": workflow.source,
                            "triggers": workflow.triggers,
                        });
                        if let Some(latest) = latest {
                            item["lastRun"] = json!({
                                "id": latest.id,
                                "status": latest.status,
                                "startedAt": latest.started_at,
                                "error": latest.error,
                            });
                        }
                        item
                    })
                    .collect();
                Ok(Value::Array(list))
            }
            "boss_workflow_create" => {
                let input = WorkflowInput {
                    name: text("name").unwrap_or_default().to_owned(),
                    description: text("description").filter(|d| !d.is_empty()).map(str::to_owned),
                    script: text("script").unwrap_or_default().to_owned(),
                    project_path: project_path.clone(),
                    triggers: workflow_triggers_from(args),
                    overlap_policy: WorkflowOverlapPolicy::Skip,
                    budget: None,
                    defaults: None,
                    keep_runs: 0,
                };
                let workflow = engine.create(input, WorkflowSource::Agent)?;
                Ok(json!({
                    "id": workflow.id,
                    "enabled": workflow.enabled,
                    "note": if auto_approve {
                        "Workflow approval is set to auto, so its triggers are live immediately. Use boss_workflow_run to also execute it once now."
                    } else {
                        "Created disabled: triggers stay dormant until the user enables it in the Workflows page. Use boss_workflow_run to execute it once now."
                    },
                }))
            }
            "boss_workflow_update" => {
                let target = require_workflow(text("workflowId"))?;
                // Under ask-mode approval an edited workflow is disabled
                // again: editing is how an agent iterates, enabling is how
                // the user approves.
                let mut patch = WorkflowPatch { enabled: (!auto_approve).then_some(false), ..Default::default() };
                if let Some(name) = text("name").map(str::trim).filter(|n| !n.is_empty()) {
                    patch.name = Some(name.to_owned());
                }
                if let Some(description) = text("description") {
                    patch.description = Some(description.to_owned());
                }
                if let Some(script) = text("script").filter(|s| !s.trim().is_empty()) {
                    patch.script = Some(script.to_owned());
                }
                if ["cron", "eventType", "eventFilters"].iter().any(|key| args.get(key).is_some()) {
                    patch.triggers = Some(workflow_triggers_from(args));
                }
                let updated = engine.update(&target.id, patch, true)?;
                Ok(json!({
                    "id": updated.id,
                    "enabled": updated.enabled,
                    "note": if auto_approve { "Saved." } else { "Saved, and disabled until the user re-enables it." },
                }))
            }
            "boss_workflow_run" => {
                let target = require_workflow(text("workflowId"))?;
                let run = engine.run_now(&target.id, Some(thread.id.to_string())).await?;
                Ok(json!({
                    "runId": run.id,
                    "status": run.status,
                    "note": "The result will arrive in this conversation as a message when the run finishes.",
                }))
            }
            "boss_workflow_runs" => {
                let requested = text("workflowId").unwrap_or_default().trim();
                let ids: Vec<String> = if requested.is_empty() {
                    workflows.iter().filter(|w| visible(w)).map(|w| w.id.clone()).collect()
                } else {
                    vec![require_workflow(Some(requested))?.id]
                };
                let limit =
                    args.get("limit").and_then(Value::as_f64).unwrap_or(5.0).clamp(1.0, 20.0) as usize;
                let mut matching: Vec<&WorkflowRun> =
                    runs.iter().filter(|run| ids.contains(&run.workflow_id)).collect();
                matching.sort_by(|a, b| b.started_at.cmp(&a.started_at));
                let list: Vec<Value> = matching
                    .into_iter()
                    .take(limit)
                    .map(|run| {
                        json!({
                            "id": run.id,
                            "workflowId": run.workflow_id,
                            "status": run.status,
                            "trigger": run.trigger,
                            "startedAt": run.started_at,
                            "finishedAt": run.finished_at,
                            "error": run.error,
                            "result": run.result,
                            "note": run.note,
                            "steps": run.journal.iter().map(|entry| {
                                let mut step = json!({
                                    "seq": entry.seq,
                                    "op": entry.op,
                                    "label": entry.label,
                                    "status": entry.status,
                                });
                                if let Some(error) = &entry.error {
                                    step["error"] = json!(error);
                                }
                                step
                            }).collect::<Vec<_>>(),
                        })
                    })
                    .collect();
                Ok(Value::Array(list))
            }
            _ => bail!("Unknown BOSS workflow tool."),
        }
    }

    async fn call(&self, caller: &BusCaller, name: &str, args: Value) -> Result<Value> {
        let rt = self.runtime()?;
        let thread = rt.state.thread(&caller.thread_id).ok_or_else(|| anyhow!("BOSS could not identify the calling thread."))?;
        let s = |k: &str| args.get(k).and_then(Value::as_str).unwrap_or("").to_owned();
        let b = |k: &str, d: bool| args.get(k).and_then(Value::as_bool).unwrap_or(d);
        let n = |k: &str, d: f64| args.get(k).and_then(Value::as_f64).unwrap_or(d);

        if name.starts_with("boss_browser_") {
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
                let created = match rt.new_chat(Some(&project), engine, Some(title.clone())) {
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
                // A scratch thread that names no project opens a scratch
                // room: a room the user could not have opened otherwise
                // would be a way to widen the caller's own scope.
                let named = s("project");
                let project = match (named.trim().is_empty(), &thread.project_id) {
                    (true, None) => None,
                    _ => Some(self.target_project(&rt, &thread, &named)?),
                };
                let opened = opener.open_room(project.as_ref(), shape, &instruction).await?;
                Ok(json!({ "id": opened.id, "title": opened.title }))
            }
            // Job notes belong to the caller's own job, so they are not gated
            // by the collaboration policy. They are the only thing that
            // carries a job past the agents working on it: an agent brought
            // in later reads these and nothing else.
            "boss_notes_record" => {
                let list = |key: &str| -> Option<Vec<String>> {
                    let items = args.get(key)?.as_array()?;
                    Some(
                        items
                            .iter()
                            .filter_map(Value::as_str)
                            .map(str::trim)
                            .filter(|line| !line.is_empty())
                            .map(str::to_owned)
                            .collect(),
                    )
                };
                let at = time::OffsetDateTime::now_utc();
                let patch = rooms::JobNotesPatch {
                    agreed: list("agreed"),
                    decided: list("decided").map(|texts| {
                        texts
                            .into_iter()
                            .map(|text| rooms::JobDecision {
                                text,
                                at,
                                by: caller.participant_id.clone(),
                            })
                            .collect()
                    }),
                    changed: list("changed"),
                };
                if patch.agreed.is_none() && patch.decided.is_none() && patch.changed.is_none() {
                    bail!("Record at least one of agreed, decided, or changed.");
                }
                // A participant records against its thread, because that is
                // the job it is working on.
                let notes = rt.rooms().record_notes(&thread.id, patch);
                Ok(json!({
                    "recorded": true,
                    "updatedAt": notes.updated_at.map(|at| at.unix_timestamp_nanos() / 1_000_000).unwrap_or(0) as i64,
                }))
            }
            // Presence is the user's own bar for being interrupted, not a
            // collaboration question, so it is answered before the policy.
            "boss_presence_set" => {
                let wanted = match s("presence").as_str() {
                    "desk" => Presence::Desk,
                    "away" => Presence::Away,
                    "quiet" => Presence::Quiet,
                    _ => bail!("presence must be \"desk\", \"away\", or \"quiet\"."),
                };
                let held = rt.notify.set_presence(wanted);
                Ok(json!({
                    "presence": s("presence"),
                    // Named so the assistant can say what waited rather than
                    // leaving the user to discover it.
                    "waiting": held
                        .iter()
                        .map(|e| json!({ "title": e.title, "body": e.body }))
                        .collect::<Vec<_>>(),
                }))
            }
            // Report artifacts are local to BOSS and belong to the calling
            // thread, so creating or refining one does not depend on
            // cross-thread collaboration either.
            "boss_reports_create" => {
                let summary = args.get("summary").and_then(Value::as_str).map(str::to_owned);
                let report = rt.reports.create_from_agent(
                    AgentReportInput {
                        thread_id: thread.id.to_string(),
                        project_path: self.project_path_of(&rt, &thread),
                        backend_id: self.backend_id_of(&rt, &thread, caller).to_owned(),
                        title: s("title"),
                        summary,
                        body: s("body"),
                    },
                    time::OffsetDateTime::now_ms(),
                )?;
                Ok(json!({ "id": report.id, "title": report.title, "summary": report.summary }))
            }
            "boss_reports_update" => {
                let text = |key: &str| args.get(key).and_then(Value::as_str).map(str::to_owned);
                let patch = AgentReportPatch {
                    title: text("title"),
                    summary: text("summary"),
                    body: text("body"),
                };
                if patch.is_empty() {
                    bail!("Pass at least one report field to update.");
                }
                let id = s("reportId");
                if id.trim().is_empty() {
                    bail!("A reportId is required.");
                }
                let report = rt.reports.update_from_agent(
                    &thread.id.to_string(),
                    &id,
                    patch,
                    time::OffsetDateTime::now_ms(),
                )?;
                Ok(json!({
                    "id": report.id,
                    "title": report.title,
                    "summary": report.summary,
                    "updatedAt": report.updated_at,
                }))
            }
            // Workflows are local to BOSS and scoped to the caller's project,
            // so like reports they are answered without a peer check.
            _ if name.starts_with("boss_workflow_") => {
                self.workflow_tool(&rt, &thread, name, &args).await
            }
            _ => bail!("Unknown BOSS thread tool."),
        }
    }
}

/// The triggers a `boss_workflow_create`/`update` call asks for. Port of
/// `workflowTriggersFrom`: a cron expression and an event type are both
/// optional and both may be given, and a workflow with neither is manual.
///
/// Only scalar filters survive, matching the TS: an object or array filter
/// could never equal a flat event field, so keeping one would silently make
/// the trigger unmatchable.
fn workflow_triggers_from(args: &Value) -> Vec<WorkflowTrigger> {
    let mut triggers = Vec::new();
    let text = |key: &str| args.get(key).and_then(Value::as_str).map(str::trim).unwrap_or("");
    let cron = text("cron");
    if !cron.is_empty() {
        triggers.push(WorkflowTrigger::Cron { expression: cron.to_owned() });
    }
    let event_type = text("eventType");
    if !event_type.is_empty() {
        let filters: std::collections::BTreeMap<String, Value> = args
            .get("eventFilters")
            .and_then(Value::as_object)
            .map(|raw| {
                raw.iter()
                    .filter(|(_, value)| value.is_string() || value.is_number() || value.is_boolean())
                    .map(|(key, value)| (key.clone(), value.clone()))
                    .collect()
            })
            .unwrap_or_default();
        triggers.push(WorkflowTrigger::Event {
            pattern: EventPattern {
                kind: event_type.to_owned(),
                project_path: None,
                filters: Some(filters).filter(|f| !f.is_empty()),
            },
        });
    }
    triggers
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
        // Answered here rather than through `call`, which returns a `Value`
        // and so cannot carry an image: a state capture's screenshot is the
        // larger half of its answer, and flattening it to text loses it.
        if name == "boss_computer" {
            let policy = self.qa_policy(&caller.thread_id);
            return self.computer.call_bus_tool(&args, policy).await;
        }
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
        async fn open_room(&self, project: Option<&Project>, shape: RoomShape, title: &str) -> Result<Thread> {
            self.opened.lock().unwrap().push((Thread::cwd_for(project), shape, title.to_owned()));
            let now = time::OffsetDateTime::now_utc();
            Ok(Thread {
                id: ThreadId::from("thr_room"),
                project_id: project.map(|p| p.id.clone()),
                title: "Ship the thing".into(),
                kind: ThreadKind::Room { room_id: RoomId::new() },
                created_at: now,
                updated_at: now,
                cwd: Thread::cwd_for(project),
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

        /// The tool path an agent actually takes, which unlike `call` can
        /// carry an image back.
        async fn call_tool(&self, name: &str, args: Value) -> BusToolResult {
            let caller = BusCaller {
                thread_id: self.thread.id.clone(),
                participant_id: ParticipantId::from("who_test"),
            };
            self.rt.bus_handler().call_tool(&caller, name, args).await
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
        let thread = rt.new_chat(Some(&project), EngineId::Pi, Some("Fix the login bug".into())).unwrap();
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
    async fn boss_computer_reaches_the_driver_with_its_screenshot_intact() {
        // The bug this pins: the QA delegation flattened every result to text,
        // so a state capture's screenshot — the larger half of its answer —
        // was dropped before the agent ever saw it. No browser QA handler is
        // registered here either, which is the point: the computer tool must
        // not depend on the UI being up.
        let _fake = crate::computer_use::FakeDriver::install();
        let f = fixture().await;

        let looked = f.call_tool("boss_computer", json!({ "operation": "get_window_state" })).await;
        assert!(!looked.is_error, "{:?}", looked.content);
        assert_eq!(looked.content.len(), 2, "text and image: {:?}", looked.content);
        assert!(matches!(&looked.content[1], BusContent::Image { mime_type, .. } if mime_type == "image/png"));

        // Acting goes through under the automatic default, with the click
        // action canonicalized on the way.
        let acted = f
            .call_tool("boss_computer", json!({ "operation": "click", "arguments": { "action": "showmenu" } }))
            .await;
        assert!(!acted.is_error, "{:?}", acted.content);
        let echoed: Value = serde_json::from_str(&text_of(&acted)).unwrap();
        assert_eq!(echoed["arguments"]["action"], "show_menu");

        // Under Suggest, looking still works and acting is refused with a
        // message that says what to do about it.
        f.rt.bus_handler().set_qa_policy(&f.thread.id, Some(crate::computer_use::QaPolicy::Suggest));
        let refused = f.call_tool("boss_computer", json!({ "operation": "click" })).await;
        assert!(refused.is_error);
        assert!(text_of(&refused).contains("Automatic QA"), "{:?}", refused.content);
        let still_looks = f.call_tool("boss_computer", json!({ "operation": "list_apps" })).await;
        assert!(!still_looks.is_error, "{:?}", still_looks.content);
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

    // ------------------------------------------------------- reports

    #[tokio::test]
    async fn reports_create_stores_an_artifact_the_thread_owns() {
        let f = fixture().await;
        let made = f
            .call(
                "boss_reports_create",
                json!({ "title": "  Findings  ", "summary": "The short version", "body": "# Findings\n\nDetail." }),
            )
            .await
            .unwrap();
        let id = made["id"].as_str().unwrap().to_owned();
        assert_eq!(made["title"], "Findings", "the title is trimmed");
        assert_eq!(made["summary"], "The short version");

        let stored = f.rt.reports.get(&id).unwrap();
        assert_eq!(stored.thread_id.as_deref(), Some(f.thread.id.as_str()));
        assert_eq!(stored.project_path, f.project.root.to_string_lossy());
        // The fixture thread runs on pi, so that is what the report records.
        assert_eq!(stored.source, boss_core::store::ReportSource::Agent { backend_id: "pi".into() });
        assert!(stored.created_at > 0);

        // It survives a reopen of the store, so the artifact outlives the run.
        let reopened = boss_core::store::ReportStore::open(Some(&f.rt.data_dir)).unwrap();
        assert_eq!(reopened.get(&id).unwrap().body, "# Findings\n\nDetail.");
    }

    #[tokio::test]
    async fn reports_create_refuses_empty_and_oversized_text() {
        let f = fixture().await;
        let blank = f.call("boss_reports_create", json!({ "title": "  ", "body": "x" })).await;
        assert!(blank.unwrap_err().to_string().contains("Report title is required."));

        let huge = json!({ "title": "t", "body": "x".repeat(250_001) });
        let message = f.call("boss_reports_create", huge).await.unwrap_err().to_string();
        assert!(message.contains("250,000 characters"), "message was {message}");
        assert!(f.rt.reports.list().is_empty(), "nothing was stored");
    }

    #[tokio::test]
    async fn reports_update_refines_the_thread_s_own_report_only() {
        let f = fixture().await;
        let made = f
            .call("boss_reports_create", json!({ "title": "Findings", "summary": "Draft", "body": "First." }))
            .await
            .unwrap();
        let id = made["id"].as_str().unwrap().to_owned();

        // Clearing the summary means passing an empty one, as the TS did.
        let updated =
            f.call("boss_reports_update", json!({ "reportId": &id, "summary": "", "body": "Revised." })).await.unwrap();
        assert_eq!(updated["id"], id.as_str());
        assert!(updated["summary"].is_null(), "the summary was cleared");
        assert!(updated["updatedAt"].as_i64().unwrap() > 0);
        let stored = f.rt.reports.get(&id).unwrap();
        assert_eq!(stored.body, "Revised.");
        assert_eq!(stored.title, "Findings", "an unset field is left alone");

        // Another thread cannot rewrite it.
        let other = f.rt.new_chat(Some(&f.project), EngineId::Pi, Some("Other".into())).unwrap();
        let denied = f
            .rt
            .bus_handler()
            .call(
                &BusCaller { thread_id: other.id, participant_id: ParticipantId::from("who_other") },
                "boss_reports_update",
                json!({ "reportId": &id, "title": "Hijacked" }),
            )
            .await
            .unwrap_err()
            .to_string();
        assert!(denied.contains("Only the thread that created"), "message was {denied}");
        assert_eq!(f.rt.reports.get(&id).unwrap().title, "Findings");
    }

    #[tokio::test]
    async fn reports_update_needs_a_field_and_an_id() {
        let f = fixture().await;
        let made = f.call("boss_reports_create", json!({ "title": "Findings", "body": "First." })).await.unwrap();
        let id = made["id"].as_str().unwrap().to_owned();

        let nothing = f.call("boss_reports_update", json!({ "reportId": &id })).await.unwrap_err().to_string();
        assert!(nothing.contains("at least one report field"), "message was {nothing}");

        let no_id = f.call("boss_reports_update", json!({ "title": "New" })).await.unwrap_err().to_string();
        assert!(no_id.contains("reportId is required"), "message was {no_id}");

        let missing =
            f.call("boss_reports_update", json!({ "reportId": "nope", "title": "New" })).await.unwrap_err().to_string();
        assert!(missing.contains("Report not found."), "message was {missing}");
    }

    #[tokio::test]
    async fn the_phone_lists_reports_without_their_bodies_and_fetches_one_whole() {
        let f = fixture().await;
        f.call("boss_reports_create", json!({ "title": "Findings", "body": "A long body." })).await.unwrap();

        let snapshot = f.rt.reports.snapshot();
        let listed = &snapshot["reports"][0];
        assert_eq!(listed["title"], "Findings");
        assert!(listed.get("body").is_none(), "the list carries no bodies");

        let whole = f.rt.reports.get(listed["id"].as_str().unwrap()).unwrap();
        assert_eq!(whole.body, "A long body.");
    }

    // --------------------------------------------------------- notes

    #[tokio::test]
    async fn notes_record_stores_what_survives_the_job() {
        let f = fixture().await;
        let recorded = f
            .call(
                "boss_notes_record",
                json!({
                    "agreed": ["save the query and the sort order", "  "],
                    "decided": ["chose sqlite over a file"],
                    "changed": ["11 files, 3 new tests"],
                }),
            )
            .await
            .unwrap();
        assert_eq!(recorded["recorded"], true);
        assert!(recorded["updatedAt"].as_i64().unwrap() > 0);

        let notes = f.rt.rooms().room(&f.thread.id).notes;
        // Blank lines are dropped rather than stored as empty bullets.
        assert_eq!(notes.agreed, vec!["save the query and the sort order"]);
        assert_eq!(notes.changed, vec!["11 files, 3 new tests"]);
        assert_eq!(notes.decided.len(), 1);
        assert_eq!(notes.decided[0].text, "chose sqlite over a file");
        assert_eq!(notes.decided[0].by.as_str(), "who_test", "the caller's seat is credited");
        assert!(notes.updated_at.is_some());
    }

    #[tokio::test]
    async fn recording_one_heading_leaves_the_others_alone() {
        let f = fixture().await;
        f.call("boss_notes_record", json!({ "agreed": ["the plan"] })).await.unwrap();
        f.call("boss_notes_record", json!({ "changed": ["the code"] })).await.unwrap();
        let notes = f.rt.rooms().room(&f.thread.id).notes;
        assert_eq!(notes.agreed, vec!["the plan"]);
        assert_eq!(notes.changed, vec!["the code"]);
    }

    #[tokio::test]
    async fn notes_record_needs_at_least_one_heading() {
        let f = fixture().await;
        let empty = f.call("boss_notes_record", json!({})).await.unwrap_err().to_string();
        assert!(empty.contains("at least one of agreed, decided, or changed"), "message was {empty}");
        assert!(f.rt.rooms().room(&f.thread.id).notes.is_empty());
    }

    // ------------------------------------------------------ presence

    #[tokio::test]
    async fn presence_set_moves_the_users_bar_and_persists_it() {
        use boss_core::store::Presence;
        let f = fixture().await;
        let set = f.call("boss_presence_set", json!({ "presence": "quiet" })).await.unwrap();
        assert_eq!(set["presence"], "quiet");
        assert_eq!(set["waiting"].as_array().unwrap().len(), 0);
        assert_eq!(f.rt.settings.get().notifications.presence, Presence::Quiet);

        // Durable, so "do not disturb" is not quietly forgotten on restart.
        let reopened = boss_core::store::SettingsStore::open(Some(&f.rt.data_dir)).unwrap();
        assert_eq!(reopened.get().notifications.presence, Presence::Quiet);
    }

    #[tokio::test]
    async fn coming_back_says_what_waited() {
        use crate::notify::{NotifyEvent, NotifyEventType};
        let f = fixture().await;
        f.call("boss_presence_set", json!({ "presence": "quiet" })).await.unwrap();
        f.rt.notify.publish(NotifyEvent {
            kind: NotifyEventType::TaskNeedsAttention,
            title: "Approve the migration".into(),
            body: "It is waiting on you.".into(),
            thread_id: None,
            project_path: None,
            created_at: 1,
        });

        let back = f.call("boss_presence_set", json!({ "presence": "desk" })).await.unwrap();
        let waiting = back["waiting"].as_array().unwrap();
        assert_eq!(waiting.len(), 1);
        assert_eq!(waiting[0]["title"], "Approve the migration");
        assert_eq!(waiting[0]["body"], "It is waiting on you.");

        // Handed over once, so returning again does not repeat itself.
        f.call("boss_presence_set", json!({ "presence": "quiet" })).await.unwrap();
        let again = f.call("boss_presence_set", json!({ "presence": "desk" })).await.unwrap();
        assert!(again["waiting"].as_array().unwrap().is_empty());
    }

    #[tokio::test]
    async fn presence_set_refuses_a_value_it_does_not_know() {
        use boss_core::store::Presence;
        let f = fixture().await;
        let bad = f.call("boss_presence_set", json!({ "presence": "asleep" })).await.unwrap_err().to_string();
        assert!(bad.contains(r#"must be "desk", "away", or "quiet""#), "message was {bad}");
        assert_eq!(f.rt.settings.get().notifications.presence, Presence::Desk, "unchanged");
    }
}
