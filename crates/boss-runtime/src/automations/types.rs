//! The wire and on-disk types for workflows and automations.
//!
//! Ports `src/shared/workflow.ts`, `src/shared/automation.ts`, and
//! `src/shared/automation-trigger.ts`. Field names and JSON shapes are kept
//! byte-compatible with the Electron files (`workflows.json`,
//! `workflow-runs.json`, `workflow-subscriptions.json`, `automations.json`,
//! `automation-runs.json`), so the two apps can read each other's state.
//!
//! Timestamps are epoch milliseconds, as JavaScript wrote them.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::BTreeMap;

/// Epoch milliseconds right now.
pub fn now_ms() -> i64 {
    (time::OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000) as i64
}

// ----------------------------------------------------------------- events

/// Normalized envelope for everything that can wake a workflow.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct BossEvent {
    pub id: String,
    /// Dotted event name, e.g. `cron.fired`, `github.workflow_run`.
    #[serde(rename = "type")]
    pub kind: String,
    pub at: i64,
    /// Absolute project path the event belongs to, absent when global.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_path: Option<String>,
    /// Flat payload. Subscription filters match on top-level fields.
    #[serde(default)]
    pub data: Map<String, Value>,
}

impl BossEvent {
    /// A manual or synthetic event with no payload.
    pub fn new(kind: impl Into<String>, at: i64) -> Self {
        Self { id: uuid::Uuid::new_v4().to_string(), kind: kind.into(), at, project_path: None, data: Map::new() }
    }
}

/// What a subscription listens for.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct EventPattern {
    /// Exact event type, or a prefix wildcard like `github.*`.
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_path: Option<String>,
    /// Equality filters against `event.data` fields, compared as strings.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filters: Option<BTreeMap<String, Value>>,
}

/// Render a JSON scalar the way `String(value)` does in JavaScript, so
/// filters written by the Electron app keep matching.
fn js_string(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Null => "null".to_owned(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        other => other.to_string(),
    }
}

/// Does `event` satisfy `pattern`? Port of `matchesPattern`.
pub fn matches_pattern(pattern: &EventPattern, event: &BossEvent) -> bool {
    if let Some(prefix) = pattern.kind.strip_suffix('*') {
        if !event.kind.starts_with(prefix) {
            return false;
        }
    } else if pattern.kind != event.kind {
        return false;
    }
    if let Some(wanted) = &pattern.project_path {
        // An absent projectPath on the event reads as '' in the TS.
        if wanted != event.project_path.as_deref().unwrap_or("") {
            return false;
        }
    }
    if let Some(filters) = &pattern.filters {
        for (key, expected) in filters {
            let actual = event.data.get(key).map(js_string).unwrap_or_else(|| "undefined".to_owned());
            if actual != js_string(expected) {
                return false;
            }
        }
    }
    true
}

// ---------------------------------------------------------- subscriptions

/// Where a fired subscription delivers.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum SubscriptionTarget {
    /// Resume a parked run: deliver the event as the result of entry `seq`.
    Resume {
        #[serde(rename = "runId")]
        run_id: String,
        seq: i64,
    },
    /// Start a new run of a workflow.
    Trigger {
        #[serde(rename = "workflowId")]
        workflow_id: String,
    },
}

/// The cron half of a subscription. `next_at` is maintained by the bus.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CronSubscription {
    pub expression: String,
    pub next_at: i64,
}

/// A durable "wake me when X happens".
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowSubscription {
    pub id: String,
    pub target: SubscriptionTarget,
    /// Absent for pure timers (sleep).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pattern: Option<EventPattern>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cron: Option<CronSubscription>,
    /// `waitFor` timeout or sleep deadline. The bus fires with a null event.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<i64>,
    pub created_at: i64,
}

// -------------------------------------------------------------- workflows

/// What starts a workflow without anyone asking.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum WorkflowTrigger {
    Cron { expression: String },
    Event { pattern: EventPattern },
}

