//! Serves the thread tools to agents. Port of the tool half of
//! `src/main/thread-bus.ts`: peer fences, durable inter-thread messages,
//! and delegation of browser, computer, and MCP tools.

use crate::runtime::Runtime;
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

pub struct RuntimeBusHandler {
    runtime: OnceLock<Weak<Runtime>>,
    messages: Mutex<Vec<BusMessage>>,
    messages_file: JsonFile,
    delivery_locks: Mutex<HashSet<ThreadId>>,
    native_sessions: KeyValueFile,
    /// Browser and computer tools, provided by the app once the UI exists.
    qa: Mutex<Option<std::sync::Arc<dyn BusHandler>>>,
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
        })
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
            "boss_threads_spawn_worktree" | "boss_rooms_open" | "boss_threads_use_worktree" | "boss_threads_leave_worktree" => {
                bail!("{name} is not available yet in this build of BOSS.")
            }
            "boss_reports_create" | "boss_reports_update" | "boss_notes_record" | "boss_presence_set" => {
                bail!("{name} is not available yet in this build of BOSS.")
            }
            _ if name.starts_with("boss_workflow_") => bail!("Workflows are not available."),
            _ => bail!("Unknown BOSS thread tool."),
        }
    }
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
