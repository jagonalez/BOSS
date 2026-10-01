//! The workflow and automation engines' window onto the rest of BOSS.
//!
//! Port of `src/main/workflow-host.ts` (`BossWorkflowHost`) and the
//! `BackendManager`/`WorktreeManager`/`NotificationRouter` calls
//! `automation-manager.ts` made directly. Owns the full agent conversation
//! lifecycle for an unattended step: a scoped thread, an optional worktree,
//! unattended permission handling, the step deadline, and outcome collection
//! (summary, last assistant text, changed files).
//!
//! The engines never touch [`Runtime`] directly, which is what keeps them
//! testable against a fake that never starts a process.

use super::host::{
    AgentOutcome, AgentRequest, AgentStatus, AutomationHost, Notice, RunOutcome, StartedAgent, WorkflowHost,
};
use super::types::AutomationWorkspace;
use crate::notify::{NotifyEvent, NotifyEventType};
use crate::runtime::Runtime;
use crate::sessions::SessionKey;
use anyhow::{Result, anyhow, bail};
use async_trait::async_trait;
use boss_core::store::ReportSource;
use boss_core::*;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, Weak};

/// How long an unattended permission prompt is left for a person before the
/// host answers it. Matches `PERMISSION_GRACE_MS` in the TS.
const PERMISSION_GRACE_MS: u64 = 2_500;

/// Newest messages an outcome is collected from, matching the TS
/// `thread.messages` limit.
const OUTCOME_MESSAGE_LIMIT: usize = 50;

/// Longest summary line kept, matching `extractSummary`'s `.slice(0, 300)`.
const MAX_SUMMARY: usize = 300;

/// A step conversation this host is supervising.
#[derive(Debug)]
struct Watched {
    /// Title used in the notice when the step needs a person.
    title: String,
    /// Epoch millis at which the step is stopped for exceeding its budget.
    deadline_at: i64,
    /// True once the prompt was delivered; an idle before that must not
    /// finish the step.
    sent: bool,
    /// True when an idle arrived before the prompt delivery resolved.
    saw_idle: bool,
    /// Permission requests waiting out their grace period.
    pending_permissions: Vec<RequestId>,
    /// Only the first question notifies; a chatty agent must not spam.
    notified_question: bool,
}

/// Who wants to hear that a step's conversation ended.
///
/// Both engines take a finished agent the same way, and the host does not
/// know which one started a given thread — it offers the outcome to each in
/// turn and whichever owns the thread acts on it.
#[async_trait]
pub trait AgentSink: Send + Sync {
    async fn on_agent_finished(&self, thread_id: &str, outcome: AgentOutcome);
}

/// [`AutomationHost`] and [`WorkflowHost`] over the live [`Runtime`].
pub struct RuntimeHost {
    runtime: Weak<Runtime>,
    watched: Mutex<HashMap<String, Watched>>,
    /// Set after construction: the engines need this host to exist first.
    sinks: Mutex<Vec<Weak<dyn AgentSink>>>,
    /// This host, weakly, for the work it spawns onto the runtime.
    self_ref: std::sync::OnceLock<Weak<RuntimeHost>>,
}

impl RuntimeHost {
    pub fn new(runtime: Weak<Runtime>) -> Arc<Self> {
        let host = Arc::new(Self {
            runtime,
            watched: Mutex::new(HashMap::new()),
            sinks: Mutex::new(Vec::new()),
            self_ref: std::sync::OnceLock::new(),
        });
        let _ = host.self_ref.set(Arc::downgrade(&host));
        host
    }

    /// Register an engine to receive finished agents. Held weakly, so a
    /// dropped engine does not keep itself alive through the host.
    pub fn add_sink(&self, sink: Weak<dyn AgentSink>) {
        self.sinks.lock().unwrap().push(sink);
    }

    fn runtime(&self) -> Result<Arc<Runtime>> {
        self.runtime.upgrade().ok_or_else(|| anyhow!("The BOSS runtime is no longer running."))
    }

