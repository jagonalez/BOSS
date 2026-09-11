//! The automation run loop: scheduled and webhook-triggered prompts.
//!
//! Port of `src/main/automation-manager.ts`. An automation is one prompt run
//! unattended in a fresh thread on a cron schedule, on a GitHub webhook, or
//! on demand. The manager owns the schedule, the overlap policy, the run
//! budget, and the run history.
//!
//! What a run needs from the rest of BOSS goes through
//! [`AutomationHost`](super::host::AutomationHost), so the whole loop is
//! testable against a fake that never starts a process.

use super::bus::Clock;
use super::cron::{cron_error, missed_cron_fires_in, next_cron_time_in};
use super::github::{self, GitHubDelivery};
use super::host::{
    AgentRequest, AutomationHost, Notice, RunOutcome, automation_header,
};
use super::store::AutomationStore;
use super::types::*;
use anyhow::{Result, bail};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

/// What a webhook delivery did to the automation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DeliveryResult {
    Started,
    Queued,
    Skipped,
}

/// A delivery that could not be accepted, carrying the HTTP status the hook
/// endpoint should answer with.
#[derive(Debug, thiserror::Error)]
#[error("{message}")]
pub struct DeliveryError {
    pub message: String,
    pub status: u16,
}

/// A run in flight, and what it is waiting on.
#[derive(Debug)]
struct ActiveRun {
    run_id: String,
    thread_id: Option<String>,
    /// When the run's own clock runs out.
    deadline_at: i64,
    /// Set when a trigger arrived while this run held the slot and the
    /// policy is `queue`.
    queued_trigger: Option<AutomationRunTrigger>,
    /// True once the prompt was delivered; an idle event before that must
    /// not finish the run.
    sent: bool,
    /// True when an idle event arrived before the prompt delivery resolved.
    saw_idle: bool,
}

/// Runs automations: the schedule, the runs, and their history.
pub struct AutomationManager {
    store: Arc<AutomationStore>,
    host: Arc<dyn AutomationHost>,
    clock: Arc<dyn Clock>,
    /// One active run per automation, keyed by automation id.
    active: Mutex<HashMap<String, ActiveRun>>,
}

impl AutomationManager {
    pub fn new(store: Arc<AutomationStore>, host: Arc<dyn AutomationHost>, clock: Arc<dyn Clock>) -> Arc<Self> {
        Arc::new(Self { store, host, clock, active: Mutex::new(HashMap::new()) })
    }

    pub fn store(&self) -> &Arc<AutomationStore> {
        &self.store
    }

    /// Everything the UI and the phone show.
    pub fn snapshot(&self) -> serde_json::Value {
        serde_json::json!({
            "automations": self.store.automations(),
            "runs": self.store.runs(),
        })
    }

    // -------------------------------------------------------------- CRUD

    /// Reject an input the engine cannot run, and normalize what it can.
    ///
    /// A projectless automation has nowhere to make a worktree, so its
    /// workspace collapses to `none` — the TS does the same rather than
    /// failing a run later.
    fn normalize(&self, mut input: AutomationInput) -> Result<AutomationInput> {
        input.name = input.name.trim().to_owned();
        if input.name.is_empty() {
            bail!("Give the automation a name.");
        }
        if input.prompt.trim().is_empty() {
            bail!("Give the automation a prompt.");
        }
        if input.schedule.kind == AutomationScheduleKind::Cron {
            let expression = input.schedule.expression.clone().unwrap_or_default();
            if let Some(problem) = cron_error(&expression) {
                bail!(problem);
            }
        }
        if let Some(webhook) = &mut input.webhook {
            webhook.events.retain(|event| AUTOMATION_WEBHOOK_EVENTS.contains(&event.as_str()));
            webhook.branch = webhook.branch.as_ref().map(|b| b.trim().to_owned()).filter(|b| !b.is_empty());
        }
        input.project_path = input.project_path.trim().to_owned();
        if input.project_path.is_empty() {
            input.workspace = AutomationWorkspace::None;
        }
        input.max_run_minutes = input.max_run_minutes.clamp(1, 24 * 60);
        input.keep_runs = input.keep_runs.clamp(1, 500);
        Ok(input)
    }

    /// The next fire time for an automation, or `None` when it has no cron
    /// schedule or is disabled.
    fn next_run_at(&self, enabled: bool, schedule: &AutomationSchedule, after: i64) -> Option<i64> {
        if !enabled || schedule.kind != AutomationScheduleKind::Cron {
            return None;
        }
        next_cron_time_in(schedule.expression.as_deref()?, after, self.clock.offset())
    }

    pub fn create(&self, input: AutomationInput) -> Result<Automation> {
        let clean = self.normalize(input)?;
        let now = self.clock.now_ms();
        let automation = Automation {
            id: uuid::Uuid::new_v4().to_string(),
            name: clean.name,
            prompt: clean.prompt,
            project_path: clean.project_path,
            backend_id: clean.backend_id,
            model: clean.model,
            mode: clean.mode,
            next_run_at: self.next_run_at(true, &clean.schedule, now),
            schedule: clean.schedule,
            webhook: clean.webhook,
            workspace: clean.workspace,
            overlap_policy: clean.overlap_policy,
            catch_up: clean.catch_up,
            notify: clean.notify,
            max_run_minutes: clean.max_run_minutes,
            keep_runs: clean.keep_runs,
            enabled: true,
            last_run_at: None,
            last_webhook_at: None,
            last_webhook_label: None,
            missed_runs: 0,
            created_at: now,
            updated_at: now,
        };
        if automation.webhook.is_some() {
            self.store.ensure_webhook_token(&automation.id);
        }
        self.store.upsert_automation(automation.clone());
        self.store.save()?;
        Ok(automation)
    }

