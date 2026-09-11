//! JSON persistence for workflows and automations.
//!
//! Ports `src/main/workflow-store.ts` and the persistence half of
//! `src/main/automation-manager.ts`. The documents are written with the
//! same `version: 1` envelopes and the same field names, so the Electron
//! app and this one read each other's files.

use super::types::*;
use anyhow::Result;
use boss_core::store::JsonFile;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Mutex;

/// The `workflows.json` envelope.
#[derive(Debug, Default, Serialize, Deserialize)]
struct WorkflowDoc {
    version: u32,
    #[serde(default)]
    workflows: Vec<Workflow>,
    #[serde(default, rename = "approvalMode", skip_serializing_if = "Option::is_none")]
    approval_mode: Option<WorkflowApprovalMode>,
    /// Per-workflow durable key/value memory, shared across runs. This is
    /// what lets a watcher remember an alert history between fires.
    #[serde(default)]
    memory: BTreeMap<String, BTreeMap<String, Value>>,
}

/// The `workflow-runs.json` envelope.
#[derive(Debug, Default, Serialize, Deserialize)]
struct WorkflowRunDoc {
    version: u32,
    #[serde(default)]
    runs: Vec<WorkflowRun>,
}

/// Everything the workflow engine keeps on disk. Locking is coarse — one
/// mutex over the whole document — because writes are rare (a step settling)
/// and always rewrite the file anyway.
#[derive(Debug)]
pub struct WorkflowStore {
    state_file: JsonFile,
    runs_file: JsonFile,
    inner: Mutex<WorkflowInner>,
}

#[derive(Debug, Default)]
struct WorkflowInner {
    workflows: Vec<Workflow>,
    approval_mode: WorkflowApprovalMode,
    runs: Vec<WorkflowRun>,
    memory: BTreeMap<String, BTreeMap<String, Value>>,
}

impl WorkflowStore {
    /// Open `workflows.json` and `workflow-runs.json` under `dir`. A missing
    /// file is a first launch; a damaged one is an error, so a typo in the
    /// file never silently wipes a user's workflows.
    pub fn open(dir: &Path) -> Result<Self> {
        let state_file = JsonFile::in_dir(Some(dir), "workflows.json");
        let runs_file = JsonFile::in_dir(Some(dir), "workflow-runs.json");
        let state = state_file.load::<WorkflowDoc>()?.unwrap_or_default();
        let runs = runs_file.load::<WorkflowRunDoc>()?.unwrap_or_default();
        // The TS ignores a document whose version is not 1 rather than
        // guessing at a future shape; do the same.
        let inner = WorkflowInner {
            workflows: if state.version == 1 { state.workflows } else { Vec::new() },
            approval_mode: if state.version == 1 { state.approval_mode.unwrap_or_default() } else { Default::default() },
            memory: if state.version == 1 { state.memory } else { BTreeMap::new() },
            runs: if runs.version == 1 { runs.runs } else { Vec::new() },
        };
        Ok(Self { state_file, runs_file, inner: Mutex::new(inner) })
    }

    /// Write both documents.
    pub fn save(&self) -> Result<()> {
        let inner = self.inner.lock().unwrap();
        self.state_file.save(&WorkflowDoc {
            version: 1,
            workflows: inner.workflows.clone(),
            approval_mode: Some(inner.approval_mode),
            memory: inner.memory.clone(),
        })?;
        self.runs_file.save(&WorkflowRunDoc { version: 1, runs: inner.runs.clone() })?;
        Ok(())
    }

    pub fn workflows(&self) -> Vec<Workflow> {
        self.inner.lock().unwrap().workflows.clone()
    }

    pub fn workflow(&self, id: &str) -> Option<Workflow> {
        self.inner.lock().unwrap().workflows.iter().find(|w| w.id == id).cloned()
    }

    pub fn approval_mode(&self) -> WorkflowApprovalMode {
        self.inner.lock().unwrap().approval_mode
    }

