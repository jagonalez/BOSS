//! Durable, human-facing artifacts produced by agents and automations.
//!
//! Port of `src/main/report-manager.ts` and `src/shared/report.ts`. The file
//! stays byte-compatible with the Electron `reports.json` (version 2, camelCase
//! keys, millisecond timestamps) so importing the user's existing file is a
//! copy rather than a migration.

use super::{JsonFile, Result, StoreError};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::path::Path;
use std::sync::Mutex;

/// Longest a report title may be.
pub const MAX_TITLE: usize = 200;
/// Longest a report summary may be.
pub const MAX_SUMMARY: usize = 1_000;
/// Longest a report body may be.
pub const MAX_BODY: usize = 250_000;

/// Where a report came from.
///
/// Serialized as the TS discriminated union: `{ "kind": "agent", "backendId":
/// "claude" }` or `{ "kind": "automation", "automationId": …, … }`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ReportSource {
    /// An agent wrote it through `boss_reports_create`.
    #[serde(rename_all = "camelCase")]
    Agent {
        /// Engine the writing thread runs on (`claude`, `codex`, …).
        backend_id: String,
    },
    /// An automation run produced it.
    #[serde(rename_all = "camelCase")]
    Automation {
        /// Automation that ran.
        automation_id: String,
        /// Its name at the time of the run.
        automation_name: String,
        /// The run that produced this report.
        run_id: String,
        /// How that run ended (`success`, `failure`, …).
        status: String,
    },
}

/// A report as stored. Owns a presentation copy of its content: deleting the
/// source thread never empties the artifact.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    /// Stable id, a UUID.
    pub id: String,
    /// Who wrote it.
    pub source: ReportSource,
    /// Thread it came from, kept as provenance.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    /// Absolute project path, or `""` for a projectless report.
    pub project_path: String,
    /// One line, shown in the list.
    pub title: String,
    /// Optional abstract.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    /// The artifact itself, markdown.
    pub body: String,
    /// Unix milliseconds.
    pub created_at: i64,
    /// Unix milliseconds; bumped by every edit.
    pub updated_at: i64,
    /// Unix milliseconds when the user read it. Cleared by an edit, so a
    /// revised report is unread again.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub read_at: Option<i64>,
}

/// What an agent passes to create a report.
#[derive(Clone, Debug, Default)]
pub struct AgentReportInput {
    /// Thread that is writing.
    pub thread_id: String,
    /// Its project path, or `""`.
    pub project_path: String,
    /// Its engine id.
    pub backend_id: String,
    /// Report title.
    pub title: String,
    /// Optional summary.
    pub summary: Option<String>,
    /// Report body.
    pub body: String,
}

/// A partial edit. `Some("")` clears the summary; `None` leaves a field alone.
#[derive(Clone, Debug, Default)]
pub struct AgentReportPatch {
    /// Replace the title.
    pub title: Option<String>,
    /// Replace or clear the summary.
    pub summary: Option<String>,
    /// Replace the body.
    pub body: Option<String>,
}

impl AgentReportPatch {
    /// Nothing to change.
    pub fn is_empty(&self) -> bool {
        self.title.is_none() && self.summary.is_none() && self.body.is_none()
    }
}

/// On-disk document. `version` is 2; version 1 files are upgraded on load.
#[derive(Debug, Serialize, Deserialize)]
struct ReportState {
    version: u32,
    reports: Vec<Report>,
}

/// Highest file version this build writes and reads.
const VERSION: u32 = 2;

/// Every report BOSS holds, in one JSON file.
///
/// Reads are cheap (an in-memory copy); every mutation rewrites the file
/// atomically, exactly as the Electron manager did.
pub struct ReportStore {
    file: JsonFile,
    reports: Mutex<Vec<Report>>,
}

impl ReportStore {
    /// Open `reports.json` under `base`, or under the user data dir.
    pub fn open(base: Option<&Path>) -> Result<Self> {
        Self::at(JsonFile::in_dir(base, "reports.json"))
    }