    /// Is this thread one of ours?
    pub fn is_watching(&self, thread_id: &str) -> bool {
        self.watched.lock().unwrap().contains_key(thread_id)
    }

    /// Re-arm supervision for a thread that was already running before a
    /// restart: its prompt was delivered in the previous session.
    pub fn watch_agent(&self, thread_id: &str, deadline_at: i64) {
        let mut watched = self.watched.lock().unwrap();
        if watched.contains_key(thread_id) {
            return;
        }
        watched.insert(
            thread_id.to_owned(),
            Watched {
                title: "Workflow step".to_owned(),
                deadline_at,
                sent: true,
                saw_idle: false,
                pending_permissions: Vec::new(),
                notified_question: false,
            },
        );
    }

    /// Feed one session event through supervision. The runtime's tap calls
    /// this for every event; anything about a thread we are not watching is
    /// ignored, so this is cheap on the common path.
    pub async fn observe(self: &Arc<Self>, event: &crate::sessions::SessionEvent) {
        let thread_id = event.key.thread_id.to_string();
        if !self.is_watching(&thread_id) {
            return;
        }
        match &event.event {
            // Idle is the end of a turn. The Rust runtime spells it as a
            // status flip rather than the TS `session.idle` event.
            EngineEvent::Status { busy: false } => {
                let ready = {
                    let mut watched = self.watched.lock().unwrap();
                    match watched.get_mut(&thread_id) {
                        Some(entry) if !entry.sent => {
                            entry.saw_idle = true;
                            false
                        }
                        Some(_) => true,
                        None => false,
                    }
                };
                if ready {
                    self.finish(&thread_id, AgentStatus::Success, None).await;
                }
            }
            EngineEvent::Error { message, fatal } if *fatal => {
                self.finish(&thread_id, AgentStatus::Failure, Some(message.clone())).await;
            }
            EngineEvent::PermissionRequested { request, .. } => {
                let fresh = {
                    let mut watched = self.watched.lock().unwrap();
                    match watched.get_mut(&thread_id) {
                        Some(entry) if !entry.pending_permissions.contains(request) => {
                            entry.pending_permissions.push(request.clone());
                            true
                        }
                        _ => false,
                    }
                };
                if fresh {
                    // The grace period is the user's chance to answer it
                    // themselves; after that an unattended run must not sit
                    // waiting on a prompt nobody is watching.
                    let host = self.clone();
                    let thread = thread_id.clone();
                    let request = request.clone();
                    let key = event.key.clone();
                    let Ok(rt) = self.runtime() else { return };
                    rt.handle.spawn(async move {
                        tokio::time::sleep(std::time::Duration::from_millis(PERMISSION_GRACE_MS)).await;
                        host.on_permission_timeout(&thread, &key, request).await;
                    });
                }
            }
            EngineEvent::RequestWithdrawn { request } => {
                let mut watched = self.watched.lock().unwrap();
                if let Some(entry) = watched.get_mut(&thread_id) {
                    entry.pending_permissions.retain(|r| r != request);
                }
            }
            EngineEvent::QuestionAsked { .. } => {
                let notice = {
                    let mut watched = self.watched.lock().unwrap();
                    match watched.get_mut(&thread_id) {
                        Some(entry) if !entry.notified_question => {
                            entry.notified_question = true;
                            Some(entry.title.clone())
                        }
                        _ => None,
                    }
                };
                if let Some(title) = notice {
                    self.notify(Notice {
                        title: format!("BOSS · {title}"),
                        body: "A workflow agent is waiting on a question. Open the thread to answer it.".to_owned(),
                        attention: true,
                        project_path: String::new(),
                        thread_id: Some(thread_id.clone()),
                    });
                }
            }
            _ => {}
        }
    }