    pub fn set_approval_mode(&self, mode: WorkflowApprovalMode) {
        self.inner.lock().unwrap().approval_mode = mode;
    }

    pub fn upsert_workflow(&self, workflow: Workflow) {
        let mut inner = self.inner.lock().unwrap();
        match inner.workflows.iter_mut().find(|w| w.id == workflow.id) {
            Some(slot) => *slot = workflow,
            None => inner.workflows.push(workflow),
        }
    }

    /// Edit a workflow in place. `None` when there is no such workflow.
    pub fn update_workflow<T>(&self, id: &str, edit: impl FnOnce(&mut Workflow) -> T) -> Option<T> {
        let mut inner = self.inner.lock().unwrap();
        inner.workflows.iter_mut().find(|w| w.id == id).map(edit)
    }

    pub fn runs(&self) -> Vec<WorkflowRun> {
        self.inner.lock().unwrap().runs.clone()
    }

    pub fn run(&self, id: &str) -> Option<WorkflowRun> {
        self.inner.lock().unwrap().runs.iter().find(|r| r.id == id).cloned()
    }

    pub fn push_run(&self, run: WorkflowRun) {
        self.inner.lock().unwrap().runs.push(run);
    }

    /// Edit a run in place. `None` when there is no such run.
    pub fn update_run<T>(&self, id: &str, edit: impl FnOnce(&mut WorkflowRun) -> T) -> Option<T> {
        let mut inner = self.inner.lock().unwrap();
        inner.runs.iter_mut().find(|r| r.id == id).map(edit)
    }

    /// Active runs, oldest first. Replay resumes exactly these.
    pub fn active_runs(&self) -> Vec<WorkflowRun> {
        self.inner.lock().unwrap().runs.iter().filter(|r| r.status.is_active()).cloned().collect()
    }

    pub fn memory_get(&self, workflow_id: &str, key: &str) -> Value {
        self.inner
            .lock()
            .unwrap()
            .memory
            .get(workflow_id)
            .and_then(|slot| slot.get(key))
            .cloned()
            .unwrap_or(Value::Null)
    }

    /// Store a value, or forget the key when the value is null — which is
    /// how a script clears a remembered fact.
    pub fn memory_set(&self, workflow_id: &str, key: &str, value: Value) {
        let mut inner = self.inner.lock().unwrap();
        if value.is_null() {
            if let Some(slot) = inner.memory.get_mut(workflow_id) {
                slot.remove(key);
                if slot.is_empty() {
                    inner.memory.remove(workflow_id);
                }
            }
            return;
        }
        inner.memory.entry(workflow_id.to_owned()).or_default().insert(key.to_owned(), value);
    }

    /// Finished runs beyond the workflow's `keepRuns` cap, newest first in
    /// the surviving set. The caller disposes their threads and worktrees
    /// before dropping them.
    pub fn prune_candidates(&self, workflow_id: &str) -> Vec<WorkflowRun> {
        let inner = self.inner.lock().unwrap();
        let keep = inner
            .workflows
            .iter()
            .find(|w| w.id == workflow_id)
            .map(|w| w.keep_runs)
            .unwrap_or(100) as usize;
        let mut finished: Vec<WorkflowRun> =
            inner.runs.iter().filter(|r| r.workflow_id == workflow_id && !r.status.is_active()).cloned().collect();
        finished.sort_by(|a, b| b.started_at.cmp(&a.started_at));
        finished.into_iter().skip(keep).collect()
    }

    pub fn drop_runs(&self, ids: &[String]) {
        let mut inner = self.inner.lock().unwrap();
        inner.runs.retain(|r| !ids.iter().any(|id| id == &r.id));
    }

    /// Forget a workflow, its runs, and its memory.
    pub fn drop_workflow(&self, id: &str) {
        let mut inner = self.inner.lock().unwrap();
        inner.workflows.retain(|w| w.id != id);
        inner.runs.retain(|r| r.workflow_id != id);
        inner.memory.remove(id);
    }
}

