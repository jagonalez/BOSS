//! Durable workflow execution with replay.
//!
//! Port of `src/main/workflow-engine.ts`. A run's journal is the source of
//! truth. Executing a run always means running its script from the top:
//! journaled steps return their recorded results instantly, and the first
//! un-journaled step performs live. After a restart the engine reattaches
//! in-flight steps — live agent threads keep running, vanished ones
//! re-perform, durable wait subscriptions survive in the event bus — and
//! replays the script to exactly where it left off.
//!
//! # What is ported and what is not
//!
//! Everything that makes execution *durable* is here: the journal, the
//! replay contract, `argsHash` invalidation on a script edit, budgets,
//! reattach-after-restart, the wait/sleep subscriptions, judge retries, run
//! pruning, and the scheduler.
//!
//! The one piece that is not is the JavaScript interpreter. The Electron
//! engine ran scripts on `node:vm`; this workspace has no JS engine, and
//! adding one is a dependency decision above this module. So the script side
//! sits behind [`ScriptRunner`]: it receives the primitive calls and drives
//! them through [`StepContext`], which is the same replay-aware `step()`
//! wrapper the TS used. Plugging in a JS engine means implementing that one
//! trait — no change to the journal, the store, or the bus.
//!
//! [`NoScriptRunner`] is the default and refuses to run, so a workflow the
//! user has stored is never silently reported as succeeding.

use super::bus::{Clock, EventBus};
use super::cron::cron_error;
use super::host::{AgentRequest, AgentStatus, Notice, WorkflowHost, workflow_step_header};
use super::store::WorkflowStore;
use super::types::*;
use anyhow::{Result, anyhow, bail};
use async_trait::async_trait;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::sync::Arc;

/// The seq used by the whole-run deadline timer subscription. Negative, so
/// `unsubscribe_resumes_from` never takes it.
pub const DEADLINE_SEQ: i64 = -1;

const JUDGE_RETRY_SUFFIX: &str = "\n\nYour previous answer did not end with a valid VERDICT line. Answer again, ending with the REASON and VERDICT lines exactly as specified.";

/// A budget a run has already spent. Ends the run as `needs-attention`
/// rather than `failed`: nothing went wrong, there is just no more rope.
#[derive(Debug)]
struct BudgetExceeded(String);

impl BudgetExceeded {
    fn new(what: &str, limit: u32) -> Self {
        Self(format!(
            "Budget exceeded: this run already used its {limit} {what}. Raise the workflow budget or split the work."
        ))
    }
}

/// What one primitive call resolved to.
#[derive(Clone, Debug, PartialEq)]
pub enum StepOutcome {
    /// The step is finished and the script may continue.
    Done(Value),
    /// The step failed; the script sees an error.
    Failed(String),
    /// The step is parked on something durable (an agent, a wait, a sleep,
    /// an unanswered question). The script instance stops here and is
    /// replayed from the top when the step settles.
    Parked,
}

/// The primitives a script may call. One variant per journaled op.
#[derive(Clone, Debug, PartialEq)]
pub enum Primitive {
    Agent { prompt: String, options: AgentOptions },
    Judge { input: String, choices: Vec<String>, rubric: Option<String> },
    WaitFor { pattern: EventPattern, timeout_ms: Option<i64> },
    Sleep { ms: i64 },
    Notify { body: String, title: Option<String>, attention: bool },
    Ask { question: String, choices: Option<Vec<String>> },
    StateGet { key: String },
    StateSet { key: String, value: Value },
    Log { message: String },
    Pr { thread_id: String, title: Option<String>, body: Option<String>, base_branch: Option<String>, draft: bool },
}

impl Primitive {
    fn op(&self) -> JournalOp {
        match self {
            Primitive::Agent { .. } => JournalOp::Agent,
            Primitive::Judge { .. } => JournalOp::Judge,
            Primitive::WaitFor { .. } => JournalOp::Wait,
            Primitive::Sleep { .. } => JournalOp::Sleep,
            Primitive::Notify { .. } => JournalOp::Notify,
            Primitive::Ask { .. } => JournalOp::Ask,
            Primitive::StateGet { .. } => JournalOp::StateGet,
            Primitive::StateSet { .. } => JournalOp::StateSet,
            Primitive::Log { .. } => JournalOp::Log,
            Primitive::Pr { .. } => JournalOp::Pr,
        }
    }

    /// The arguments as the journal records them. The shapes match the TS
    /// exactly, so `argsHash` agrees across the two apps and a journal
    /// written by either replays in the other.
    fn args(&self) -> Value {
        match self {
            Primitive::Agent { prompt, options } => json!({ "prompt": prompt, "options": options.to_json() }),
            Primitive::Judge { input, choices, rubric } => {
                let call_options = match rubric {
                    Some(rubric) => json!({ "rubric": rubric }),
                    None => json!({}),
                };
                json!({ "input": input, "choices": choices, "callOptions": call_options })
            }
            Primitive::WaitFor { pattern, timeout_ms } => match timeout_ms {
                Some(ms) => json!({ "pattern": pattern, "timeoutMs": ms }),
                None => json!({ "pattern": pattern }),
            },
            Primitive::Sleep { ms } => json!({ "ms": ms }),
            Primitive::Notify { body, title, attention } => {
                let mut options = serde_json::Map::new();
                if let Some(title) = title {
                    options.insert("title".into(), json!(title));
                }
                if *attention {
                    options.insert("attention".into(), json!(true));
                }
                json!({ "body": body, "options": Value::Object(options) })
            }
            Primitive::Ask { question, choices } => match choices {
                Some(choices) => json!({ "question": question, "choices": choices }),
                None => json!({ "question": question }),
            },
            Primitive::StateGet { key } => json!({ "key": key }),
            Primitive::StateSet { key, value } => json!({ "key": key, "value": clamp_result(value) }),
            Primitive::Log { message } => json!({ "message": message }),
            Primitive::Pr { thread_id, title, body, base_branch, draft } => {
                let mut options = serde_json::Map::new();
                if let Some(title) = title {
                    options.insert("title".into(), json!(title));
                }
                if let Some(body) = body {
                    options.insert("body".into(), json!(body));
                }
                if let Some(base) = base_branch {
                    options.insert("baseBranch".into(), json!(base));
                }
                if *draft {
                    options.insert("draft".into(), json!(true));
                }
                json!({ "threadId": thread_id, "options": Value::Object(options) })
            }
        }
    }
}

/// Per-step agent settings a script call may override.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct AgentOptions {
    pub engine: Option<String>,
    pub model: Option<String>,
    pub mode: Option<String>,
    pub workspace: Option<AutomationWorkspace>,
    /// Run in the same checkout as a prior step's conversation.
    pub in_worktree_of: Option<String>,
    pub max_minutes: Option<f64>,
    pub title: Option<String>,
}

impl AgentOptions {
    /// The `AgentCallOptions` shape the TS journaled, so `argsHash` matches.
    fn to_json(&self) -> Value {
        let mut map = serde_json::Map::new();
        if let Some(engine) = &self.engine {
            map.insert("backendId".into(), json!(engine));
        }
        if let Some(model) = &self.model {
            map.insert("model".into(), json!(model));
        }
        if let Some(mode) = &self.mode {
            map.insert("mode".into(), json!(mode));
        }
        if let Some(workspace) = &self.workspace {
            map.insert("workspace".into(), serde_json::to_value(workspace).unwrap_or(Value::Null));
        }
        if let Some(thread) = &self.in_worktree_of {
            map.insert("inWorktreeOf".into(), json!(thread));
        }
        if let Some(minutes) = self.max_minutes {
            map.insert("maxMinutes".into(), json!(minutes));
        }
        if let Some(title) = &self.title {
            map.insert("title".into(), json!(title));
        }
        Value::Object(map)
    }
}

/// The handle a script uses to call primitives. One instance per replay of
/// one run; `call` is the replay-aware `step()` wrapper.
#[async_trait]
pub trait StepContext: Send + Sync {
    /// Perform (or replay) one primitive call.
    async fn call(&self, primitive: Primitive) -> StepOutcome;

    /// The triggering event, exposed to the script as `event`.
    fn event(&self) -> Option<BossEvent>;

    /// The calls this replay journaled but could not settle from the journal
    /// alone, handed back to the engine to perform. Draining, so a second
    /// call returns nothing.
    fn take_pending(&self) -> Vec<(i64, Primitive)>;
}

/// Runs a workflow's script against the primitives.
///
/// Called once per replay of a run: from the top, every time. An
/// implementation must be deterministic given the same journal — that is
/// what makes replay exact — and must stop as soon as [`StepContext::call`]
/// returns [`StepOutcome::Parked`].
#[async_trait]
pub trait ScriptRunner: Send + Sync {
    /// Run `script`. `Ok(Some(value))` is a completed run with that result;
    /// `Ok(None)` means the script parked on a durable step and this replay
    /// is over; `Err` fails the run.
    async fn run(&self, script: &str, context: Arc<dyn StepContext>) -> Result<Option<Value>>;

    /// Reject a script that cannot run before it is ever stored. The default
    /// accepts anything.
    fn check(&self, _script: &str) -> Result<()> {
        Ok(())
    }
}

/// The default runner: refuses every script.
///
/// A build with no JavaScript engine must not pretend a workflow ran. This
/// fails the run with a message that says exactly why, so a stored workflow
/// is visibly unavailable rather than silently successful.
///
/// TODO(script-engine): swap in a real interpreter (boa or rquickjs) and the
/// rest of this module runs unchanged — the journal, replay, budgets, and
/// scheduler are all engine-agnostic.
pub struct NoScriptRunner;

#[async_trait]
impl ScriptRunner for NoScriptRunner {
    async fn run(&self, _script: &str, _context: Arc<dyn StepContext>) -> Result<Option<Value>> {
        bail!("This build of BOSS has no workflow script engine, so the script cannot run.")
    }
}

/// Durable workflow execution: the store, the bus, and the host in one
/// object the UI and the bus tools talk to.
pub struct WorkflowEngine {
    store: Arc<WorkflowStore>,
    bus: Arc<EventBus>,
    host: Arc<dyn WorkflowHost>,
    clock: Arc<dyn Clock>,
    scripts: Arc<dyn ScriptRunner>,
}

impl WorkflowEngine {
    pub fn new(
        store: Arc<WorkflowStore>,
        bus: Arc<EventBus>,
        host: Arc<dyn WorkflowHost>,
        clock: Arc<dyn Clock>,
        scripts: Arc<dyn ScriptRunner>,
    ) -> Arc<Self> {
        Arc::new(Self { store, bus, host, clock, scripts })
    }

    pub fn store(&self) -> &Arc<WorkflowStore> {
        &self.store
    }

    pub fn bus(&self) -> &Arc<EventBus> {
        &self.bus
    }

    /// Everything the UI and the phone show.
    pub fn snapshot(&self) -> Value {
        json!({
            "workflows": self.store.workflows(),
            "runs": self.store.runs(),
            "approvalMode": self.store.approval_mode(),
        })
    }

    // -------------------------------------------------------------- CRUD

    /// Reject a workflow that cannot run, and normalize what can.
    fn validate(&self, mut input: WorkflowInput) -> Result<WorkflowInput> {
        input.name = input.name.trim().to_owned();
        if input.name.is_empty() {
            bail!("Give the workflow a name.");
        }
        if input.script.trim().is_empty() {
            bail!("Give the workflow a script.");
        }
        self.scripts.check(&input.script).map_err(|e| anyhow!("The script does not parse: {e}"))?;
        for trigger in &input.triggers {
            match trigger {
                WorkflowTrigger::Cron { expression } => {
                    if let Some(problem) = cron_error(expression) {
                        bail!(problem);
                    }
                }
                WorkflowTrigger::Event { pattern } => {
                    if pattern.kind.trim().is_empty() {
                        bail!("An event trigger needs an event type.");
                    }
                }
            }
        }
        input.project_path = input.project_path.trim().to_owned();
        if input.keep_runs == 0 {
            input.keep_runs = 100;
        }
        Ok(input)
    }