/// Ceilings one run may not cross.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowBudget {
    pub max_agent_runs: u32,
    pub max_judge_calls: u32,
    pub max_notifies: u32,
    /// Wall-clock ceiling for one run, waiting included.
    pub max_run_hours: f64,
    /// Default per-agent-run ceiling; `agent()` options may lower it.
    pub max_agent_minutes: f64,
}

impl Default for WorkflowBudget {
    fn default() -> Self {
        Self { max_agent_runs: 10, max_judge_calls: 20, max_notifies: 5, max_run_hours: 72.0, max_agent_minutes: 30.0 }
    }
}

/// The same fields as `WorkflowBudget` but every one optional, which is how
/// a workflow stores its overrides.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PartialBudget {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_agent_runs: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_judge_calls: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_notifies: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_run_hours: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_agent_minutes: Option<f64>,
}

impl PartialBudget {
    /// Defaults with this workflow's overrides applied.
    pub fn resolve(&self) -> WorkflowBudget {
        let base = WorkflowBudget::default();
        WorkflowBudget {
            max_agent_runs: self.max_agent_runs.unwrap_or(base.max_agent_runs),
            max_judge_calls: self.max_judge_calls.unwrap_or(base.max_judge_calls),
            max_notifies: self.max_notifies.unwrap_or(base.max_notifies),
            max_run_hours: self.max_run_hours.unwrap_or(base.max_run_hours),
            max_agent_minutes: self.max_agent_minutes.unwrap_or(base.max_agent_minutes),
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WorkflowOverlapPolicy {
    /// A trigger that arrives while a run is active records a skipped run.
    #[default]
    Skip,
    /// Every trigger starts its own run.
    Parallel,
}

/// Whether an agent-authored workflow goes live immediately (`Auto`) or waits
/// for the user to enable it (`Ask`, the default and the approval step).
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WorkflowApprovalMode {
    #[default]
    Ask,
    Auto,
}

/// Who wrote a workflow.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WorkflowSource {
    #[default]
    User,
    Agent,
    Builtin,
}

/// Per-step agent settings a script call may override.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowDefaults {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backend_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub judge_backend_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub judge_model: Option<Value>,
}

fn default_keep_runs_workflow() -> u32 {
    100
}

/// A durable workflow definition, exactly as `workflows.json` stores it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workflow {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// JavaScript source executed by the engine.
    pub script: String,
    /// Absolute project path, or `""` for a global workflow.
    #[serde(default)]
    pub project_path: String,
    #[serde(default)]
    pub triggers: Vec<WorkflowTrigger>,
    #[serde(default)]
    pub overlap_policy: WorkflowOverlapPolicy,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub budget: Option<PartialBudget>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub defaults: Option<WorkflowDefaults>,
    #[serde(default = "default_keep_runs_workflow")]
    pub keep_runs: u32,
    pub enabled: bool,
    #[serde(default)]
    pub source: WorkflowSource,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_run_at: Option<i64>,
}

/// The user- or agent-supplied half of a workflow: everything except the
/// fields the engine owns.
#[derive(Clone, Debug, Default)]
pub struct WorkflowInput {
    pub name: String,
    pub description: Option<String>,
    pub script: String,
    pub project_path: String,
    pub triggers: Vec<WorkflowTrigger>,
    pub overlap_policy: WorkflowOverlapPolicy,
    pub budget: Option<PartialBudget>,
    pub defaults: Option<WorkflowDefaults>,
    pub keep_runs: u32,
}

/// A patch: every field the caller left alone stays as it was.
#[derive(Clone, Debug, Default)]
pub struct WorkflowPatch {
    pub name: Option<String>,
    pub description: Option<String>,
    pub script: Option<String>,
    pub project_path: Option<String>,
    pub triggers: Option<Vec<WorkflowTrigger>>,
    pub overlap_policy: Option<WorkflowOverlapPolicy>,
    pub keep_runs: Option<u32>,
    pub enabled: Option<bool>,
}

// ----------------------------------------------------------------- journal