    /// Apply a patch. Editing clears `missedRuns` and re-derives the next
    /// fire time, so a schedule change takes effect immediately.
    pub fn update(&self, id: &str, patch: AutomationPatch) -> Result<Automation> {
        let existing = self.store.automation(id).ok_or_else(|| anyhow::anyhow!("Automation not found."))?;
        let merged = AutomationInput {
            name: patch.name.unwrap_or(existing.name),
            prompt: patch.prompt.unwrap_or(existing.prompt),
            project_path: patch.project_path.unwrap_or(existing.project_path),
            backend_id: patch.backend_id.unwrap_or(existing.backend_id),
            model: patch.model.or(existing.model),
            mode: patch.mode.unwrap_or(existing.mode),
            schedule: patch.schedule.unwrap_or(existing.schedule),
            // `Some(None)` clears the webhook; `None` leaves it alone.
            webhook: match patch.webhook {
                Some(webhook) => webhook,
                None => existing.webhook,
            },
            workspace: patch.workspace.unwrap_or(existing.workspace),
            overlap_policy: patch.overlap_policy.unwrap_or(existing.overlap_policy),
            catch_up: patch.catch_up.unwrap_or(existing.catch_up),
            notify: patch.notify.unwrap_or(existing.notify),
            max_run_minutes: patch.max_run_minutes.unwrap_or(existing.max_run_minutes),
            keep_runs: patch.keep_runs.unwrap_or(existing.keep_runs),
        };
        let clean = self.normalize(merged)?;
        let enabled = patch.enabled.unwrap_or(existing.enabled);
        let now = self.clock.now_ms();
        let next_run_at = self.next_run_at(enabled, &clean.schedule, now);
        let has_webhook = clean.webhook.is_some();
        self.store.update_automation(id, |automation| {
            automation.name = clean.name;
            automation.prompt = clean.prompt;
            automation.project_path = clean.project_path;
            automation.backend_id = clean.backend_id;
            automation.model = clean.model;
            automation.mode = clean.mode;
            automation.schedule = clean.schedule;
            automation.webhook = clean.webhook;
            automation.workspace = clean.workspace;
            automation.overlap_policy = clean.overlap_policy;
            automation.catch_up = clean.catch_up;
            automation.notify = clean.notify;
            automation.max_run_minutes = clean.max_run_minutes;
            automation.keep_runs = clean.keep_runs;
            automation.enabled = enabled;
            automation.updated_at = now;
            automation.missed_runs = 0;
            automation.next_run_at = next_run_at;
        });
        if has_webhook {
            self.store.ensure_webhook_token(id);
        } else {
            self.store.drop_webhook_token(id);
        }
        self.store.save()?;
        self.store.automation(id).ok_or_else(|| anyhow::anyhow!("Automation not found."))
    }

    pub async fn delete(&self, id: &str) -> Result<()> {
        if self.active.lock().unwrap().contains_key(id) {
            let _ = self.stop_run(id).await;
        }
        self.store.drop_automation(id);
        self.store.save()?;
        Ok(())
    }

    // -------------------------------------------------------- the schedule

    /// Catch up on fires missed while the app was closed.
    ///
    /// An automation with `catchUp` runs once for the whole gap, no matter
    /// how many fires it covers, and counts the rest as missed. Without
    /// `catchUp` every missed fire is only counted.
    pub async fn catch_up(&self) -> Result<()> {
        let now = self.clock.now_ms();
        let offset = self.clock.offset();
        let mut to_start = Vec::new();
        let mut changed = false;
        for automation in self.store.automations() {
            if automation.schedule.kind != AutomationScheduleKind::Cron {
                continue;
            }
            let Some(expression) = automation.schedule.expression.clone() else { continue };
            if let Some(due) = automation.next_run_at.filter(|at| automation.enabled && *at <= now) {
                let missed = missed_cron_fires_in(&expression, due - 1, now, 500, offset) as u32;
                if automation.catch_up && missed > 0 {
                    // One run covers the gap; the others are only counted.
                    self.store.update_automation(&automation.id, |a| a.missed_runs += missed - 1);
                    to_start.push(automation.id.clone());
                } else {
                    self.store.update_automation(&automation.id, |a| a.missed_runs += missed);
                }
                changed = true;
            }
            let next = next_cron_time_in(&expression, now, offset);
            if automation.next_run_at != next {
                self.store.update_automation(&automation.id, |a| a.next_run_at = next);
                changed = true;
            }
        }
        if changed {
            self.store.save()?;
        }
        for id in to_start {
            let _ = self.start_run(&id, AutomationRunTrigger::CatchUp, None).await;
        }
        Ok(())
    }

    /// One scheduler pass: start whatever is due and re-arm it.
    ///
    /// The next fire time is written *before* the run starts, so a run that
    /// outlives the interval cannot make the automation fire twice for the
    /// same slot.
    pub async fn tick(&self) -> Result<()> {
        let now = self.clock.now_ms();
        let offset = self.clock.offset();
        let mut to_start = Vec::new();
        let mut changed = false;
        for automation in self.store.automations() {
            if !automation.enabled || automation.schedule.kind != AutomationScheduleKind::Cron {
                continue;
            }
            let Some(expression) = automation.schedule.expression.clone() else { continue };
            match automation.next_run_at {
                // First sight of an enabled cron automation: just arm it.
                None => {
                    self.store
                        .update_automation(&automation.id, |a| a.next_run_at = next_cron_time_in(&expression, now, offset));
                    changed = true;
                }
                Some(at) if at <= now => {
                    self.store
                        .update_automation(&automation.id, |a| a.next_run_at = next_cron_time_in(&expression, now, offset));
                    changed = true;
                    to_start.push(automation.id.clone());
                }
                Some(_) => {}
            }
        }
        if changed {
            self.store.save()?;
        }
        for id in to_start {
            let _ = self.start_run(&id, AutomationRunTrigger::Schedule, None).await;
        }
        // A run whose clock ran out while nothing else was happening.
        self.enforce_deadlines().await?;
        Ok(())
    }