    /// A permission prompt outlived its grace period: answer it so the run
    /// keeps moving. The TS only defers to the user in `ask` mode; the Rust
    /// runtime has no per-step mode yet, so an unattended step always
    /// allows once.
    async fn on_permission_timeout(&self, thread_id: &str, key: &SessionKey, request: RequestId) {
        let still_pending = {
            let mut watched = self.watched.lock().unwrap();
            match watched.get_mut(thread_id) {
                Some(entry) => {
                    let had = entry.pending_permissions.iter().any(|r| *r == request);
                    entry.pending_permissions.retain(|r| *r != request);
                    had
                }
                None => false,
            }
        };
        if !still_pending {
            return;
        }
        let Ok(rt) = self.runtime() else { return };
        let _ = rt
            .sessions
            .respond_permission(key, request, PermissionDecision::Allow { updated_input: None })
            .await;
    }

    /// Stop watching a thread, returning what it was watched with.
    fn unwatch(&self, thread_id: &str) -> Option<Watched> {
        self.watched.lock().unwrap().remove(thread_id)
    }

    /// One pass over the deadlines: stop any step past its budget. Driven by
    /// the same scheduler tick as cron, rather than a timer per step.
    pub async fn tick(&self, now_ms: i64) {
        let expired: Vec<String> = self
            .watched
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, w)| w.deadline_at <= now_ms)
            .map(|(id, _)| id.clone())
            .collect();
        for thread_id in expired {
            let _ = self.abort_session(&thread_id).await;
            self.finish(
                &thread_id,
                AgentStatus::Timeout,
                Some("The step exceeded its time budget and was stopped.".to_owned()),
            )
            .await;
        }
    }

    /// Settle a watched step and hand the outcome to whichever engine owns it.
    async fn finish(&self, thread_id: &str, status: AgentStatus, error: Option<String>) {
        let Some(_watch) = self.unwatch(thread_id) else { return };
        let mut outcome = AgentOutcome {
            status,
            summary: None,
            text: None,
            changed_files: 0,
            thread_id: thread_id.to_owned(),
            worktree_id: None,
            error,
        };
        // A failure has nothing to summarize: the conversation never got
        // going, and reading its transcript would only report the error back.
        if status != AgentStatus::Failure
            && let Ok(rt) = self.runtime()
        {
            let id = ThreadId::from_raw(thread_id);
            let messages = rt.load_messages(&id);
            outcome.summary = extract_summary(&messages);
            outcome.text = Some(last_assistant_text(&messages)).filter(|t| !t.is_empty());
            outcome.changed_files = changed_files(&rt, &id).await;
        }
        let sinks: Vec<Arc<dyn AgentSink>> =
            self.sinks.lock().unwrap().iter().filter_map(Weak::upgrade).collect();
        for sink in sinks {
            sink.on_agent_finished(thread_id, outcome.clone()).await;
        }
    }

    /// Close the session behind a thread, so an aborted step stops working.
    async fn abort_session(&self, thread_id: &str) -> Result<()> {
        let rt = self.runtime()?;
        let id = ThreadId::from_raw(thread_id);
        let Some(thread) = rt.state.thread(&id) else { return Ok(()) };
        let participant = rt.primary_participant(&thread)?;
        let key = SessionKey { thread_id: id, participant_id: participant.id };
        let _ = rt.sessions.interrupt(&key).await;
        let _ = rt.sessions.close(&key).await;
        Ok(())
    }

    /// The project a step runs in, and the checkout it starts from.
    fn scope(&self, rt: &Runtime, request: &AgentRequest) -> Result<(Option<Project>, PathBuf)> {
        // Sharing a prior step's checkout: the reviewer reads what the
        // implementer wrote. Ownership stays with the original thread.
        if let Some(owner) = &request.in_worktree_of {
            let owner = rt
                .state
                .thread(&ThreadId::from_raw(owner))
                .ok_or_else(|| anyhow!("The step whose worktree this one should share no longer exists."))?;
            let project = owner.project_id.as_ref().and_then(|id| rt.state.project(id));
            return Ok((project, owner.cwd));
        }
        if request.project_path.trim().is_empty() {
            return Ok((None, Thread::cwd_for(None)));
        }
        let root = PathBuf::from(&request.project_path);
        let project = rt
            .state
            .project_by_root(&root)
            .ok_or_else(|| anyhow!("That project is not open in BOSS."))?;
        let root = project.root.clone();
        Ok((Some(project), root))
    }
}