    /// Store a new workflow.
    ///
    /// An agent-authored workflow starts disabled unless approval is on
    /// `auto`: its triggers stay dormant until the user enables it, which is
    /// the approval step.
    pub fn create(&self, input: WorkflowInput, source: WorkflowSource) -> Result<Workflow> {
        let clean = self.validate(input)?;
        let now = self.clock.now_ms();
        let enabled = source != WorkflowSource::Agent || self.store.approval_mode() == WorkflowApprovalMode::Auto;
        let workflow = Workflow {
            id: uuid::Uuid::new_v4().to_string(),
            name: clean.name,
            description: clean.description,
            script: clean.script,
            project_path: clean.project_path,
            triggers: clean.triggers,
            overlap_policy: clean.overlap_policy,
            budget: clean.budget,
            defaults: clean.defaults,
            keep_runs: clean.keep_runs,
            enabled,
            source,
            created_at: now,
            updated_at: now,
            last_run_at: None,
        };
        self.store.upsert_workflow(workflow.clone());
        self.register_triggers(&workflow)?;
        self.store.save()?;
        Ok(workflow)
    }

    /// Apply a patch.
    ///
    /// Under ask-mode approval an agent editing a workflow disables it
    /// again: editing is how an agent iterates, enabling is how the user
    /// approves.
    pub fn update(&self, id: &str, patch: WorkflowPatch, by_agent: bool) -> Result<Workflow> {
        let existing = self.store.workflow(id).ok_or_else(|| anyhow!("Workflow not found."))?;
        let merged = WorkflowInput {
            name: patch.name.unwrap_or(existing.name),
            description: patch.description.or(existing.description),
            script: patch.script.unwrap_or(existing.script),
            project_path: patch.project_path.unwrap_or(existing.project_path),
            triggers: patch.triggers.unwrap_or(existing.triggers),
            overlap_policy: patch.overlap_policy.unwrap_or(existing.overlap_policy),
            budget: existing.budget,
            defaults: existing.defaults,
            keep_runs: patch.keep_runs.unwrap_or(existing.keep_runs),
        };
        let clean = self.validate(merged)?;
        let ask_mode = self.store.approval_mode() == WorkflowApprovalMode::Ask;
        let enabled = match patch.enabled {
            Some(enabled) => enabled,
            None if by_agent && ask_mode => false,
            None => existing.enabled,
        };
        let now = self.clock.now_ms();
        self.store.update_workflow(id, |workflow| {
            workflow.name = clean.name;
            workflow.description = clean.description;
            workflow.script = clean.script;
            workflow.project_path = clean.project_path;
            workflow.triggers = clean.triggers;
            workflow.overlap_policy = clean.overlap_policy;
            workflow.keep_runs = clean.keep_runs;
            workflow.enabled = enabled;
            workflow.updated_at = now;
        });
        let workflow = self.store.workflow(id).ok_or_else(|| anyhow!("Workflow not found."))?;
        self.register_triggers(&workflow)?;
        self.store.save()?;
        Ok(workflow)
    }

    pub async fn delete(&self, id: &str) -> Result<()> {
        let Some(_) = self.store.workflow(id) else { bail!("Workflow not found.") };
        for run in self.store.runs().into_iter().filter(|r| r.workflow_id == id && r.status.is_active()) {
            let _ = self.finish_run(&run.id, WorkflowRunStatus::Stopped, None).await;
        }
        self.bus.unsubscribe_workflow(id)?;
        for run in self.store.runs().into_iter().filter(|r| r.workflow_id == id) {
            self.dispose_run(&run).await;
        }
        self.store.drop_workflow(id);
        self.store.save()?;
        Ok(())
    }

    pub fn set_approval_mode(&self, mode: WorkflowApprovalMode) -> Result<()> {
        self.store.set_approval_mode(mode);
        self.store.save()?;
        Ok(())
    }

    /// Keep the bus's trigger subscriptions in sync with the definition.
    ///
    /// Cron triggers have no catch-up: a fire missed while the app was
    /// closed is skipped and the next occurrence fires normally. A workflow
    /// is a watcher, not a ledger — replaying a week of missed fires at
    /// startup would be worse than skipping them.
    fn register_triggers(&self, workflow: &Workflow) -> Result<()> {
        self.bus.unsubscribe_workflow(&workflow.id)?;
        if !workflow.enabled {
            return Ok(());
        }
        for trigger in &workflow.triggers {
            let target = SubscriptionTarget::Trigger { workflow_id: workflow.id.clone() };
            match trigger {
                WorkflowTrigger::Cron { expression } => {
                    self.bus.subscribe(target, None, Some(expression.clone()), None)?;
                }
                WorkflowTrigger::Event { pattern } => {
                    self.bus.subscribe(target, Some(pattern.clone()), None, None)?;
                }
            }
        }
        Ok(())
    }

    // --------------------------------------------------------------- runs

    /// Run a workflow once, now, whether or not it is enabled.
    pub async fn run_now(&self, workflow_id: &str, started_by_thread_id: Option<String>) -> Result<WorkflowRun> {
        let workflow = self.store.workflow(workflow_id).ok_or_else(|| anyhow!("Workflow not found."))?;
        if workflow.overlap_policy != WorkflowOverlapPolicy::Parallel
            && self.store.runs().iter().any(|r| r.workflow_id == workflow_id && r.status.is_active())
        {
            bail!("This workflow already has an active run. Stop it first.");
        }
        self.start_run(&workflow, WorkflowRunTrigger::Manual, None, started_by_thread_id).await
    }

    async fn start_run(
        &self,
        workflow: &Workflow,
        trigger: WorkflowRunTrigger,
        event: Option<BossEvent>,
        started_by_thread_id: Option<String>,
    ) -> Result<WorkflowRun> {
        let now = self.clock.now_ms();
        let active = self.store.runs().into_iter().any(|r| r.workflow_id == workflow.id && r.status.is_active());
        if active && workflow.overlap_policy != WorkflowOverlapPolicy::Parallel {
            let skipped = WorkflowRun {
                id: uuid::Uuid::new_v4().to_string(),
                workflow_id: workflow.id.clone(),
                started_by_thread_id: None,
                trigger,
                status: WorkflowRunStatus::Skipped,
                event,
                journal: vec![],
                usage: Default::default(),
                result: None,
                error: Some("The previous run was still active.".to_owned()),
                note: None,
                started_at: now,
                finished_at: Some(now),
            };
            self.store.push_run(skipped.clone());
            self.store.save()?;
            return Ok(skipped);
        }
        let run = WorkflowRun {
            id: uuid::Uuid::new_v4().to_string(),
            workflow_id: workflow.id.clone(),
            started_by_thread_id,
            trigger,
            status: WorkflowRunStatus::Running,
            event,
            journal: vec![],
            usage: Default::default(),
            result: None,
            error: None,
            note: None,
            started_at: now,
            finished_at: None,
        };
        let run_id = run.id.clone();
        self.store.push_run(run);
        self.store.update_workflow(&workflow.id, |w| w.last_run_at = Some(now));
        // The whole-run deadline, as a durable timer: a run parked for
        // longer than its budget wakes up and ends itself.
        let budget = workflow.budget.unwrap_or_default().resolve();
        self.bus.subscribe(
            SubscriptionTarget::Resume { run_id: run_id.clone(), seq: DEADLINE_SEQ },
            None,
            None,
            Some(now + (budget.max_run_hours * 3_600_000.0) as i64),
        )?;
        self.store.save()?;
        self.launch(&run_id).await?;
        self.store.run(&run_id).ok_or_else(|| anyhow!("Workflow run not found."))
    }

    /// Answer a pending `ask()` step.
    pub async fn answer(&self, run_id: &str, seq: i64, response: &str) -> Result<()> {
        let run = self.store.run(run_id).ok_or_else(|| anyhow!("Workflow run not found."))?;
        if !run.status.is_active() {
            bail!("This run is no longer active.");
        }
        let matched = run
            .journal
            .iter()
            .any(|e| e.seq == seq && e.op == JournalOp::Ask && e.status == JournalStatus::Started);
        if !matched {
            bail!("This run has no pending question at that step.");
        }
        self.settle(run_id, seq, Ok(json!({ "answer": response })));
        self.store.save()?;
        self.launch(run_id).await
    }

    pub async fn stop_run(&self, run_id: &str) -> Result<()> {
        let run = self.store.run(run_id).ok_or_else(|| anyhow!("Workflow run not found."))?;
        if !run.status.is_active() {
            bail!("This run is not active.");
        }
        self.finish_run(run_id, WorkflowRunStatus::Stopped, None).await
    }

    // ---------------------------------------------------------- execution

    /// Run (or re-run) a run's script from the top.
    ///
    /// This is the whole replay contract: journaled steps return their
    /// recorded results instantly, and the first un-journaled step performs
    /// live. A step that parks ends this replay; settling it launches
    /// another.
    async fn launch(&self, run_id: &str) -> Result<()> {
        let Some(run) = self.store.run(run_id) else { return Ok(()) };
        if !run.status.is_active() {
            return Ok(());
        }
        let Some(workflow) = self.store.workflow(&run.workflow_id) else { return Ok(()) };
        let context: Arc<dyn StepContext> = Arc::new(Replay {
            engine_store: self.store.clone(),
            run_id: run_id.to_owned(),
            workflow: workflow.clone(),
            next_seq: std::sync::Mutex::new(0),
            performed: std::sync::Mutex::new(Vec::new()),
            event: run.event.clone(),
        });
        let script = workflow.script.clone();
        let outcome = self.scripts.run(&script, context.clone()).await;

        // The replay collects the calls it could not settle from the journal
        // alone; perform them now, outside the script's borrow.
        for (seq, primitive) in context.take_pending() {
            self.perform(run_id, seq, primitive).await?;
        }

        match outcome {
            Ok(Some(result)) => {
                // A script that returned while a step is still in flight has
                // not really finished; the parked step will relaunch it.
                if self.has_in_flight(run_id) {
                    return Ok(());
                }
                self.store.update_run(run_id, |run| run.result = Some(clamp_result(&result)));
                self.finish_run(run_id, WorkflowRunStatus::Completed, None).await
            }
            Ok(None) => {
                self.refresh_status(run_id);
                self.store.save()?;
                Ok(())
            }
            Err(error) => {
                let message = error.to_string();
                let status = if message.starts_with("Budget exceeded:") {
                    WorkflowRunStatus::NeedsAttention
                } else {
                    WorkflowRunStatus::Failed
                };
                self.finish_run(run_id, status, Some(message)).await
            }
        }
    }

    /// Is any step of this run still in flight?
    fn has_in_flight(&self, run_id: &str) -> bool {
        self.store
            .run(run_id)
            .map(|run| run.journal.iter().any(|e| e.status == JournalStatus::Started))
            .unwrap_or(false)
    }

