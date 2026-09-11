//! What an import did, written to `import-report.json` in the native folder.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use time::OffsetDateTime;

/// Counts and complaints from one import run. Written whole, so a second
/// run overwrites the first; the import itself is idempotent.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "snake_case")]
pub struct ImportReport {
    /// Folder the data came from.
    pub source: PathBuf,
    /// Folder it went into.
    pub target: PathBuf,
    /// When the run finished, RFC 3339.
    pub finished_at: String,
    /// How long it took.
    pub duration_ms: u64,
    /// Per-kind counts.
    pub counts: Counts,
    /// Files copied verbatim because the native store is byte-compatible.
    pub copied: Vec<String>,
    /// Files that were already present in the target and left alone.
    pub skipped_existing: Vec<String>,
    /// Things deliberately not imported, with a reason.
    pub skipped: Vec<Skipped>,
    /// Things that should have imported and did not.
    pub errors: Vec<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "snake_case")]
pub struct Counts {
    pub projects: usize,
    pub threads: usize,
    pub rooms: usize,
    pub messages: usize,
    pub parts: usize,
    pub mcp_connections: usize,
}

/// One thing left behind, and why.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct Skipped {
    /// What kind of thing: `thread`, `message`, `file`, ...
    pub kind: String,
    /// Its id or name in the Electron data.
    pub id: String,
    pub reason: String,
}

impl ImportReport {
    pub fn new(source: &Path, target: &Path) -> Self {
        Self { source: source.to_path_buf(), target: target.to_path_buf(), ..Default::default() }
    }

    pub fn skip(&mut self, kind: &str, id: impl Into<String>, reason: impl Into<String>) {
        self.skipped.push(Skipped { kind: kind.into(), id: id.into(), reason: reason.into() });
    }

    pub fn error(&mut self, message: impl Into<String>) {
        self.errors.push(message.into());
    }

    /// Stamp the finish time and write `import-report.json` into the target.
    pub fn write(&mut self, started: std::time::Instant) -> std::io::Result<()> {
        self.duration_ms = started.elapsed().as_millis() as u64;
        self.finished_at = OffsetDateTime::now_utc()
            .format(&time::format_description::well_known::Rfc3339)
            .unwrap_or_default();
        let path = self.target.join("import-report.json");
        let json = serde_json::to_string_pretty(self).unwrap_or_else(|_| "{}".into());
        std::fs::write(path, json)
    }
}