#[async_trait]
impl AutomationHost for RuntimeHost {
    async fn start_agent(&self, request: AgentRequest) -> Result<StartedAgent> {
        let rt = self.runtime()?;
        let (project, base) = self.scope(&rt, &request)?;

        // `none` runs in the global scope: a judge or an analysis step has no
        // business holding a checkout.
        let wants_worktree = request.in_worktree_of.is_none()
            && request.workspace == AutomationWorkspace::Worktree
            && project.is_some();
        let worktree = match wants_worktree {
            true => Some(rt.bus_handler().worktrees().create(&base, &request.title).await?),
            false => None,
        };

        let engine = match request.engine.as_deref() {
            Some(name) if !name.trim().is_empty() => rooms::parse_engine(name)
                .ok_or_else(|| anyhow!("Unknown agent backend \"{name}\"."))?,
            _ => rt.settings.get().default_engine,
        };
        let cwd = worktree.as_ref().map(|w| w.path.clone()).unwrap_or(base);
        let scoped = match request.workspace {
            // A step that wants no workspace still needs somewhere to run;
            // the global scope is the user's home, as `Thread::cwd_for` says.
            AutomationWorkspace::None if request.in_worktree_of.is_none() => None,
            _ => project.as_ref(),
        };
        let thread = match rt.new_chat(scoped, engine, Some(request.title.clone())) {
            Ok(thread) => thread,
            Err(e) => {
                if let Some(worktree) = &worktree {
                    let _ = rt.bus_handler().worktrees().remove(&worktree.path).await;
                }
                return Err(e);
            }
        };
        let thread = rt
            .state
            .update_thread(&thread.id, |t| t.cwd = cwd)?
            .ok_or_else(|| anyhow!("The step's conversation could not be registered."))?;
        let thread_id = thread.id.to_string();

        self.watched.lock().unwrap().insert(
            thread_id.clone(),
            Watched {
                title: request.title.clone(),
                deadline_at: time::OffsetDateTime::now_utc().unix_timestamp() * 1_000
                    + (request.max_minutes * 60_000.0) as i64,
                sent: false,
                saw_idle: false,
                pending_permissions: Vec::new(),
                notified_question: false,
            },
        );

        // The engine journals the thread id now; delivery runs in the
        // background and completion arrives through session events.
        let participant = Participant {
            model: request.model.clone().or_else(|| participant_model(&rt, engine)),
            ..rt.primary_participant(&thread)?
        };
        let host_for_send = self.self_ref.get().cloned().unwrap_or_default();
        let prompt = Prompt { text: request.prompt.clone(), attachments: vec![] };
        let sent_thread = thread.clone();
        let sent_id = thread_id.clone();
        let send_rt = rt.clone();
        rt.handle.spawn(async move {
            match send_rt.send(&sent_thread, &participant, prompt).await {
                Ok(_) => {
                    let finish_now = {
                        let Some(host) = host_for_send.upgrade() else { return };
                        let mut watched = host.watched.lock().unwrap();
                        match watched.get_mut(&sent_id) {
                            Some(entry) => {
                                entry.sent = true;
                                // An engine whose send resolves only after
                                // the work is done already went idle; that
                                // event was ignored while `sent` was false.
                                entry.saw_idle && !send_rt.is_busy(&sent_thread.id)
                            }
                            None => false,
                        }
                    };
                    if finish_now && let Some(host) = host_for_send.upgrade() {
                        host.finish(&sent_id, AgentStatus::Success, None).await;
                    }
                }
                Err(error) => {
                    if let Some(host) = host_for_send.upgrade() {
                        host.finish(&sent_id, AgentStatus::Failure, Some(error.to_string())).await;
                    }
                }
            }
        });

        Ok(StartedAgent {
            thread_id,
            // The worktree is identified by its path: this runtime keeps no
            // worktree registry, because a thread's checkout is its `cwd`.
            worktree_id: worktree.map(|w| w.path.to_string_lossy().into_owned()),
        })
    }