    /// Start the durable work behind a freshly journaled step.
    ///
    /// Immediate ops (notify, state, log, pr) settle here and let the next
    /// replay carry on. The rest register something durable — a thread, a
    /// subscription — and the step stays parked.
    async fn perform(&self, run_id: &str, seq: i64, primitive: Primitive) -> Result<()> {
        let Some(run) = self.store.run(run_id) else { return Ok(()) };
        let Some(workflow) = self.store.workflow(&run.workflow_id) else { return Ok(()) };
        let budget = workflow.budget.unwrap_or_default().resolve();
        let entry = run.journal.iter().find(|e| e.seq == seq).cloned();
        let Some(entry) = entry else { return Ok(()) };
        if entry.status != JournalStatus::Started {
            return Ok(());
        }

        let result = match &primitive {
            Primitive::Agent { .. } => {
                if run.usage.agent_runs >= budget.max_agent_runs {
                    Err(BudgetExceeded::new("agent runs", budget.max_agent_runs).0)
                } else {
                    self.store.update_run(run_id, |r| r.usage.agent_runs += 1);
                    self.begin_agent(&workflow, run_id, seq, &primitive, budget).await.err().map(|e| e.to_string()).map_or(Ok(()), Err)
                }
            }
            Primitive::Judge { .. } => {
                if run.usage.judge_calls >= budget.max_judge_calls {
                    Err(BudgetExceeded::new("judge calls", budget.max_judge_calls).0)
                } else {
                    self.store.update_run(run_id, |r| r.usage.judge_calls += 1);
                    self.begin_judge(&workflow, run_id, seq, &primitive, budget, false)
                        .await
                        .err()
                        .map(|e| e.to_string())
                        .map_or(Ok(()), Err)
                }
            }
            Primitive::WaitFor { pattern, timeout_ms } => self
                .bus
                .subscribe(
                    SubscriptionTarget::Resume { run_id: run_id.to_owned(), seq },
                    Some(pattern.clone()),
                    None,
                    timeout_ms.map(|ms| entry.started_at + ms),
                )
                .map(|_| ())
                .map_err(|e| e.to_string()),
            Primitive::Sleep { ms } => {
                if *ms <= 0 {
                    Err("sleep() needs a positive number of milliseconds.".to_owned())
                } else {
                    self.bus
                        .subscribe(
                            SubscriptionTarget::Resume { run_id: run_id.to_owned(), seq },
                            None,
                            None,
                            Some(entry.started_at + ms),
                        )
                        .map(|_| ())
                        .map_err(|e| e.to_string())
                }
            }
            Primitive::Notify { body, title, attention } => {
                if run.usage.notifies >= budget.max_notifies {
                    Err(BudgetExceeded::new("notifications", budget.max_notifies).0)
                } else {
                    self.store.update_run(run_id, |r| r.usage.notifies += 1);
                    self.host.notify(Notice {
                        title: title.clone().unwrap_or_else(|| format!("BOSS · {}", workflow.name)),
                        body: body.clone(),
                        attention: *attention,
                        project_path: workflow.project_path.clone(),
                        thread_id: None,
                    });
                    self.settle(run_id, seq, Ok(Value::Null));
                    Ok(())
                }
            }
            Primitive::Ask { question, .. } => {
                // Nothing durable to register: the pending question lives in
                // the journal and `answer` settles it.
                self.host.notify(Notice {
                    title: format!("BOSS · {}", workflow.name),
                    body: format!("Waiting on you: {question}"),
                    attention: true,
                    project_path: workflow.project_path.clone(),
                    thread_id: None,
                });
                Ok(())
            }
            Primitive::StateGet { key } => {
                let value = self.store.memory_get(&workflow.id, key);
                self.settle(run_id, seq, Ok(value));
                Ok(())
            }
            Primitive::StateSet { key, value } => {
                self.store.memory_set(&workflow.id, key, clamp_result(value));
                self.settle(run_id, seq, Ok(Value::Null));
                Ok(())
            }
            Primitive::Log { .. } => {
                self.settle(run_id, seq, Ok(Value::Null));
                Ok(())
            }
            Primitive::Pr { thread_id, title, body, base_branch, draft } => {
                if thread_id.is_empty() {
                    Err("pr() needs the agent outcome whose worktree holds the commits, e.g. pr(impl, {...}).".to_owned())
                } else {
                    match self
                        .host
                        .create_change_request(
                            thread_id,
                            title.as_deref(),
                            body.as_deref(),
                            base_branch.as_deref(),
                            *draft,
                        )
                        .await
                    {
                        Ok(value) => {
                            self.settle(run_id, seq, Ok(clamp_result(&value)));
                            Ok(())
                        }
                        Err(error) => Err(error.to_string()),
                    }
                }
            }
        };

        if let Err(message) = result {
            self.settle(run_id, seq, Err(message));
        }
        self.store.save()?;

        // An immediate op settled above; carry the script on from there.
        if self.step_settled(run_id, seq) {
            Box::pin(self.launch(run_id)).await?;
        }
        Ok(())
    }

    fn step_settled(&self, run_id: &str, seq: i64) -> bool {
        self.store
            .run(run_id)
            .and_then(|run| run.journal.iter().find(|e| e.seq == seq).map(|e| e.status != JournalStatus::Started))
            .unwrap_or(false)
    }

    /// Record a step's outcome on its journal entry.
    ///
    /// A budget failure is marked so a *replayed* one still ends the run as
    /// `needs-attention` rather than `failed`.
    fn settle(&self, run_id: &str, seq: i64, outcome: std::result::Result<Value, String>) {
        self.store.update_run(run_id, |run| {
            let now_at = self.clock.now_ms();
            if let Some(entry) = run.journal.iter_mut().find(|e| e.seq == seq) {
                if entry.status != JournalStatus::Started {
                    return;
                }
                match outcome {
                    Ok(value) => {
                        entry.status = JournalStatus::Done;
                        entry.result = Some(clamp_result(&value));
                    }
                    Err(message) => {
                        entry.status = JournalStatus::Failed;
                        entry.error = Some(if message.starts_with("Budget exceeded:") {
                            format!("[budget] {message}")
                        } else {
                            message
                        });
                    }
                }
                entry.finished_at = Some(now_at);
            }
        });
        self.refresh_status(run_id);
    }

    /// Derive the run status from what its journal is currently doing: a
    /// step with an agent behind it is `running`, a parked wait is
    /// `waiting`.
    fn refresh_status(&self, run_id: &str) {
        self.store.update_run(run_id, |run| {
            if !run.status.is_active() {
                return;
            }
            let in_flight: Vec<JournalOp> =
                run.journal.iter().filter(|e| e.status == JournalStatus::Started).map(|e| e.op).collect();
            let working = in_flight
                .iter()
                .any(|op| matches!(op, JournalOp::Agent | JournalOp::Judge | JournalOp::Pr));
            run.status = if working || in_flight.is_empty() {
                WorkflowRunStatus::Running
            } else {
                WorkflowRunStatus::Waiting
            };
        });
    }

    // ------------------------------------------------------ agents & judges

    async fn begin_agent(
        &self,
        workflow: &Workflow,
        run_id: &str,
        seq: i64,
        primitive: &Primitive,
        budget: WorkflowBudget,
    ) -> Result<()> {
        let Primitive::Agent { prompt, options } = primitive else { return Ok(()) };
        let defaults = workflow.defaults.clone().unwrap_or_default();
        let max_minutes = options.max_minutes.unwrap_or(budget.max_agent_minutes).min(budget.max_agent_minutes);
        let started = self
            .host
            .start_agent(AgentRequest {
                run_id: run_id.to_owned(),
                seq,
                project_path: workflow.project_path.clone(),
                title: options.title.clone().unwrap_or_else(|| format!("{} · step {seq}", workflow.name)),
                prompt: workflow_step_header(&workflow.name, prompt),
                engine: options.engine.clone().or(defaults.backend_id.clone()),
                model: options
                    .model
                    .clone()
                    .or_else(|| defaults.model.as_ref().and_then(|m| m.as_str().map(str::to_owned))),
                workspace: options.workspace.unwrap_or(AutomationWorkspace::Worktree),
                in_worktree_of: options.in_worktree_of.clone(),
                max_minutes,
            })
            .await?;
        self.store.update_run(run_id, |run| {
            if let Some(entry) = run.journal.iter_mut().find(|e| e.seq == seq) {
                entry.thread_id = Some(started.thread_id.clone());
                entry.worktree_id = started.worktree_id.clone();
            }
        });
        Ok(())
    }

    async fn begin_judge(
        &self,
        workflow: &Workflow,
        run_id: &str,
        seq: i64,
        primitive: &Primitive,
        budget: WorkflowBudget,
        retry: bool,
    ) -> Result<()> {
        let Primitive::Judge { input, choices, rubric } = primitive else { return Ok(()) };
        let defaults = workflow.defaults.clone().unwrap_or_default();
        let mut prompt = judge_prompt(input, choices, rubric.as_deref());
        if retry {
            prompt.push_str(JUDGE_RETRY_SUFFIX);
        }
        let started = self
            .host
            .start_agent(AgentRequest {
                run_id: run_id.to_owned(),
                seq,
                project_path: workflow.project_path.clone(),
                title: format!("{} · judge {seq}", workflow.name),
                prompt,
                engine: defaults.judge_backend_id.clone().or(defaults.backend_id.clone()),
                model: defaults
                    .judge_model
                    .as_ref()
                    .or(defaults.model.as_ref())
                    .and_then(|m| m.as_str().map(str::to_owned)),
                // A judge only reads; it never needs a checkout.
                workspace: AutomationWorkspace::None,
                in_worktree_of: None,
                max_minutes: 10.0_f64.min(budget.max_agent_minutes),
            })
            .await?;
        self.store.update_run(run_id, |run| {
            if let Some(entry) = run.journal.iter_mut().find(|e| e.seq == seq) {
                entry.thread_id = Some(started.thread_id.clone());
                entry.attempts = Some(entry.attempts.unwrap_or(0) + 1);
            }
        });
        Ok(())
    }

    /// An agent thread this engine started has finished.
    pub async fn on_agent_finished(&self, thread_id: &str, outcome: super::host::AgentOutcome) -> Result<()> {
        // The journal is the durable source of truth: find the step that
        // owns this thread rather than trusting in-memory bookkeeping, which
        // a restart would have lost.
        let found = self.store.runs().into_iter().find_map(|run| {
            if !run.status.is_active() {
                return None;
            }
            run.journal
                .iter()
                .find(|e| e.status == JournalStatus::Started && e.thread_id.as_deref() == Some(thread_id))
                .map(|e| (run.id.clone(), e.seq))
        });
        let Some((run_id, seq)) = found else { return Ok(()) };
        self.settle_agent_step(&run_id, seq, outcome).await
    }

    /// Turn an agent outcome into a step result, retrying a judge once when
    /// its verdict did not parse.
    async fn settle_agent_step(&self, run_id: &str, seq: i64, outcome: super::host::AgentOutcome) -> Result<()> {
        let Some(run) = self.store.run(run_id) else { return Ok(()) };
        let Some(entry) = run.journal.iter().find(|e| e.seq == seq).cloned() else { return Ok(()) };

        if entry.op == JournalOp::Judge {
            let choices: Vec<String> = entry
                .args
                .as_ref()
                .and_then(|args| args.get("choices"))
                .and_then(Value::as_array)
                .map(|items| items.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect())
                .unwrap_or_default();
            let text = outcome.text.as_deref().or(outcome.summary.as_deref());
            let parsed = if outcome.status == AgentStatus::Success {
                parse_judge_outcome(text, &choices)
            } else {
                None
            };
            match parsed {
                Some(verdict) => {
                    self.settle(run_id, seq, Ok(serde_json::to_value(verdict).unwrap_or(Value::Null)));
                }
                None if outcome.status == AgentStatus::Success && entry.attempts.unwrap_or(1) < 2 => {
                    // One retry with a firmer contract before giving up.
                    let Some(workflow) = self.store.workflow(&run.workflow_id) else { return Ok(()) };
                    let budget = workflow.budget.unwrap_or_default().resolve();
                    self.store.update_run(run_id, |r| r.usage.judge_calls += 1);
                    let primitive = Primitive::Judge {
                        input: entry
                            .args
                            .as_ref()
                            .and_then(|a| a.get("input"))
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_owned(),
                        choices,
                        rubric: entry
                            .args
                            .as_ref()
                            .and_then(|a| a.get("callOptions"))
                            .and_then(|o| o.get("rubric"))
                            .and_then(Value::as_str)
                            .map(str::to_owned),
                    };
                    if let Err(error) = self.begin_judge(&workflow, run_id, seq, &primitive, budget, true).await {
                        self.settle(run_id, seq, Err(error.to_string()));
                    }
                    self.store.save()?;
                    if !self.step_settled(run_id, seq) {
                        return Ok(());
                    }
                }
                None => {
                    let message = if outcome.status == AgentStatus::Success {
                        "The judge never produced a valid VERDICT line.".to_owned()
                    } else {
                        outcome.error.clone().unwrap_or_else(|| {
                            let status = serde_json::to_value(outcome.status)
                                .ok()
                                .and_then(|v| v.as_str().map(str::to_owned))
                                .unwrap_or_default();
                            format!("The judge conversation ended with status {status}.")
                        })
                    };
                    self.settle(run_id, seq, Err(message));
                }
            }
        } else {
            self.settle(run_id, seq, Ok(serde_json::to_value(&outcome).unwrap_or(Value::Null)));
        }
        self.store.save()?;
        self.launch(run_id).await
    }