    /// Open a specific file. Used by tests and by an import.
    pub fn at(file: JsonFile) -> Result<Self> {
        let reports = match file.load::<Value>()? {
            None => Vec::new(),
            Some(value) => {
                let version = value.get("version").and_then(Value::as_u64).unwrap_or(0) as u32;
                if version > VERSION {
                    return Err(StoreError::Version {
                        path: file.path().to_path_buf(),
                        found: version,
                        supported: VERSION,
                    });
                }
                let rows = value.get("reports").and_then(Value::as_array).cloned().unwrap_or_default();
                match version {
                    2 => rows
                        .into_iter()
                        .map(serde_json::from_value)
                        .collect::<std::result::Result<Vec<Report>, _>>()
                        .map_err(|source| StoreError::Json { path: file.path().to_path_buf(), source })?,
                    // Version 1 held automation reports with the source
                    // fields inlined. Upgrade in memory; the next save
                    // writes version 2.
                    1 => rows.iter().filter_map(upgrade_v1).collect(),
                    _ => Vec::new(),
                }
            }
        };
        let store = Self { file, reports: Mutex::new(reports) };
        Ok(store)
    }

    /// Where the file lives.
    pub fn path(&self) -> &Path {
        self.file.path()
    }

    /// Every report, newest edit first.
    pub fn list(&self) -> Vec<Report> {
        let mut all = self.reports.lock().unwrap().clone();
        all.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        all
    }

    /// Every report without its body, newest edit first. This is what the
    /// phone and the sidebar list.
    pub fn summaries(&self) -> Vec<Value> {
        self.list().iter().map(summary_of).collect()
    }

    /// The `report.list` payload the PWA expects.
    pub fn snapshot(&self) -> Value {
        serde_json::json!({ "reports": self.summaries() })
    }

    /// One report in full.
    pub fn get(&self, id: &str) -> Option<Report> {
        self.reports.lock().unwrap().iter().find(|r| r.id == id).cloned()
    }

    /// Store a report an agent wrote. Fails on empty or oversized text, the
    /// same limits the Electron manager enforced.
    pub fn create_from_agent(&self, input: AgentReportInput, now: i64) -> Result<Report> {
        let report = Report {
            id: uuid::Uuid::new_v4().to_string(),
            source: ReportSource::Agent { backend_id: input.backend_id },
            thread_id: Some(input.thread_id),
            project_path: input.project_path,
            title: required_text(&input.title, "Report title", MAX_TITLE)?,
            summary: optional_text(input.summary.as_deref(), "Report summary", MAX_SUMMARY)?,
            body: required_text(&input.body, "Report body", MAX_BODY)?,
            created_at: now,
            updated_at: now,
            read_at: None,
        };
        self.reports.lock().unwrap().push(report.clone());
        self.save()?;
        Ok(report)
    }

    /// Store a report an automation run produced.
    pub fn create_from_automation(
        &self,
        source: ReportSource,
        thread_id: Option<String>,
        project_path: String,
        title: &str,
        summary: Option<&str>,
        body: &str,
        now: i64,
    ) -> Result<Report> {
        let report = Report {
            id: uuid::Uuid::new_v4().to_string(),
            source,
            thread_id,
            project_path,
            title: required_text(title, "Report title", MAX_TITLE)?,
            summary: optional_text(summary, "Report summary", MAX_SUMMARY)?,
            body: required_text(body, "Report body", MAX_BODY)?,
            created_at: now,
            updated_at: now,
            read_at: None,
        };
        self.reports.lock().unwrap().push(report.clone());
        self.save()?;
        Ok(report)
    }