/// The `automations.json` envelope.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AutomationDoc {
    version: u32,
    #[serde(default)]
    automations: Vec<Automation>,
    /// POST target for phone push (an ntfy topic URL or any webhook).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    notify_webhook_url: Option<String>,
    /// Absent means on: a push is for reaching you away from BOSS.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    notify_webhook_only_when_away: Option<bool>,
    /// Per-automation hook secrets, kept out of snapshots so phones and the
    /// relay never see them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    webhook_tokens: Option<BTreeMap<String, String>>,
}

/// The `automation-runs.json` envelope.
#[derive(Debug, Default, Serialize, Deserialize)]
struct AutomationRunDoc {
    version: u32,
    #[serde(default)]
    runs: Vec<AutomationRun>,
}

/// Where a webhook notification goes.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebhookSettings {
    pub url: String,
    pub only_when_away: bool,
}

#[derive(Debug)]
pub struct AutomationStore {
    state_file: JsonFile,
    runs_file: JsonFile,
    inner: Mutex<AutomationInner>,
}

#[derive(Debug, Default)]
struct AutomationInner {
    automations: Vec<Automation>,
    runs: Vec<AutomationRun>,
    notify_webhook_url: String,
    notify_webhook_only_when_away: bool,
    webhook_tokens: BTreeMap<String, String>,
}

impl AutomationStore {
    /// Open `automations.json` and `automation-runs.json` under `dir`.
    ///
    /// A run left `Running` cannot survive a restart — the previous session's
    /// thread is gone — so it is marked aborted on load, exactly as the TS
    /// does. That edit is not saved here; the caller saves once it starts.
    pub fn open(dir: &Path) -> Result<Self> {
        let state_file = JsonFile::in_dir(Some(dir), "automations.json");
        let runs_file = JsonFile::in_dir(Some(dir), "automation-runs.json");
        let state = state_file.load::<AutomationDoc>()?.unwrap_or_default();
        let runs = runs_file.load::<AutomationRunDoc>()?.unwrap_or_default();
        let mut inner = AutomationInner {
            automations: if state.version == 1 { state.automations } else { Vec::new() },
            notify_webhook_url: state.notify_webhook_url.unwrap_or_default(),
            notify_webhook_only_when_away: state.notify_webhook_only_when_away.unwrap_or(true),
            webhook_tokens: state.webhook_tokens.unwrap_or_default(),
            runs: if runs.version == 1 { runs.runs } else { Vec::new() },
        };
        for run in &mut inner.runs {
            if run.status == AutomationRunStatus::Running {
                run.status = AutomationRunStatus::Aborted;
                run.finished_at = run.finished_at.or_else(|| Some(now_ms()));
                run.error = Some("The app quit while this run was active.".to_owned());
            }
        }
        Ok(Self { state_file, runs_file, inner: Mutex::new(inner) })
    }

    pub fn save(&self) -> Result<()> {
        let inner = self.inner.lock().unwrap();
        self.state_file.save(&AutomationDoc {
            version: 1,
            automations: inner.automations.clone(),
            // The TS omits an empty url and omits the flag when it is true,
            // so a file this app writes is byte-identical to one the
            // Electron app would have written from the same state.
            notify_webhook_url: if inner.notify_webhook_url.is_empty() {
                None
            } else {
                Some(inner.notify_webhook_url.clone())
            },
            notify_webhook_only_when_away: if inner.notify_webhook_only_when_away { None } else { Some(false) },
            webhook_tokens: if inner.webhook_tokens.is_empty() { None } else { Some(inner.webhook_tokens.clone()) },
        })?;
        self.runs_file.save(&AutomationRunDoc { version: 1, runs: inner.runs.clone() })?;
        Ok(())
    }

    pub fn automations(&self) -> Vec<Automation> {
        self.inner.lock().unwrap().automations.clone()
    }

    pub fn automation(&self, id: &str) -> Option<Automation> {
        self.inner.lock().unwrap().automations.iter().find(|a| a.id == id).cloned()
    }