    // ------------------------------------------------------------- resume

    /// One scheduler pass: fire due cron triggers and expired timers.
    pub async fn tick(&self) -> Result<()> {
        for (target, event) in self.bus.tick()? {
            self.deliver(target, event).await?;
        }
        Ok(())
    }

    /// Publish an event and deliver it to whatever was waiting.
    pub async fn publish(&self, event: &BossEvent) -> Result<()> {
        for (target, delivered) in self.bus.publish(event)? {
            self.deliver(target, delivered).await?;
        }
        Ok(())
    }

    /// Hand a fired subscription to its run or workflow.
    async fn deliver(&self, target: SubscriptionTarget, event: Option<BossEvent>) -> Result<()> {
        match target {
            SubscriptionTarget::Trigger { workflow_id } => {
                let Some(workflow) = self.store.workflow(&workflow_id) else { return Ok(()) };
                let Some(event) = event else { return Ok(()) };
                if !workflow.enabled {
                    return Ok(());
                }
                let trigger = if event.kind == "cron.fired" {
                    WorkflowRunTrigger::Cron
                } else {
                    WorkflowRunTrigger::Event
                };
                self.start_run(&workflow, trigger, Some(event), None).await?;
                Ok(())
            }
            SubscriptionTarget::Resume { run_id, seq } => {
                let Some(run) = self.store.run(&run_id) else { return Ok(()) };
                if !run.status.is_active() {
                    return Ok(());
                }
                if seq == DEADLINE_SEQ {
                    return self
                        .finish_run(
                            &run_id,
                            WorkflowRunStatus::NeedsAttention,
                            Some("The run exceeded its wall-clock budget.".to_owned()),
                        )
                        .await;
                }
                let Some(entry) = run.journal.iter().find(|e| e.seq == seq).cloned() else { return Ok(()) };
                if entry.status != JournalStatus::Started {
                    return Ok(());
                }
                // The journal is the source of truth: a delivery must match
                // the entry's own recorded pattern. This shields a
                // re-journaled step from a stale subscription left behind by
                // a since-edited script.
                match entry.op {
                    JournalOp::Wait => {
                        let recorded: Option<EventPattern> = entry
                            .args
                            .as_ref()
                            .and_then(|args| args.get("pattern"))
                            .and_then(|p| serde_json::from_value(p.clone()).ok());
                        match (&event, &recorded) {
                            (Some(event), Some(pattern)) if !matches_pattern(pattern, event) => return Ok(()),
                            (Some(_), None) => return Ok(()),
                            // A timeout only settles a wait that asked for one.
                            (None, _) if entry.args.as_ref().and_then(|a| a.get("timeoutMs")).is_none() => {
                                return Ok(());
                            }
                            _ => {}
                        }
                    }
                    // A sleep ends on its timer, never on an event.
                    JournalOp::Sleep if event.is_some() => return Ok(()),
                    JournalOp::Sleep => {}
                    _ => return Ok(()),
                }
                let value = match &event {
                    Some(event) => clamp_result(&serde_json::to_value(event).unwrap_or(Value::Null)),
                    None => Value::Null,
                };
                self.settle(&run_id, seq, Ok(value));
                self.store.save()?;
                self.launch(&run_id).await
            }
        }
    }

    /// Rebuild live state for every unfinished run after an app start.
    ///
    /// In-flight steps are reattached first — a live agent thread keeps
    /// running, a vanished one re-performs, a lost wait subscription is
    /// re-registered — and then each run replays to where it left off.
    pub async fn recover(&self) -> Result<()> {
        for workflow in self.store.workflows() {
            if workflow.enabled {
                self.register_triggers(&workflow)?;
            }
        }
        for run in self.store.active_runs() {
            let in_flight: Vec<JournalEntry> =
                run.journal.iter().filter(|e| e.status == JournalStatus::Started).cloned().collect();
            for entry in in_flight {
                if let Err(error) = self.reattach(&run.id, &entry).await {
                    self.settle(&run.id, entry.seq, Err(error.to_string()));
                }
            }
            self.store.save()?;
            self.launch(&run.id).await?;
        }
        Ok(())
    }

    /// Reattach one in-flight journal entry found during recovery.
    async fn reattach(&self, run_id: &str, entry: &JournalEntry) -> Result<()> {
        match entry.op {
            JournalOp::Agent | JournalOp::Judge => {
                if let Some(thread) = &entry.thread_id {
                    if self.host.is_agent_active(thread) {
                        // Still working: leave it be, its completion will
                        // arrive through `on_agent_finished`.
                        return Ok(());
                    }
                    if let Some(outcome) = self.host.collect_outcome(thread).await {
                        return self.settle_agent_step(run_id, entry.seq, outcome).await;
                    }
                }
                // The conversation is gone, or never started: re-perform the
                // step in a fresh thread. This is the "restart the stage"
                // recovery.
                let Some(primitive) = primitive_from_entry(entry) else {
                    bail!("This step cannot be replayed: its recorded arguments are unreadable.");
                };
                self.perform(run_id, entry.seq, primitive).await
            }
            JournalOp::Wait | JournalOp::Sleep => {
                let already = self.bus.list().iter().any(|item| {
                    matches!(&item.target, SubscriptionTarget::Resume { run_id: r, seq } if r == run_id && *seq == entry.seq)
                });
                if already {
                    return Ok(());
                }
                let expires_at = match entry.op {
                    JournalOp::Sleep => entry
                        .args
                        .as_ref()
                        .and_then(|a| a.get("ms"))
                        .and_then(Value::as_i64)
                        .map(|ms| entry.started_at + ms),
                    _ => entry
                        .args
                        .as_ref()
                        .and_then(|a| a.get("timeoutMs"))
                        .and_then(Value::as_i64)
                        .map(|ms| entry.started_at + ms),
                };
                // A deadline that passed while the app was down settles now.
                if expires_at.is_some_and(|at| at <= self.clock.now_ms()) {
                    self.settle(run_id, entry.seq, Ok(Value::Null));
                    return Ok(());
                }
                let pattern: Option<EventPattern> = entry
                    .args
                    .as_ref()
                    .and_then(|a| a.get("pattern"))
                    .and_then(|p| serde_json::from_value(p.clone()).ok());
                self.bus.subscribe(
                    SubscriptionTarget::Resume { run_id: run_id.to_owned(), seq: entry.seq },
                    pattern,
                    None,
                    expires_at,
                )?;
                Ok(())
            }
            // `ask` needs nothing: the pending question survives in the
            // journal and `answer` settles it whenever the user responds.
            JournalOp::Ask => Ok(()),
            // An immediate op interrupted between perform and persist. Its
            // effect is idempotent or harmless to repeat, so re-perform.
            _ => match primitive_from_entry(entry) {
                Some(primitive) => self.perform(run_id, entry.seq, primitive).await,
                None => {
                    self.settle(run_id, entry.seq, Ok(Value::Null));
                    Ok(())
                }
            },
        }
    }

    /// Record a run's ending, tell whoever asked, and tidy up after it.
    async fn finish_run(&self, run_id: &str, status: WorkflowRunStatus, error: Option<String>) -> Result<()> {
        let Some(run) = self.store.run(run_id) else { return Ok(()) };
        if !run.status.is_active() {
            return Ok(());
        }
        let now = self.clock.now_ms();
        self.store.update_run(run_id, |run| {
            run.status = status;
            if let Some(error) = &error {
                run.error = Some(error.clone());
            }
            run.finished_at = Some(now);
        });
        let workflow = self.store.workflow(&run.workflow_id);
        let name = workflow.as_ref().map(|w| w.name.clone()).unwrap_or_else(|| "Workflow".to_owned());

        // Notify in the same breath as the status flip: whoever sees the
        // terminal status must also find the notification.
        if matches!(status, WorkflowRunStatus::Failed | WorkflowRunStatus::NeedsAttention) {
            let body = match status {
                WorkflowRunStatus::Failed => {
                    format!("The run failed: {}", error.clone().unwrap_or_else(|| "unknown error.".to_owned()))
                }
                _ => error.clone().unwrap_or_else(|| "The run needs your attention.".to_owned()),
            };
            self.host.notify(Notice {
                title: format!("BOSS · {name}"),
                body,
                attention: true,
                project_path: workflow.as_ref().map(|w| w.project_path.clone()).unwrap_or_default(),
                thread_id: None,
            });
        }

        // Stop whatever was still working for a run that did not complete.
        let refreshed = self.store.run(run_id).unwrap_or(run);
        for entry in refreshed.journal.iter().filter(|e| e.status == JournalStatus::Started) {
            if let Some(thread) = &entry.thread_id {
                if status != WorkflowRunStatus::Completed {
                    let _ = self.host.abort_agent(thread).await;
                }
            }
        }
        self.bus.unsubscribe_run(run_id)?;

        // Close the loop for an agent that called boss_workflow_run.
        if let Some(thread) = &refreshed.started_by_thread_id {
            let status_text = serde_json::to_value(status)
                .ok()
                .and_then(|v| v.as_str().map(str::to_owned))
                .unwrap_or_default();
            let mut lines = vec![
                "[BOSS WORKFLOW RESULT]".to_owned(),
                format!("Workflow: {name}"),
                format!("Run {} finished: {status_text}.", refreshed.id),
            ];
            if let Some(error) = &refreshed.error {
                lines.push(format!("Error: {error}"));
            }
            if let Some(result) = refreshed.result.as_ref().filter(|r| !r.is_null()) {
                let rendered = match result.as_str() {
                    Some(text) => text.to_owned(),
                    None => result.to_string(),
                };
                lines.push(format!("Result: {rendered}"));
            }
            let _ = self.host.deliver_to_thread(thread, &lines.join("\n")).await;
        }

        if let Some(workflow) = &workflow {
            let pruned = self.store.prune_candidates(&workflow.id);
            for old in &pruned {
                self.dispose_run(old).await;
            }
            let ids: Vec<String> = pruned.into_iter().map(|r| r.id).collect();
            self.store.drop_runs(&ids);
        }
        self.store.save()?;
        Ok(())
    }

    /// Delete the durable leftovers of a pruned run.
    async fn dispose_run(&self, run: &WorkflowRun) {
        for entry in &run.journal {
            if let Some(thread) = &entry.thread_id {
                let _ = self.host.dispose_thread(thread, entry.worktree_id.as_deref()).await;
            }
        }
    }
}

/// Rebuild the primitive a journal entry recorded, so a step interrupted by
/// a restart can be performed again without the script.
fn primitive_from_entry(entry: &JournalEntry) -> Option<Primitive> {
    let args = entry.args.as_ref()?;
    let text = |key: &str| args.get(key).and_then(Value::as_str).unwrap_or_default().to_owned();
    let option = |group: &str, key: &str| {
        args.get(group).and_then(|o| o.get(key)).and_then(Value::as_str).map(str::to_owned)
    };
    Some(match entry.op {
        JournalOp::Agent => Primitive::Agent {
            prompt: text("prompt"),
            options: AgentOptions {
                engine: option("options", "backendId"),
                model: option("options", "model"),
                mode: option("options", "mode"),
                workspace: args
                    .get("options")
                    .and_then(|o| o.get("workspace"))
                    .and_then(|w| serde_json::from_value(w.clone()).ok()),
                in_worktree_of: option("options", "inWorktreeOf"),
                max_minutes: args.get("options").and_then(|o| o.get("maxMinutes")).and_then(Value::as_f64),
                title: option("options", "title"),
            },
        },
        JournalOp::Judge => Primitive::Judge {
            input: text("input"),
            choices: args
                .get("choices")
                .and_then(Value::as_array)
                .map(|items| items.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect())
                .unwrap_or_default(),
            rubric: option("callOptions", "rubric"),
        },
        JournalOp::Wait => Primitive::WaitFor {
            pattern: args.get("pattern").and_then(|p| serde_json::from_value(p.clone()).ok())?,
            timeout_ms: args.get("timeoutMs").and_then(Value::as_i64),
        },
        JournalOp::Sleep => Primitive::Sleep { ms: args.get("ms").and_then(Value::as_i64).unwrap_or(0) },
        JournalOp::Notify => Primitive::Notify {
            body: text("body"),
            title: option("options", "title"),
            attention: args.get("options").and_then(|o| o.get("attention")) == Some(&Value::Bool(true)),
        },
        JournalOp::Ask => Primitive::Ask {
            question: text("question"),
            choices: args
                .get("choices")
                .and_then(Value::as_array)
                .map(|items| items.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect()),
        },
        JournalOp::StateGet => Primitive::StateGet { key: text("key") },
        JournalOp::StateSet => {
            Primitive::StateSet { key: text("key"), value: args.get("value").cloned().unwrap_or(Value::Null) }
        }
        JournalOp::Log => Primitive::Log { message: text("message") },
        JournalOp::Pr => Primitive::Pr {
            thread_id: text("threadId"),
            title: option("options", "title"),
            body: option("options", "body"),
            base_branch: option("options", "baseBranch"),
            draft: args.get("options").and_then(|o| o.get("draft")) == Some(&Value::Bool(true)),
        },
    })
}

