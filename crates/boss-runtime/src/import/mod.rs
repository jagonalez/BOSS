//! One-time import of the Electron app's data into the native folder.
//!
//! The native app keeps its data in `BOSS-native`; the Electron app's sits
//! in the sibling `BOSS`. [`import`] moves a user's history across once,
//! when the native folder has no `projects.json` and the Electron folder is
//! there. `Runtime::import_from_electron` runs the same thing on demand.
//!
//! Two rules hold throughout. The source is opened **read-only** — the
//! SQLite handle uses `?mode=ro`, and nothing is ever written into the
//! Electron folder. And the import is **idempotent**: threads and messages
//! are upserted under their Electron ids, and a file is only copied when
//! the target does not already have one, so a second run changes nothing.

mod convert;
mod electron;
mod report;
mod sources;

pub use report::{Counts, ImportReport, Skipped};
pub use sources::default_electron_dir;

use anyhow::{Context, Result};
use boss_core::store::{SettingsStore, StateStore, TranscriptStore};
use std::path::Path;

/// Files the native stores read byte-for-byte, so copying is the import.
/// Copied only when the target has no file of that name, which keeps a
/// second run from clobbering work done in the native app.
const COPY_AS_IS: &[&str] = &[
    // Relay pairing: the native relay client is byte-compatible with these.
    "remote-access.json",
    "remote-access-key.json",
    // Tailscale web access for the phone PWA.
    "mobile-access.json",
    // Worktrees, reports, workflows and automations: the native stores for
    // these are byte-compatible with the Electron files.
    "worktrees.json",
    "reports.json",
    "workflows.json",
    "workflow-runs.json",
    "workflow-subscriptions.json",
    "automations.json",
    "automation-runs.json",
];

/// Should [`import`] run? Only when the native folder has never been set up
/// (no `projects.json`) and there is an Electron folder to read.
pub fn should_import(native: &Path, electron: &Path) -> bool {
    !native.join("projects.json").exists() && electron.join("state.json").exists()
}

/// Import `electron` into `native`, writing `import-report.json` into
/// `native`. Safe to call twice: the second run finds everything present
/// and reports zero new rows.
pub fn import(native: &Path, electron: &Path) -> Result<ImportReport> {
    let started = std::time::Instant::now();
    std::fs::create_dir_all(native).with_context(|| format!("create {}", native.display()))?;
    let mut rep = ImportReport::new(electron, native);

    let state = StateStore::open(Some(native)).context("open native state store")?;
    let settings = SettingsStore::open(Some(native)).context("open native settings")?;
    let transcripts = TranscriptStore::open_in(Some(native)).context("open native transcripts")?;

    // Projects and threads first: a message needs a thread to belong to.
    let projects = sources::import_projects(electron, &state, &mut rep);
    let threads = sources::import_threads(electron, &state, &projects, &mut rep);

    sources::import_rooms(electron, &state, &threads, &mut rep);
    sources::import_mcp_connections(electron, &settings, &mut rep);

    // Transcripts: the sqlite database, then the sessions that only ever
    // lived in claude-threads.json.
    // Order matters: sqlite first, because where the two sources hold the
    // same message the sqlite row has more of it. `stored` carries that
    // fact forward so the JSON pass only fills gaps.
    let stored = sources::import_transcripts(electron, &transcripts, &threads, &mut rep);
    sources::import_claude_threads(electron, &transcripts, &threads, &stored, &mut rep);

    for name in COPY_AS_IS {
        sources::copy_if_absent(electron, native, name, &mut rep);
    }

    rep.write(started).context("write import-report.json")?;
    Ok(rep)
}

#[cfg(test)]
mod tests;