    pub fn upsert_automation(&self, automation: Automation) {
        let mut inner = self.inner.lock().unwrap();
        match inner.automations.iter_mut().find(|a| a.id == automation.id) {
            Some(slot) => *slot = automation,
            None => inner.automations.push(automation),
        }
    }

    pub fn update_automation<T>(&self, id: &str, edit: impl FnOnce(&mut Automation) -> T) -> Option<T> {
        let mut inner = self.inner.lock().unwrap();
        inner.automations.iter_mut().find(|a| a.id == id).map(edit)
    }

    /// Forget an automation, its runs, and its hook token.
    pub fn drop_automation(&self, id: &str) {
        let mut inner = self.inner.lock().unwrap();
        inner.automations.retain(|a| a.id != id);
        inner.runs.retain(|r| r.automation_id != id);
        inner.webhook_tokens.remove(id);
    }

    pub fn runs(&self) -> Vec<AutomationRun> {
        self.inner.lock().unwrap().runs.clone()
    }

    pub fn push_run(&self, run: AutomationRun) {
        self.inner.lock().unwrap().runs.push(run);
    }

    pub fn update_run<T>(&self, id: &str, edit: impl FnOnce(&mut AutomationRun) -> T) -> Option<T> {
        let mut inner = self.inner.lock().unwrap();
        inner.runs.iter_mut().find(|r| r.id == id).map(edit)
    }

    pub fn webhook_token(&self, id: &str) -> Option<String> {
        self.inner.lock().unwrap().webhook_tokens.get(id).cloned()
    }

    /// This automation's hook token, minting one on first use.
    pub fn ensure_webhook_token(&self, id: &str) -> String {
        let mut inner = self.inner.lock().unwrap();
        if let Some(existing) = inner.webhook_tokens.get(id) {
            return existing.clone();
        }
        // 24 random bytes, base64url — the same shape and entropy the TS
        // minted with `randomBytes(24).toString('base64url')`.
        let mut bytes = [0u8; 24];
        rand::Rng::fill(&mut rand::thread_rng(), &mut bytes);
        let token = base64_url(&bytes);
        inner.webhook_tokens.insert(id.to_owned(), token.clone());
        token
    }

    pub fn drop_webhook_token(&self, id: &str) {
        self.inner.lock().unwrap().webhook_tokens.remove(id);
    }

    pub fn webhook_settings(&self) -> WebhookSettings {
        let inner = self.inner.lock().unwrap();
        WebhookSettings {
            url: inner.notify_webhook_url.clone(),
            only_when_away: inner.notify_webhook_only_when_away,
        }
    }

    pub fn set_webhook_settings(&self, url: Option<String>, only_when_away: Option<bool>) {
        let mut inner = self.inner.lock().unwrap();
        if let Some(url) = url {
            inner.notify_webhook_url = url;
        }
        if let Some(flag) = only_when_away {
            inner.notify_webhook_only_when_away = flag;
        }
    }

    /// Finished runs beyond this automation's `keepRuns` cap. The caller
    /// deletes their threads and worktrees before dropping them.
    pub fn prune_candidates(&self, automation_id: &str) -> Vec<AutomationRun> {
        let inner = self.inner.lock().unwrap();
        let keep = inner
            .automations
            .iter()
            .find(|a| a.id == automation_id)
            .map(|a| a.keep_runs)
            .unwrap_or(50) as usize;
        let mut finished: Vec<AutomationRun> = inner
            .runs
            .iter()
            .filter(|r| r.automation_id == automation_id && r.status != AutomationRunStatus::Running)
            .cloned()
            .collect();
        finished.sort_by(|a, b| b.started_at.cmp(&a.started_at));
        finished.into_iter().skip(keep).collect()
    }

    pub fn drop_runs(&self, ids: &[String]) {
        let mut inner = self.inner.lock().unwrap();
        inner.runs.retain(|r| !ids.iter().any(|id| id == &r.id));
    }
}