    /// Finish any run that has outlived its `maxRunMinutes`.
    async fn enforce_deadlines(&self) -> Result<()> {
        let now = self.clock.now_ms();
        let overdue: Vec<String> = self
            .active
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, active)| active.deadline_at <= now)
            .map(|(id, _)| id.clone())
            .collect();
        for id in overdue {
            let minutes = self.store.automation(&id).map(|a| a.max_run_minutes).unwrap_or(0);
            let thread = self.active.lock().unwrap().get(&id).and_then(|a| a.thread_id.clone());
            if let Some(thread) = thread {
                let _ = self.host.abort_agent(&thread).await;
            }
            self.finish_run(
                &id,
                AutomationRunStatus::Timeout,
                Some(format!("The run exceeded {minutes} minutes and was stopped.")),
            )
            .await?;
        }
        Ok(())
    }

    // ------------------------------------------------------------- running

    /// Run this automation now. Refuses when one is already in flight — a
    /// manual run is a deliberate act, so it says so rather than silently
    /// recording a skip.
    pub async fn run_now(&self, id: &str) -> Result<()> {
        if self.active.lock().unwrap().contains_key(id) {
            bail!("This automation is already running. Stop the active run first.");
        }
        self.start_run(id, AutomationRunTrigger::Manual, None).await?;
        Ok(())
    }

    /// Start a run, honouring the overlap policy.
    async fn start_run(
        &self,
        id: &str,
        trigger: AutomationRunTrigger,
        prompt_vars: Option<std::collections::BTreeMap<String, String>>,
    ) -> Result<DeliveryResult> {
        let Some(automation) = self.store.automation(id) else {
            bail!("Automation not found.");
        };
        let now = self.clock.now_ms();

        // The slot is taken: queue behind it or record a skip.
        {
            let mut active = self.active.lock().unwrap();
            if let Some(existing) = active.get_mut(id) {
                if automation.overlap_policy == AutomationOverlapPolicy::Queue {
                    existing.queued_trigger = Some(trigger);
                    return Ok(DeliveryResult::Queued);
                }
                drop(active);
                self.store.push_run(AutomationRun {
                    id: uuid::Uuid::new_v4().to_string(),
                    automation_id: automation.id.clone(),
                    thread_id: None,
                    worktree_id: None,
                    trigger,
                    status: AutomationRunStatus::Skipped,
                    summary: None,
                    error: Some("The previous run was still active.".to_owned()),
                    needs_attention: None,
                    changed_files: 0,
                    started_at: now,
                    finished_at: Some(now),
                });
                self.store.save()?;
                return Ok(DeliveryResult::Skipped);
            }
        }

        let run = AutomationRun {
            id: uuid::Uuid::new_v4().to_string(),
            automation_id: automation.id.clone(),
            thread_id: None,
            worktree_id: None,
            trigger,
            status: AutomationRunStatus::Running,
            summary: None,
            error: None,
            needs_attention: None,
            changed_files: 0,
            started_at: now,
            finished_at: None,
        };
        let run_id = run.id.clone();
        self.store.push_run(run);
        self.store.update_automation(id, |a| {
            a.last_run_at = Some(now);
            a.missed_runs = 0;
        });
        self.active.lock().unwrap().insert(
            automation.id.clone(),
            ActiveRun {
                run_id: run_id.clone(),
                thread_id: None,
                deadline_at: now + automation.max_run_minutes as i64 * 60_000,
                queued_trigger: None,
                sent: false,
                saw_idle: false,
            },
        );
        self.store.save()?;

        let prompt = match &prompt_vars {
            Some(vars) => github::template_prompt(&automation.prompt, vars),
            None => automation.prompt.clone(),
        };
        let request = AgentRequest {
            run_id: run_id.clone(),
            seq: 0,
            project_path: automation.project_path.clone(),
            title: format!("{} · {}", automation.name, format_stamp(now)),
            prompt: automation_header(&automation.name, &prompt),
            engine: Some(automation.backend_id.clone()),
            model: automation.model.as_ref().and_then(|m| m.as_str()).map(str::to_owned),
            workspace: automation.workspace,
            in_worktree_of: None,
            max_minutes: automation.max_run_minutes as f64,
        };
        match self.host.start_agent(request).await {
            Ok(started) => {
                self.store.update_run(&run_id, |run| {
                    run.thread_id = Some(started.thread_id.clone());
                    run.worktree_id = started.worktree_id.clone();
                });
                let finish_now = {
                    let mut active = self.active.lock().unwrap();
                    match active.get_mut(&automation.id) {
                        Some(entry) => {
                            entry.thread_id = Some(started.thread_id.clone());
                            entry.sent = true;
                            // An engine whose send resolves only after the
                            // work is done already went idle; that event was
                            // ignored while `sent` was false, so finish here.
                            entry.saw_idle && !self.host.is_agent_active(&started.thread_id)
                        }
                        // Stopped while we were starting.
                        None => false,
                    }
                };
                self.store.save()?;
                if finish_now {
                    self.finish_run(&automation.id, AutomationRunStatus::Success, None).await?;
                }
                Ok(DeliveryResult::Started)
            }
            Err(error) => {
                self.finish_run(&automation.id, AutomationRunStatus::Failure, Some(error.to_string())).await?;
                Ok(DeliveryResult::Started)
            }
        }
    }

    /// Stop the active run of an automation.
    pub async fn stop_run(&self, id: &str) -> Result<()> {
        let thread = {
            let mut active = self.active.lock().unwrap();
            let Some(entry) = active.get_mut(id) else {
                bail!("This automation has no active run.");
            };
            entry.queued_trigger = None;
            entry.thread_id.clone()
        };
        if let Some(thread) = thread {
            let _ = self.host.abort_agent(&thread).await;
        }
        self.finish_run(id, AutomationRunStatus::Aborted, None).await
    }

    /// Stop every run, e.g. at shutdown. The runs are recorded as aborted so
    /// nothing is left looking live in the history.
    pub async fn stop_all(&self) -> Result<()> {
        let ids: Vec<String> = self.active.lock().unwrap().keys().cloned().collect();
        for id in ids {
            let _ = self
                .finish_run(
                    &id,
                    AutomationRunStatus::Aborted,
                    Some("The app quit while this run was active.".to_owned()),
                )
                .await;
        }
        Ok(())
    }

    /// The automation whose active run owns this thread.
    fn automation_for_thread(&self, thread_id: &str) -> Option<String> {
        self.active
            .lock()
            .unwrap()
            .iter()
            .find(|(_, active)| active.thread_id.as_deref() == Some(thread_id))
            .map(|(id, _)| id.clone())
    }

    /// A thread this manager is watching went idle: its run succeeded.
    ///
    /// An idle that arrives before the prompt delivery resolved is only
    /// remembered — the engine has not started yet, and finishing here would
    /// record a run that never ran.
    pub async fn on_thread_idle(&self, thread_id: &str) -> Result<()> {
        let Some(id) = self.automation_for_thread(thread_id) else { return Ok(()) };
        let ready = {
            let mut active = self.active.lock().unwrap();
            match active.get_mut(&id) {
                Some(entry) if !entry.sent => {
                    entry.saw_idle = true;
                    false
                }
                Some(_) => true,
                None => false,
            }
        };
        if ready {
            self.finish_run(&id, AutomationRunStatus::Success, None).await?;
        }
        Ok(())
    }

    /// A thread this manager is watching reported an error: its run failed.
    pub async fn on_thread_error(&self, thread_id: &str, detail: &str) -> Result<()> {
        let Some(id) = self.automation_for_thread(thread_id) else { return Ok(()) };
        self.finish_run(&id, AutomationRunStatus::Failure, Some(detail.to_owned())).await
    }

    /// A thread this manager is watching asked the user something. The run
    /// keeps going — only a person can unblock it — but it is flagged and
    /// the user is told.
    pub fn on_thread_question(&self, thread_id: &str) -> Result<()> {
        let Some(id) = self.automation_for_thread(thread_id) else { return Ok(()) };
        let Some(automation) = self.store.automation(&id) else { return Ok(()) };
        let run_id = self.active.lock().unwrap().get(&id).map(|a| a.run_id.clone());
        if let Some(run_id) = run_id {
            self.store.update_run(&run_id, |run| run.needs_attention = Some(true));
        }
        self.notify(
            &automation,
            format!("\"{}\" is waiting on a question. Open the run to answer it.", automation.name),
            true,
            thread_id,
        );
        self.store.save()?;
        Ok(())
    }

    /// Record a run's ending, tidy up after it, and start whatever queued
    /// behind it.
    async fn finish_run(&self, id: &str, status: AutomationRunStatus, error: Option<String>) -> Result<()> {
        let Some(active) = self.active.lock().unwrap().remove(id) else { return Ok(()) };
        let Some(automation) = self.store.automation(id) else { return Ok(()) };
        let now = self.clock.now_ms();

        // A failure has nothing to summarize: the thread never got going.
        let outcome = match (&active.thread_id, status) {
            (Some(thread), s) if s != AutomationRunStatus::Failure => self.host.collect_outcome(thread).await,
            _ => None,
        };

        let mut changed_files = 0;
        self.store.update_run(&active.run_id, |run| {
            run.status = status;
            run.finished_at = Some(now);
            if let Some(error) = &error {
                run.error = Some(error.clone());
            }
            if let Some(outcome) = &outcome {
                if outcome.summary.is_some() {
                    run.summary = outcome.summary.clone();
                }
                run.changed_files = outcome.changed_files;
                changed_files = outcome.changed_files;
            }
        });

        // A clean worktree has no review value. `remove` refuses a dirty one,
        // which is what keeps real changes safe.
        let worktree = self.store.runs().into_iter().find(|r| r.id == active.run_id).and_then(|r| r.worktree_id);
        if let Some(worktree) = worktree.filter(|_| changed_files == 0) {
            let _ = self.host.remove_worktree(&worktree).await;
        }

        let run = self.store.runs().into_iter().find(|r| r.id == active.run_id);
        let thread_id = active.thread_id.clone().unwrap_or_default();
        match status {
            AutomationRunStatus::Failure | AutomationRunStatus::Timeout => {
                let what = if status == AutomationRunStatus::Timeout { "timed out" } else { "failed" };
                let detail = match run.as_ref().and_then(|r| r.error.clone()) {
                    Some(error) => format!(": {error}"),
                    None => ".".to_owned(),
                };
                self.notify(&automation, format!("\"{}\" {what}{detail}", automation.name), true, &thread_id);
            }
            AutomationRunStatus::Success if changed_files > 0 => {
                let plural = if changed_files == 1 { "" } else { "s" };
                self.notify(
                    &automation,
                    format!("\"{}\" finished with {changed_files} changed file{plural}.", automation.name),
                    false,
                    &thread_id,
                );
            }
            AutomationRunStatus::Success if automation.notify == AutomationNotifyMode::Always => {
                let summary = run.as_ref().and_then(|r| r.summary.clone()).unwrap_or_else(|| "finished.".to_owned());
                self.notify(&automation, format!("\"{}\": {summary}", automation.name), false, &thread_id);
            }
            _ => {}
        }

        // Hand a finished run to the reports store, so a run that produced
        // something worth keeping leaves an artifact behind.
        if let Some(run) = run.as_ref().filter(|r| r.status == AutomationRunStatus::Success) {
            if let Some(body) = outcome.as_ref().and_then(|o| o.text.clone()).filter(|t| !t.trim().is_empty()) {
                let _ = self
                    .host
                    .record_report(RunOutcome {
                        automation_id: automation.id.clone(),
                        automation_name: automation.name.clone(),
                        run_id: run.id.clone(),
                        status: "success".to_owned(),
                        project_path: automation.project_path.clone(),
                        thread_id: run.thread_id.clone(),
                        title: format!("{} · {}", automation.name, format_stamp(run.started_at)),
                        summary: run.summary.clone(),
                        body,
                    })
                    .await;
            }
        }

        self.prune_runs(&automation).await?;
        self.store.save()?;

        if let Some(trigger) = active.queued_trigger {
            // Box breaks the start_run → finish_run → start_run cycle.
            let _ = Box::pin(self.start_run(id, trigger, None)).await;
        }
        Ok(())
    }

    /// Drop run history past this automation's `keepRuns`, taking the
    /// threads and worktrees with it.
    async fn prune_runs(&self, automation: &Automation) -> Result<()> {
        let excess = self.store.prune_candidates(&automation.id);
        if excess.is_empty() {
            return Ok(());
        }
        for run in &excess {
            if let Some(thread) = &run.thread_id {
                let _ = self.host.dispose_thread(thread, run.worktree_id.as_deref()).await;
            } else if let Some(worktree) = &run.worktree_id {
                let _ = self.host.remove_worktree(worktree).await;
            }
        }
        let ids: Vec<String> = excess.into_iter().map(|run| run.id).collect();
        self.store.drop_runs(&ids);
        Ok(())
    }

    fn notify(&self, automation: &Automation, body: String, attention: bool, thread_id: &str) {
        if automation.notify == AutomationNotifyMode::Off {
            return;
        }
        self.host.notify(Notice {
            title: format!("BOSS · {}", automation.name),
            body,
            attention,
            project_path: automation.project_path.clone(),
            thread_id: if thread_id.is_empty() { None } else { Some(thread_id.to_owned()) },
        });
    }

    // ------------------------------------------------------------ webhooks

    /// Entry point for the hook endpoint.
    ///
    /// The token is compared in constant time, and an unknown id and an
    /// unknown token are indistinguishable to the caller — otherwise the
    /// endpoint would confirm which automations exist.
    pub async fn deliver_webhook(
        &self,
        id: &str,
        token: &str,
        event_header: Option<&str>,
        body: &serde_json::Value,
    ) -> std::result::Result<DeliveryResult, DeliveryError> {
        let stored = self.store.webhook_token(id);
        let automation = self.store.automation(id);
        let authorized = match (&stored, &automation) {
            (Some(stored), Some(_)) => constant_time_eq(stored.as_bytes(), token.as_bytes()),
            _ => false,
        };
        if !authorized {
            return Err(DeliveryError { message: "Unknown automation or token.".to_owned(), status: 404 });
        }
        let automation = automation.expect("checked above");
        let Some(delivery) = github::parse_delivery(event_header, body) else {
            return Err(DeliveryError {
                message: "The payload must be a JSON object with a GitHub event header.".to_owned(),
                status: 400,
            });
        };
        let now = self.clock.now_ms();
        let label = github::describe_delivery(&delivery);
        self.store.update_automation(id, |a| {
            a.last_webhook_at = Some(now);
            a.last_webhook_label = Some(label);
        });
        let _ = self.store.save();
        if !automation.enabled || !github::trigger_matches(automation.webhook.as_ref(), &delivery) {
            return Ok(DeliveryResult::Skipped);
        }
        self.start_run(id, AutomationRunTrigger::Webhook, Some(github::payload_variables(&delivery)))
            .await
            .map_err(|error| DeliveryError { message: error.to_string(), status: 500 })
    }

    /// The [`BossEvent`] a delivery publishes, for the workflow bus. Every
    /// authenticated delivery is published: subscriptions narrow by type and
    /// data filters, not by which automation was addressed.
    pub fn webhook_event(&self, delivery: &GitHubDelivery) -> Option<BossEvent> {
        github::delivery_event(delivery, uuid::Uuid::new_v4().to_string(), self.clock.now_ms())
    }
}

