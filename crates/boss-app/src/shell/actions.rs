//! What the shell asks the application to do. The shell owns tabs,
//! selection and the sidebar; everything that touches engines, disk or
//! other windows goes through this trait so the app can wire it later.

use super::state::TabId;
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
    /// Start a chat with one agent in `project`, or a scratch chat with no
    /// project when `project` is `None`.
    fn new_chat(&self, project: Option<&ProjectId>, engine: EngineId, cx: &mut App);
    /// Start a room in `project` with the given shape, or a scratch room.
    fn new_room(&self, project: Option<&ProjectId>, shape: RoomShape, cx: &mut App);
    /// Archive a thread. The shell already closed its tab.
    fn archive_thread(&self, thread: &ThreadId, cx: &mut App);
    /// Rename a thread. The shell already shows the new title.
    fn rename_thread(&self, thread: &ThreadId, title: &str, cx: &mut App);
    /// Open a terminal in `cwd`. The shell has already made the tab; `tab`
    /// is the one the terminal view belongs to and the one whose title and
    /// exit state the app reports back.
    fn new_terminal(&self, cwd: &std::path::Path, tab: TabId, cx: &mut App);
    /// Open a browser page in the tab the shell just made.
    fn new_browser(&self, url: &str, tab: TabId, cx: &mut App);
    /// Start a fresh shell in a terminal tab whose last one exited.
    fn restart_terminal(&self, tab: TabId, cx: &mut App);
    /// A tab was closed. The app drops its view, which kills the shell or
    /// closes the page behind it.
    fn close_tab(&self, tab: TabId, cx: &mut App);
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
    fn new_chat(&self, project: Option<&ProjectId>, engine: EngineId, _cx: &mut App) {
        tracing::info!(?project, engine = engine.as_str(), "new_chat");
    }
    fn new_room(&self, project: Option<&ProjectId>, shape: RoomShape, _cx: &mut App) {
        tracing::info!(?project, ?shape, "new_room");
    }
    fn archive_thread(&self, thread: &ThreadId, _cx: &mut App) {
        tracing::info!(%thread, "archive_thread");
    }
    fn rename_thread(&self, thread: &ThreadId, title: &str, _cx: &mut App) {
        tracing::info!(%thread, title, "rename_thread");
    }
    fn new_terminal(&self, cwd: &std::path::Path, tab: TabId, _cx: &mut App) {
        tracing::info!(cwd = %cwd.display(), tab = tab.0, "new_terminal");
    }
    fn new_browser(&self, url: &str, tab: TabId, _cx: &mut App) {
        tracing::info!(url, tab = tab.0, "new_browser");
    }
    fn restart_terminal(&self, tab: TabId, _cx: &mut App) {
        tracing::info!(tab = tab.0, "restart_terminal");
    }
    fn close_tab(&self, tab: TabId, _cx: &mut App) {
        tracing::info!(tab = tab.0, "close_tab");
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

/// Where a terminal opens when there is no project and no thread to root it
/// in: the user's home directory, as a shell opened from the Dock would.
///
/// `current_dir()` is deliberately not used — for a bundled app that is `/`,
/// which is a confusing place to land.
pub fn home_dir() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .unwrap_or_else(|| PathBuf::from("/"))
}