/// The effectful primitives a script may call. Every call is journaled.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum JournalOp {
    #[serde(rename = "agent")]
    Agent,
    #[serde(rename = "judge")]
    Judge,
    #[serde(rename = "wait")]
    Wait,
    #[serde(rename = "sleep")]
    Sleep,
    #[serde(rename = "notify")]
    Notify,
    #[serde(rename = "ask")]
    Ask,
    #[serde(rename = "state.get")]
    StateGet,
    #[serde(rename = "state.set")]
    StateSet,
    #[serde(rename = "pr")]
    Pr,
    #[serde(rename = "log")]
    Log,
}

impl JournalOp {
    /// Ops whose `begin` settles the entry before returning, so an entry left
    /// `Started` by a crash is safe to re-perform.
    pub fn is_immediate(self) -> bool {
        matches!(self, JournalOp::Notify | JournalOp::StateGet | JournalOp::StateSet | JournalOp::Log | JournalOp::Pr)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum JournalStatus {
    Started,
    Done,
    Failed,
}

/// One journaled primitive call.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalEntry {
    pub seq: i64,
    pub op: JournalOp,
    /// Stable hash of (op, args); a mismatch on replay means the script was
    /// edited and the journal is invalid from this entry on.
    pub args_hash: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub args: Option<Value>,
    /// Short human-readable label for run displays.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    pub status: JournalStatus,
    /// Live perform attempts, e.g. a judge retry after an unparseable verdict.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attempts: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub started_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<i64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum WorkflowRunStatus {
    Running,
    Waiting,
    Completed,
    Failed,
    Stopped,
    Skipped,
    NeedsAttention,
}

impl WorkflowRunStatus {
    /// A run still doing something: replay may resume it.
    pub fn is_active(self) -> bool {
        matches!(self, WorkflowRunStatus::Running | WorkflowRunStatus::Waiting)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WorkflowRunTrigger {
    Cron,
    Event,
    Manual,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRunUsage {
    pub agent_runs: u32,
    pub judge_calls: u32,
    pub notifies: u32,
}

/// One execution of a workflow, journal included.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRun {
    pub id: String,
    pub workflow_id: String,
    /// Conversation that asked for this run; it gets the result as a message.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_by_thread_id: Option<String>,
    pub trigger: WorkflowRunTrigger,
    pub status: WorkflowRunStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub event: Option<BossEvent>,
    #[serde(default)]
    pub journal: Vec<JournalEntry>,
    #[serde(default)]
    pub usage: WorkflowRunUsage,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Engine annotations, e.g. a journal invalidation after a script edit.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    pub started_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<i64>,
}

// ------------------------------------------------------------ automations

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AutomationWorkspace {
    #[default]
    Worktree,
    Project,
    None,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AutomationOverlapPolicy {
    #[default]
    Skip,
    Queue,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AutomationRunTrigger {
    Schedule,
    Manual,
    CatchUp,
    Webhook,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AutomationRunStatus {
    Running,
    Success,
    Failure,
    Timeout,
    Skipped,
    Aborted,
}

/// `Off` never notifies; `Events` notifies on failures, timeouts, and runs
/// that changed files; `Always` notifies on every finished run.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AutomationNotifyMode {
    Off,
    #[default]
    Events,
    Always,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AutomationScheduleKind {
    Cron,
    #[default]
    Manual,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct AutomationSchedule {
    pub kind: AutomationScheduleKind,
    /// Five-field cron expression, local time. Present when kind is `Cron`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expression: Option<String>,
}

/// GitHub events BOSS can receive on its hook endpoint.
pub const AUTOMATION_WEBHOOK_EVENTS: [&str; 2] = ["push", "pull_request"];

/// Pull-request actions that count as "a PR was opened". Anything else is
/// repo noise no one asked to be woken for.
pub const PULL_REQUEST_ACTIONS: [&str; 2] = ["opened", "reopened"];

/// Fires the automation when GitHub delivers one of these events.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct AutomationWebhookTrigger {
    /// Empty means any supported event.
    #[serde(default)]
    pub events: Vec<String>,
    /// Empty or absent means any branch.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
}

fn default_max_run_minutes() -> u32 {
    30
}
fn default_keep_runs_automation() -> u32 {
    50
}
fn default_catch_up() -> bool {
    true
}

/// A scheduled or webhook-triggered prompt, as `automations.json` stores it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Automation {
    pub id: String,
    pub name: String,
    pub prompt: String,
    /// Absolute project path, or `""` for a projectless automation.
    #[serde(default)]
    pub project_path: String,
    pub backend_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<Value>,
    #[serde(default)]
    pub mode: String,
    #[serde(default)]
    pub schedule: AutomationSchedule,
    /// Absent or null means the automation has no webhook.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub webhook: Option<AutomationWebhookTrigger>,
    #[serde(default)]
    pub workspace: AutomationWorkspace,
    #[serde(default)]
    pub overlap_policy: AutomationOverlapPolicy,
    #[serde(default = "default_catch_up")]
    pub catch_up: bool,
    #[serde(default)]
    pub notify: AutomationNotifyMode,
    #[serde(default = "default_max_run_minutes")]
    pub max_run_minutes: u32,
    #[serde(default = "default_keep_runs_automation")]
    pub keep_runs: u32,
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_run_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_run_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_webhook_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_webhook_label: Option<String>,
    #[serde(default)]
    pub missed_runs: u32,
    pub created_at: i64,
    pub updated_at: i64,
}

/// The user-supplied half of an automation.
#[derive(Clone, Debug)]
pub struct AutomationInput {
    pub name: String,
    pub prompt: String,
    pub project_path: String,
    pub backend_id: String,
    pub model: Option<Value>,
    pub mode: String,
    pub schedule: AutomationSchedule,
    pub webhook: Option<AutomationWebhookTrigger>,
    pub workspace: AutomationWorkspace,
    pub overlap_policy: AutomationOverlapPolicy,
    pub catch_up: bool,
    pub notify: AutomationNotifyMode,
    pub max_run_minutes: u32,
    pub keep_runs: u32,
}

impl Default for AutomationInput {
    fn default() -> Self {
        Self {
            name: String::new(),
            prompt: String::new(),
            project_path: String::new(),
            backend_id: "claude".to_owned(),
            model: None,
            mode: "auto".to_owned(),
            schedule: AutomationSchedule::default(),
            webhook: None,
            workspace: AutomationWorkspace::default(),
            overlap_policy: AutomationOverlapPolicy::default(),
            catch_up: true,
            notify: AutomationNotifyMode::default(),
            max_run_minutes: default_max_run_minutes(),
            keep_runs: default_keep_runs_automation(),
        }
    }
}

/// One execution of an automation.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationRun {
    pub id: String,
    pub automation_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree_id: Option<String>,
    pub trigger: AutomationRunTrigger,
    pub status: AutomationRunStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub needs_attention: Option<bool>,
    #[serde(default)]
    pub changed_files: u32,
    pub started_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<i64>,
}

// ---------------------------------------------------------------- helpers

/// Stable stringification: object keys sorted, `undefined` values dropped.
/// Mirrors the TS `stableStringify` so hashes match across the two apps.
fn stable_stringify(value: &Value) -> String {
    match value {
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            let parts: Vec<String> = keys
                .into_iter()
                .map(|k| format!("{}:{}", Value::String(k.clone()), stable_stringify(&map[k])))
                .collect();
            format!("{{{}}}", parts.join(","))
        }
        Value::Array(items) => {
            format!("[{}]", items.iter().map(stable_stringify).collect::<Vec<_>>().join(","))
        }
        // `JSON.stringify` of a scalar, which serde_json already matches.
        other => other.to_string(),
    }
}

/// Stable hash of a primitive call, used to detect script edits on replay.
/// FNV-1a over the stable stringification, exactly as `hashArgs` does, so a
/// journal written by the Electron app replays identically here.
pub fn hash_args(op: &str, args: &Value) -> String {
    let text = format!("{op} {}", stable_stringify(args));
    let mut hash: u32 = 0x811c_9dc5;
    // JS hashes UTF-16 code units; `encode_utf16` reproduces that exactly.
    for unit in text.encode_utf16() {
        hash ^= unit as u32;
        hash = hash.wrapping_mul(0x0100_0193);
    }
    format!("{hash:08x}")
}

/// Longest string a journaled result may hold before it is truncated.
const RESULT_CHAR_LIMIT: usize = 32_000;

/// Clamp a primitive result to a JSON-safe value bounded in size, so
/// journals stay small and replay is exact. Port of `clampResult`.
pub fn clamp_result(value: &Value) -> Value {
    fn clamp(value: &Value, depth: u32) -> Value {
        match value {
            Value::Null => Value::Null,
            Value::String(s) => {
                // The TS counts UTF-16 code units; do the same so a journal
                // written by either app truncates at the same point.
                if s.encode_utf16().count() > RESULT_CHAR_LIMIT {
                    let kept: String = char_prefix_utf16(s, RESULT_CHAR_LIMIT);
                    Value::String(format!("{kept}… [truncated]"))
                } else {
                    value.clone()
                }
            }
            Value::Number(n) => {
                if n.as_f64().map(f64::is_finite).unwrap_or(false) {
                    value.clone()
                } else {
                    Value::Null
                }
            }
            Value::Bool(_) => value.clone(),
            _ if depth > 8 => Value::Null,
            Value::Array(items) => {
                Value::Array(items.iter().take(500).map(|item| clamp(item, depth + 1)).collect())
            }
            Value::Object(map) => {
                Value::Object(map.iter().map(|(k, v)| (k.clone(), clamp(v, depth + 1))).collect())
            }
        }
    }
    clamp(value, 0)
}

/// The longest prefix of `s` that is at most `limit` UTF-16 code units,
/// cut on a character boundary.
fn char_prefix_utf16(s: &str, limit: usize) -> String {
    let mut used = 0;
    let mut out = String::new();
    for ch in s.chars() {
        let width = ch.len_utf16();
        if used + width > limit {
            break;
        }
        used += width;
        out.push(ch);
    }
    out
}

/// The verdict a `judge()` call resolved to.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct JudgeOutcome {
    pub verdict: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// Final-line contract for `judge()` calls, mirroring the reviewer contract.
pub fn judge_prompt(input: &str, options: &[String], rubric: Option<&str>) -> String {
    let joined = options.join(", ");
    let mut lines = vec![
        "[BOSS WORKFLOW JUDGE]".to_owned(),
        "You are a deterministic classifier inside an unattended workflow. Do not ask questions.".to_owned(),
    ];
    if let Some(rubric) = rubric {
        lines.push(format!("Rubric:\n{rubric}"));
    }
    lines.push(format!("Classify the input as exactly one of: {joined}"));
    lines.push("End your final message with exactly these two lines:".to_owned());
    lines.push("REASON: <one sentence>".to_owned());
    lines.push(format!("VERDICT: <one of {}>", options.join(" | ")));
    lines.push(String::new());
    lines.push("Input:".to_owned());
    lines.push(input.to_owned());
    lines.join("\n")
}

/// Parse the judge contract from the model's final text. `None` when the
/// verdict line is missing or names an option that was not offered.
pub fn parse_judge_outcome(text: Option<&str>, options: &[String]) -> Option<JudgeOutcome> {
    let text = text?.trim();
    let lines: Vec<&str> = text.split('\n').collect();
    let mut verdict: Option<String> = None;
    let mut reason: Option<String> = None;
    // Only the last ten lines, as the TS does.
    let start = lines.len().saturating_sub(10);
    for line in lines[start..].iter().rev() {
        let line = line.trim();
        if verdict.is_none() {
            if let Some(rest) = strip_prefix_ci(line, "VERDICT:") {
                let rest = rest.trim();
                if !rest.is_empty() {
                    verdict = Some(rest.to_owned());
                }
            }
        }
        if reason.is_none() {
            if let Some(rest) = strip_prefix_ci(line, "REASON:") {
                let rest = rest.trim();
                if !rest.is_empty() {
                    reason = Some(rest.to_owned());
                }
            }
        }
    }
    let verdict = verdict?;
    let matched = options.iter().find(|option| option.eq_ignore_ascii_case(&verdict))?;
    Some(JudgeOutcome { verdict: matched.clone(), reason })
}

fn strip_prefix_ci<'a>(line: &'a str, prefix: &str) -> Option<&'a str> {
    if line.len() >= prefix.len() && line[..prefix.len()].eq_ignore_ascii_case(prefix) {
        Some(&line[prefix.len()..])
    } else {
        None
    }
}

/// A one-line summary of what a thread finished doing. Prefers an explicit
/// `SUMMARY:` line; falls back to the last non-empty line. Port of
/// `extractSummary` in `src/shared/thread-result.ts`.
pub fn extract_summary(text: &str) -> Option<String> {
    let explicit = text
        .lines()
        .filter_map(|line| strip_prefix_ci(line.trim_start(), "SUMMARY:"))
        .map(str::trim)
        .filter(|rest| !rest.is_empty())
        .next_back();
    let line = match explicit {
        Some(line) => line,
        None => text.trim().lines().filter(|l| !l.is_empty()).next_back()?,
    };
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(char_prefix_utf16(trimmed, 300))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn event(kind: &str, data: Value) -> BossEvent {
        BossEvent {
            id: "e1".into(),
            kind: kind.into(),
            at: 1,
            project_path: None,
            data: data.as_object().cloned().unwrap_or_default(),
        }
    }

    #[test]
    fn pattern_matches_exact_and_wildcard_types() {
        let ev = event("github.pull_request", json!({}));
        assert!(matches_pattern(&EventPattern { kind: "github.pull_request".into(), ..Default::default() }, &ev));
        assert!(matches_pattern(&EventPattern { kind: "github.*".into(), ..Default::default() }, &ev));
        assert!(!matches_pattern(&EventPattern { kind: "cron.*".into(), ..Default::default() }, &ev));
        assert!(!matches_pattern(&EventPattern { kind: "github.push".into(), ..Default::default() }, &ev));
    }

    #[test]
    fn pattern_filters_compare_as_strings() {
        let ev = event("github.pull_request", json!({ "prNumber": 204, "draft": false }));
        let with = |filters: Value| EventPattern {
            kind: "github.pull_request".into(),
            project_path: None,
            filters: Some(filters.as_object().unwrap().iter().map(|(k, v)| (k.clone(), v.clone())).collect()),
        };
        // A string "204" matches the number 204, as String(value) does in JS.
        assert!(matches_pattern(&with(json!({ "prNumber": "204" })), &ev));
        assert!(matches_pattern(&with(json!({ "prNumber": 204 })), &ev));
        assert!(matches_pattern(&with(json!({ "draft": "false" })), &ev));
        assert!(!matches_pattern(&with(json!({ "prNumber": 205 })), &ev));
        // A missing field never matches.
        assert!(!matches_pattern(&with(json!({ "absent": "x" })), &ev));
    }

    #[test]
    fn pattern_project_path_treats_absent_as_empty() {
        let ev = event("manual", json!({}));
        let global = EventPattern { kind: "manual".into(), project_path: Some(String::new()), filters: None };
        assert!(matches_pattern(&global, &ev));
        let scoped = EventPattern { kind: "manual".into(), project_path: Some("/repo".into()), filters: None };
        assert!(!matches_pattern(&scoped, &ev));
    }

    #[test]
    fn hash_args_matches_the_javascript_implementation() {
        // These are the hashes the Electron app wrote into workflow-runs.json.
        assert_eq!(hash_args("log", &json!({ "message": "Caretaker started for PR #204." })), "0c3f2985");
        assert_eq!(
            hash_args(
                "wait",
                &json!({
                    "pattern": {
                        "type": "github.workflow_run",
                        "filters": { "repo": "jagonalez/BOSS", "branch": "boss/review-boss-workflow-ux-137e4e39" }
                    },
                    "timeoutMs": 21_600_000i64
                })
            ),
            "f68b6194"
        );
    }

    #[test]
    fn hash_args_is_key_order_independent() {
        let a = hash_args("agent", &json!({ "prompt": "x", "options": {} }));
        let b = hash_args("agent", &json!({ "options": {}, "prompt": "x" }));
        assert_eq!(a, b);
        assert_ne!(a, hash_args("agent", &json!({ "prompt": "y", "options": {} })));
    }

    #[test]
    fn clamp_truncates_long_strings_and_deep_values() {
        let long = "a".repeat(40_000);
        let clamped = clamp_result(&json!(long));
        let text = clamped.as_str().unwrap();
        assert!(text.ends_with("… [truncated]"));
        assert_eq!(text.chars().filter(|c| *c == 'a').count(), 32_000);
        // Arrays cap at 500 entries.
        let big: Vec<Value> = (0..600).map(|i| json!(i)).collect();
        assert_eq!(clamp_result(&json!(big)).as_array().unwrap().len(), 500);
    }

    #[test]
    fn clamp_nulls_out_values_past_the_depth_limit() {
        let mut deep = json!(1);
        for _ in 0..12 {
            deep = json!({ "next": deep });
        }
        let clamped = clamp_result(&deep);
        let text = serde_json::to_string(&clamped).unwrap();
        assert!(text.contains("null"), "{text}");
    }

    #[test]
    fn judge_prompt_lists_the_options_twice() {
        let options = vec!["pass".to_owned(), "fail".to_owned()];
        let prompt = judge_prompt("some input", &options, Some("be strict"));
        assert!(prompt.starts_with("[BOSS WORKFLOW JUDGE]"));
        assert!(prompt.contains("Rubric:\nbe strict"));
        assert!(prompt.contains("exactly one of: pass, fail"));
        assert!(prompt.contains("VERDICT: <one of pass | fail>"));
        assert!(prompt.ends_with("Input:\nsome input"));
        // Without a rubric there is no Rubric block.
        assert!(!judge_prompt("x", &options, None).contains("Rubric"));
    }

    #[test]
    fn parses_a_verdict_and_reason() {
        let options = vec!["pass".to_owned(), "fail".to_owned()];
        let text = "some analysis\nREASON: the tests are green\nVERDICT: pass";
        let parsed = parse_judge_outcome(Some(text), &options).unwrap();
        assert_eq!(parsed.verdict, "pass");
        assert_eq!(parsed.reason.as_deref(), Some("the tests are green"));
        // Case-insensitive, and the offered spelling wins.
        assert_eq!(parse_judge_outcome(Some("VERDICT: PASS"), &options).unwrap().verdict, "pass");
    }

    #[test]
    fn rejects_a_missing_or_unoffered_verdict() {
        let options = vec!["pass".to_owned(), "fail".to_owned()];
        assert!(parse_judge_outcome(Some("no verdict here"), &options).is_none());
        assert!(parse_judge_outcome(Some("VERDICT: maybe"), &options).is_none());
        assert!(parse_judge_outcome(None, &options).is_none());
        // Buried more than ten lines up, the verdict is not found.
        let buried = format!("VERDICT: pass{}", "\nfiller".repeat(12));
        assert!(parse_judge_outcome(Some(&buried), &options).is_none());
    }

    #[test]
    fn summary_prefers_the_last_explicit_line() {
        assert_eq!(extract_summary("SUMMARY: first\nSUMMARY: second").as_deref(), Some("second"));
        assert_eq!(extract_summary("no marker\nlast line").as_deref(), Some("last line"));
        assert_eq!(extract_summary("   ").as_deref(), None);
        assert_eq!(extract_summary("summary: lowercase works").as_deref(), Some("lowercase works"));
    }

    #[test]
    fn workflow_round_trips_through_the_electron_shape() {
        let text = r#"{
          "name": "Caretaker",
          "script": "log('hi');",
          "description": "d",
          "projectPath": "/repo",
          "triggers": [{ "kind": "cron", "expression": "0 9 * * *" }],
          "overlapPolicy": "skip",
          "id": "w1",
          "enabled": true,
          "source": "agent",
          "createdAt": 1,
          "updatedAt": 2,
          "lastRunAt": 3
        }"#;
        let workflow: Workflow = serde_json::from_str(text).unwrap();
        assert_eq!(workflow.source, WorkflowSource::Agent);
        assert_eq!(workflow.keep_runs, 100);
        assert_eq!(workflow.triggers.len(), 1);
        let back = serde_json::to_value(&workflow).unwrap();
        assert_eq!(back["projectPath"], "/repo");
        assert_eq!(back["overlapPolicy"], "skip");
        assert_eq!(back["lastRunAt"], 3);
        assert_eq!(back["triggers"][0]["kind"], "cron");
    }

