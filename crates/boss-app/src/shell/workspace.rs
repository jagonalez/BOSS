//! The root view: title bar, sidebar, and the tab area. Owns tabs and
//! selection in `AppState`; anything beyond the shell goes through
//! `ShellActions`.

use super::actions::{ShellActions, home_dir};
use super::settings::{ProbeState, SettingsPage};
use super::sidebar::{Sidebar, SidebarEvent};
use super::state::{AppState, Tab as OpenTab, TabContext, TabId, TabKind};
use super::update_banner::UpdateBanner;
use super::{
    ActivateTab, CloseTab, FocusSidebarFilter, NewChat, NewRoom, NewTerminal, NextTab, OpenSettings, PrevTab, ReopenTab,
    ToggleSidebar, apply_font_size, apply_theme,
};
use boss_core::store::Theme as ThemePref;
use boss_core::*;
use gpui::{
    App, Bounds, Context, Entity, FocusHandle, Focusable, IntoElement, MouseButton, ParentElement, Pixels, Point,
    Render, SharedString, Size, Styled, Subscription, Window, WindowBounds, WindowHandle, WindowKind, WindowOptions,
    div, prelude::*, px,
};
use gpui_component::{
    ActiveTheme, Icon, IconName, Root, Sizable, TitleBar, h_flex,
    button::{Button, ButtonVariants},
    resizable::{h_resizable, resizable_panel},
    tab::{Tab, TabBar},
    v_flex,
};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

/// Page a new browser tab opens with until the app supplies one.
pub const DEFAULT_BROWSER_URL: &str = "https://docs.rs/gpui";

/// Sidebar width bounds and default, in pixels. Same as the Electron app.
pub const SIDEBAR_MIN: f32 = 210.;
/// Widest the sidebar can be dragged.
pub const SIDEBAR_MAX: f32 = 480.;
/// Width the sidebar opens with.
pub const SIDEBAR_DEFAULT: f32 = 268.;

/// Where the window bounds are remembered, under the user data dir.
pub const WINDOW_FILE: &str = "window.json";

/// How long the window must sit still before its bounds are written. A
/// drag fires dozens of move events; only the last one reaches disk.
pub const BOUNDS_DEBOUNCE: Duration = Duration::from_millis(400);

/// The default window size before anything is saved.
pub const DEFAULT_WINDOW_SIZE: Size<Pixels> = Size { width: px(1280.), height: px(840.) };

/// Smallest window the user can drag to.
pub const MIN_WINDOW_SIZE: Size<Pixels> = Size { width: px(720.), height: px(480.) };

/// The remembered position, size and screen of the main window.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "snake_case")]
pub struct WindowState {
    /// Left edge, in the global coordinate space that spans every display.
    pub x: f32,
    /// Top edge.
    pub y: f32,
    /// Width in logical pixels.
    pub width: f32,
    /// Height in logical pixels.
    pub height: f32,
    /// The window was maximized (zoomed) when it was last saved.
    pub maximized: bool,
    /// The window was fullscreen when it was last saved.
    pub fullscreen: bool,
    /// UUID of the display it was on, so a saved position can be checked
    /// against the screens that are actually attached now.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display: Option<String>,
}

impl WindowState {
    /// Read the current window's bounds and screen.
    pub fn capture(window: &Window, cx: &App) -> Self {
        let (bounds, maximized, fullscreen) = match window.window_bounds() {
            WindowBounds::Windowed(b) => (b, false, false),
            WindowBounds::Maximized(b) => (b, true, false),
            WindowBounds::Fullscreen(b) => (b, false, true),
        };
        Self {
            x: bounds.origin.x.into(),
            y: bounds.origin.y.into(),
            width: bounds.size.width.into(),
            height: bounds.size.height.into(),
            maximized,
            fullscreen,
            display: window.display(cx).and_then(|d| d.uuid().ok()).map(|u| u.to_string()),
        }
    }

    /// The saved rectangle in GPUI terms.
    pub fn bounds(&self) -> Bounds<Pixels> {
        Bounds { origin: Point { x: px(self.x), y: px(self.y) }, size: Size { width: px(self.width), height: px(self.height) } }
    }

    /// Turn a saved state into the bounds to open with, or `None` when it
    /// cannot be trusted: a degenerate size, or a rectangle that no longer
    /// overlaps any attached display (the screen was unplugged).
    pub fn to_window_bounds(&self, displays: &[Bounds<Pixels>]) -> Option<WindowBounds> {
        let bounds = self.bounds();
        if bounds.size.width < MIN_WINDOW_SIZE.width || bounds.size.height < MIN_WINDOW_SIZE.height {
            return None;
        }
        if !displays.iter().any(|d| visibly_overlaps(&bounds, d)) {
            return None;
        }
        Some(if self.fullscreen {
            WindowBounds::Fullscreen(bounds)
        } else if self.maximized {
            WindowBounds::Maximized(bounds)
        } else {
            WindowBounds::Windowed(bounds)
        })
    }
}

/// Is enough of `window` on `display` that the user could grab its title
/// bar? A sliver poking onto a screen is as good as off-screen.
pub fn visibly_overlaps(window: &Bounds<Pixels>, display: &Bounds<Pixels>) -> bool {
    let overlap = |a0: f32, a1: f32, b0: f32, b1: f32| (a1.min(b1) - a0.max(b0)).max(0.0);
    let wx0: f32 = window.origin.x.into();
    let wy0: f32 = window.origin.y.into();
    let wx1 = wx0 + f32::from(window.size.width);
    let wy1 = wy0 + f32::from(window.size.height);
    let dx0: f32 = display.origin.x.into();
    let dy0: f32 = display.origin.y.into();
    let dx1 = dx0 + f32::from(display.size.width);
    let dy1 = dy0 + f32::from(display.size.height);
    // 120x40 is about a title bar: enough to drag the window back.
    overlap(wx0, wx1, dx0, dx1) >= 120.0 && overlap(wy0, wy1, dy0, dy1) >= 40.0
}

/// The `window.json` file in the user data dir.
pub fn window_file() -> boss_core::store::JsonFile {
    boss_core::store::JsonFile::in_dir(None, WINDOW_FILE)
}

/// A tab being dragged along the tab bar.
#[derive(Clone, Debug)]
pub struct TabDrag {
    /// Index the tab started at.
    pub from: usize,
    title: SharedString,
}

impl Render for TabDrag {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .px_2()
            .py_1()
            .rounded(cx.theme().radius)
            .bg(cx.theme().tab_active)
            .text_color(cx.theme().tab_active_foreground)
            .text_sm()
            .shadow_md()
            .child(self.title.clone())
    }
}