    /// Refine a report. Only the agent thread that wrote it may edit it, so a
    /// thread cannot rewrite another's artifact.
    pub fn update_from_agent(
        &self,
        thread_id: &str,
        id: &str,
        patch: AgentReportPatch,
        now: i64,
    ) -> Result<Report> {
        let mut reports = self.reports.lock().unwrap();
        let report = reports
            .iter_mut()
            .find(|r| r.id == id)
            .ok_or_else(|| StoreError::Invalid("Report not found.".into()))?;
        let owned = matches!(report.source, ReportSource::Agent { .. })
            && report.thread_id.as_deref() == Some(thread_id);
        if !owned {
            return Err(StoreError::Invalid(
                "Only the thread that created this report can update it.".into(),
            ));
        }
        if let Some(title) = patch.title.as_deref() {
            report.title = required_text(title, "Report title", MAX_TITLE)?;
        }
        if let Some(body) = patch.body.as_deref() {
            report.body = required_text(body, "Report body", MAX_BODY)?;
        }
        if let Some(summary) = patch.summary.as_deref() {
            report.summary = optional_text(Some(summary), "Report summary", MAX_SUMMARY)?;
        }
        report.updated_at = now;
        // An edited report is unread again: the user read the old text.
        report.read_at = None;
        let updated = report.clone();
        drop(reports);
        self.save()?;
        Ok(updated)
    }

    /// Mark a report read. Idempotent: reading twice keeps the first time.
    pub fn mark_read(&self, id: &str, now: i64) -> Result<Report> {
        let mut reports = self.reports.lock().unwrap();
        let report = reports
            .iter_mut()
            .find(|r| r.id == id)
            .ok_or_else(|| StoreError::Invalid("Report not found.".into()))?;
        let changed = report.read_at.is_none();
        if changed {
            report.read_at = Some(now);
        }
        let updated = report.clone();
        drop(reports);
        if changed {
            self.save()?;
        }
        Ok(updated)
    }

    /// Remove a report for good.
    pub fn delete(&self, id: &str) -> Result<()> {
        let mut reports = self.reports.lock().unwrap();
        let before = reports.len();
        reports.retain(|r| r.id != id);
        if reports.len() == before {
            return Err(StoreError::Invalid("Report not found.".into()));
        }
        drop(reports);
        self.save()
    }

    fn save(&self) -> Result<()> {
        let reports = self.reports.lock().unwrap();
        self.file.save(&ReportState { version: VERSION, reports: reports.clone() })
    }
}

/// A report minus its body: what a list needs. Built from the serialized form
/// so the key names and the omitted-when-absent fields match the full report.
fn summary_of(report: &Report) -> Value {
    let mut value = serde_json::to_value(report).unwrap_or_else(|_| Value::Object(Map::new()));
    if let Some(map) = value.as_object_mut() {
        map.remove("body");
    }
    value
}

/// A version 1 row: an automation report with its source inlined.
fn upgrade_v1(row: &Value) -> Option<Report> {
    let s = |key: &str| row.get(key).and_then(Value::as_str).map(str::to_owned);
    let n = |key: &str| row.get(key).and_then(Value::as_i64);
    let created_at = n("createdAt").unwrap_or_default();
    Some(Report {
        id: s("id")?,
        source: ReportSource::Automation {
            automation_id: s("automationId").unwrap_or_default(),
            automation_name: s("automationName").unwrap_or_default(),
            run_id: s("runId").unwrap_or_default(),
            status: s("status").unwrap_or_else(|| "success".into()),
        },
        thread_id: s("threadId").filter(|t| !t.is_empty()),
        project_path: s("projectPath").unwrap_or_default(),
        title: s("title")?,
        summary: s("summary").filter(|t| !t.is_empty()),
        body: s("body").unwrap_or_default(),
        created_at,
        // Version 1 had no updatedAt; the creation time is the only truth.
        updated_at: created_at,
        read_at: n("readAt").filter(|at| *at > 0),
    })
}

fn required_text(value: &str, label: &str, max: usize) -> Result<String> {
    let text = value.trim();
    if text.is_empty() {
        return Err(StoreError::Invalid(format!("{label} is required.")));
    }
    if text.chars().count() > max {
        return Err(StoreError::Invalid(format!("{label} is limited to {} characters.", thousands(max))));
    }
    Ok(text.to_owned())
}