    #[test]
    fn journal_entries_keep_their_wire_names() {
        let text = r#"{
          "seq": 1,
          "op": "state.get",
          "argsHash": "abc",
          "args": { "key": "k" },
          "label": "l",
          "status": "started",
          "startedAt": 10
        }"#;
        let entry: JournalEntry = serde_json::from_str(text).unwrap();
        assert_eq!(entry.op, JournalOp::StateGet);
        assert_eq!(entry.status, JournalStatus::Started);
        let back = serde_json::to_value(&entry).unwrap();
        assert_eq!(back["op"], "state.get");
        assert_eq!(back["argsHash"], "abc");
        assert!(back.get("result").is_none(), "absent fields stay absent: {back}");
    }

    #[test]
    fn run_status_uses_the_kebab_case_wire_name() {
        assert_eq!(serde_json::to_value(WorkflowRunStatus::NeedsAttention).unwrap(), json!("needs-attention"));
        assert_eq!(serde_json::to_value(AutomationRunTrigger::CatchUp).unwrap(), json!("catch-up"));
        assert!(WorkflowRunStatus::Waiting.is_active());
        assert!(!WorkflowRunStatus::Skipped.is_active());
    }

    #[test]
    fn automation_round_trips_through_the_electron_shape() {
        let text = r#"{
          "name": "Summarize DD monitors",
          "prompt": "p",
          "projectPath": "",
          "backendId": "codex",
          "mode": "auto",
          "schedule": { "kind": "cron", "expression": "0 9 * * *" },
          "workspace": "none",
          "overlapPolicy": "skip",
          "catchUp": true,
          "notify": "always",
          "maxRunMinutes": 30,
          "keepRuns": 50,
          "id": "a1",
          "enabled": true,
          "missedRuns": 0,
          "createdAt": 1,
          "updatedAt": 2
        }"#;
        let automation: Automation = serde_json::from_str(text).unwrap();
        assert_eq!(automation.notify, AutomationNotifyMode::Always);
        assert_eq!(automation.workspace, AutomationWorkspace::None);
        assert_eq!(automation.schedule.expression.as_deref(), Some("0 9 * * *"));
        let back = serde_json::to_value(&automation).unwrap();
        assert_eq!(back["backendId"], "codex");
        assert_eq!(back["maxRunMinutes"], 30);
        assert!(back.get("webhook").is_none());
    }

    #[test]
    fn subscription_targets_keep_their_tag() {
        let resume = WorkflowSubscription {
            id: "s1".into(),
            target: SubscriptionTarget::Resume { run_id: "r1".into(), seq: 3 },
            pattern: None,
            cron: None,
            expires_at: Some(99),
            created_at: 1,
        };
        let text = serde_json::to_string(&resume).unwrap();
        assert!(text.contains(r#""kind":"resume""#), "{text}");
        assert!(text.contains(r#""runId":"r1""#), "{text}");
        assert_eq!(serde_json::from_str::<WorkflowSubscription>(&text).unwrap(), resume);
    }

    #[test]
    fn budget_overrides_fall_back_to_the_defaults() {
        let partial = PartialBudget { max_agent_runs: Some(2), ..Default::default() };
        let budget = partial.resolve();
        assert_eq!(budget.max_agent_runs, 2);
        assert_eq!(budget.max_judge_calls, WorkflowBudget::default().max_judge_calls);
    }
}