/// The root view.
pub struct Workspace {
    state: Entity<AppState>,
    actions: Arc<dyn ShellActions>,
    sidebar: Entity<Sidebar>,
    settings_page: Entity<SettingsPage>,
    probe_state: Entity<ProbeState>,
    /// The "a newer BOSS exists" bar. Hidden until the app offers a release.
    update_banner: Entity<UpdateBanner>,
    focus_handle: FocusHandle,
    last_title: String,
    /// The pending debounced write of `window.json`.
    save_bounds: Option<gpui::Task<()>>,
    _subscriptions: Vec<Subscription>,
}

impl Workspace {
    /// Build the workspace over shared state and the app's actions.
    pub fn new(state: Entity<AppState>, actions: Arc<dyn ShellActions>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let sidebar = cx.new(|cx| Sidebar::new(state.clone(), window, cx));
        // The app fills this entity from `Engine::probe` / `list_models`;
        // the settings page observes it. See `ProbeState`.
        let probe_state = cx.new(|_| ProbeState::new());
        let settings_page =
            cx.new(|cx| SettingsPage::new(state.clone(), probe_state.clone(), actions.clone(), window, cx));

        let settings = state.read(cx).settings.clone();
        apply_theme(settings.theme, Some(window), cx);
        super::apply_fonts(&settings.typography, Some(window), cx);
        apply_font_size(settings.typography.reading_size, Some(window), cx);

        let update_banner = cx.new(|_| UpdateBanner::new());

        let appearance_state = state.clone();
        let subscriptions = vec![
            cx.observe(&state, |_, _, cx| cx.notify()),
            cx.observe(&update_banner, |_, _, cx| cx.notify()),
            cx.subscribe_in(&sidebar, window, Self::on_sidebar_event),
            cx.observe_window_bounds(window, Self::on_window_bounds_changed),
            window.observe_window_appearance(move |window, cx| {
                if appearance_state.read(cx).settings.theme == ThemePref::System {
                    apply_theme(ThemePref::System, Some(window), cx);
                }
            }),
        ];

        Self {
            state,
            actions,
            sidebar,
            settings_page,
            probe_state,
            update_banner,
            focus_handle: cx.focus_handle(),
            last_title: String::new(),
            save_bounds: None,
            _subscriptions: subscriptions,
        }
    }