    fn is_agent_active(&self, thread_id: &str) -> bool {
        match self.runtime() {
            Ok(rt) => rt.is_busy(&ThreadId::from_raw(thread_id)),
            Err(_) => false,
        }
    }

    async fn collect_outcome(&self, thread_id: &str) -> Option<AgentOutcome> {
        let rt = self.runtime().ok()?;
        let id = ThreadId::from_raw(thread_id);
        rt.state.thread(&id)?;
        let messages = rt.load_messages(&id);
        let text = last_assistant_text(&messages);
        if text.is_empty() {
            return None;
        }
        Some(AgentOutcome {
            status: AgentStatus::Success,
            summary: extract_summary(&messages),
            text: Some(text),
            changed_files: changed_files(&rt, &id).await,
            thread_id: thread_id.to_owned(),
            worktree_id: None,
            error: None,
        })
    }

    async fn abort_agent(&self, thread_id: &str) -> Result<()> {
        self.unwatch(thread_id);
        let _ = self.abort_session(thread_id).await;
        Ok(())
    }

    fn notify(&self, notice: Notice) {
        let Ok(rt) = self.runtime() else { return };
        rt.notify.publish(NotifyEvent {
            kind: match notice.attention {
                true => NotifyEventType::WorkflowNeedsAttention,
                false => NotifyEventType::WorkflowCompleted,
            },
            title: notice.title,
            body: notice.body,
            thread_id: notice.thread_id,
            project_path: Some(notice.project_path).filter(|p| !p.is_empty()),
            created_at: now_ms(),
        });
    }

    async fn deliver_to_thread(&self, thread_id: &str, body: &str) -> Result<()> {
        let rt = self.runtime()?;
        let id = ThreadId::from_raw(thread_id);
        let thread = rt.state.thread(&id).ok_or_else(|| anyhow!("That conversation no longer exists."))?;
        let participant = rt.primary_participant(&thread)?;
        rt.send(&thread, &participant, Prompt { text: body.to_owned(), attachments: vec![] }).await?;
        Ok(())
    }

    async fn dispose_thread(&self, thread_id: &str, worktree_id: Option<&str>) -> Result<()> {
        let rt = self.runtime()?;
        let _ = self.abort_agent(thread_id).await;
        let _ = rt.state.remove_thread(&ThreadId::from_raw(thread_id));
        if let Some(worktree) = worktree_id {
            let _ = self.remove_worktree(worktree).await;
        }
        Ok(())
    }

    async fn remove_worktree(&self, worktree_id: &str) -> Result<()> {
        let rt = self.runtime()?;
        let path = PathBuf::from(worktree_id);
        if !crate::worktree::is_worktree(&path).await {
            return Ok(());
        }
        rt.bus_handler().worktrees().remove(&path).await
    }

    async fn record_report(&self, outcome: RunOutcome) -> Result<()> {
        let rt = self.runtime()?;
        rt.reports.create_from_automation(
            ReportSource::Automation {
                automation_id: outcome.automation_id,
                automation_name: outcome.automation_name,
                run_id: outcome.run_id,
                status: outcome.status,
            },
            outcome.thread_id,
            outcome.project_path,
            &outcome.title,
            outcome.summary.as_deref(),
            &outcome.body,
            now_ms(),
        )?;
        Ok(())
    }
}