/// One replay of one run: consults the journal for each call, and collects
/// the steps that need live work for the engine to perform afterwards.
struct Replay {
    engine_store: Arc<WorkflowStore>,
    run_id: String,
    workflow: Workflow,
    next_seq: std::sync::Mutex<i64>,
    performed: std::sync::Mutex<Vec<(i64, Primitive)>>,
    event: Option<BossEvent>,
}

#[async_trait]
impl StepContext for Replay {
    fn event(&self) -> Option<BossEvent> {
        self.event.clone()
    }

    /// The one replay-aware primitive wrapper.
    ///
    /// Consults the journal, then either returns the recorded result, parks
    /// on an in-flight step, or records a fresh entry for the engine to
    /// perform.
    async fn call(&self, primitive: Primitive) -> StepOutcome {
        let seq = {
            let mut next = self.next_seq.lock().unwrap();
            let seq = *next;
            *next += 1;
            seq
        };
        let op = primitive.op();
        let args = clamp_result(&primitive.args());
        let op_name = serde_json::to_value(op).ok().and_then(|v| v.as_str().map(str::to_owned)).unwrap_or_default();
        let args_hash = hash_args(&op_name, &args);

        let existing = self
            .engine_store
            .run(&self.run_id)
            .and_then(|run| run.journal.iter().find(|e| e.seq == seq).cloned());

        let mut entry = existing;
        let mut invalidated_from = None;

        // The script changed since this journal was written. Everything from
        // here on no longer matches; drop it and continue live. Earlier
        // steps keep their results — that is what makes editing a workflow
        // mid-run safe.
        if let Some(found) = &entry {
            if found.op != op || found.args_hash != args_hash {
                let note = format!("The script changed; steps from #{seq} re-ran.");
                self.engine_store.update_run(&self.run_id, |run| {
                    run.journal.retain(|e| e.seq < seq);
                    run.note = Some(note);
                });
                invalidated_from = Some(seq);
                entry = None;
            }
        }

        // An immediate step interrupted mid-write (the app quit between
        // perform and persist). Its effect is idempotent or harmless to
        // repeat, so re-perform rather than park forever.
        if let Some(found) = &entry {
            if found.status == JournalStatus::Started && op.is_immediate() {
                self.engine_store.update_run(&self.run_id, |run| run.journal.retain(|e| e.seq != seq));
                entry = None;
            }
        }

        if let Some(found) = entry {
            return match found.status {
                JournalStatus::Done => StepOutcome::Done(found.result.unwrap_or(Value::Null)),
                JournalStatus::Failed => {
                    StepOutcome::Failed(found.error.unwrap_or_else(|| "This step failed.".to_owned()))
                }
                // In flight: this replay stops here.
                JournalStatus::Started => StepOutcome::Parked,
            };
        }

        let fresh = JournalEntry {
            seq,
            op,
            args_hash,
            label: Some(label_for(op, &args)),
            args: Some(args),
            status: JournalStatus::Started,
            attempts: None,
            thread_id: None,
            worktree_id: None,
            result: None,
            error: None,
            started_at: now_ms(),
            finished_at: None,
        };
        self.engine_store.update_run(&self.run_id, |run| run.journal.push(fresh));
        self.performed.lock().unwrap().push((seq, primitive));
        let _ = (&self.workflow, invalidated_from);
        StepOutcome::Parked
    }

    fn take_pending(&self) -> Vec<(i64, Primitive)> {
        std::mem::take(&mut *self.performed.lock().unwrap())
    }
}

/// A short human-readable label for run displays.
fn label_for(op: JournalOp, args: &Value) -> String {
    let text = |key: &str| args.get(key).and_then(Value::as_str).unwrap_or("").to_owned();
    let raw = match op {
        JournalOp::Agent => text("prompt"),
        JournalOp::Judge => text("input"),
        JournalOp::Wait => {
            let kind = args
                .get("pattern")
                .and_then(|p| p.get("type"))
                .and_then(Value::as_str)
                .unwrap_or("event");
            format!("waiting for {kind}")
        }
        JournalOp::Ask => text("question"),
        JournalOp::Notify => text("body"),
        JournalOp::Log => text("message"),
        JournalOp::Sleep => {
            format!("sleeping {}ms", args.get("ms").and_then(Value::as_i64).unwrap_or(0))
        }
        other => serde_json::to_value(other)
            .ok()
            .and_then(|v| v.as_str().map(str::to_owned))
            .unwrap_or_default(),
    };
    let flat = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() > 80 {
        let kept: String = flat.chars().take(77).collect();
        format!("{kept}…")
    } else {
        flat
    }
}

/// Convenience for tests and callers building an input by hand.
impl WorkflowInput {
    pub fn new(name: impl Into<String>, script: impl Into<String>) -> Self {
        Self { name: name.into(), script: script.into(), keep_runs: 100, ..Default::default() }
    }
}

/// A trigger's cron expression, if it has one.
pub fn trigger_cron(trigger: &WorkflowTrigger) -> Option<&str> {
    match trigger {
        WorkflowTrigger::Cron { expression } => Some(expression),
        WorkflowTrigger::Event { .. } => None,
    }
}

/// The pattern an event trigger listens for.
pub fn trigger_pattern(trigger: &WorkflowTrigger) -> Option<&EventPattern> {
    match trigger {
        WorkflowTrigger::Cron { .. } => None,
        WorkflowTrigger::Event { pattern } => Some(pattern),
    }
}

/// Named steps a scripted test runs, standing in for a compiled script.
pub type Steps = Vec<Primitive>;

/// A [`ScriptRunner`] that plays a fixed list of primitives in order and
/// returns `done` when they all settle. Enough to exercise the journal,
/// replay, and budgets without a JavaScript engine.
pub struct SequenceRunner {
    steps: Steps,
    /// Returned as the run's result once every step is done.
    done: Value,
    /// Scripts to swap in by name, for editing a workflow mid-run.
    named: BTreeMap<String, Steps>,
}

impl SequenceRunner {
    pub fn new(steps: Steps) -> Arc<Self> {
        Arc::new(Self { steps, done: json!("ok"), named: BTreeMap::new() })
    }

    pub fn with_result(steps: Steps, done: Value) -> Arc<Self> {
        Arc::new(Self { steps, done, named: BTreeMap::new() })
    }

    /// A runner that picks its steps by the workflow's script text, so a
    /// test can "edit" a workflow and get different behaviour.
    pub fn named(named: BTreeMap<String, Steps>, done: Value) -> Arc<Self> {
        Arc::new(Self { steps: Vec::new(), done, named })
    }
}