    /// The window moved or was resized. Writing on every event would hit
    /// disk dozens of times per drag, so the last position after
    /// [`BOUNDS_DEBOUNCE`] of quiet is the one that lands.
    fn on_window_bounds_changed(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let state = WindowState::capture(window, cx);
        self.save_bounds = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(BOUNDS_DEBOUNCE).await;
            cx.background_executor()
                .spawn(async move {
                    if let Err(err) = window_file().save(&state) {
                        tracing::warn!(%err, "could not save window bounds");
                    }
                })
                .await;
            let _ = this.update(cx, |this, _| this.save_bounds = None);
        }));
    }

    /// The shared state.
    pub fn state(&self) -> &Entity<AppState> {
        &self.state
    }

    /// The sidebar view.
    pub fn sidebar(&self) -> &Entity<Sidebar> {
        &self.sidebar
    }

    /// The settings view (mounted when the settings tab is active).
    pub fn settings_page(&self) -> &Entity<SettingsPage> {
        &self.settings_page
    }

    /// Live engine probe and model results. `app.rs` updates this entity
    /// from the tokio runtime and the settings page redraws itself.
    pub fn probe_state(&self) -> &Entity<ProbeState> {
        &self.probe_state
    }

    /// The update bar. `app.rs` offers a release into it and drives its
    /// stages; the workspace only mounts it.
    pub fn update_banner(&self) -> &Entity<UpdateBanner> {
        &self.update_banner
    }

    fn mutate(&self, cx: &mut Context<Self>, f: impl FnOnce(&mut AppState)) {
        self.state.update(cx, |s, cx| {
            f(s);
            cx.notify();
        });
    }

    fn on_sidebar_event(&mut self, _: &Entity<Sidebar>, event: &SidebarEvent, _window: &mut Window, cx: &mut Context<Self>) {
        match event.clone() {
            SidebarEvent::OpenThread(id) => self.open_thread(id, cx),
            SidebarEvent::NewChat { project, engine } => self.actions.new_chat(project.as_ref(), engine, cx),
            SidebarEvent::NewRoom { project, shape } => self.actions.new_room(project.as_ref(), shape, cx),
            SidebarEvent::Archive(id) => {
                self.mutate(cx, |s| {
                    s.archive_thread(&id);
                });
                self.actions.archive_thread(&id, cx);
            }
            SidebarEvent::Unarchive(id) => self.mutate(cx, |s| {
                s.set_archived(&id, false);
            }),
            SidebarEvent::Rename(id, title) => {
                self.mutate(cx, |s| {
                    s.rename_thread(&id, &title);
                });
                self.actions.rename_thread(&id, &title, cx);
            }
            SidebarEvent::AddProject => self.actions.open_project_picker(cx),
        }
    }

    // ---- tab operations ----------------------------------------------

    /// Open or focus a thread's tab and tell the app.
    pub fn open_thread(&mut self, thread: ThreadId, cx: &mut Context<Self>) {
        let opened = self.state.update(cx, |s, cx| {
            let ix = s.open_thread(thread.clone());
            cx.notify();
            ix.is_some()
        });
        if opened {
            self.actions.open_thread(&thread, cx);
        }
    }

    /// Open or focus the settings tab.
    pub fn open_settings(&mut self, cx: &mut Context<Self>) {
        self.mutate(cx, |s| {
            s.open_tab(TabKind::Settings);
        });
        self.actions.open_settings(cx);
    }

    /// Open a terminal tab with no recorded origin ("Scratch").
    pub fn open_terminal(&mut self, cwd: PathBuf, cx: &mut Context<Self>) {
        self.open_terminal_in(cwd, TabContext::none(), cx);
    }

    /// Open a terminal tab and remember which project and thread it came
    /// from, so the strip above it can say what it belongs to.
    pub fn open_terminal_in(&mut self, cwd: PathBuf, context: TabContext, cx: &mut Context<Self>) {
        let id = self.state.update(cx, |s, cx| {
            let ix = s.open_tab_with_context(TabKind::Terminal { cwd: cwd.clone() }, context);
            cx.notify();
            s.tabs[ix].id
        });
        self.actions.new_terminal(&cwd, id, cx);
    }

    /// Open a browser tab.
    pub fn open_browser(&mut self, url: String, cx: &mut Context<Self>) {
        self.open_browser_in(url, TabContext::none(), cx);
    }

    /// Open a browser tab and remember where it came from.
    pub fn open_browser_in(&mut self, url: String, context: TabContext, cx: &mut Context<Self>) {
        let id = self.state.update(cx, |s, cx| {
            let ix = s.open_tab_with_context(TabKind::Browser { url: url.clone() }, context);
            cx.notify();
            s.tabs[ix].id
        });
        self.actions.new_browser(&url, id, cx);
    }

    /// Where a new terminal should open and what it belongs to: the active
    /// thread's working directory when there is one, else the current
    /// project's root, else the home directory.
    fn terminal_target(&self, cx: &App) -> (PathBuf, TabContext) {
        let state = self.state.read(cx);
        if let Some(thread) = state.selected_thread.as_ref().and_then(|id| state.thread(id)) {
            let context = TabContext { project: thread.project_id.clone(), thread: Some(thread.id.clone()) };
            return (thread.cwd.clone(), context);
        }
        match state.current_project() {
            Some(project) => (project.root.clone(), TabContext::project(project.id.clone())),
            None => (home_dir(), TabContext::none()),
        }
    }

    /// Close tab `ix`. The app is told so it can drop the shell or page
    /// behind it rather than leaving a child process running unseen.
    pub fn close_tab(&mut self, ix: usize, cx: &mut Context<Self>) {
        let closed = self.state.update(cx, |s, cx| {
            let tab = s.close_tab(ix);
            cx.notify();
            tab
        });
        if let Some(tab) = closed {
            self.actions.close_tab(tab.id, cx);
        }
    }

    /// Make tab `ix` active.
    pub fn activate_tab(&mut self, ix: usize, cx: &mut Context<Self>) {
        self.mutate(cx, |s| s.activate_tab(ix));
    }

    /// Reorder a tab.
    pub fn move_tab(&mut self, from: usize, to: usize, cx: &mut Context<Self>) {
        self.mutate(cx, |s| s.move_tab(from, to));
    }

    /// Show or hide the sidebar.
    pub fn toggle_sidebar(&mut self, cx: &mut Context<Self>) {
        self.mutate(cx, AppState::toggle_sidebar);
    }

    // ---- key-bound actions -------------------------------------------

    fn on_new_chat(&mut self, _: &NewChat, _: &mut Window, cx: &mut Context<Self>) {
        let (project, engine) = {
            let s = self.state.read(cx);
            (s.current_project().map(|p| p.id.clone()), s.settings.default_engine)
        };
        // With no project the chat is a scratch chat; the shortcut works
        // from the first launch.
        self.actions.new_chat(project.as_ref(), engine, cx);
    }

    fn on_new_room(&mut self, _: &NewRoom, _: &mut Window, cx: &mut Context<Self>) {
        let project = self.state.read(cx).current_project().map(|p| p.id.clone());
        self.actions.new_room(project.as_ref(), RoomShape::Direct, cx);
    }

    fn on_new_terminal(&mut self, _: &NewTerminal, _: &mut Window, cx: &mut Context<Self>) {
        let (cwd, context) = self.terminal_target(cx);
        self.open_terminal_in(cwd, context, cx);
    }

    fn on_close_tab(&mut self, _: &CloseTab, _: &mut Window, cx: &mut Context<Self>) {
        if let Some(ix) = self.state.read(cx).active_tab {
            self.close_tab(ix, cx);
        }
    }

    fn on_open_settings(&mut self, _: &OpenSettings, _: &mut Window, cx: &mut Context<Self>) {
        self.open_settings(cx);
    }

    fn on_next_tab(&mut self, _: &NextTab, _: &mut Window, cx: &mut Context<Self>) {
        self.mutate(cx, AppState::next_tab);
    }

    fn on_prev_tab(&mut self, _: &PrevTab, _: &mut Window, cx: &mut Context<Self>) {
        self.mutate(cx, AppState::prev_tab);
    }

    fn on_activate_tab(&mut self, action: &ActivateTab, _: &mut Window, cx: &mut Context<Self>) {
        self.activate_tab(action.0, cx);
    }

    fn on_toggle_sidebar(&mut self, _: &ToggleSidebar, _: &mut Window, cx: &mut Context<Self>) {
        self.toggle_sidebar(cx);
    }

    /// Cmd+Shift+T: bring back the tab that was closed last. A thread tab
    /// also needs its pane rebuilt, so the app is told as if the thread had
    /// been picked in the sidebar.
    fn on_reopen_tab(&mut self, _: &ReopenTab, _: &mut Window, cx: &mut Context<Self>) {
        let reopened = self.state.update(cx, |s, cx| {
            let kind = s.reopen_closed_tab()?;
            cx.notify();
            // The tab the reopen just made or focused is the active one.
            let id = s.active_tab().map(|t| t.id)?;
            Some((kind, id))
        });
        match reopened {
            Some((TabKind::Thread(id), _)) => self.actions.open_thread(&id, cx),
            Some((TabKind::Terminal { cwd }, tab)) => self.actions.new_terminal(&cwd, tab, cx),
            Some((TabKind::Browser { url }, tab)) => self.actions.new_browser(&url, tab, cx),
            Some((TabKind::Settings, _)) => self.actions.open_settings(cx),
            None => {}
        }
    }

    /// Cmd+K: put the caret in the sidebar's filter box, opening the
    /// sidebar first if it is hidden.
    fn on_focus_sidebar_filter(&mut self, _: &FocusSidebarFilter, window: &mut Window, cx: &mut Context<Self>) {
        if self.state.read(cx).sidebar_collapsed {
            self.mutate(cx, AppState::toggle_sidebar);
        }
        self.sidebar.update(cx, |sidebar, cx| sidebar.focus_search(window, cx));
    }

    // ---- rendering ---------------------------------------------------

    fn render_title_bar(&self, title: &str, sidebar_collapsed: bool, cx: &mut Context<Self>) -> impl IntoElement {
        let toggle_icon = if sidebar_collapsed { IconName::PanelLeftOpen } else { IconName::PanelLeftClose };
        TitleBar::new()
            .child(
                h_flex()
                    .items_center()
                    .gap_2()
                    .child(
                        Button::new("toggle-sidebar")
                            .icon(toggle_icon)
                            .ghost()
                            .xsmall()
                            .tooltip("Toggle sidebar (⌘B)")
                            .on_click(cx.listener(|this, _, _, cx| this.toggle_sidebar(cx))),
                    )
                    .child(div().text_sm().font_weight(gpui::FontWeight::MEDIUM).truncate().child(title.to_owned())),
            )
            .child(
                h_flex()
                    .flex_1()
                    .items_center()
                    .justify_end()
                    .px_2()
                    .gap_1()
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .child(
                        Button::new("tb-terminal")
                            .icon(IconName::SquareTerminal)
                            .ghost()
                            .xsmall()
                            .tooltip("New terminal (⌘T)")
                            .on_click(cx.listener(|this, _, window, cx| this.on_new_terminal(&NewTerminal, window, cx))),
                    )
                    .child(
                        Button::new("tb-browser")
                            .icon(IconName::Globe)
                            .ghost()
                            .xsmall()
                            .tooltip("New browser tab")
                            .on_click(cx.listener(|this, _, _, cx| this.open_browser(DEFAULT_BROWSER_URL.into(), cx))),
                    )
                    .child(
                        Button::new("tb-settings")
                            .icon(IconName::Settings)
                            .ghost()
                            .xsmall()
                            .tooltip("Settings (⌘,)")
                            .on_click(cx.listener(|this, _, _, cx| this.open_settings(cx))),
                    ),
            )
    }

    fn tab_icon(kind: &TabKind, state: &AppState) -> IconName {
        match kind {
            TabKind::Thread(id) => match state.thread(id).map(|t| &t.kind) {
                Some(ThreadKind::Room { .. }) => IconName::Network,
                _ => IconName::Bot,
            },
            TabKind::Terminal { .. } => IconName::SquareTerminal,
            TabKind::Browser { .. } => IconName::Globe,
            TabKind::Settings => IconName::Settings,
        }
    }

    fn render_tab(&self, ix: usize, tab: &OpenTab, state: &AppState, cx: &mut Context<Self>) -> Tab {
        let title: SharedString = state.tab_title(tab).into();
        let drag = TabDrag { from: ix, title: title.clone() };
        let busy = matches!(&tab.kind, TabKind::Thread(id) if state.is_busy(id));
        let icon = Icon::new(Self::tab_icon(&tab.kind, state)).xsmall();
        let icon = if busy { icon.text_color(cx.theme().success) } else { icon };
        Tab::new()
            .label(title)
            .icon(icon)
            .suffix(
                Button::new(("close-tab", tab.id.0 as usize))
                    .icon(IconName::Close)
                    .ghost()
                    .xsmall()
                    .compact()
                    .on_click(cx.listener(move |this, _, _, cx| {
                        cx.stop_propagation();
                        this.close_tab(ix, cx);
                    })),
            )
            .on_drag(drag, |drag, _, _, cx| cx.new(|_| drag.clone()))
            .drag_over::<TabDrag>(|style, _, _, cx| style.bg(cx.theme().accent))
            .on_drop(cx.listener(move |this, drag: &TabDrag, _, cx| this.move_tab(drag.from, ix, cx)))
    }

    fn render_tab_bar(&self, state: &AppState, cx: &mut Context<Self>) -> impl IntoElement {
        let tabs: Vec<Tab> = state.tabs.iter().enumerate().map(|(ix, tab)| self.render_tab(ix, tab, state, cx)).collect();
        let mut bar = TabBar::new("tabs")
            .children(tabs)
            .on_click(cx.listener(|this, ix: &usize, _, cx| this.activate_tab(*ix, cx)))
            .last_empty_space(
                h_flex().h_full().items_center().px_1().child(
                    Button::new("tab-new")
                        .icon(IconName::Plus)
                        .ghost()
                        .xsmall()
                        .tooltip("New chat (⌘N)")
                        .on_click(cx.listener(|this, _, window, cx| this.on_new_chat(&NewChat, window, cx))),
                ),
            );
        if let Some(ix) = state.active_tab {
            bar = bar.selected_index(ix);
        }
        div()
            .w_full()
            .flex_shrink_0()
            .border_b_1()
            .border_color(cx.theme().border)
            .bg(cx.theme().tab_bar)
            .child(bar)
    }

    fn render_placeholder(title: impl Into<SharedString>, lines: Vec<SharedString>, cx: &App) -> impl IntoElement {
        // The empty state is quiet: a heading at reading weight over the
        // canvas, hints below it in the faint voice. `.empty-state` gave it
        // room rather than a border.
        v_flex()
            .size_full()
            .items_center()
            .justify_center()
            .gap_1p5()
            .bg(cx.theme().background)
            .text_color(cx.theme().muted_foreground)
            .child(
                div()
                    .text_xl()
                    .font_weight(gpui::FontWeight::SEMIBOLD)
                    .text_color(cx.theme().foreground)
                    .child(title.into()),
            )
            .children(lines.into_iter().map(|line| div().text_sm().child(line)))
    }

    /// The thin strip above a terminal or browser pane that says what the
    /// tab belongs to. Terminals name their project and path; browsers name
    /// the page, its URL, and the id agents drive it by.
    fn render_tab_header(&self, tab: &OpenTab, state: &AppState, cx: &mut Context<Self>) -> Option<gpui::AnyElement> {
        let (heading, detail) = state.tab_context_lines(tab)?;
        let icon = Self::tab_icon(&tab.kind, state);
        let exited = tab.terminal.as_ref().and_then(|t| t.exited);
        let tab_id = tab.id;
        Some(
            h_flex()
                .w_full()
                .flex_shrink_0()
                .items_center()
                .gap_2()
                .px_3()
                .py_1()
                .border_b_1()
                .border_color(cx.theme().border)
                .bg(cx.theme().secondary)
                .text_xs()
                .child(Icon::new(icon).xsmall().text_color(cx.theme().muted_foreground))
                .child(div().flex_shrink_0().font_weight(gpui::FontWeight::MEDIUM).truncate().child(heading))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .truncate()
                        .text_color(cx.theme().muted_foreground)
                        .child(detail),
                )
                .when_some(exited, |this, code| {
                    this.child(
                        Button::new(("terminal-restart", tab_id.0 as usize))
                            .label(format!("Shell exited ({code}) · Reopen"))
                            .xsmall()
                            .primary()
                            .on_click(cx.listener(move |this, _, _, cx| this.restart_terminal(tab_id, cx))),
                    )
                })
                .into_any_element(),
        )
    }

    /// Bring a terminal tab back after its shell exited. Also bound to Enter
    /// inside the dead terminal, so the habit of pressing Return works.
    pub fn restart_terminal(&mut self, tab: TabId, cx: &mut Context<Self>) {
        self.state.update(cx, |s, cx| {
            s.set_terminal_exited(tab, None);
            cx.notify();
        });
        self.actions.restart_terminal(tab, cx);
    }

    fn render_content(&self, state: &AppState, cx: &mut Context<Self>) -> gpui::AnyElement {
        let Some(tab) = state.active_tab() else {
            return Self::render_placeholder(
                "Nothing open",
                vec!["Pick a thread in the sidebar".into(), "⌘N new chat · ⌘⇧N new room · ⌘T terminal · ⌘, settings".into()],
                cx,
            )
            .into_any_element();
        };
        let header = self.render_tab_header(tab, state, cx);
        if let Some(view) = cx.try_global::<crate::app::TabViews>().and_then(|v| v.views.get(&tab.id).cloned()) {
            return v_flex()
                .size_full()
                .children(header)
                .child(div().flex_1().min_h_0().w_full().child(view))
                .into_any_element();
        }
        match &tab.kind {
            TabKind::Thread(id) => {
                let title = state.thread(id).map(|t| t.title.clone()).unwrap_or_else(|| "Thread".into());
                let seats: Vec<String> = state
                    .participants_of(id)
                    .iter()
                    .map(|p| match &p.model {
                        Some(m) => format!("{} · {} ({m})", p.name, p.engine.label()),
                        None => format!("{} · {}", p.name, p.engine.label()),
                    })
                    .collect();
                let mut lines: Vec<SharedString> = vec![seats.join("   ").into()];
                if state.is_busy(id) {
                    lines.push("Working…".into());
                }
                lines.push("ThreadPane goes here".into());
                Self::render_placeholder(title, lines, cx).into_any_element()
            }
            TabKind::Terminal { cwd } => {
                // TODO(terminal): mount boss_terminal's view for `cwd` here.
                Self::render_placeholder("Terminal", vec![cwd.display().to_string().into(), "Terminal goes here".into()], cx)
                    .into_any_element()
            }
            TabKind::Browser { url } => {
                // TODO(browser): mount boss_browser's view for `url` here.
                Self::render_placeholder("Browser", vec![url.clone().into(), "Browser goes here".into()], cx).into_any_element()
            }
            TabKind::Settings => self.settings_page.clone().into_any_element(),
        }
    }
}

