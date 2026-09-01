//! What the shell asks the application to do. The shell owns tabs,
//! selection and the sidebar; everything that touches engines, disk or
//! other windows goes through this trait so the app can wire it later.

use boss_core::store::{Settings, Theme};
use boss_core::*;
use gpui::App;
use std::path::PathBuf;

/// Requests from the shell to the app. Called on the main thread with the
/// GPUI `App`, so an implementation can update entities directly and hand
/// long work to the tokio runtime (`crate::shell::tokio_handle`).
pub trait ShellActions {
    /// The user picked a thread; load its transcript.
    fn open_thread(&self, thread: &ThreadId, cx: &mut App);
    /// Start a chat with one agent in `project`.
    fn new_chat(&self, project: &ProjectId, engine: EngineId, cx: &mut App);
    /// Start a room in `project` with the given shape.
    fn new_room(&self, project: &ProjectId, shape: RoomShape, cx: &mut App);
    /// Archive a thread. The shell already closed its tab.
    fn archive_thread(&self, thread: &ThreadId, cx: &mut App);
    /// Rename a thread. The shell already shows the new title.
    fn rename_thread(&self, thread: &ThreadId, title: &str, cx: &mut App);
    /// Open a terminal in `cwd`.
    fn new_terminal(&self, cwd: &std::path::Path, cx: &mut App);
    /// Open a browser page.
    fn new_browser(&self, url: &str, cx: &mut App);
    /// The settings tab was opened.
    fn open_settings(&self, cx: &mut App);
    /// Show the OS folder picker to add a project.
    fn open_project_picker(&self, cx: &mut App);
    /// The theme preference changed. The shell already re-themed the window.
    fn set_theme(&self, theme: Theme, cx: &mut App);
    /// Any other setting changed; persist the snapshot.
    fn save_settings(&self, settings: &Settings, cx: &mut App);
    /// Re-check which engines are installed and logged in.
    fn probe_engines(&self, cx: &mut App);
}

/// Logs every request and does nothing. For the demo and for tests.
#[derive(Debug, Default, Clone, Copy)]
pub struct NoopActions;

impl ShellActions for NoopActions {
    fn open_thread(&self, thread: &ThreadId, _cx: &mut App) {
        tracing::info!(%thread, "open_thread");
    }
    fn new_chat(&self, project: &ProjectId, engine: EngineId, _cx: &mut App) {
        tracing::info!(%project, engine = engine.as_str(), "new_chat");
    }
    fn new_room(&self, project: &ProjectId, shape: RoomShape, _cx: &mut App) {
        tracing::info!(%project, ?shape, "new_room");
    }
    fn archive_thread(&self, thread: &ThreadId, _cx: &mut App) {
        tracing::info!(%thread, "archive_thread");
    }
    fn rename_thread(&self, thread: &ThreadId, title: &str, _cx: &mut App) {
        tracing::info!(%thread, title, "rename_thread");
    }
    fn new_terminal(&self, cwd: &std::path::Path, _cx: &mut App) {
        tracing::info!(cwd = %cwd.display(), "new_terminal");
    }
    fn new_browser(&self, url: &str, _cx: &mut App) {
        tracing::info!(url, "new_browser");
    }
    fn open_settings(&self, _cx: &mut App) {
        tracing::info!("open_settings");
    }
    fn open_project_picker(&self, _cx: &mut App) {
        tracing::info!("open_project_picker");
    }
    fn set_theme(&self, theme: Theme, _cx: &mut App) {
        tracing::info!(?theme, "set_theme");
    }
    fn save_settings(&self, _settings: &Settings, _cx: &mut App) {
        tracing::info!("save_settings");
    }
    fn probe_engines(&self, _cx: &mut App) {
        tracing::info!("probe_engines");
    }
}

/// Where a terminal opens when nothing better is known.
pub fn default_terminal_cwd(project: Option<&Project>) -> PathBuf {
    project.map(|p| p.root.clone()).or_else(|| std::env::current_dir().ok()).unwrap_or_else(|| PathBuf::from("/"))
}