/// URL-safe base64 without padding, matching Node's `base64url`.
fn base64_url(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn workflow(id: &str, keep: u32) -> Workflow {
        Workflow {
            id: id.to_owned(),
            name: format!("w-{id}"),
            description: None,
            script: "log('x');".into(),
            project_path: String::new(),
            triggers: vec![],
            overlap_policy: WorkflowOverlapPolicy::Skip,
            budget: None,
            defaults: None,
            keep_runs: keep,
            enabled: true,
            source: WorkflowSource::User,
            created_at: 1,
            updated_at: 1,
            last_run_at: None,
        }
    }

    fn run(id: &str, workflow_id: &str, started_at: i64, status: WorkflowRunStatus) -> WorkflowRun {
        WorkflowRun {
            id: id.to_owned(),
            workflow_id: workflow_id.to_owned(),
            started_by_thread_id: None,
            trigger: WorkflowRunTrigger::Manual,
            status,
            event: None,
            journal: vec![],
            usage: Default::default(),
            result: None,
            error: None,
            note: None,
            started_at,
            finished_at: None,
        }
    }

    #[test]
    fn a_missing_file_is_an_empty_store() {
        let dir = tempfile::tempdir().unwrap();
        let store = WorkflowStore::open(dir.path()).unwrap();
        assert!(store.workflows().is_empty());
        assert!(store.runs().is_empty());
        assert_eq!(store.approval_mode(), WorkflowApprovalMode::Ask);
    }

    #[test]
    fn workflows_survive_a_save_and_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let store = WorkflowStore::open(dir.path()).unwrap();
        store.upsert_workflow(workflow("w1", 3));
        store.set_approval_mode(WorkflowApprovalMode::Auto);
        store.memory_set("w1", "seen", json!(["a", "b"]));
        store.push_run(run("r1", "w1", 10, WorkflowRunStatus::Completed));
        store.save().unwrap();

        let reopened = WorkflowStore::open(dir.path()).unwrap();
        assert_eq!(reopened.workflows().len(), 1);
        assert_eq!(reopened.approval_mode(), WorkflowApprovalMode::Auto);
        assert_eq!(reopened.memory_get("w1", "seen"), json!(["a", "b"]));
        assert_eq!(reopened.runs().len(), 1);
    }

    #[test]
    fn the_saved_envelope_matches_the_electron_shape() {
        let dir = tempfile::tempdir().unwrap();
        let store = WorkflowStore::open(dir.path()).unwrap();
        store.upsert_workflow(workflow("w1", 3));
        store.save().unwrap();
        let text = std::fs::read_to_string(dir.path().join("workflows.json")).unwrap();
        let doc: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(doc["version"], 1);
        assert_eq!(doc["approvalMode"], "ask");
        assert_eq!(doc["workflows"][0]["keepRuns"], 3);
        let runs: Value =
            serde_json::from_str(&std::fs::read_to_string(dir.path().join("workflow-runs.json")).unwrap()).unwrap();
        assert_eq!(runs["version"], 1);
        assert!(runs["runs"].as_array().unwrap().is_empty());
    }

    #[test]
    fn a_real_electron_workflows_file_loads() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("workflows.json"),
            r#"{
              "version": 1,
              "workflows": [{
                "name": "Caretaker",
                "script": "log('x');",
                "projectPath": "/Users/jeremy/dev/BOSS",
                "triggers": [],
                "overlapPolicy": "skip",
                "id": "5e974603",
                "enabled": true,
                "source": "agent",
                "createdAt": 1788036883522,
                "updatedAt": 1788037773813,
                "lastRunAt": 1788036893014
              }]
            }"#,
        )
        .unwrap();
        let store = WorkflowStore::open(dir.path()).unwrap();
        let loaded = store.workflows();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].source, WorkflowSource::Agent);
        assert_eq!(loaded[0].last_run_at, Some(1_788_036_893_014));
        // keepRuns is absent in the file and defaults to the TS default.
        assert_eq!(loaded[0].keep_runs, 100);
    }

    #[test]
    fn memory_clears_the_key_and_the_slot_when_set_to_null() {
        let dir = tempfile::tempdir().unwrap();
        let store = WorkflowStore::open(dir.path()).unwrap();
        store.memory_set("w1", "a", json!(1));
        store.memory_set("w1", "b", json!(2));
        store.memory_set("w1", "a", Value::Null);
        assert_eq!(store.memory_get("w1", "a"), Value::Null);
        assert_eq!(store.memory_get("w1", "b"), json!(2));
        store.memory_set("w1", "b", Value::Null);
        store.save().unwrap();
        let doc: Value =
            serde_json::from_str(&std::fs::read_to_string(dir.path().join("workflows.json")).unwrap()).unwrap();
        assert_eq!(doc["memory"], json!({}), "the empty slot is removed, not left behind");
    }

    #[test]
    fn prune_keeps_the_newest_finished_runs_and_never_an_active_one() {
        let dir = tempfile::tempdir().unwrap();
        let store = WorkflowStore::open(dir.path()).unwrap();
        store.upsert_workflow(workflow("w1", 2));
        for (id, at) in [("r1", 10), ("r2", 20), ("r3", 30), ("r4", 40)] {
            store.push_run(run(id, "w1", at, WorkflowRunStatus::Completed));
        }
        store.push_run(run("live", "w1", 50, WorkflowRunStatus::Running));
        let pruned: Vec<String> = store.prune_candidates("w1").into_iter().map(|r| r.id).collect();
        assert_eq!(pruned, vec!["r2".to_owned(), "r1".to_owned()]);
        store.drop_runs(&pruned);
        let left: Vec<String> = store.runs().into_iter().map(|r| r.id).collect();
        assert_eq!(left, vec!["r3".to_owned(), "r4".to_owned(), "live".to_owned()]);
    }

    #[test]
    fn dropping_a_workflow_takes_its_runs_and_memory() {
        let dir = tempfile::tempdir().unwrap();
        let store = WorkflowStore::open(dir.path()).unwrap();
        store.upsert_workflow(workflow("w1", 5));
        store.upsert_workflow(workflow("w2", 5));
        store.push_run(run("r1", "w1", 1, WorkflowRunStatus::Completed));
        store.push_run(run("r2", "w2", 1, WorkflowRunStatus::Completed));
        store.memory_set("w1", "k", json!(1));
        store.drop_workflow("w1");
        assert_eq!(store.workflows().len(), 1);
        assert_eq!(store.runs().len(), 1);
        assert_eq!(store.memory_get("w1", "k"), Value::Null);
    }

    fn automation(id: &str, keep: u32) -> Automation {
        Automation {
            id: id.to_owned(),
            name: format!("a-{id}"),
            prompt: "do the thing".into(),
            project_path: String::new(),
            backend_id: "claude".into(),
            model: None,
            mode: "auto".into(),
            schedule: AutomationSchedule::default(),
            webhook: None,
            workspace: AutomationWorkspace::None,
            overlap_policy: AutomationOverlapPolicy::Skip,
            catch_up: true,
            notify: AutomationNotifyMode::Events,
            max_run_minutes: 30,
            keep_runs: keep,
            enabled: true,
            next_run_at: None,
            last_run_at: None,
            last_webhook_at: None,
            last_webhook_label: None,
            missed_runs: 0,
            created_at: 1,
            updated_at: 1,
        }
    }

    fn automation_run(id: &str, automation_id: &str, at: i64, status: AutomationRunStatus) -> AutomationRun {
        AutomationRun {
            id: id.to_owned(),
            automation_id: automation_id.to_owned(),
            thread_id: None,
            worktree_id: None,
            trigger: AutomationRunTrigger::Schedule,
            status,
            summary: None,
            error: None,
            needs_attention: None,
            changed_files: 0,
            started_at: at,
            finished_at: None,
        }
    }

    #[test]
    fn automations_survive_a_save_and_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let store = AutomationStore::open(dir.path()).unwrap();
        store.upsert_automation(automation("a1", 5));
        store.push_run(automation_run("r1", "a1", 1, AutomationRunStatus::Success));
        store.save().unwrap();
        let reopened = AutomationStore::open(dir.path()).unwrap();
        assert_eq!(reopened.automations().len(), 1);
        assert_eq!(reopened.runs().len(), 1);
    }

    #[test]
    fn a_run_left_running_by_a_crash_loads_as_aborted() {
        let dir = tempfile::tempdir().unwrap();
        let store = AutomationStore::open(dir.path()).unwrap();
        store.push_run(automation_run("r1", "a1", 1, AutomationRunStatus::Running));
        store.save().unwrap();
        let reopened = AutomationStore::open(dir.path()).unwrap();
        let loaded = &reopened.runs()[0];
        assert_eq!(loaded.status, AutomationRunStatus::Aborted);
        assert!(loaded.error.as_deref().unwrap().contains("quit while this run was active"));
        assert!(loaded.finished_at.is_some());
    }

    #[test]
    fn webhook_tokens_are_stable_and_stay_out_of_the_automation() {
        let dir = tempfile::tempdir().unwrap();
        let store = AutomationStore::open(dir.path()).unwrap();
        store.upsert_automation(automation("a1", 5));
        let token = store.ensure_webhook_token("a1");
        assert_eq!(store.ensure_webhook_token("a1"), token, "a second call returns the same token");
        assert_eq!(token.len(), 32, "24 bytes of base64url");
        assert!(!token.contains('+') && !token.contains('/') && !token.contains('='));
        store.save().unwrap();
        let doc: Value =
            serde_json::from_str(&std::fs::read_to_string(dir.path().join("automations.json")).unwrap()).unwrap();
        assert_eq!(doc["webhookTokens"]["a1"], json!(token));
        assert!(doc["automations"][0].get("webhookTokens").is_none());
        assert_eq!(AutomationStore::open(dir.path()).unwrap().webhook_token("a1").as_deref(), Some(token.as_str()));
    }

    #[test]
    fn the_saved_automation_envelope_omits_the_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let store = AutomationStore::open(dir.path()).unwrap();
        store.upsert_automation(automation("a1", 5));
        store.save().unwrap();
        let doc: Value =
            serde_json::from_str(&std::fs::read_to_string(dir.path().join("automations.json")).unwrap()).unwrap();
        assert_eq!(doc["version"], 1);
        assert!(doc.get("notifyWebhookUrl").is_none());
        assert!(doc.get("notifyWebhookOnlyWhenAway").is_none());
        assert!(doc.get("webhookTokens").is_none());

        store.set_webhook_settings(Some("https://ntfy.sh/topic".into()), Some(false));
        store.save().unwrap();
        let doc: Value =
            serde_json::from_str(&std::fs::read_to_string(dir.path().join("automations.json")).unwrap()).unwrap();
        assert_eq!(doc["notifyWebhookUrl"], "https://ntfy.sh/topic");
        assert_eq!(doc["notifyWebhookOnlyWhenAway"], false);
        assert_eq!(AutomationStore::open(dir.path()).unwrap().webhook_settings().only_when_away, false);
    }

    #[test]
    fn automation_prune_keeps_the_newest_and_spares_a_live_run() {
        let dir = tempfile::tempdir().unwrap();
        let store = AutomationStore::open(dir.path()).unwrap();
        store.upsert_automation(automation("a1", 2));
        for (id, at) in [("r1", 10), ("r2", 20), ("r3", 30)] {
            store.push_run(automation_run(id, "a1", at, AutomationRunStatus::Success));
        }
        store.push_run(automation_run("live", "a1", 40, AutomationRunStatus::Running));
        let pruned: Vec<String> = store.prune_candidates("a1").into_iter().map(|r| r.id).collect();
        assert_eq!(pruned, vec!["r1".to_owned()]);
    }
}