#[async_trait]
impl ScriptRunner for SequenceRunner {
    async fn run(&self, script: &str, context: Arc<dyn StepContext>) -> Result<Option<Value>> {
        let steps = self.named.get(script).unwrap_or(&self.steps);
        for step in steps {
            match context.call(step.clone()).await {
                StepOutcome::Done(_) => continue,
                StepOutcome::Failed(message) => bail!(message),
                StepOutcome::Parked => return Ok(None),
            }
        }
        Ok(Some(self.done.clone()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::automations::bus::FakeClock;
    use crate::automations::host::{AgentOutcome, AutomationHost, RunOutcome, StartedAgent};
    use std::sync::Mutex;

    #[derive(Default)]
    struct FakeHost {
        started: Mutex<Vec<AgentRequest>>,
        aborted: Mutex<Vec<String>>,
        disposed: Mutex<Vec<String>>,
        delivered: Mutex<Vec<(String, String)>>,
        notices: Mutex<Vec<Notice>>,
        active: Mutex<Vec<String>>,
        outcome: Mutex<Option<AgentOutcome>>,
        change_request: Mutex<Option<Value>>,
    }

    impl FakeHost {
        fn arc() -> Arc<Self> {
            Arc::new(Self::default())
        }
        fn last_thread(&self) -> String {
            self.started.lock().unwrap().last().map(|r| thread_of(r)).expect("an agent was started")
        }
        fn notice_bodies(&self) -> Vec<String> {
            self.notices.lock().unwrap().iter().map(|n| n.body.clone()).collect()
        }
    }

    fn thread_of(request: &AgentRequest) -> String {
        format!("t-{}-{}", request.run_id, request.seq)
    }

    #[async_trait]
    impl AutomationHost for FakeHost {
        async fn start_agent(&self, request: AgentRequest) -> Result<StartedAgent> {
            let thread_id = thread_of(&request);
            self.started.lock().unwrap().push(request);
            self.active.lock().unwrap().push(thread_id.clone());
            Ok(StartedAgent { thread_id, worktree_id: None })
        }
        fn is_agent_active(&self, thread_id: &str) -> bool {
            self.active.lock().unwrap().iter().any(|t| t == thread_id)
        }
        async fn collect_outcome(&self, thread_id: &str) -> Option<AgentOutcome> {
            self.outcome.lock().unwrap().clone().map(|mut o| {
                o.thread_id = thread_id.to_owned();
                o
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
        async fn deliver_to_thread(&self, thread_id: &str, body: &str) -> Result<()> {
            self.delivered.lock().unwrap().push((thread_id.to_owned(), body.to_owned()));
            Ok(())
        }
        async fn dispose_thread(&self, thread_id: &str, _worktree: Option<&str>) -> Result<()> {
            self.disposed.lock().unwrap().push(thread_id.to_owned());
            Ok(())
        }
        async fn record_report(&self, _outcome: RunOutcome) -> Result<()> {
            Ok(())
        }
    }

    #[async_trait]
    impl WorkflowHost for FakeHost {
        async fn create_change_request(
            &self,
            _thread_id: &str,
            _title: Option<&str>,
            _body: Option<&str>,
            _base: Option<&str>,
            _draft: bool,
        ) -> Result<Value> {
            match self.change_request.lock().unwrap().clone() {
                Some(value) => Ok(value),
                None => bail!("Change requests are not available in this BOSS build."),
            }
        }
    }

    const START: i64 = 1_767_257_940_000;

    struct Harness {
        engine: Arc<WorkflowEngine>,
        host: Arc<FakeHost>,
        clock: Arc<FakeClock>,
        store: Arc<WorkflowStore>,
        dir: tempfile::TempDir,
    }

    fn harness_with(scripts: Arc<dyn ScriptRunner>) -> Harness {
        let dir = tempfile::tempdir().unwrap();
        let clock = FakeClock::new(START);
        let store = Arc::new(WorkflowStore::open(dir.path()).unwrap());
        let bus = Arc::new(EventBus::open(dir.path(), clock.clone()).unwrap());
        let host = FakeHost::arc();
        let engine = WorkflowEngine::new(store.clone(), bus, host.clone(), clock.clone(), scripts);
        Harness { engine, host, clock, store, dir }
    }

    fn harness(steps: Steps) -> Harness {
        harness_with(SequenceRunner::new(steps))
    }

    fn agent(prompt: &str) -> Primitive {
        Primitive::Agent { prompt: prompt.to_owned(), options: AgentOptions::default() }
    }

    fn make(h: &Harness, name: &str) -> Workflow {
        h.engine.create(WorkflowInput::new(name, "script();"), WorkflowSource::User).unwrap()
    }

    #[tokio::test]
    async fn a_script_of_immediate_steps_completes_in_one_pass() {
        let h = harness(vec![
            Primitive::Log { message: "starting".into() },
            Primitive::StateSet { key: "seen".into(), value: json!(1) },
            Primitive::StateGet { key: "seen".into() },
        ]);
        let workflow = make(&h, "Quick");
        let run = h.engine.run_now(&workflow.id, None).await.unwrap();
        let finished = h.store.run(&run.id).unwrap();
        assert_eq!(finished.status, WorkflowRunStatus::Completed);
        assert_eq!(finished.result, Some(json!("ok")));
        assert_eq!(finished.journal.len(), 3);
        assert!(finished.journal.iter().all(|e| e.status == JournalStatus::Done));
        // state.get read back what state.set wrote.
        assert_eq!(finished.journal[2].result, Some(json!(1)));
        assert_eq!(h.store.memory_get(&workflow.id, "seen"), json!(1));
    }

    #[tokio::test]
    async fn an_agent_step_parks_the_run_until_its_thread_finishes() {
        let h = harness(vec![agent("do the work")]);
        let workflow = make(&h, "One step");
        let run = h.engine.run_now(&workflow.id, None).await.unwrap();
        let parked = h.store.run(&run.id).unwrap();
        assert_eq!(parked.status, WorkflowRunStatus::Running);
        assert_eq!(parked.journal.len(), 1);
        assert_eq!(parked.journal[0].status, JournalStatus::Started);
        assert_eq!(parked.usage.agent_runs, 1);
        let request = h.host.started.lock().unwrap()[0].clone();
        assert!(request.prompt.starts_with("[BOSS WORKFLOW STEP]\nWorkflow: One step\n"));
        assert!(request.prompt.ends_with("\n\ndo the work"));

        let thread = h.host.last_thread();
        h.engine
            .on_agent_finished(
                &thread,
                AgentOutcome {
                    status: AgentStatus::Success,
                    summary: Some("done".into()),
                    text: None,
                    changed_files: 2,
                    thread_id: thread.clone(),
                    worktree_id: None,
                    error: None,
                },
            )
            .await
            .unwrap();
        let finished = h.store.run(&run.id).unwrap();
        assert_eq!(finished.status, WorkflowRunStatus::Completed);
        let result = finished.journal[0].result.as_ref().unwrap();
        assert_eq!(result["status"], "success");
        assert_eq!(result["changedFiles"], 2);
    }

    #[tokio::test]
    async fn a_multi_step_script_replays_earlier_steps_from_the_journal() {
        let h = harness(vec![agent("first"), agent("second")]);
        let workflow = make(&h, "Two steps");
        let run = h.engine.run_now(&workflow.id, None).await.unwrap();
        assert_eq!(h.host.started.lock().unwrap().len(), 1, "only the first step started");

        let first = h.host.last_thread();
        h.engine.on_agent_finished(&first, success(&first)).await.unwrap();
        // The replay returned step 0 from the journal and performed step 1.
        assert_eq!(h.host.started.lock().unwrap().len(), 2);
        let journal = h.store.run(&run.id).unwrap().journal;
        assert_eq!(journal[0].status, JournalStatus::Done);
        assert_eq!(journal[1].status, JournalStatus::Started);

        let second = h.host.last_thread();
        h.engine.on_agent_finished(&second, success(&second)).await.unwrap();
        assert_eq!(h.store.run(&run.id).unwrap().status, WorkflowRunStatus::Completed);
        assert_eq!(h.store.run(&run.id).unwrap().usage.agent_runs, 2);
    }

    fn success(thread: &str) -> AgentOutcome {
        AgentOutcome {
            status: AgentStatus::Success,
            summary: Some("ok".into()),
            text: Some("SUMMARY: ok".into()),
            changed_files: 0,
            thread_id: thread.to_owned(),
            worktree_id: None,
            error: None,
        }
    }

    #[tokio::test]
    async fn a_failed_step_fails_the_run_with_its_message() {
        let h = harness(vec![agent("do it")]);
        let workflow = make(&h, "Failing");
        let run = h.engine.run_now(&workflow.id, None).await.unwrap();
        let thread = h.host.last_thread();
        h.engine
            .on_agent_finished(
                &thread,
                AgentOutcome {
                    status: AgentStatus::Failure,
                    summary: None,
                    text: None,
                    changed_files: 0,
                    thread_id: thread.clone(),
                    worktree_id: None,
                    error: Some("the engine died".into()),
                },
            )
            .await
            .unwrap();
        // An agent step resolves to its outcome, not an error: the script
        // decides what a failed agent means.
        let finished = h.store.run(&run.id).unwrap();
        assert_eq!(finished.status, WorkflowRunStatus::Completed);
        assert_eq!(finished.journal[0].result.as_ref().unwrap()["status"], "failure");
    }

    #[tokio::test]
    async fn the_agent_budget_ends_the_run_as_needs_attention() {
        let h = harness(vec![agent("a"), agent("b"), agent("c")]);
        let workflow = h
            .engine
            .create(
                WorkflowInput {
                    budget: Some(PartialBudget { max_agent_runs: Some(2), ..Default::default() }),
                    ..WorkflowInput::new("Tight", "script();")
                },
                WorkflowSource::User,
            )
            .unwrap();
        let run = h.engine.run_now(&workflow.id, None).await.unwrap();
        for _ in 0..2 {
            let thread = h.host.last_thread();
            h.engine.on_agent_finished(&thread, success(&thread)).await.unwrap();
        }
        let finished = h.store.run(&run.id).unwrap();
        assert_eq!(finished.status, WorkflowRunStatus::NeedsAttention);
        assert!(finished.error.as_deref().unwrap().contains("Budget exceeded"), "{:?}", finished.error);
        assert_eq!(h.host.started.lock().unwrap().len(), 2, "the third agent never started");
        assert!(h.host.notice_bodies()[0].contains("Budget exceeded"));
    }

    #[tokio::test]
    async fn the_notify_budget_stops_at_the_limit() {
        let h = harness(vec![
            Primitive::Notify { body: "one".into(), title: None, attention: false },
            Primitive::Notify { body: "two".into(), title: None, attention: false },
            Primitive::Notify { body: "three".into(), title: None, attention: false },
        ]);
        let workflow = h
            .engine
            .create(
                WorkflowInput {
                    budget: Some(PartialBudget { max_notifies: Some(2), ..Default::default() }),
                    ..WorkflowInput::new("Chatty", "script();")
                },
                WorkflowSource::User,
            )
            .unwrap();
        let run = h.engine.run_now(&workflow.id, None).await.unwrap();
        assert_eq!(h.store.run(&run.id).unwrap().status, WorkflowRunStatus::NeedsAttention);
        // Two got through; the third was refused, and the run's own
        // needs-attention notice is the last one.
        let bodies = h.host.notice_bodies();
        assert_eq!(bodies[0], "one");
        assert_eq!(bodies[1], "two");
        assert!(bodies[2].contains("Budget exceeded"));
    }

    #[tokio::test]
    async fn a_judge_step_parses_the_verdict() {
        let h = harness(vec![Primitive::Judge {
            input: "the diff".into(),
            choices: vec!["pass".into(), "fail".into()],
            rubric: Some("be strict".into()),
        }]);
        let workflow = make(&h, "Judged");
        let run = h.engine.run_now(&workflow.id, None).await.unwrap();
        let prompt = h.host.started.lock().unwrap()[0].prompt.clone();
        assert!(prompt.starts_with("[BOSS WORKFLOW JUDGE]"));
        assert!(prompt.contains("Rubric:\nbe strict"));
        assert_eq!(h.host.started.lock().unwrap()[0].workspace, AutomationWorkspace::None);

        let thread = h.host.last_thread();
        h.engine
            .on_agent_finished(
                &thread,
                AgentOutcome {
                    text: Some("REASON: tests are green\nVERDICT: pass".into()),
                    ..success(&thread)
                },
            )
            .await
            .unwrap();
        let finished = h.store.run(&run.id).unwrap();
        assert_eq!(finished.status, WorkflowRunStatus::Completed);
        let verdict = finished.journal[0].result.as_ref().unwrap();
        assert_eq!(verdict["verdict"], "pass");
        assert_eq!(verdict["reason"], "tests are green");
    }

    #[tokio::test]
    async fn a_judge_that_will_not_answer_is_retried_once_then_fails() {
        let h = harness(vec![Primitive::Judge {
            input: "the diff".into(),
            choices: vec!["pass".into(), "fail".into()],
            rubric: None,
        }]);
        let workflow = make(&h, "Judged");
        let run = h.engine.run_now(&workflow.id, None).await.unwrap();

        let first = h.host.last_thread();
        h.engine
            .on_agent_finished(&first, AgentOutcome { text: Some("I am not sure".into()), ..success(&first) })
            .await
            .unwrap();
        assert_eq!(h.host.started.lock().unwrap().len(), 2, "retried once");
        let retry_prompt = h.host.started.lock().unwrap()[1].prompt.clone();
        assert!(retry_prompt.ends_with(JUDGE_RETRY_SUFFIX));
        assert_eq!(h.store.run(&run.id).unwrap().journal[0].attempts, Some(2));

        let second = h.host.last_thread();
        h.engine
            .on_agent_finished(&second, AgentOutcome { text: Some("still unsure".into()), ..success(&second) })
            .await
            .unwrap();
        assert_eq!(h.host.started.lock().unwrap().len(), 2, "no second retry");
        let finished = h.store.run(&run.id).unwrap();
        assert_eq!(finished.status, WorkflowRunStatus::Failed);
        assert!(finished.error.as_deref().unwrap().contains("valid VERDICT line"));
    }

    #[tokio::test]
    async fn a_wait_step_resumes_on_a_matching_event_only() {
        let h = harness(vec![Primitive::WaitFor {
            pattern: EventPattern {
                kind: "github.workflow_run".into(),
                project_path: None,
                filters: Some([("conclusion".to_owned(), json!("success"))].into()),
            },
            timeout_ms: Some(3_600_000),
        }]);
        let workflow = make(&h, "Watcher");
        let run = h.engine.run_now(&workflow.id, None).await.unwrap();
        assert_eq!(h.store.run(&run.id).unwrap().status, WorkflowRunStatus::Waiting);

        // A failing CI run is not what this step is waiting for.
        let mut event = BossEvent::new("github.workflow_run", h.clock.now_ms());
        event.data.insert("conclusion".into(), json!("failure"));
        h.engine.publish(&event).await.unwrap();
        assert_eq!(h.store.run(&run.id).unwrap().status, WorkflowRunStatus::Waiting);

        let mut good = BossEvent::new("github.workflow_run", h.clock.now_ms());
        good.data.insert("conclusion".into(), json!("success"));
        h.engine.publish(&good).await.unwrap();
        let finished = h.store.run(&run.id).unwrap();
        assert_eq!(finished.status, WorkflowRunStatus::Completed);
        assert_eq!(finished.journal[0].result.as_ref().unwrap()["type"], "github.workflow_run");
    }

    #[tokio::test]
    async fn a_wait_that_times_out_resumes_with_nothing() {
        let h = harness(vec![Primitive::WaitFor {
            pattern: EventPattern { kind: "github.push".into(), ..Default::default() },
            timeout_ms: Some(60_000),
        }]);
        let workflow = make(&h, "Impatient");
        let run = h.engine.run_now(&workflow.id, None).await.unwrap();
        h.engine.tick().await.unwrap();
        assert_eq!(h.store.run(&run.id).unwrap().status, WorkflowRunStatus::Waiting);

        h.clock.advance(61_000);
        h.engine.tick().await.unwrap();
        let finished = h.store.run(&run.id).unwrap();
        assert_eq!(finished.status, WorkflowRunStatus::Completed);
        assert_eq!(finished.journal[0].result, Some(Value::Null), "a timeout resolves to null");
    }

    #[tokio::test]
    async fn a_sleep_step_resumes_on_its_deadline_and_ignores_events() {
        let h = harness(vec![Primitive::Sleep { ms: 3_600_000 }]);
        let workflow = make(&h, "Sleeper");
        let run = h.engine.run_now(&workflow.id, None).await.unwrap();
        assert_eq!(h.store.run(&run.id).unwrap().status, WorkflowRunStatus::Waiting);

        // No event wakes a sleep.
        h.engine.publish(&BossEvent::new("github.push", h.clock.now_ms())).await.unwrap();
        assert_eq!(h.store.run(&run.id).unwrap().status, WorkflowRunStatus::Waiting);

        h.clock.advance(3_600_001);
        h.engine.tick().await.unwrap();
        assert_eq!(h.store.run(&run.id).unwrap().status, WorkflowRunStatus::Completed);
    }

    #[tokio::test]
    async fn an_ask_step_waits_for_a_person_and_resumes_on_the_answer() {
        let h = harness(vec![Primitive::Ask { question: "Ship it?".into(), choices: None }]);
        let workflow = make(&h, "Asker");
        let run = h.engine.run_now(&workflow.id, None).await.unwrap();
        assert_eq!(h.store.run(&run.id).unwrap().status, WorkflowRunStatus::Waiting);
        assert!(h.host.notice_bodies()[0].contains("Waiting on you: Ship it?"));

        assert!(h.engine.answer(&run.id, 9, "yes").await.is_err(), "no question at that step");
        h.engine.answer(&run.id, 0, "yes").await.unwrap();
        let finished = h.store.run(&run.id).unwrap();
        assert_eq!(finished.status, WorkflowRunStatus::Completed);
        assert_eq!(finished.journal[0].result.as_ref().unwrap()["answer"], "yes");
        assert!(h.engine.answer(&run.id, 0, "again").await.is_err(), "the run is over");
    }

    #[tokio::test]
    async fn a_cron_trigger_starts_a_run_on_tick() {
        let h = harness(vec![Primitive::Log { message: "fired".into() }]);
        let workflow = h
            .engine
            .create(
                WorkflowInput {
                    triggers: vec![WorkflowTrigger::Cron { expression: "0 9 * * *".into() }],
                    ..WorkflowInput::new("Daily", "script();")
                },
                WorkflowSource::User,
            )
            .unwrap();
        h.engine.tick().await.unwrap();
        assert!(h.store.runs().is_empty(), "not nine o'clock yet");

        h.clock.advance(60_000);
        h.engine.tick().await.unwrap();
        let runs = h.store.runs();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].trigger, WorkflowRunTrigger::Cron);
        assert_eq!(runs[0].status, WorkflowRunStatus::Completed);
        assert_eq!(runs[0].event.as_ref().unwrap().kind, "cron.fired");
        assert_eq!(h.store.workflow(&workflow.id).unwrap().last_run_at, Some(h.clock.now_ms()));
    }

    #[tokio::test]
    async fn an_event_trigger_starts_a_run_and_a_disabled_one_does_not() {
        let h = harness(vec![Primitive::Log { message: "fired".into() }]);
        let workflow = h
            .engine
            .create(
                WorkflowInput {
                    triggers: vec![WorkflowTrigger::Event {
                        pattern: EventPattern { kind: "github.push".into(), ..Default::default() },
                    }],
                    ..WorkflowInput::new("On push", "script();")
                },
                WorkflowSource::User,
            )
            .unwrap();
        h.engine.publish(&BossEvent::new("github.push", h.clock.now_ms())).await.unwrap();
        assert_eq!(h.store.runs().len(), 1);
        assert_eq!(h.store.runs()[0].trigger, WorkflowRunTrigger::Event);

        h.engine.update(&workflow.id, WorkflowPatch { enabled: Some(false), ..Default::default() }, false).unwrap();
        h.engine.publish(&BossEvent::new("github.push", h.clock.now_ms())).await.unwrap();
        assert_eq!(h.store.runs().len(), 1, "a disabled workflow has no live triggers");
    }

    #[tokio::test]
    async fn an_agent_authored_workflow_starts_disabled_under_ask_approval() {
        let h = harness(vec![]);
        let asked = h.engine.create(WorkflowInput::new("Agent's", "script();"), WorkflowSource::Agent).unwrap();
        assert!(!asked.enabled, "enabling is the approval");
        assert!(h.engine.bus().list().is_empty(), "and its triggers stay dormant");

        h.engine.set_approval_mode(WorkflowApprovalMode::Auto).unwrap();
        let auto = h.engine.create(WorkflowInput::new("Trusted", "script();"), WorkflowSource::Agent).unwrap();
        assert!(auto.enabled);
        // A user-authored workflow is always enabled.
        assert!(h.engine.create(WorkflowInput::new("Mine", "script();"), WorkflowSource::User).unwrap().enabled);
    }

    #[tokio::test]
    async fn an_agent_edit_disables_the_workflow_again_under_ask_approval() {
        let h = harness(vec![]);
        let workflow = make(&h, "Mine");
        assert!(workflow.enabled);
        let edited = h
            .engine
            .update(&workflow.id, WorkflowPatch { script: Some("changed();".into()), ..Default::default() }, true)
            .unwrap();
        assert!(!edited.enabled, "an agent edit needs re-approval");
        // A user edit does not.
        let user_edited = h
            .engine
            .update(&workflow.id, WorkflowPatch { enabled: Some(true), ..Default::default() }, false)
            .unwrap();
        assert!(user_edited.enabled);
    }

    #[tokio::test]
    async fn overlap_skip_records_a_skipped_run_and_parallel_starts_both() {
        let h = harness(vec![agent("long")]);
        let workflow = make(&h, "Skipper");
        h.engine.run_now(&workflow.id, None).await.unwrap();
        assert!(h.engine.run_now(&workflow.id, None).await.is_err(), "a manual overlap says so");
        // A triggered overlap records a skip instead.
        let again = h
            .engine
            .start_run(&h.store.workflow(&workflow.id).unwrap(), WorkflowRunTrigger::Event, None, None)
            .await
            .unwrap();
        assert_eq!(again.status, WorkflowRunStatus::Skipped);
        assert_eq!(again.error.as_deref(), Some("The previous run was still active."));

        h.engine
            .update(
                &workflow.id,
                WorkflowPatch { overlap_policy: Some(WorkflowOverlapPolicy::Parallel), ..Default::default() },
                false,
            )
            .unwrap();
        let parallel = h.engine.run_now(&workflow.id, None).await.unwrap();
        assert_eq!(parallel.status, WorkflowRunStatus::Running);
    }

    #[tokio::test]
    async fn editing_a_script_mid_run_keeps_earlier_steps_and_re_runs_the_tail() {
        // Two named scripts: the second changes step 1.
        let first: Steps = vec![agent("step zero"), agent("step one")];
        let second: Steps = vec![agent("step zero"), agent("step one, revised")];
        let runner = SequenceRunner::named(
            [("v1".to_owned(), first), ("v2".to_owned(), second)].into(),
            json!("ok"),
        );
        let h = harness_with(runner);
        let workflow = h.engine.create(WorkflowInput::new("Editable", "v1"), WorkflowSource::User).unwrap();
        let run = h.engine.run_now(&workflow.id, None).await.unwrap();

        let zero = h.host.last_thread();
        h.engine.on_agent_finished(&zero, success(&zero)).await.unwrap();
        assert_eq!(h.host.started.lock().unwrap().len(), 2);
        let before = h.store.run(&run.id).unwrap();
        assert_eq!(before.journal.len(), 2);
        let step_zero_hash = before.journal[0].args_hash.clone();

        // Edit the script while the run is parked on step 1.
        h.engine
            .update(&workflow.id, WorkflowPatch { script: Some("v2".into()), ..Default::default() }, false)
            .unwrap();
        let one = h.host.last_thread();
        h.engine.on_agent_finished(&one, success(&one)).await.unwrap();

        let after = h.store.run(&run.id).unwrap();
        assert_eq!(after.journal[0].args_hash, step_zero_hash, "step 0 kept its recorded result");
        assert_eq!(after.journal[0].status, JournalStatus::Done);
        assert!(after.note.as_deref().unwrap().contains("steps from #1 re-ran"));
        // The revised step 1 ran with the new prompt.
        let prompts: Vec<String> = h.host.started.lock().unwrap().iter().map(|r| r.prompt.clone()).collect();
        assert!(prompts.last().unwrap().ends_with("step one, revised"), "{:?}", prompts.last());
    }

    #[tokio::test]
    async fn a_stale_subscription_cannot_settle_a_re_journaled_step() {
        let first: Steps = vec![Primitive::WaitFor {
            pattern: EventPattern { kind: "github.push".into(), ..Default::default() },
            timeout_ms: None,
        }];
        let second: Steps = vec![Primitive::WaitFor {
            pattern: EventPattern { kind: "github.pull_request".into(), ..Default::default() },
            timeout_ms: None,
        }];
        let runner =
            SequenceRunner::named([("v1".to_owned(), first), ("v2".to_owned(), second)].into(), json!("ok"));
        let h = harness_with(runner);
        let workflow = h.engine.create(WorkflowInput::new("Watcher", "v1"), WorkflowSource::User).unwrap();
        let run = h.engine.run_now(&workflow.id, None).await.unwrap();

        h.engine
            .update(&workflow.id, WorkflowPatch { script: Some("v2".into()), ..Default::default() }, false)
            .unwrap();
        // Nothing has re-run yet, so the old subscription is still live.
        // The push must not settle a step that now waits for a PR.
        h.engine.publish(&BossEvent::new("github.push", h.clock.now_ms())).await.unwrap();
        let after = h.store.run(&run.id).unwrap();
        assert!(after.status.is_active(), "the run did not complete on a stale delivery");
        assert_eq!(after.journal[0].args.as_ref().unwrap()["pattern"]["type"], "github.push");
    }

    #[tokio::test]
    async fn a_run_that_outlives_its_wall_clock_budget_needs_attention() {
        let h = harness(vec![Primitive::Sleep { ms: 400 * 3_600_000 }]);
        let workflow = h
            .engine
            .create(
                WorkflowInput {
                    budget: Some(PartialBudget { max_run_hours: Some(1.0), ..Default::default() }),
                    ..WorkflowInput::new("Slow", "script();")
                },
                WorkflowSource::User,
            )
            .unwrap();
        let run = h.engine.run_now(&workflow.id, None).await.unwrap();
        h.clock.advance(3_600_001);
        h.engine.tick().await.unwrap();
        let finished = h.store.run(&run.id).unwrap();
        assert_eq!(finished.status, WorkflowRunStatus::NeedsAttention);
        assert_eq!(finished.error.as_deref(), Some("The run exceeded its wall-clock budget."));
    }

    #[tokio::test]
    async fn stopping_a_run_aborts_its_threads_and_clears_its_subscriptions() {
        let h = harness(vec![agent("long")]);
        let workflow = make(&h, "Stoppable");
        let run = h.engine.run_now(&workflow.id, None).await.unwrap();
        h.engine.stop_run(&run.id).await.unwrap();
        assert_eq!(h.store.run(&run.id).unwrap().status, WorkflowRunStatus::Stopped);
        assert_eq!(h.host.aborted.lock().unwrap().len(), 1);
        let left = h.engine.bus().list();
        assert!(
            !left.iter().any(|s| matches!(&s.target, SubscriptionTarget::Resume { run_id, .. } if run_id == &run.id)),
            "the deadline timer went with it"
        );
        assert!(h.engine.stop_run(&run.id).await.is_err(), "nothing left to stop");
    }

    #[tokio::test]
    async fn a_finished_run_reports_back_to_the_thread_that_asked_for_it() {
        let h = harness(vec![Primitive::Log { message: "hi".into() }]);
        let workflow = make(&h, "Reporter");
        let run = h.engine.run_now(&workflow.id, Some("asking-thread".into())).await.unwrap();
        let delivered = h.host.delivered.lock().unwrap().clone();
        assert_eq!(delivered.len(), 1);
        assert_eq!(delivered[0].0, "asking-thread");
        assert!(delivered[0].1.starts_with("[BOSS WORKFLOW RESULT]\nWorkflow: Reporter\n"));
        assert!(delivered[0].1.contains(&format!("Run {} finished: completed.", run.id)));
        assert!(delivered[0].1.contains("Result: ok"));
    }

    #[tokio::test]
    async fn a_pr_step_needs_a_thread_and_a_build_that_can_make_one() {
        let h = harness(vec![Primitive::Pr {
            thread_id: String::new(),
            title: None,
            body: None,
            base_branch: None,
            draft: false,
        }]);
        let workflow = make(&h, "Opener");
        let run = h.engine.run_now(&workflow.id, None).await.unwrap();
        let finished = h.store.run(&run.id).unwrap();
        assert_eq!(finished.status, WorkflowRunStatus::Failed);
        assert!(finished.error.as_deref().unwrap().contains("pr() needs the agent outcome"));

        let h = harness(vec![Primitive::Pr {
            thread_id: "t-1".into(),
            title: Some("Add the thing".into()),
            body: None,
            base_branch: None,
            draft: false,
        }]);
        let workflow = make(&h, "Opener");
        *h.host.change_request.lock().unwrap() = Some(json!({ "url": "https://example.test/pr/1" }));
        let run = h.engine.run_now(&workflow.id, None).await.unwrap();
        let finished = h.store.run(&run.id).unwrap();
        assert_eq!(finished.status, WorkflowRunStatus::Completed);
        assert_eq!(finished.journal[0].result.as_ref().unwrap()["url"], "https://example.test/pr/1");
    }

    #[tokio::test]
    async fn history_is_pruned_to_keep_runs_and_takes_the_threads_with_it() {
        let h = harness(vec![agent("work")]);
        let workflow = h
            .engine
            .create(
                WorkflowInput { keep_runs: 2, ..WorkflowInput::new("Busy", "script();") },
                WorkflowSource::User,
            )
            .unwrap();
        for _ in 0..4 {
            h.engine.run_now(&workflow.id, None).await.unwrap();
            let thread = h.host.last_thread();
            h.engine.on_agent_finished(&thread, success(&thread)).await.unwrap();
            h.clock.advance(1_000);
        }
        assert_eq!(h.store.runs().len(), 2);
        assert_eq!(h.host.disposed.lock().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn deleting_a_workflow_stops_its_runs_and_forgets_everything() {
        let h = harness(vec![agent("long")]);
        let workflow = h
            .engine
            .create(
                WorkflowInput {
                    triggers: vec![WorkflowTrigger::Cron { expression: "0 9 * * *".into() }],
                    ..WorkflowInput::new("Doomed", "script();")
                },
                WorkflowSource::User,
            )
            .unwrap();
        h.engine.run_now(&workflow.id, None).await.unwrap();
        h.store.memory_set(&workflow.id, "k", json!(1));
        h.engine.delete(&workflow.id).await.unwrap();
        assert!(h.store.workflows().is_empty());
        assert!(h.store.runs().is_empty());
        assert!(h.engine.bus().list().is_empty(), "its trigger went too");
        assert_eq!(h.store.memory_get(&workflow.id, "k"), Value::Null);
    }

    #[tokio::test]
    async fn recovery_reattaches_a_thread_that_is_still_working() {
        let h = harness(vec![agent("first"), agent("second")]);
        let workflow = make(&h, "Survivor");
        let run = h.engine.run_now(&workflow.id, None).await.unwrap();
        let thread = h.host.last_thread();
        let started_before = h.host.started.lock().unwrap().len();

        // A new engine over the same files, as after a restart.
        let store = Arc::new(WorkflowStore::open(h.dir.path()).unwrap());
        let bus = Arc::new(EventBus::open(h.dir.path(), h.clock.clone()).unwrap());
        let engine = WorkflowEngine::new(
            store.clone(),
            bus,
            h.host.clone(),
            h.clock.clone(),
            SequenceRunner::new(vec![agent("first"), agent("second")]),
        );
        engine.recover().await.unwrap();
        assert_eq!(h.host.started.lock().unwrap().len(), started_before, "the live thread was left alone");
        assert_eq!(store.run(&run.id).unwrap().journal[0].thread_id.as_deref(), Some(thread.as_str()));

        // And it still settles the step when it finishes.
        engine.on_agent_finished(&thread, success(&thread)).await.unwrap();
        assert_eq!(store.run(&run.id).unwrap().journal[0].status, JournalStatus::Done);
        assert_eq!(h.host.started.lock().unwrap().len(), started_before + 1, "step 1 went on");
    }

    #[tokio::test]
    async fn recovery_collects_an_outcome_that_arrived_while_the_app_was_down() {
        let h = harness(vec![agent("only")]);
        let workflow = make(&h, "Missed it");
        let run = h.engine.run_now(&workflow.id, None).await.unwrap();
        let thread = h.host.last_thread();
        // The thread finished while nothing was listening.
        h.host.active.lock().unwrap().clear();
        *h.host.outcome.lock().unwrap() = Some(success(&thread));

        let store = Arc::new(WorkflowStore::open(h.dir.path()).unwrap());
        let bus = Arc::new(EventBus::open(h.dir.path(), h.clock.clone()).unwrap());
        let engine = WorkflowEngine::new(
            store.clone(),
            bus,
            h.host.clone(),
            h.clock.clone(),
            SequenceRunner::new(vec![agent("only")]),
        );
        engine.recover().await.unwrap();
        assert_eq!(store.run(&run.id).unwrap().status, WorkflowRunStatus::Completed);
    }

    #[tokio::test]
    async fn recovery_re_performs_a_step_whose_thread_vanished() {
        let h = harness(vec![agent("only")]);
        let workflow = make(&h, "Restart the stage");
        let run = h.engine.run_now(&workflow.id, None).await.unwrap();
        // The thread is gone and has no outcome to collect.
        h.host.active.lock().unwrap().clear();
        let before = h.host.started.lock().unwrap().len();

        let store = Arc::new(WorkflowStore::open(h.dir.path()).unwrap());
        let bus = Arc::new(EventBus::open(h.dir.path(), h.clock.clone()).unwrap());
        let engine = WorkflowEngine::new(
            store.clone(),
            bus,
            h.host.clone(),
            h.clock.clone(),
            SequenceRunner::new(vec![agent("only")]),
        );
        engine.recover().await.unwrap();
        assert_eq!(h.host.started.lock().unwrap().len(), before + 1, "a fresh thread took over");
        assert!(store.run(&run.id).unwrap().status.is_active());
    }

    #[tokio::test]
    async fn recovery_settles_a_sleep_whose_deadline_passed_while_the_app_was_down() {
        let h = harness(vec![Primitive::Sleep { ms: 60_000 }]);
        let workflow = make(&h, "Sleeper");
        let run = h.engine.run_now(&workflow.id, None).await.unwrap();
        h.clock.advance(120_000);

        let store = Arc::new(WorkflowStore::open(h.dir.path()).unwrap());
        let bus = Arc::new(EventBus::open(h.dir.path(), h.clock.clone()).unwrap());
        let engine = WorkflowEngine::new(
            store.clone(),
            bus,
            h.host.clone(),
            h.clock.clone(),
            SequenceRunner::new(vec![Primitive::Sleep { ms: 60_000 }]),
        );
        engine.recover().await.unwrap();
        assert_eq!(store.run(&run.id).unwrap().status, WorkflowRunStatus::Completed);
    }

    #[tokio::test]
    async fn recovery_re_registers_a_lost_wait_subscription() {
        let h = harness(vec![Primitive::WaitFor {
            pattern: EventPattern { kind: "github.push".into(), ..Default::default() },
            timeout_ms: None,
        }]);
        let workflow = make(&h, "Watcher");
        let run = h.engine.run_now(&workflow.id, None).await.unwrap();

        // A bus file that lost its subscriptions, as an interrupted write
        // would leave it.
        std::fs::write(
            h.dir.path().join("workflow-subscriptions.json"),
            r#"{ "version": 1, "subscriptions": [] }"#,
        )
        .unwrap();
        let store = Arc::new(WorkflowStore::open(h.dir.path()).unwrap());
        let bus = Arc::new(EventBus::open(h.dir.path(), h.clock.clone()).unwrap());
        let engine = WorkflowEngine::new(
            store.clone(),
            bus,
            h.host.clone(),
            h.clock.clone(),
            SequenceRunner::new(vec![Primitive::WaitFor {
                pattern: EventPattern { kind: "github.push".into(), ..Default::default() },
                timeout_ms: None,
            }]),
        );
        engine.recover().await.unwrap();
        engine.publish(&BossEvent::new("github.push", h.clock.now_ms())).await.unwrap();
        assert_eq!(store.run(&run.id).unwrap().status, WorkflowRunStatus::Completed);
    }

    #[tokio::test]
    async fn a_build_with_no_script_engine_fails_the_run_rather_than_faking_it() {
        let h = harness_with(Arc::new(NoScriptRunner));
        let workflow = make(&h, "Unrunnable");
        let run = h.engine.run_now(&workflow.id, None).await.unwrap();
        let finished = h.store.run(&run.id).unwrap();
        assert_eq!(finished.status, WorkflowRunStatus::Failed);
        assert!(finished.error.as_deref().unwrap().contains("no workflow script engine"));
    }

    #[test]
    fn create_rejects_a_workflow_that_cannot_run() {
        let h = harness(vec![]);
        assert!(
            h.engine
                .create(WorkflowInput::new("  ", "script();"), WorkflowSource::User)
                .unwrap_err()
                .to_string()
                .contains("name")
        );
        assert!(
            h.engine
                .create(WorkflowInput::new("Nameless", "  "), WorkflowSource::User)
                .unwrap_err()
                .to_string()
                .contains("script")
        );
        let bad_cron = WorkflowInput {
            triggers: vec![WorkflowTrigger::Cron { expression: "nope".into() }],
            ..WorkflowInput::new("Bad cron", "script();")
        };
        assert!(h.engine.create(bad_cron, WorkflowSource::User).unwrap_err().to_string().contains("5 fields"));
        let blank_event = WorkflowInput {
            triggers: vec![WorkflowTrigger::Event { pattern: EventPattern::default() }],
            ..WorkflowInput::new("Bad event", "script();")
        };
        assert!(
            h.engine.create(blank_event, WorkflowSource::User).unwrap_err().to_string().contains("event type")
        );
    }

    #[test]
    fn a_label_is_flattened_and_capped() {
        let long = "a ".repeat(100);
        let label = label_for(JournalOp::Agent, &json!({ "prompt": long }));
        assert_eq!(label.chars().count(), 78, "77 characters and an ellipsis");
        assert!(label.ends_with('…'));
        assert_eq!(
            label_for(JournalOp::Wait, &json!({ "pattern": { "type": "github.push" } })),
            "waiting for github.push"
        );
        assert_eq!(label_for(JournalOp::Sleep, &json!({ "ms": 500 })), "sleeping 500ms");
        assert_eq!(
            label_for(JournalOp::Log, &json!({ "message": "line one\n  line two" })),
            "line one line two",
            "newlines and runs of spaces collapse"
        );
    }

    #[test]
    fn a_journal_entry_rebuilds_the_primitive_that_wrote_it() {
        let entry = JournalEntry {
            seq: 0,
            op: JournalOp::Agent,
            args_hash: "x".into(),
            args: Some(json!({ "prompt": "do it", "options": { "backendId": "codex", "maxMinutes": 5 } })),
            label: None,
            status: JournalStatus::Started,
            attempts: None,
            thread_id: None,
            worktree_id: None,
            result: None,
            error: None,
            started_at: 0,
            finished_at: None,
        };
        let Some(Primitive::Agent { prompt, options }) = primitive_from_entry(&entry) else {
            panic!("an agent step");
        };
        assert_eq!(prompt, "do it");
        assert_eq!(options.engine.as_deref(), Some("codex"));
        assert_eq!(options.max_minutes, Some(5.0));
    }
}
