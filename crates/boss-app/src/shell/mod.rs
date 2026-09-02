//! The application shell: window, title bar, sidebar, tab area, settings.
//!
//! - [`AppState`] is the one entity every shell view reads.
//! - [`ShellActions`] is how the shell asks the app to do things.
//! - [`Workspace`] is the root view; [`open_main_window`] mounts it.

pub mod actions;
pub mod settings;
pub mod sidebar;
pub mod state;
pub mod workspace;

pub use actions::{NoopActions, ShellActions};
pub use settings::SettingsPage;
pub use sidebar::{Sidebar, SidebarEvent};
pub use state::{AppState, Tab, TabId, TabKind};
pub use workspace::{Workspace, open_main_window, open_main_window_with_workspace};

use boss_core::store::Theme as ThemePref;
use gpui::{App, KeyBinding, Window, px};
use gpui_component::{Theme, ThemeMode};
use std::sync::OnceLock;

gpui::actions!(
    boss,
    [
        /// Start a chat in the current project with the default engine.
        NewChat,
        /// Start a room in the current project.
        NewRoom,
        /// Open a terminal in the current project.
        NewTerminal,
        /// Close the active tab.
        CloseTab,
        /// Open the settings tab.
        OpenSettings,
        /// Activate the tab to the right.
        NextTab,
        /// Activate the tab to the left.
        PrevTab,
        /// Show or hide the sidebar.
        ToggleSidebar,
        /// Reopen the tab that was closed most recently.
        ReopenTab,
        /// Put the caret in the sidebar's filter box.
        FocusSidebarFilter,
    ]
);

/// Activate the tab at this zero-based index (Cmd+1 … Cmd+9).
#[derive(Clone, PartialEq, Eq, Debug, serde::Deserialize, gpui::Action)]
#[action(namespace = boss, no_json)]
pub struct ActivateTab(pub usize);

static RUNTIME: OnceLock<tokio::runtime::Runtime> = OnceLock::new();

/// The app's tokio runtime. Its worker threads start on first use and live
/// for the process; engines and the bus run here, never on the UI thread.
pub fn tokio_handle() -> tokio::runtime::Handle {
    RUNTIME
        .get_or_init(|| {
            tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .thread_name("boss-tokio")
                .build()
                .expect("tokio runtime")
        })
        .handle()
        .clone()
}

/// Register the shell's key bindings. Call once after `gpui_component::init`.
pub fn init(cx: &mut App) {
    let mut bindings = vec![
        KeyBinding::new("cmd-n", NewChat, None),
        KeyBinding::new("cmd-shift-n", NewRoom, None),
        KeyBinding::new("cmd-t", NewTerminal, None),
        KeyBinding::new("cmd-w", CloseTab, None),
        KeyBinding::new("cmd-,", OpenSettings, None),
        KeyBinding::new("cmd-b", ToggleSidebar, None),
        KeyBinding::new("cmd-shift-t", ReopenTab, None),
        KeyBinding::new("cmd-k", FocusSidebarFilter, None),
        KeyBinding::new("cmd-shift-]", NextTab, None),
        KeyBinding::new("cmd-shift-[", PrevTab, None),
        KeyBinding::new("ctrl-tab", NextTab, None),
        KeyBinding::new("ctrl-shift-tab", PrevTab, None),
        // Linux and Windows.
        KeyBinding::new("ctrl-n", NewChat, None),
        KeyBinding::new("ctrl-shift-n", NewRoom, None),
        KeyBinding::new("ctrl-w", CloseTab, None),
        KeyBinding::new("ctrl-,", OpenSettings, None),
        KeyBinding::new("ctrl-b", ToggleSidebar, None),
        KeyBinding::new("ctrl-shift-t", ReopenTab, None),
        KeyBinding::new("ctrl-k", FocusSidebarFilter, None),
    ];
    for n in 1..=9usize {
        bindings.push(KeyBinding::new(&format!("cmd-{n}"), ActivateTab(n - 1), None));
        bindings.push(KeyBinding::new(&format!("alt-{n}"), ActivateTab(n - 1), None));
    }
    cx.bind_keys(bindings);
}

/// Apply a theme preference to the gpui-component theme.
pub fn apply_theme(theme: ThemePref, window: Option<&mut Window>, cx: &mut App) {
    match theme {
        ThemePref::System => Theme::sync_system_appearance(window, cx),
        ThemePref::Light => Theme::change(ThemeMode::Light, window, cx),
        ThemePref::Dark => Theme::change(ThemeMode::Dark, window, cx),
    }
}

/// Apply the UI font size, in points, to the theme. The root view reads it
/// as the rem size, so everything scales with it.
pub fn apply_font_size(points: f32, window: Option<&mut Window>, cx: &mut App) {
    Theme::global_mut(cx).font_size = px(points);
    Theme::sync_base(cx);
    if let Some(window) = window {
        window.refresh();
    }
}

/// Short relative time: `now`, `5m`, `3h`, `2d`. Same scale the Electron
/// sidebar used.
pub fn time_ago(then: time::OffsetDateTime, now: time::OffsetDateTime) -> String {
    let secs = (now - then).whole_seconds().max(0);
    match secs {
        s if s < 60 => "now".into(),
        s if s < 3_600 => format!("{}m", s / 60),
        s if s < 86_400 => format!("{}h", s / 3_600),
        s => format!("{}d", s / 86_400),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use time::{Duration, OffsetDateTime};

    #[test]
    fn time_ago_scales() {
        let now = OffsetDateTime::now_utc();
        assert_eq!(time_ago(now, now), "now");
        assert_eq!(time_ago(now + Duration::minutes(5), now), "now");
        assert_eq!(time_ago(now - Duration::minutes(7), now), "7m");
        assert_eq!(time_ago(now - Duration::hours(5), now), "5h");
        assert_eq!(time_ago(now - Duration::days(3), now), "3d");
    }

    #[test]
    fn tokio_handle_runs_work() {
        let handle = tokio_handle();
        let n = handle.block_on(async { 40 + 2 });
        assert_eq!(n, 42);
        assert_eq!(tokio_handle().id(), handle.id());
    }
}