fn optional_text(value: Option<&str>, label: &str, max: usize) -> Result<Option<String>> {
    let Some(value) = value else { return Ok(None) };
    let text = value.trim();
    if text.chars().count() > max {
        return Err(StoreError::Invalid(format!("{label} is limited to {} characters.", thousands(max))));
    }
    Ok(if text.is_empty() { None } else { Some(text.to_owned()) })
}

/// `250000` as `250,000`, matching the `toLocaleString()` in the TS message so
/// the text an agent sees is unchanged.
fn thousands(n: usize) -> String {
    let digits = n.to_string();
    let mut out = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(c);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (tempfile::TempDir, ReportStore) {
        let dir = tempfile::tempdir().unwrap();
        let store = ReportStore::open(Some(dir.path())).unwrap();
        (dir, store)
    }

    fn input(thread: &str) -> AgentReportInput {
        AgentReportInput {
            thread_id: thread.into(),
            project_path: "/repo".into(),
            backend_id: "claude".into(),
            title: "Architecture notes".into(),
            summary: Some("Initial design".into()),
            body: "# Design\n\nFirst draft.".into(),
        }
    }

    #[test]
    fn an_agent_report_round_trips_through_the_file() {
        let (dir, store) = store();
        let made = store.create_from_agent(input("thread-1"), 1_000).unwrap();
        assert_eq!(made.source, ReportSource::Agent { backend_id: "claude".into() });
        assert_eq!(made.created_at, 1_000);
        assert_eq!(made.updated_at, 1_000);
        assert_eq!(made.read_at, None);

        let reopened = ReportStore::open(Some(dir.path())).unwrap();
        let got = reopened.get(&made.id).unwrap();
        assert_eq!(got, made);
    }

    #[test]
    fn the_file_matches_the_electron_shape() {
        let (dir, store) = store();
        store.create_from_agent(input("thread-1"), 1_000).unwrap();
        let text = std::fs::read_to_string(dir.path().join("reports.json")).unwrap();
        let value: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(value["version"], 2);
        let report = &value["reports"][0];
        assert_eq!(report["source"]["kind"], "agent");
        assert_eq!(report["source"]["backendId"], "claude");
        assert_eq!(report["threadId"], "thread-1");
        assert_eq!(report["projectPath"], "/repo");
        assert_eq!(report["createdAt"], 1_000);
        assert_eq!(report["updatedAt"], 1_000);
        // Absent rather than null, so a TS `readAt === undefined` check holds.
        assert!(report.get("readAt").is_none(), "readAt is omitted when unset");
        assert!(report["id"].as_str().unwrap().len() == 36, "id is a uuid");
    }

    #[test]
    fn the_real_electron_file_parses_unchanged() {
        // Shape taken from ~/Library/Application Support/BOSS/reports.json.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("reports.json");
        std::fs::write(
            &path,
            r#"{
              "version": 2,
              "reports": [
                {
                  "id": "84d13187-18ad-472e-8ad5-aac871525849",
                  "source": { "kind": "agent", "backendId": "codex" },
                  "threadId": "76644732-9c0f-4db3-895a-e9ff29a1bef9",
                  "projectPath": "/Users/jeremy/dev/BOSS",
                  "title": "RLM, CodeAct, and Programmatic Tool-Calling",
                  "summary": "A source-backed comparison.",
                  "body": "RLM notes.",
                  "createdAt": 1787701797047,
                  "updatedAt": 1787701797047,
                  "readAt": 1787701982946
                },
                {
                  "id": "73bab9ef-227f-4d10-8472-399c927f4b08",
                  "source": {
                    "kind": "automation",
                    "automationId": "c974c621",
                    "automationName": "Review changelogs",
                    "runId": "6b57dafc",
                    "status": "success"
                  },
                  "threadId": "40b0d0aa",
                  "projectPath": "",
                  "title": "Review claude and codex changelogs",
                  "body": "Both summaries were sent.",
                  "createdAt": 1787752850060,
                  "updatedAt": 1787752850060
                }
              ]
            }"#,
        )
        .unwrap();
        let store = ReportStore::at(JsonFile::new(&path)).unwrap();
        let all = store.list();
        assert_eq!(all.len(), 2);
        // Newest edit first.
        assert_eq!(all[0].title, "Review claude and codex changelogs");
        assert_eq!(all[0].summary, None);
        assert_eq!(all[0].project_path, "");
        assert_eq!(
            all[0].source,
            ReportSource::Automation {
                automation_id: "c974c621".into(),
                automation_name: "Review changelogs".into(),
                run_id: "6b57dafc".into(),
                status: "success".into(),
            }
        );
        assert_eq!(all[1].read_at, Some(1787701982946));

        // Rewriting produces the same values, so a saved file stays readable
        // by the Electron app.
        store.mark_read(&all[0].id, 1787760165583).unwrap();
        let round: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(round["version"], 2);
        assert_eq!(round["reports"].as_array().unwrap().len(), 2);
        // Stored order is unchanged; only `list()` sorts.
        assert_eq!(round["reports"][0]["source"]["backendId"], "codex");
        assert_eq!(round["reports"][1]["source"]["automationName"], "Review changelogs");
        assert_eq!(round["reports"][1]["readAt"], 1787760165583i64);
        // A report with no summary keeps the key absent, not null.
        assert!(round["reports"][1].get("summary").is_none());
    }

    #[test]
    fn only_the_source_thread_can_refine_a_report() {
        let (_dir, store) = store();
        let made = store.create_from_agent(input("thread-1"), 1_000).unwrap();
        let denied = store
            .update_from_agent("thread-other", &made.id, AgentReportPatch { title: Some("Hijacked".into()), ..Default::default() }, 2_000)
            .unwrap_err()
            .to_string();
        assert!(denied.contains("Only the thread that created"), "message was {denied}");
        assert_eq!(store.get(&made.id).unwrap().title, "Architecture notes");
    }

    #[test]
    fn an_edit_clears_the_summary_and_the_read_mark() {
        let (_dir, store) = store();
        let made = store.create_from_agent(input("thread-1"), 1_000).unwrap();
        assert!(store.mark_read(&made.id, 1_500).unwrap().read_at.is_some());

        let edited = store
            .update_from_agent(
                "thread-1",
                &made.id,
                AgentReportPatch {
                    summary: Some(String::new()),
                    body: Some("# Design\n\nRevised draft.".into()),
                    ..Default::default()
                },
                2_000,
            )
            .unwrap();
        assert_eq!(edited.summary, None);
        assert_eq!(edited.read_at, None);
        assert_eq!(edited.updated_at, 2_000);
        assert!(edited.body.contains("Revised draft"));
        // The unset fields are left alone.
        assert_eq!(edited.title, "Architecture notes");
        assert_eq!(edited.created_at, 1_000);
    }

    #[test]
    fn marking_read_twice_keeps_the_first_time() {
        let (_dir, store) = store();
        let made = store.create_from_agent(input("thread-1"), 1_000).unwrap();
        store.mark_read(&made.id, 1_500).unwrap();
        assert_eq!(store.mark_read(&made.id, 9_000).unwrap().read_at, Some(1_500));
    }

    #[test]
    fn empty_and_oversized_text_are_refused() {
        let (_dir, store) = store();
        let blank = AgentReportInput { title: "   ".into(), ..input("thread-1") };
        assert!(store.create_from_agent(blank, 1).unwrap_err().to_string().contains("Report title is required."));

        let long = AgentReportInput { body: "x".repeat(MAX_BODY + 1), ..input("thread-1") };
        let message = store.create_from_agent(long, 1).unwrap_err().to_string();
        assert!(message.contains("250,000 characters"), "message was {message}");

        let long_title = AgentReportInput { title: "t".repeat(MAX_TITLE + 1), ..input("thread-1") };
        assert!(store.create_from_agent(long_title, 1).unwrap_err().to_string().contains("200 characters"));
        assert!(store.list().is_empty(), "nothing was stored");
    }

    #[test]
    fn deleting_persists_the_removal() {
        let (dir, store) = store();
        let made = store.create_from_agent(input("thread-1"), 1_000).unwrap();
        store.delete(&made.id).unwrap();
        assert!(store.get(&made.id).is_none());
        assert!(store.delete(&made.id).unwrap_err().to_string().contains("Report not found."));
        assert!(ReportStore::open(Some(dir.path())).unwrap().list().is_empty());
    }

    #[test]
    fn summaries_drop_the_body_and_sort_newest_first() {
        let (_dir, store) = store();
        let first = store.create_from_agent(input("thread-1"), 1_000).unwrap();
        let second = store
            .create_from_agent(AgentReportInput { title: "Later".into(), ..input("thread-2") }, 2_000)
            .unwrap();
        let list = store.summaries();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0]["id"], second.id);
        assert_eq!(list[1]["id"], first.id);
        assert!(list[0].get("body").is_none(), "the list carries no bodies");
        assert_eq!(list[0]["title"], "Later");
        assert_eq!(store.snapshot()["reports"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn a_version_one_file_upgrades_to_the_agent_and_automation_split() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("reports.json");
        std::fs::write(
            &path,
            r#"{"version":1,"reports":[{"id":"r1","automationId":"a1","automationName":"Nightly",
               "runId":"run1","threadId":"t1","projectPath":"/repo","title":"Nightly run",
               "summary":"All good","body":"Details.","status":"success","createdAt":10,"readAt":20}]}"#,
        )
        .unwrap();
        let store = ReportStore::at(JsonFile::new(&path)).unwrap();
        let all = store.list();
        assert_eq!(all.len(), 1);
        assert_eq!(
            all[0].source,
            ReportSource::Automation {
                automation_id: "a1".into(),
                automation_name: "Nightly".into(),
                run_id: "run1".into(),
                status: "success".into(),
            }
        );
        assert_eq!(all[0].updated_at, 10, "version 1 had no updatedAt");
        assert_eq!(all[0].read_at, Some(20));

        // The next save writes version 2 with the split source.
        store
            .create_from_agent(
                AgentReportInput {
                    thread_id: "t2".into(),
                    project_path: "/repo".into(),
                    backend_id: "pi".into(),
                    title: "Later".into(),
                    summary: None,
                    body: "New.".into(),
                },
                40,
            )
            .unwrap();
        let value: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(value["version"], 2);
        assert_eq!(value["reports"][0]["source"]["kind"], "automation");
        assert_eq!(value["reports"][0]["source"]["automationName"], "Nightly");
        assert_eq!(value["reports"][0]["updatedAt"], 10);
        assert_eq!(value["reports"][1]["source"]["backendId"], "pi");
    }

    #[test]
    fn a_newer_file_is_refused_rather_than_truncated() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("reports.json");
        std::fs::write(&path, r#"{"version":99,"reports":[]}"#).unwrap();
        assert!(matches!(
            ReportStore::at(JsonFile::new(&path)),
            Err(StoreError::Version { found: 99, supported: 2, .. })
        ));
    }

    #[test]
    fn an_automation_report_is_not_editable_by_a_thread() {
        let (_dir, store) = store();
        let made = store
            .create_from_automation(
                ReportSource::Automation {
                    automation_id: "a1".into(),
                    automation_name: "Nightly".into(),
                    run_id: "run1".into(),
                    status: "failure".into(),
                },
                Some("t1".into()),
                String::new(),
                "Nightly run",
                Some("  "),
                "It failed.",
                5_000,
            )
            .unwrap();
        assert_eq!(made.summary, None, "a blank summary is stored as absent");
        let denied = store
            .update_from_agent("t1", &made.id, AgentReportPatch { body: Some("nope".into()), ..Default::default() }, 6_000)
            .unwrap_err()
            .to_string();
        assert!(denied.contains("Only the thread that created"), "message was {denied}");
    }
}
