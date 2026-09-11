//! What the workflow and automation engines need from the rest of BOSS.
//!
//! Port of the `WorkflowHost` interface in `src/main/workflow-host.ts` and
//! the `BackendManager`/`WorktreeManager`/`NotificationRouter` calls the
//! automation manager made directly. Keeping it behind a trait is what lets
//! both engines be tested headless, against a fake that never starts a
//! process.
//!
//! The real implementation over [`crate::Runtime`] lives in
//! [`super::runtime_host`].

use super::types::*;
use anyhow::Result;
use async_trait::async_trait;

/// What one agent step asks for.
#[derive(Clone, Debug)]
pub struct AgentRequest {
    /// The run this step belongs to.
    pub run_id: String,
    /// Journal sequence number, so a late outcome finds its entry.
    pub seq: i64,
    /// Absolute project path, or `""` for a global workflow.
    pub project_path: String,
    /// Thread title.
    pub title: String,
    /// The prompt, header included.
    pub prompt: String,
    /// Engine id (`claude`, `codex`, …), or `None` for the default.
    pub engine: Option<String>,
    /// Model preference, engine-specific.
    pub model: Option<String>,
    /// `worktree`, `project`, or `none`.
    pub workspace: AutomationWorkspace,
    /// Run in the same checkout as a prior step's conversation: how a
    /// reviewer reads an implementer's worktree.
    pub in_worktree_of: Option<String>,
    /// Ceiling for this one conversation.
    pub max_minutes: f64,
}

/// A thread the host started for a step.
#[derive(Clone, Debug, PartialEq)]
pub struct StartedAgent {
    pub thread_id: String,
    pub worktree_id: Option<String>,
}

/// How an agent conversation ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentStatus {
    Success,
    Failure,
    Timeout,
    Aborted,
}

/// What an `agent()` call resolves to inside a script, and what an
/// automation run records.
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentOutcome {
    pub status: AgentStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    /// Last assistant message text, for scripts that parse structured output.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default)]
    pub changed_files: u32,
    pub thread_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl AgentOutcome {
    /// A failure with nothing to show for it.
    pub fn failed(thread_id: impl Into<String>, error: impl Into<String>) -> Self {
        Self {
            status: AgentStatus::Failure,
            summary: None,
            text: None,
            changed_files: 0,
            thread_id: thread_id.into(),
            worktree_id: None,
            error: Some(error.into()),
        }
    }
}

/// Something worth telling a person about.
#[derive(Clone, Debug, PartialEq)]
pub struct Notice {
    pub title: String,
    pub body: String,
    /// True when it blocks progress or is a failure.
    pub attention: bool,
    /// Project it came from, or `""`.
    pub project_path: String,
    pub thread_id: Option<String>,
}

/// A finished run, handed to the reports store when the automation asked for
/// a durable artifact.
#[derive(Clone, Debug, PartialEq)]
pub struct RunOutcome {
    pub automation_id: String,
    pub automation_name: String,
    pub run_id: String,
    /// The run status, spelled as the wire format does (`success`, …).
    pub status: String,
    pub project_path: String,
    pub thread_id: Option<String>,
    pub title: String,
    pub summary: Option<String>,
    pub body: String,
}

/// What both engines need: run an agent, watch it, and tell someone.
#[async_trait]
pub trait AutomationHost: Send + Sync {
    /// Start an agent conversation. Completion arrives out of band, through
    /// whatever the implementation watches; [`Self::collect_outcome`]
    /// answers for a thread that is no longer active.
    async fn start_agent(&self, request: AgentRequest) -> Result<StartedAgent>;

    /// Is this thread's session still working?
    fn is_agent_active(&self, thread_id: &str) -> bool;

    /// Outcome of an inactive thread — it finished while the app was down,
    /// or went idle unobserved. `None` when the thread is gone or never
    /// answered.
    async fn collect_outcome(&self, thread_id: &str) -> Option<AgentOutcome>;

    /// Stop a conversation.
    async fn abort_agent(&self, thread_id: &str) -> Result<()>;

    /// Tell a person.
    fn notify(&self, notice: Notice);

    /// Deliver a finished run's result back to the conversation that started
    /// it, closing the loop for agents that call `boss_workflow_run`.
    async fn deliver_to_thread(&self, _thread_id: &str, _body: &str) -> Result<()> {
        Ok(())
    }

    /// Delete the durable leftovers of a pruned run.
    async fn dispose_thread(&self, _thread_id: &str, _worktree_id: Option<&str>) -> Result<()> {
        Ok(())
    }

    /// Remove a worktree whose run left nothing worth reviewing.
    async fn remove_worktree(&self, _worktree_id: &str) -> Result<()> {
        Ok(())
    }

    /// Store a finished run as a durable report.
    async fn record_report(&self, _outcome: RunOutcome) -> Result<()> {
        Ok(())
    }
}

/// The extra capability the workflow engine's `pr()` primitive needs.
#[async_trait]
pub trait WorkflowHost: AutomationHost {
    /// Open a change request from a step's worktree. The default refuses,
    /// matching a build without change requests.
    async fn create_change_request(
        &self,
        _thread_id: &str,
        _title: Option<&str>,
        _body: Option<&str>,
        _base_branch: Option<&str>,
        _draft: bool,
    ) -> Result<serde_json::Value> {
        anyhow::bail!("Change requests are not available in this BOSS build.")
    }
}

/// The prompt header every unattended automation run carries.
pub fn automation_header(name: &str, prompt: &str) -> String {
    [
        "[BOSS AUTOMATION RUN]",
        &format!("Automation: {name}"),
        "This run is unattended. Complete the task below without asking the user questions.",
        "End your final message with exactly one line in this form:",
        "SUMMARY: <one sentence on what you did and what changed>",
        "",
        prompt,
    ]
    .join("\n")
}

/// The prompt header every workflow `agent()` step carries.
pub fn workflow_step_header(workflow_name: &str, prompt: &str) -> String {
    [
        "[BOSS WORKFLOW STEP]",
        &format!("Workflow: {workflow_name}"),
        "This run is unattended. Complete the task below without asking the user questions.",
        "End your final message with exactly one line in this form:",
        "SUMMARY: <one sentence on what you did and what changed>",
        "",
        prompt,
    ]
    .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_headers_match_the_electron_wording() {
        let header = automation_header("Nightly", "check the logs");
        assert!(header.starts_with("[BOSS AUTOMATION RUN]\nAutomation: Nightly\n"));
        assert!(header.contains("SUMMARY: <one sentence on what you did and what changed>"));
        assert!(header.ends_with("\n\ncheck the logs"));

        let step = workflow_step_header("Caretaker", "fix CI");
        assert!(step.starts_with("[BOSS WORKFLOW STEP]\nWorkflow: Caretaker\n"));
        assert!(step.ends_with("\n\nfix CI"));
    }

    #[test]
    fn an_agent_outcome_round_trips_in_the_electron_shape() {
        let outcome = AgentOutcome {
            status: AgentStatus::Success,
            summary: Some("did it".into()),
            text: None,
            changed_files: 3,
            thread_id: "t1".into(),
            worktree_id: Some("w1".into()),
            error: None,
        };
        let value = serde_json::to_value(&outcome).unwrap();
        assert_eq!(value["status"], "success");
        assert_eq!(value["changedFiles"], 3);
        assert_eq!(value["worktreeId"], "w1");
        assert!(value.get("text").is_none(), "absent fields stay absent");
        assert_eq!(serde_json::from_value::<AgentOutcome>(value).unwrap(), outcome);
    }
}
