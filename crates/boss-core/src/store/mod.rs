//! Persistence for BOSS: JSON files for small state, SQLite for transcripts,
//! the OS keychain for secrets.
//!
//! Every store here is synchronous and `Send + Sync`; callers wrap calls in
//! `spawn_blocking`. Files live under [`crate::paths::user_data_dir`] unless
//! a base directory is given, which is what tests do.

pub mod json;
pub mod reports;
pub mod secrets;
pub mod settings;
pub mod state;
pub mod transcript;

pub use json::JsonFile;
pub use reports::{AgentReportInput, AgentReportPatch, Report, ReportSource, ReportStore};
pub use secrets::{MemorySecrets, Secrets};
#[cfg(feature = "keyring")]
pub use secrets::KeyringSecrets;
pub use settings::{
    McpConnection, McpTransport, NotificationSettings, NotifyLevel, Presence, Settings, SettingsStore,
    TelegramSettings, Theme, Typography, UpdateChannel,
};
pub use state::StateStore;
pub use transcript::{SearchHit, TranscriptStore};

use std::path::PathBuf;

/// Anything a store can fail with.
#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    /// Reading, writing, or renaming a file failed.
    #[error("{path}: {source}")]
    Io {
        /// File the operation was on.
        path: PathBuf,
        /// The underlying error.
        #[source]
        source: std::io::Error,
    },
    /// A file exists but does not parse. Never treated as "first launch":
    /// starting empty and saving would make the damage permanent.
    #[error("{path}: invalid JSON: {source}")]
    Json {
        /// File that failed to parse.
        path: PathBuf,
        /// The underlying error.
        #[source]
        source: serde_json::Error,
    },
    /// A file was written by a newer BOSS than this one.
    #[error("{path}: version {found} is newer than supported {supported}")]
    Version {
        /// File with the unknown version.
        path: PathBuf,
        /// Version found in the file.
        found: u32,
        /// Highest version this build reads.
        supported: u32,
    },
    /// A value could not be serialized.
    #[error("serialize: {0}")]
    Serialize(#[from] serde_json::Error),
    /// The caller passed something a store refuses: text that is empty when
    /// it must not be, text past a limit, or a record it does not own. The
    /// message is written for the agent or the user who sees it.
    #[error("{0}")]
    Invalid(String),
    /// The transcript database failed.
    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),
    /// The secret store failed.
    #[error("secrets: {0}")]
    Secrets(String),
}

/// Result alias for store operations.
pub type Result<T> = std::result::Result<T, StoreError>;