#[async_trait]
impl WorkflowHost for RuntimeHost {
    async fn create_change_request(
        &self,
        thread_id: &str,
        title: Option<&str>,
        body: Option<&str>,
        base_branch: Option<&str>,
        draft: bool,
    ) -> Result<serde_json::Value> {
        let rt = self.runtime()?;
        let thread = rt
            .state
            .thread(&ThreadId::from_raw(thread_id))
            .ok_or_else(|| anyhow!("The agent conversation backing this step no longer exists."))?;
        // The same `gh pr create` the `boss_git_create_change_request` tool
        // runs, from the step's own checkout.
        let mut cmd = tokio::process::Command::new("gh");
        cmd.current_dir(&thread.cwd).arg("pr").arg("create");
        match (title.unwrap_or_default(), body.unwrap_or_default()) {
            ("", "") => {
                cmd.arg("--fill");
            }
            (title, body) => {
                cmd.args(["--title", title, "--body", body]);
            }
        }
        if let Some(base) = base_branch.filter(|b| !b.is_empty()) {
            cmd.args(["--base", base]);
        }
        if draft {
            cmd.arg("--draft");
        }
        let out = cmd.output().await?;
        if !out.status.success() {
            bail!(String::from_utf8_lossy(&out.stderr).trim().to_string());
        }
        Ok(serde_json::json!({ "url": String::from_utf8_lossy(&out.stdout).trim() }))
    }
}

/// Epoch milliseconds.
fn now_ms() -> i64 {
    (time::OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000) as i64
}

/// The engine's configured default model, so an unattended step runs on the
/// same model an interactive thread would.
fn participant_model(rt: &Runtime, engine: EngineId) -> Option<String> {
    rt.settings.get().default_model(engine).map(str::to_owned)
}

/// The text of a thread's most recent assistant reply. Port of
/// `lastAssistantText` in `src/shared/thread-result.ts`.
pub fn last_assistant_text(messages: &[Message]) -> String {
    messages
        .iter()
        .rev()
        .take(OUTCOME_MESSAGE_LIMIT)
        .find(|m| m.role == Role::Assistant)
        .map(|m| m.text())
        .unwrap_or_default()
}

/// A one-line summary of what a thread finished doing. Port of
/// `extractSummary`: an explicit `SUMMARY:` line wins, because the prompt
/// asked for one; otherwise the last non-empty line, which is where an agent
/// that was not asked puts its conclusion.
pub fn extract_summary(messages: &[Message]) -> Option<String> {
    let text = last_assistant_text(messages);
    let summary = text
        .lines()
        .filter_map(|line| {
            let trimmed = line.trim_start();
            let rest = trimmed.get(..8).filter(|p| p.eq_ignore_ascii_case("SUMMARY:"))?;
            let _ = rest;
            let value = trimmed[8..].trim();
            (!value.is_empty()).then(|| value.to_owned())
        })
        .next_back()
        .or_else(|| text.lines().map(str::trim).filter(|l| !l.is_empty()).next_back().map(str::to_owned))?;
    let clipped: String = summary.chars().take(MAX_SUMMARY).collect();
    Some(clipped).filter(|s| !s.is_empty())
}

/// How many files a step changed, from git in its checkout. The TS counts
/// `thread.diff` entries; this runtime has no per-thread diff, so it asks
/// git in the thread's own directory, which is the same set for a worktree.
async fn changed_files(rt: &Runtime, thread_id: &ThreadId) -> u32 {
    let Some(thread) = rt.state.thread(thread_id) else { return 0 };
    let out = tokio::process::Command::new("git")
        .arg("-C")
        .arg(&thread.cwd)
        .args(["status", "--porcelain"])
        .output()
        .await;
    match out {
        Ok(out) if out.status.success() => {
            String::from_utf8_lossy(&out.stdout).lines().filter(|l| !l.trim().is_empty()).count() as u32
        }
        _ => 0,
    }
}