impl Focusable for Workspace {
    fn focus_handle(&self, _cx: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

impl Render for Workspace {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let state = self.state.read(cx).clone();
        let title = state.window_title();
        if title != self.last_title {
            window.set_window_title(&title);
            self.last_title = title.clone();
        }

        let center = v_flex()
            .flex_1()
            .min_w_0()
            .h_full()
            .bg(cx.theme().background)
            .child(self.render_tab_bar(&state, cx))
            .child(div().flex_1().min_h_0().w_full().child(self.render_content(&state, cx)));

        v_flex()
            .id("workspace")
            .key_context("Workspace")
            .track_focus(&self.focus_handle)
            .on_action(cx.listener(Self::on_new_chat))
            .on_action(cx.listener(Self::on_new_room))
            .on_action(cx.listener(Self::on_new_terminal))
            .on_action(cx.listener(Self::on_close_tab))
            .on_action(cx.listener(Self::on_open_settings))
            .on_action(cx.listener(Self::on_next_tab))
            .on_action(cx.listener(Self::on_prev_tab))
            .on_action(cx.listener(Self::on_activate_tab))
            .on_action(cx.listener(Self::on_toggle_sidebar))
            .on_action(cx.listener(Self::on_reopen_tab))
            .on_action(cx.listener(Self::on_focus_sidebar_filter))
            .size_full()
            .child(self.render_title_bar(&title, state.sidebar_collapsed, cx))
            .when(self.update_banner.read(cx).is_visible(), |this| this.child(self.update_banner.clone()))
            .child(
                div().flex_1().min_h_0().w_full().child(
                h_resizable("workspace-split")
                    .child(
                        resizable_panel()
                            .size(px(SIDEBAR_DEFAULT))
                            .size_range(px(SIDEBAR_MIN)..px(SIDEBAR_MAX))
                            .visible(!state.sidebar_collapsed)
                            .child(self.sidebar.clone()),
                    )
                    .child(center.into_any_element()),
                ),
            )
    }
}

/// The bounds to open with: what `window.json` remembers when it still
/// lands on an attached display, otherwise a centred default.
pub fn restored_or_default_bounds(cx: &mut App) -> WindowBounds {
    let displays: Vec<Bounds<Pixels>> = cx.displays().iter().map(|d| d.bounds()).collect();
    let saved = match window_file().load::<WindowState>() {
        Ok(saved) => saved,
        Err(err) => {
            tracing::warn!(%err, "window.json could not be read; using the default bounds");
            None
        }
    };
    if let Some(bounds) = saved.and_then(|s| s.to_window_bounds(&displays)) {
        return bounds;
    }
    let mut window_size = DEFAULT_WINDOW_SIZE;
    if let Some(display) = cx.primary_display() {
        let display_size = display.bounds().size;
        window_size.width = window_size.width.min(display_size.width * 0.9);
        window_size.height = window_size.height.min(display_size.height * 0.9);
    }
    WindowBounds::Windowed(Bounds::centered(None, window_size, cx))
}

/// Open the main window with a workspace over `state`.
pub fn open_main_window(
    state: Entity<AppState>,
    actions: Arc<dyn ShellActions>,
    cx: &mut App,
) -> anyhow::Result<WindowHandle<Root>> {
    open_main_window_with_workspace(state, actions, cx).map(|(w, _)| w)
}

/// Like `open_main_window`, but also hands back the `Workspace` entity so
/// the app can reach the settings page and probe state.
pub fn open_main_window_with_workspace(
    state: Entity<AppState>,
    actions: Arc<dyn ShellActions>,
    cx: &mut App,
) -> anyhow::Result<(WindowHandle<Root>, Entity<Workspace>)> {
    let options = WindowOptions {
        window_bounds: Some(restored_or_default_bounds(cx)),
        window_min_size: Some(MIN_WINDOW_SIZE),
        kind: WindowKind::Normal,
        ..TitleBar::window_options()
    };
    let title = state.read(cx).window_title();
    let slot: std::rc::Rc<std::cell::RefCell<Option<Entity<Workspace>>>> = Default::default();
    let slot_in = slot.clone();
    let window = cx.open_window(options, move |window, cx| {
        let workspace = cx.new(|cx| Workspace::new(state, actions, window, cx));
        let focus = workspace.focus_handle(cx);
        window.defer(cx, move |window, cx| {
            if window.focused(cx).is_none() {
                focus.focus(window, cx);
            }
        });
        *slot_in.borrow_mut() = Some(workspace.clone());
        cx.new(|cx| Root::new(workspace, window, cx))
    })?;
    window.update(cx, |_, window, _| {
        window.activate_window();
        window.set_window_title(&title);
    })?;
    let workspace = slot.borrow_mut().take().expect("workspace was created with the window");
    Ok((window, workspace))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shell::NoopActions;
    use gpui::TestAppContext;

    fn display(x: f32, y: f32, w: f32, h: f32) -> Bounds<Pixels> {
        Bounds { origin: Point { x: px(x), y: px(y) }, size: Size { width: px(w), height: px(h) } }
    }

    fn saved(x: f32, y: f32, w: f32, h: f32) -> WindowState {
        WindowState { x, y, width: w, height: h, ..WindowState::default() }
    }

    #[test]
    fn saved_bounds_on_an_attached_display_are_restored() {
        let displays = [display(0., 0., 1920., 1080.)];
        let state = saved(100., 80., 1280., 840.);
        assert_eq!(
            state.to_window_bounds(&displays),
            Some(WindowBounds::Windowed(state.bounds()))
        );
        // Maximized and fullscreen carry their restore size through.
        let max = WindowState { maximized: true, ..state.clone() };
        assert_eq!(max.to_window_bounds(&displays), Some(WindowBounds::Maximized(state.bounds())));
        let full = WindowState { fullscreen: true, ..state.clone() };
        assert_eq!(full.to_window_bounds(&displays), Some(WindowBounds::Fullscreen(state.bounds())));
        // Fullscreen wins if both are somehow set.
        let both = WindowState { fullscreen: true, maximized: true, ..state };
        assert_eq!(both.to_window_bounds(&displays), Some(WindowBounds::Fullscreen(both.bounds())));
    }

    #[test]
    fn off_screen_and_degenerate_bounds_fall_back_to_the_default() {
        let displays = [display(0., 0., 1920., 1080.)];
        // The second monitor was unplugged.
        assert_eq!(saved(2400., 100., 1280., 840.).to_window_bounds(&displays), None);
        // Dragged nearly off the bottom: not enough title bar left to grab.
        assert_eq!(saved(200., 1070., 1280., 840.).to_window_bounds(&displays), None);
        // Smaller than the window can legally be.
        assert_eq!(saved(0., 0., 400., 300.).to_window_bounds(&displays), None);
        // No displays at all.
        assert_eq!(saved(0., 0., 1280., 840.).to_window_bounds(&[]), None);
        // A default (all zeroes) file is never trusted.
        assert_eq!(WindowState::default().to_window_bounds(&displays), None);
    }

    #[test]
    fn a_window_spanning_two_displays_still_restores() {
        let displays = [display(0., 0., 1920., 1080.), display(1920., 0., 1920., 1080.)];
        // Mostly on the right-hand screen.
        let state = saved(1800., 100., 1280., 840.);
        assert!(state.to_window_bounds(&displays).is_some());
    }

    #[test]
    fn window_state_round_trips_through_json() {
        let state = WindowState {
            x: 12.5,
            y: -40.0,
            width: 1400.0,
            height: 900.0,
            maximized: true,
            fullscreen: false,
            display: Some("D5F0F5A0-0000-0000-0000-000000000000".into()),
        };
        let json = serde_json::to_string(&state).unwrap();
        assert_eq!(serde_json::from_str::<WindowState>(&json).unwrap(), state);
        // Missing fields default, so an older or hand-edited file loads.
        let partial: WindowState = serde_json::from_str(r#"{"x":10,"y":20}"#).unwrap();
        assert_eq!((partial.x, partial.y, partial.width), (10.0, 20.0, 0.0));
        assert_eq!(partial.display, None);
    }

    #[test]
    fn overlap_needs_a_grabbable_title_bar() {
        let screen = display(0., 0., 1000., 800.);
        // 200px of the window is on screen: fine.
        assert!(visibly_overlaps(&display(-1080., 100., 1280., 840.), &screen));
        // Only 100px across: not enough to grab.
        assert!(!visibly_overlaps(&display(-1180., 100., 1280., 840.), &screen));
        // Plenty across but only 20px down.
        assert!(!visibly_overlaps(&display(100., 780., 1280., 840.), &screen));
    }

    fn workspace(cx: &mut TestAppContext) -> (Entity<Workspace>, &mut gpui::VisualTestContext) {
        cx.update(gpui_component::init);
        cx.update(crate::shell::init);
        let state = cx.new(|_| AppState::demo());
        let actions: Arc<dyn ShellActions> = Arc::new(NoopActions);
        let (workspace, cx) = cx.add_window_view(move |window, cx| Workspace::new(state, actions, window, cx));
        cx.update(|window, cx| window.draw(cx).clear(cx));
        (workspace, cx)
    }

    #[gpui::test]
    fn renders_demo_state_and_titles_the_window(cx: &mut TestAppContext) {
        let (workspace, cx) = workspace(cx);
        workspace.read_with(cx, |w, cx| {
            let s = w.state().read(cx);
            assert_eq!(s.tabs.len(), 2);
            assert_eq!(w.last_title, s.window_title());
            assert!(w.last_title.starts_with("Port the sidebar"));
        });
    }

    #[gpui::test]
    fn sidebar_selection_opens_a_tab_and_actions_close_it(cx: &mut TestAppContext) {
        let (workspace, cx) = workspace(cx);
        let sidebar = workspace.read_with(cx, |w, _| w.sidebar().clone());
        sidebar.update(cx, |_, cx| cx.emit(SidebarEvent::OpenThread(ThreadId::from_raw("thr_demo_7"))));
        cx.update(|window, cx| window.draw(cx).clear(cx));
        workspace.read_with(cx, |w, cx| {
            let s = w.state().read(cx);
            assert_eq!(s.tabs.len(), 3);
            assert_eq!(s.selected_thread, Some(ThreadId::from_raw("thr_demo_7")));
            assert!(w.last_title.starts_with("Add rate limits"));
        });

        workspace.update_in(cx, |w, window, cx| {
            w.on_open_settings(&OpenSettings, window, cx);
            w.on_open_settings(&OpenSettings, window, cx);
        });
        workspace.read_with(cx, |w, cx| {
            let s = w.state().read(cx);
            assert_eq!(s.tabs.len(), 4);
            assert_eq!(s.active_tab().map(|t| t.kind.clone()), Some(TabKind::Settings));
        });
        cx.update(|window, cx| window.draw(cx).clear(cx));

        workspace.update_in(cx, |w, window, cx| {
            w.on_close_tab(&CloseTab, window, cx);
            w.on_activate_tab(&ActivateTab(0), window, cx);
            w.on_next_tab(&NextTab, window, cx);
            w.on_toggle_sidebar(&ToggleSidebar, window, cx);
        });
        cx.update(|window, cx| window.draw(cx).clear(cx));
        workspace.read_with(cx, |w, cx| {
            let s = w.state().read(cx);
            assert_eq!(s.tabs.len(), 3);
            assert_eq!(s.active_tab, Some(1));
            assert!(s.sidebar_collapsed);
        });
    }

    #[gpui::test]
    fn cmd_shift_t_reopens_the_last_closed_tab(cx: &mut TestAppContext) {
        let (workspace, cx) = workspace(cx);
        workspace.update_in(cx, |w, window, cx| {
            w.on_open_settings(&OpenSettings, window, cx);
            w.on_close_tab(&CloseTab, window, cx);
        });
        cx.update(|window, cx| window.draw(cx).clear(cx));
        workspace.read_with(cx, |w, cx| {
            let s = w.state().read(cx);
            assert_eq!(s.tabs.len(), 2);
            assert_eq!(s.last_closed_tab(), Some(&TabKind::Settings));
        });

        workspace.update_in(cx, |w, window, cx| w.on_reopen_tab(&ReopenTab, window, cx));
        cx.update(|window, cx| window.draw(cx).clear(cx));
        workspace.read_with(cx, |w, cx| {
            let s = w.state().read(cx);
            assert_eq!(s.tabs.len(), 3);
            assert_eq!(s.active_tab().map(|t| t.kind.clone()), Some(TabKind::Settings));
            assert_eq!(s.closed_tab_count(), 0);
        });

        // Nothing left to reopen: the shortcut is a no-op, not a panic.
        workspace.update_in(cx, |w, window, cx| w.on_reopen_tab(&ReopenTab, window, cx));
        workspace.read_with(cx, |w, cx| assert_eq!(w.state().read(cx).tabs.len(), 3));
    }

    #[gpui::test]
    fn cmd_k_opens_the_sidebar_and_focuses_its_filter(cx: &mut TestAppContext) {
        let (workspace, cx) = workspace(cx);
        workspace.update_in(cx, |w, window, cx| w.on_toggle_sidebar(&ToggleSidebar, window, cx));
        workspace.read_with(cx, |w, cx| assert!(w.state().read(cx).sidebar_collapsed));

        workspace.update_in(cx, |w, window, cx| w.on_focus_sidebar_filter(&FocusSidebarFilter, window, cx));
        cx.update(|window, cx| window.draw(cx).clear(cx));
        workspace.read_with(cx, |w, cx| assert!(!w.state().read(cx).sidebar_collapsed, "the sidebar reopened"));
    }

    #[gpui::test]
    fn probe_results_reach_the_settings_page(cx: &mut TestAppContext) {
        let (workspace, cx) = workspace(cx);
        let probes = workspace.read_with(cx, |w, _| w.probe_state().clone());
        probes.update(cx, |state, cx| {
            state.set_probe(
                EngineId::Claude,
                boss_core::EngineProbe { installed: true, version: Some("2.1.0".into()), auth_error: None },
                cx,
            );
            state.set_models(
                EngineId::Claude,
                vec![boss_core::ModelInfo { id: "claude-opus-5".into(), label: "Opus 5".into(), provider: None }],
                cx,
            );
        });
        cx.update(|window, cx| window.draw(cx).clear(cx));
        probes.read_with(cx, |state, _| {
            assert_eq!(crate::shell::settings::probe_label(state.probe(EngineId::Claude), false), "Ready · 2.1.0");
            assert_eq!(state.models(EngineId::Claude).map(<[_]>::len), Some(1));
            assert!(state.probe(EngineId::Codex).is_none(), "only Claude was probed");
        });
    }

    #[gpui::test]
    fn archive_from_sidebar_closes_the_thread_tab(cx: &mut TestAppContext) {
        let (workspace, cx) = workspace(cx);
        let sidebar = workspace.read_with(cx, |w, _| w.sidebar().clone());
        sidebar.update(cx, |_, cx| cx.emit(SidebarEvent::Archive(ThreadId::from_raw("thr_demo_1"))));
        sidebar.update(cx, |_, cx| cx.emit(SidebarEvent::Rename(ThreadId::from_raw("thr_demo_2"), "Scroll".into())));
        cx.update(|window, cx| window.draw(cx).clear(cx));
        workspace.read_with(cx, |w, cx| {
            let s = w.state().read(cx);
            assert_eq!(s.tabs.len(), 1);
            assert!(s.thread(&ThreadId::from_raw("thr_demo_1")).unwrap().archived);
            assert_eq!(s.thread(&ThreadId::from_raw("thr_demo_2")).unwrap().title, "Scroll");
            assert_eq!(w.last_title, "Scroll — BOSS");
        });
    }

    /// Records what the shell asked the app for, so the tests can check the
    /// cwd and tab a terminal was opened with.
    #[derive(Default)]
    struct Recorder {
        terminals: std::sync::Mutex<Vec<(PathBuf, super::super::state::TabId)>>,
        closed: std::sync::Mutex<Vec<super::super::state::TabId>>,
        restarted: std::sync::Mutex<Vec<super::super::state::TabId>>,
    }

    impl ShellActions for Recorder {
        fn open_thread(&self, _: &ThreadId, _: &mut App) {}
        fn new_chat(&self, _: Option<&ProjectId>, _: EngineId, _: &mut App) {}
        fn new_room(&self, _: Option<&ProjectId>, _: RoomShape, _: &mut App) {}
        fn archive_thread(&self, _: &ThreadId, _: &mut App) {}
        fn rename_thread(&self, _: &ThreadId, _: &str, _: &mut App) {}
        fn new_terminal(&self, cwd: &std::path::Path, tab: super::super::state::TabId, _: &mut App) {
            self.terminals.lock().unwrap().push((cwd.to_path_buf(), tab));
        }
        fn new_browser(&self, _: &str, _: super::super::state::TabId, _: &mut App) {}
        fn restart_terminal(&self, tab: super::super::state::TabId, _: &mut App) {
            self.restarted.lock().unwrap().push(tab);
        }
        fn close_tab(&self, tab: super::super::state::TabId, _: &mut App) {
            self.closed.lock().unwrap().push(tab);
        }
        fn open_settings(&self, _: &mut App) {}
        fn open_project_picker(&self, _: &mut App) {}
        fn set_theme(&self, _: ThemePref, _: &mut App) {}
        fn save_settings(&self, _: &boss_core::store::Settings, _: &mut App) {}
        fn probe_engines(&self, _: &mut App) {}
    }

    fn recording_workspace(cx: &mut TestAppContext) -> (Entity<Workspace>, Arc<Recorder>, &mut gpui::VisualTestContext) {
        cx.update(gpui_component::init);
        cx.update(crate::shell::init);
        let state = cx.new(|_| AppState::demo());
        let recorder = Arc::new(Recorder::default());
        let actions: Arc<dyn ShellActions> = recorder.clone();
        let (workspace, cx) = cx.add_window_view(move |window, cx| Workspace::new(state, actions, window, cx));
        cx.update(|window, cx| window.draw(cx).clear(cx));
        (workspace, recorder, cx)
    }

    #[gpui::test]
    fn a_new_terminal_opens_where_the_active_thread_is(cx: &mut TestAppContext) {
        let (workspace, recorder, cx) = recording_workspace(cx);
        // The demo opens with thread 1 selected, rooted in the boss project.
        workspace.update_in(cx, |w, window, cx| w.on_new_terminal(&NewTerminal, window, cx));
        cx.update(|window, cx| window.draw(cx).clear(cx));

        let (cwd, tab) = recorder.terminals.lock().unwrap()[0].clone();
        assert_eq!(cwd, PathBuf::from("/Users/demo/dev/BOSS"), "the thread's cwd, not the process's");
        workspace.read_with(cx, |w, cx| {
            let s = w.state().read(cx);
            let opened = s.tab(tab).expect("the shell made the tab before asking the app");
            assert_eq!(opened.context.thread, Some(ThreadId::from_raw("thr_demo_1")));
            assert_eq!(opened.context.project.as_ref().map(|p| p.0.as_str()), Some("prj_demo_boss"));
            // The strip says what it belongs to.
            let (heading, detail) = s.tab_context_lines(opened).unwrap();
            assert!(heading.starts_with("boss · Port the sidebar"), "{heading}");
            assert_eq!(detail, "/Users/demo/dev/BOSS");
        });
    }

    #[gpui::test]
    fn a_terminal_with_no_thread_falls_back_to_the_project_then_home(cx: &mut TestAppContext) {
        let (workspace, recorder, cx) = recording_workspace(cx);
        workspace.update(cx, |w, cx| {
            w.state.update(cx, |s, cx| {
                s.select_thread(None);
                cx.notify();
            })
        });
        workspace.update_in(cx, |w, window, cx| w.on_new_terminal(&NewTerminal, window, cx));
        cx.update(|window, cx| window.draw(cx).clear(cx));
        assert_eq!(recorder.terminals.lock().unwrap()[0].0, PathBuf::from("/Users/demo/dev/BOSS"), "the first project");

        // No projects either: the home directory, never the process's cwd.
        workspace.update(cx, |w, cx| {
            w.state.update(cx, |s, cx| {
                s.projects.clear();
                s.threads.clear();
                cx.notify();
            })
        });
        workspace.update_in(cx, |w, window, cx| w.on_new_terminal(&NewTerminal, window, cx));
        cx.update(|window, cx| window.draw(cx).clear(cx));
        let (cwd, tab) = recorder.terminals.lock().unwrap()[1].clone();
        assert_eq!(cwd, home_dir());
        workspace.read_with(cx, |w, cx| {
            let s = w.state().read(cx);
            assert_eq!(s.tab_context_lines(s.tab(tab).unwrap()).unwrap().0, "Scratch");
        });
    }

    #[gpui::test]
    fn closing_a_tab_tells_the_app_so_the_shell_behind_it_dies(cx: &mut TestAppContext) {
        let (workspace, recorder, cx) = recording_workspace(cx);
        workspace.update_in(cx, |w, window, cx| w.on_new_terminal(&NewTerminal, window, cx));
        cx.update(|window, cx| window.draw(cx).clear(cx));
        let tab = recorder.terminals.lock().unwrap()[0].1;

        workspace.update_in(cx, |w, window, cx| w.on_close_tab(&CloseTab, window, cx));
        cx.update(|window, cx| window.draw(cx).clear(cx));
        assert_eq!(recorder.closed.lock().unwrap().as_slice(), [tab]);
        workspace.read_with(cx, |w, cx| assert!(w.state().read(cx).tab(tab).is_none()));
    }

    #[gpui::test]
    fn an_exited_shell_can_be_reopened_from_the_strip(cx: &mut TestAppContext) {
        let (workspace, recorder, cx) = recording_workspace(cx);
        workspace.update_in(cx, |w, window, cx| w.on_new_terminal(&NewTerminal, window, cx));
        cx.update(|window, cx| window.draw(cx).clear(cx));
        let tab = recorder.terminals.lock().unwrap()[0].1;

        workspace.update(cx, |w, cx| {
            w.state.update(cx, |s, cx| {
                s.set_terminal_title(tab, "zsh".into());
                s.set_terminal_exited(tab, Some(1));
                cx.notify();
            })
        });
        cx.update(|window, cx| window.draw(cx).clear(cx));
        workspace.read_with(cx, |w, cx| {
            let s = w.state().read(cx);
            assert_eq!(s.tab_title(s.tab(tab).unwrap()), "zsh (exited)");
        });

        workspace.update(cx, |w, cx| w.restart_terminal(tab, cx));
        cx.update(|window, cx| window.draw(cx).clear(cx));
        assert_eq!(recorder.restarted.lock().unwrap().as_slice(), [tab]);
        workspace.read_with(cx, |w, cx| {
            let s = w.state().read(cx);
            assert_eq!(s.tab_title(s.tab(tab).unwrap()), "zsh", "the exited marker is gone");
        });
    }

    #[gpui::test]
    fn the_update_banner_only_appears_once_a_release_is_offered(cx: &mut TestAppContext) {
        let (workspace, cx) = workspace(cx);
        let banner = workspace.read_with(cx, |w, _| w.update_banner().clone());
        banner.read_with(cx, |b, _| assert!(!b.is_visible()));
        banner.update(cx, |b, cx| b.offer("9.9.9".into(), cx));
        cx.update(|window, cx| window.draw(cx).clear(cx));
        banner.read_with(cx, |b, _| {
            assert!(b.is_visible());
            assert_eq!(
                super::super::update_banner::stage_label("9.9.9", b.stage()),
                "BOSS 9.9.9 is available."
            );
        });
    }
}