/// A patch: every field the caller left alone stays as it was.
/// `webhook: Some(None)` clears the webhook.
#[derive(Clone, Debug, Default)]
pub struct AutomationPatch {
    pub name: Option<String>,
    pub prompt: Option<String>,
    pub project_path: Option<String>,
    pub backend_id: Option<String>,
    pub model: Option<serde_json::Value>,
    pub mode: Option<String>,
    pub schedule: Option<AutomationSchedule>,
    pub webhook: Option<Option<AutomationWebhookTrigger>>,
    pub workspace: Option<AutomationWorkspace>,
    pub overlap_policy: Option<AutomationOverlapPolicy>,
    pub catch_up: Option<bool>,
    pub notify: Option<AutomationNotifyMode>,
    pub max_run_minutes: Option<u32>,
    pub keep_runs: Option<u32>,
    pub enabled: Option<bool>,
}

/// Compare two secrets without leaking their contents through timing.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b) {
        diff |= x ^ y;
    }
    diff == 0
}

/// A thread title stamp. `toLocaleString` has no portable equivalent, so
/// this is the ISO-ish form the rest of the Rust app uses.
fn format_stamp(at: i64) -> String {
    let seconds = at.div_euclid(1_000);
    match time::OffsetDateTime::from_unix_timestamp(seconds) {
        Ok(stamp) => {
            let stamp = stamp.to_offset(super::cron::local_offset());
            format!(
                "{:04}-{:02}-{:02} {:02}:{:02}",
                stamp.year(),
                stamp.month() as u8,
                stamp.day(),
                stamp.hour(),
                stamp.minute()
            )
        }
        Err(_) => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::host::AgentStatus;
    use crate::automations::bus::FakeClock;
    use crate::automations::host::{AgentOutcome, StartedAgent};
    use async_trait::async_trait;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// An engine that never starts a process: it records what it was asked
    /// for and answers with whatever the test set up.
    #[derive(Default)]
    struct FakeHost {
        started: Mutex<Vec<AgentRequest>>,
        aborted: Mutex<Vec<String>>,
        disposed: Mutex<Vec<String>>,
        removed_worktrees: Mutex<Vec<String>>,
        notices: Mutex<Vec<Notice>>,
        reports: Mutex<Vec<RunOutcome>>,
        /// Threads still working, by id.
        active: Mutex<Vec<String>>,
        /// What `collect_outcome` answers with.
        outcome: Mutex<Option<AgentOutcome>>,
        /// When set, `start_agent` fails with this message.
        start_error: Mutex<Option<String>>,
        /// A worktree id handed back with every started thread.
        worktree: Mutex<Option<String>>,
        counter: AtomicUsize,
    }

    impl FakeHost {
        fn arc() -> Arc<Self> {
            Arc::new(Self::default())
        }
        fn last_request(&self) -> AgentRequest {
            self.started.lock().unwrap().last().cloned().expect("an agent was started")
        }
        fn thread_ids(&self) -> Vec<String> {
            self.started.lock().unwrap().iter().map(|r| format!("thread-{}", r.run_id)).collect()
        }
        fn set_outcome(&self, outcome: AgentOutcome) {
            *self.outcome.lock().unwrap() = Some(outcome);
        }
        fn notice_bodies(&self) -> Vec<String> {
            self.notices.lock().unwrap().iter().map(|n| n.body.clone()).collect()
        }
    }

    #[async_trait]
    impl AutomationHost for FakeHost {
        async fn start_agent(&self, request: AgentRequest) -> Result<StartedAgent> {
            if let Some(message) = self.start_error.lock().unwrap().clone() {
                bail!(message);
            }
            self.counter.fetch_add(1, Ordering::SeqCst);
            let thread_id = format!("thread-{}", request.run_id);
            self.started.lock().unwrap().push(request);
            self.active.lock().unwrap().push(thread_id.clone());
            Ok(StartedAgent { thread_id, worktree_id: self.worktree.lock().unwrap().clone() })
        }
        fn is_agent_active(&self, thread_id: &str) -> bool {
            self.active.lock().unwrap().iter().any(|t| t == thread_id)
        }
        async fn collect_outcome(&self, thread_id: &str) -> Option<AgentOutcome> {
            self.outcome.lock().unwrap().clone().map(|mut outcome| {
                outcome.thread_id = thread_id.to_owned();
                outcome
            })
        }
        async fn abort_agent(&self, thread_id: &str) -> Result<()> {
            self.aborted.lock().unwrap().push(thread_id.to_owned());
            self.active.lock().unwrap().retain(|t| t != thread_id);
            Ok(())
        }
        fn notify(&self, notice: Notice) {
            self.notices.lock().unwrap().push(notice);
        }
        async fn dispose_thread(&self, thread_id: &str, _worktree_id: Option<&str>) -> Result<()> {
            self.disposed.lock().unwrap().push(thread_id.to_owned());
            Ok(())
        }
        async fn remove_worktree(&self, worktree_id: &str) -> Result<()> {
            self.removed_worktrees.lock().unwrap().push(worktree_id.to_owned());
            Ok(())
        }
        async fn record_report(&self, outcome: RunOutcome) -> Result<()> {
            self.reports.lock().unwrap().push(outcome);
            Ok(())
        }
    }

    /// 2026-01-01 08:59:00 UTC.
    const START: i64 = 1_767_257_940_000;

    struct Harness {
        manager: Arc<AutomationManager>,
        host: Arc<FakeHost>,
        clock: Arc<FakeClock>,
        _dir: tempfile::TempDir,
    }

    fn harness() -> Harness {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(AutomationStore::open(dir.path()).unwrap());
        let host = FakeHost::arc();
        let clock = FakeClock::new(START);
        let manager = AutomationManager::new(store, host.clone(), clock.clone());
        Harness { manager, host, clock, _dir: dir }
    }

    fn input(name: &str) -> AutomationInput {
        AutomationInput { name: name.to_owned(), prompt: "do the thing".to_owned(), ..Default::default() }
    }

    fn cron_input(name: &str, expression: &str) -> AutomationInput {
        AutomationInput {
            schedule: AutomationSchedule {
                kind: AutomationScheduleKind::Cron,
                expression: Some(expression.to_owned()),
            },
            ..input(name)
        }
    }

    #[test]
    fn create_rejects_an_automation_that_cannot_run() {
        let h = harness();
        assert!(h.manager.create(input("  ")).unwrap_err().to_string().contains("name"));
        assert!(
            h.manager
                .create(AutomationInput { prompt: "  ".into(), ..input("Nightly") })
                .unwrap_err()
                .to_string()
                .contains("prompt")
        );
        assert!(h.manager.create(cron_input("Nightly", "not a cron")).unwrap_err().to_string().contains("5 fields"));
    }

    #[test]
    fn create_normalizes_and_arms_the_schedule() {
        let h = harness();
        let created = h
            .manager
            .create(AutomationInput {
                name: "  Nightly  ".into(),
                max_run_minutes: 10_000,
                keep_runs: 0,
                workspace: AutomationWorkspace::Worktree,
                ..cron_input("x", "0 9 * * *")
            })
            .unwrap();
        assert_eq!(created.name, "Nightly");
        assert_eq!(created.max_run_minutes, 24 * 60, "clamped to a day");
        assert_eq!(created.keep_runs, 1, "clamped to at least one");
        assert_eq!(
            created.workspace,
            AutomationWorkspace::None,
            "a projectless automation has nowhere to make a worktree"
        );
        // Armed for 09:00, one minute out.
        assert_eq!(created.next_run_at, Some(START + 60_000));
    }

    #[tokio::test]
    async fn a_due_automation_runs_on_tick_and_re_arms() {
        let h = harness();
        let created = h.manager.create(cron_input("Nightly", "0 9 * * *")).unwrap();
        h.manager.tick().await.unwrap();
        assert!(h.host.started.lock().unwrap().is_empty(), "not due yet");

        h.clock.advance(60_000);
        h.manager.tick().await.unwrap();
        assert_eq!(h.host.started.lock().unwrap().len(), 1);
        let request = h.host.last_request();
        assert!(request.prompt.starts_with("[BOSS AUTOMATION RUN]\nAutomation: Nightly\n"));
        assert!(request.prompt.ends_with("\n\ndo the thing"));
        // Re-armed a day out, so a second tick in the same minute does not
        // start a second run.
        let armed = h.manager.store().automation(&created.id).unwrap().next_run_at.unwrap();
        assert_eq!(armed, h.clock.now_ms() + 24 * 60 * 60 * 1_000);
        h.manager.tick().await.unwrap();
        assert_eq!(h.host.started.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn an_idle_thread_finishes_the_run_with_its_summary() {
        let h = harness();
        let created = h.manager.create(input("Nightly")).unwrap();
        h.host.set_outcome(AgentOutcome {
            status: AgentStatus::Success,
            summary: Some("checked the logs".into()),
            text: None,
            changed_files: 2,
            thread_id: String::new(),
            worktree_id: None,
            error: None,
        });
        h.manager.run_now(&created.id).await.unwrap();
        let thread = h.host.thread_ids()[0].clone();
        h.manager.on_thread_idle(&thread).await.unwrap();

        let run = &h.manager.store().runs()[0];
        assert_eq!(run.status, AutomationRunStatus::Success);
        assert_eq!(run.summary.as_deref(), Some("checked the logs"));
        assert_eq!(run.changed_files, 2);
        assert!(run.finished_at.is_some());
        // Two changed files is worth a word, even on the default notify mode.
        assert_eq!(h.host.notice_bodies(), vec!["\"Nightly\" finished with 2 changed files."]);
    }

    #[tokio::test]
    async fn an_idle_that_beats_the_send_does_not_finish_the_run_early() {
        // Engines whose send resolves only after the work is done emit idle
        // first. The run must still be recorded, not dropped.
        let h = harness();
        let created = h.manager.create(input("Nightly")).unwrap();
        h.manager.run_now(&created.id).await.unwrap();
        let thread = h.host.thread_ids()[0].clone();
        // Simulate the reverse order by finishing the thread first.
        h.host.abort_agent(&thread).await.unwrap();
        h.manager.on_thread_idle(&thread).await.unwrap();
        assert_eq!(h.manager.store().runs()[0].status, AutomationRunStatus::Success);
    }

    #[tokio::test]
    async fn a_thread_error_fails_the_run() {
        let h = harness();
        let created = h.manager.create(input("Nightly")).unwrap();
        h.manager.run_now(&created.id).await.unwrap();
        let thread = h.host.thread_ids()[0].clone();
        h.manager.on_thread_error(&thread, "the engine died").await.unwrap();
        let run = &h.manager.store().runs()[0];
        assert_eq!(run.status, AutomationRunStatus::Failure);
        assert_eq!(run.error.as_deref(), Some("the engine died"));
        assert_eq!(h.host.notice_bodies(), vec!["\"Nightly\" failed: the engine died."]);
    }

    #[tokio::test]
    async fn a_failure_to_start_is_recorded_as_a_failed_run() {
        let h = harness();
        *h.host.start_error.lock().unwrap() = Some("no such engine".into());
        let created = h.manager.create(input("Nightly")).unwrap();
        h.manager.run_now(&created.id).await.unwrap();
        let run = &h.manager.store().runs()[0];
        assert_eq!(run.status, AutomationRunStatus::Failure);
        assert_eq!(run.error.as_deref(), Some("no such engine"));
        // And the slot is free again.
        assert!(h.manager.run_now(&created.id).await.is_ok());
    }

    #[tokio::test]
    async fn overlap_skip_records_a_skipped_run_and_queue_runs_it_after() {
        let h = harness();
        let skipping = h.manager.create(cron_input("Skipper", "* * * * *")).unwrap();
        h.manager.run_now(&skipping.id).await.unwrap();
        // A scheduled fire while the manual run holds the slot.
        h.clock.advance(60_000);
        h.manager.tick().await.unwrap();
        let runs = h.manager.store().runs();
        assert_eq!(runs.len(), 2);
        assert_eq!(runs[1].status, AutomationRunStatus::Skipped);
        assert_eq!(runs[1].error.as_deref(), Some("The previous run was still active."));
        assert_eq!(h.host.started.lock().unwrap().len(), 1, "the skipped run never started an agent");

        let queueing = h
            .manager
            .create(AutomationInput {
                overlap_policy: AutomationOverlapPolicy::Queue,
                ..cron_input("Queuer", "* * * * *")
            })
            .unwrap();
        h.manager.run_now(&queueing.id).await.unwrap();
        let before = h.host.started.lock().unwrap().len();
        h.clock.advance(60_000);
        h.manager.tick().await.unwrap();
        assert_eq!(h.host.started.lock().unwrap().len(), before, "queued, not started");
        // Finishing the first run releases the queued one.
        let thread = h.host.thread_ids().last().unwrap().clone();
        h.manager.on_thread_idle(&thread).await.unwrap();
        assert_eq!(h.host.started.lock().unwrap().len(), before + 1);
    }

    #[tokio::test]
    async fn a_manual_run_refuses_to_overlap_rather_than_skipping_silently() {
        let h = harness();
        let created = h.manager.create(input("Nightly")).unwrap();
        h.manager.run_now(&created.id).await.unwrap();
        let error = h.manager.run_now(&created.id).await.unwrap_err();
        assert!(error.to_string().contains("already running"), "{error}");
        assert_eq!(h.manager.store().runs().len(), 1, "and no skipped run was recorded");
    }

    #[tokio::test]
    async fn a_run_that_outlives_its_budget_times_out() {
        let h = harness();
        let created = h
            .manager
            .create(AutomationInput { max_run_minutes: 5, ..input("Nightly") })
            .unwrap();
        h.manager.run_now(&created.id).await.unwrap();
        h.clock.advance(4 * 60_000);
        h.manager.tick().await.unwrap();
        assert_eq!(h.manager.store().runs()[0].status, AutomationRunStatus::Running);

        h.clock.advance(2 * 60_000);
        h.manager.tick().await.unwrap();
        let run = &h.manager.store().runs()[0];
        assert_eq!(run.status, AutomationRunStatus::Timeout);
        assert_eq!(run.error.as_deref(), Some("The run exceeded 5 minutes and was stopped."));
        assert_eq!(h.host.aborted.lock().unwrap().len(), 1, "the thread was stopped too");
    }

    #[tokio::test]
    async fn stopping_a_run_aborts_its_thread() {
        let h = harness();
        let created = h.manager.create(input("Nightly")).unwrap();
        h.manager.run_now(&created.id).await.unwrap();
        h.manager.stop_run(&created.id).await.unwrap();
        assert_eq!(h.manager.store().runs()[0].status, AutomationRunStatus::Aborted);
        assert_eq!(h.host.aborted.lock().unwrap().len(), 1);
        assert!(h.manager.stop_run(&created.id).await.is_err(), "nothing left to stop");
    }

    #[tokio::test]
    async fn catch_up_runs_once_for_the_whole_gap_and_counts_the_rest() {
        let h = harness();
        let created = h.manager.create(cron_input("Every minute", "* * * * *")).unwrap();
        // The app was closed for an hour.
        h.clock.advance(60 * 60_000);
        h.manager.catch_up().await.unwrap();
        assert_eq!(h.host.started.lock().unwrap().len(), 1, "one run covers the gap");
        let after = h.manager.store().automation(&created.id).unwrap();
        assert!(after.missed_runs >= 58, "the rest are counted: {}", after.missed_runs);
        assert_eq!(after.next_run_at, Some(h.clock.now_ms() + 60_000));
    }

    #[tokio::test]
    async fn catch_up_without_the_flag_only_counts() {
        let h = harness();
        let created = h
            .manager
            .create(AutomationInput { catch_up: false, ..cron_input("Every minute", "* * * * *") })
            .unwrap();
        h.clock.advance(60 * 60_000);
        h.manager.catch_up().await.unwrap();
        assert!(h.host.started.lock().unwrap().is_empty());
        assert!(h.manager.store().automation(&created.id).unwrap().missed_runs >= 59);
    }

    #[tokio::test]
    async fn a_disabled_automation_neither_runs_nor_stays_armed() {
        let h = harness();
        let created = h.manager.create(cron_input("Nightly", "* * * * *")).unwrap();
        h.manager.update(&created.id, AutomationPatch { enabled: Some(false), ..Default::default() }).unwrap();
        assert_eq!(h.manager.store().automation(&created.id).unwrap().next_run_at, None);
        h.clock.advance(10 * 60_000);
        h.manager.tick().await.unwrap();
        h.manager.catch_up().await.unwrap();
        assert!(h.host.started.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn history_is_pruned_to_keep_runs_and_takes_the_threads_with_it() {
        let h = harness();
        let created = h.manager.create(AutomationInput { keep_runs: 2, ..input("Nightly") }).unwrap();
        for _ in 0..4 {
            h.manager.run_now(&created.id).await.unwrap();
            let thread = h.host.thread_ids().last().unwrap().clone();
            h.manager.on_thread_idle(&thread).await.unwrap();
            h.clock.advance(1_000);
        }
        assert_eq!(h.manager.store().runs().len(), 2);
        assert_eq!(h.host.disposed.lock().unwrap().len(), 2, "the dropped runs' threads went too");
    }

    #[tokio::test]
    async fn a_clean_worktree_is_removed_and_a_dirty_one_is_kept() {
        let h = harness();
        *h.host.worktree.lock().unwrap() = Some("wt-1".into());
        let created = h.manager.create(input("Nightly")).unwrap();
        h.manager.run_now(&created.id).await.unwrap();
        let thread = h.host.thread_ids()[0].clone();
        h.manager.on_thread_idle(&thread).await.unwrap();
        assert_eq!(h.host.removed_worktrees.lock().unwrap().as_slice(), ["wt-1"], "nothing changed, nothing to review");

        h.host.removed_worktrees.lock().unwrap().clear();
        h.host.set_outcome(AgentOutcome {
            status: AgentStatus::Success,
            summary: None,
            text: None,
            changed_files: 3,
            thread_id: String::new(),
            worktree_id: None,
            error: None,
        });
        h.manager.run_now(&created.id).await.unwrap();
        let thread = h.host.thread_ids().last().unwrap().clone();
        h.manager.on_thread_idle(&thread).await.unwrap();
        assert!(h.host.removed_worktrees.lock().unwrap().is_empty(), "real changes are kept");
    }

    #[tokio::test]
    async fn notify_off_stays_quiet_and_always_speaks_up() {
        let h = harness();
        let quiet = h
            .manager
            .create(AutomationInput { notify: AutomationNotifyMode::Off, ..input("Quiet") })
            .unwrap();
        h.manager.run_now(&quiet.id).await.unwrap();
        h.manager.on_thread_error(&h.host.thread_ids()[0].clone(), "boom").await.unwrap();
        assert!(h.host.notice_bodies().is_empty(), "off means off, even for a failure");

        let chatty = h
            .manager
            .create(AutomationInput { notify: AutomationNotifyMode::Always, ..input("Chatty") })
            .unwrap();
        h.host.set_outcome(AgentOutcome {
            status: AgentStatus::Success,
            summary: Some("all quiet".into()),
            text: None,
            changed_files: 0,
            thread_id: String::new(),
            worktree_id: None,
            error: None,
        });
        h.manager.run_now(&chatty.id).await.unwrap();
        h.manager.on_thread_idle(&h.host.thread_ids().last().unwrap().clone()).await.unwrap();
        assert_eq!(h.host.notice_bodies(), vec!["\"Chatty\": all quiet"]);
    }

    #[tokio::test]
    async fn a_question_flags_the_run_without_ending_it() {
        let h = harness();
        let created = h.manager.create(input("Nightly")).unwrap();
        h.manager.run_now(&created.id).await.unwrap();
        let thread = h.host.thread_ids()[0].clone();
        h.manager.on_thread_question(&thread).unwrap();
        let run = &h.manager.store().runs()[0];
        assert_eq!(run.needs_attention, Some(true));
        assert_eq!(run.status, AutomationRunStatus::Running, "it is still going");
        assert!(h.host.notice_bodies()[0].contains("waiting on a question"));
    }

    #[tokio::test]
    async fn a_successful_run_with_output_becomes_a_report() {
        let h = harness();
        let created = h.manager.create(input("Nightly")).unwrap();
        h.host.set_outcome(AgentOutcome {
            status: AgentStatus::Success,
            summary: Some("six monitors alerting".into()),
            text: Some("# Monitors\n\nSix are alerting.".into()),
            changed_files: 0,
            thread_id: String::new(),
            worktree_id: None,
            error: None,
        });
        h.manager.run_now(&created.id).await.unwrap();
        h.manager.on_thread_idle(&h.host.thread_ids()[0].clone()).await.unwrap();
        let reports = h.host.reports.lock().unwrap();
        assert_eq!(reports.len(), 1);
        assert_eq!(reports[0].automation_name, "Nightly");
        assert_eq!(reports[0].summary.as_deref(), Some("six monitors alerting"));
        assert!(reports[0].body.contains("Six are alerting."));
    }

    #[tokio::test]
    async fn a_failed_run_leaves_no_report() {
        let h = harness();
        let created = h.manager.create(input("Nightly")).unwrap();
        h.manager.run_now(&created.id).await.unwrap();
        h.manager.on_thread_error(&h.host.thread_ids()[0].clone(), "boom").await.unwrap();
        assert!(h.host.reports.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_webhook_needs_the_right_token_and_a_github_header() {
        let h = harness();
        let created = h
            .manager
            .create(AutomationInput {
                webhook: Some(AutomationWebhookTrigger { events: vec!["push".into()], branch: Some("main".into()) }),
                ..input("On push")
            })
            .unwrap();
        let token = h.manager.store().webhook_token(&created.id).unwrap();
        let body = serde_json::json!({ "ref": "refs/heads/main", "repository": { "full_name": "octo/hello" } });

        let wrong = h.manager.deliver_webhook(&created.id, "nope", Some("push"), &body).await.unwrap_err();
        assert_eq!(wrong.status, 404);
        // An unknown id is indistinguishable from a bad token.
        let unknown = h.manager.deliver_webhook("no-such-id", &token, Some("push"), &body).await.unwrap_err();
        assert_eq!(unknown.status, 404);
        let headerless = h.manager.deliver_webhook(&created.id, &token, None, &body).await.unwrap_err();
        assert_eq!(headerless.status, 400);
        assert!(h.host.started.lock().unwrap().is_empty());

        let ok = h.manager.deliver_webhook(&created.id, &token, Some("push"), &body).await.unwrap();
        assert_eq!(ok, DeliveryResult::Started);
        let after = h.manager.store().automation(&created.id).unwrap();
        assert_eq!(after.last_webhook_label.as_deref(), Some("push · main · octo/hello"));
        assert!(after.last_webhook_at.is_some());
    }

    #[tokio::test]
    async fn a_webhook_on_the_wrong_branch_is_recorded_but_does_not_run() {
        let h = harness();
        let created = h
            .manager
            .create(AutomationInput {
                webhook: Some(AutomationWebhookTrigger { events: vec![], branch: Some("main".into()) }),
                ..input("On push")
            })
            .unwrap();
        let token = h.manager.store().webhook_token(&created.id).unwrap();
        let body = serde_json::json!({ "ref": "refs/heads/dev" });
        assert_eq!(
            h.manager.deliver_webhook(&created.id, &token, Some("push"), &body).await.unwrap(),
            DeliveryResult::Skipped
        );
        assert!(h.host.started.lock().unwrap().is_empty());
        // The delivery still shows up on the card, so a mis-set branch is visible.
        assert!(h.manager.store().automation(&created.id).unwrap().last_webhook_at.is_some());
    }

    #[tokio::test]
    async fn a_webhook_run_fills_the_prompt_placeholders() {
        let h = harness();
        let created = h
            .manager
            .create(AutomationInput {
                prompt: "Review {{pr_title}} on {{pr_branch}} (#{{pr_number}}).".into(),
                webhook: Some(AutomationWebhookTrigger { events: vec!["pull_request".into()], branch: None }),
                ..input("On PR")
            })
            .unwrap();
        let token = h.manager.store().webhook_token(&created.id).unwrap();
        let body = serde_json::json!({
            "action": "opened",
            "number": 204,
            "pull_request": { "title": "Add the thing", "head": { "ref": "feature" }, "base": { "ref": "main" } }
        });
        h.manager.deliver_webhook(&created.id, &token, Some("pull_request"), &body).await.unwrap();
        let prompt = h.host.last_request().prompt;
        assert!(prompt.ends_with("Review Add the thing on feature (#204)."), "{prompt}");
    }

    #[tokio::test]
    async fn deleting_an_automation_stops_its_run_and_forgets_its_history() {
        let h = harness();
        let created = h.manager.create(input("Nightly")).unwrap();
        h.manager.run_now(&created.id).await.unwrap();
        h.manager.delete(&created.id).await.unwrap();
        assert!(h.manager.store().automations().is_empty());
        assert!(h.manager.store().runs().is_empty());
        assert_eq!(h.host.aborted.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn stop_all_records_every_live_run_as_aborted() {
        let h = harness();
        for name in ["One", "Two"] {
            let created = h.manager.create(input(name)).unwrap();
            h.manager.run_now(&created.id).await.unwrap();
        }
        h.manager.stop_all().await.unwrap();
        let runs = h.manager.store().runs();
        assert_eq!(runs.len(), 2);
        assert!(runs.iter().all(|r| r.status == AutomationRunStatus::Aborted));
        assert!(runs.iter().all(|r| r.error.as_deref() == Some("The app quit while this run was active.")));
    }

    #[test]
    fn update_clears_the_webhook_token_when_the_trigger_goes_away() {
        let h = harness();
        let created = h
            .manager
            .create(AutomationInput {
                webhook: Some(AutomationWebhookTrigger { events: vec!["push".into()], branch: None }),
                ..input("On push")
            })
            .unwrap();
        assert!(h.manager.store().webhook_token(&created.id).is_some());
        h.manager.update(&created.id, AutomationPatch { webhook: Some(None), ..Default::default() }).unwrap();
        assert!(h.manager.store().webhook_token(&created.id).is_none());
        assert!(h.manager.store().automation(&created.id).unwrap().webhook.is_none());
    }

    #[test]
    fn update_drops_webhook_events_boss_cannot_receive() {
        let h = harness();
        let created = h
            .manager
            .create(AutomationInput {
                webhook: Some(AutomationWebhookTrigger {
                    events: vec!["push".into(), "star".into(), "fork".into()],
                    branch: Some("  ".into()),
                }),
                ..input("On push")
            })
            .unwrap();
        let webhook = created.webhook.unwrap();
        assert_eq!(webhook.events, vec!["push".to_owned()]);
        assert_eq!(webhook.branch, None, "a blank branch means any branch");
    }

    #[tokio::test]
    async fn everything_survives_a_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let host = FakeHost::arc();
        let clock = FakeClock::new(START);
        let created = {
            let store = Arc::new(AutomationStore::open(dir.path()).unwrap());
            let manager = AutomationManager::new(store, host.clone(), clock.clone());
            let created = manager.create(cron_input("Nightly", "0 9 * * *")).unwrap();
            manager.run_now(&created.id).await.unwrap();
            created
        };
        // A new manager over the same directory, as after a restart.
        let store = Arc::new(AutomationStore::open(dir.path()).unwrap());
        let manager = AutomationManager::new(store, host, clock);
        assert_eq!(manager.store().automations().len(), 1);
        let run = &manager.store().runs()[0];
        assert_eq!(run.status, AutomationRunStatus::Aborted, "a run cannot survive the process that hosted it");
        // And the slot is free, so it can run again.
        assert!(manager.run_now(&created.id).await.is_ok());
    }
}
