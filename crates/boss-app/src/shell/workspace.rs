//! The root view: title bar, sidebar, and the tab area. Owns tabs and
//! selection in `AppState`; anything beyond the shell goes through
//! `ShellActions`.

use super::actions::{ShellActions, default_terminal_cwd};
use super::settings::SettingsPage;
use super::sidebar::{Sidebar, SidebarEvent};
use super::state::{AppState, Tab as OpenTab, TabKind};
use super::{
    ActivateTab, CloseTab, NewChat, NewRoom, NewTerminal, NextTab, OpenSettings, PrevTab, ToggleSidebar, apply_font_size,
    apply_theme,
};
use boss_core::store::Theme as ThemePref;
use boss_core::*;
use gpui::{
    App, Bounds, Context, Entity, FocusHandle, Focusable, IntoElement, MouseButton, ParentElement, Render, SharedString,
    Styled, Subscription, Window, WindowBounds, WindowHandle, WindowKind, WindowOptions, div, prelude::*, px, size,
};
use gpui_component::{
    ActiveTheme, Icon, IconName, Root, Sizable, TitleBar, h_flex,
    button::{Button, ButtonVariants},
    resizable::{h_resizable, resizable_panel},
    tab::{Tab, TabBar},
    v_flex,
};
use std::path::PathBuf;
use std::sync::Arc;

/// Page a new browser tab opens with until the app supplies one.
pub const DEFAULT_BROWSER_URL: &str = "https://docs.rs/gpui";

/// Sidebar width bounds and default, in pixels. Same as the Electron app.
pub const SIDEBAR_MIN: f32 = 210.;
/// Widest the sidebar can be dragged.
pub const SIDEBAR_MAX: f32 = 480.;
/// Width the sidebar opens with.
pub const SIDEBAR_DEFAULT: f32 = 268.;

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
    focus_handle: FocusHandle,
    last_title: String,
    _subscriptions: Vec<Subscription>,
}

impl Workspace {
    /// Build the workspace over shared state and the app's actions.
    pub fn new(state: Entity<AppState>, actions: Arc<dyn ShellActions>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let sidebar = cx.new(|cx| Sidebar::new(state.clone(), window, cx));
        let settings_page = cx.new(|cx| SettingsPage::new(state.clone(), actions.clone(), window, cx));

        let settings = state.read(cx).settings.clone();
        apply_theme(settings.theme, Some(window), cx);
        apply_font_size(settings.typography.reading_size, Some(window), cx);

        let appearance_state = state.clone();
        let subscriptions = vec![
            cx.observe(&state, |_, _, cx| cx.notify()),
            cx.subscribe_in(&sidebar, window, Self::on_sidebar_event),
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
            focus_handle: cx.focus_handle(),
            last_title: String::new(),
            _subscriptions: subscriptions,
        }
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

    fn mutate(&self, cx: &mut Context<Self>, f: impl FnOnce(&mut AppState)) {
        self.state.update(cx, |s, cx| {
            f(s);
            cx.notify();
        });
    }

    fn on_sidebar_event(&mut self, _: &Entity<Sidebar>, event: &SidebarEvent, _window: &mut Window, cx: &mut Context<Self>) {
        match event.clone() {
            SidebarEvent::OpenThread(id) => self.open_thread(id, cx),
            SidebarEvent::NewChat { project, engine } => self.actions.new_chat(&project, engine, cx),
            SidebarEvent::NewRoom { project, shape } => self.actions.new_room(&project, shape, cx),
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

    /// Open a terminal tab.
    pub fn open_terminal(&mut self, cwd: PathBuf, cx: &mut Context<Self>) {
        self.mutate(cx, |s| {
            s.open_tab(TabKind::Terminal { cwd: cwd.clone() });
        });
        self.actions.new_terminal(&cwd, cx);
    }

    /// Open a browser tab.
    pub fn open_browser(&mut self, url: String, cx: &mut Context<Self>) {
        self.mutate(cx, |s| {
            s.open_tab(TabKind::Browser { url: url.clone() });
        });
        self.actions.new_browser(&url, cx);
    }

    /// Close tab `ix`.
    pub fn close_tab(&mut self, ix: usize, cx: &mut Context<Self>) {
        self.mutate(cx, |s| {
            s.close_tab(ix);
        });
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
        if let Some(project) = project {
            self.actions.new_chat(&project, engine, cx);
        }
    }

    fn on_new_room(&mut self, _: &NewRoom, _: &mut Window, cx: &mut Context<Self>) {
        let project = self.state.read(cx).current_project().map(|p| p.id.clone());
        if let Some(project) = project {
            self.actions.new_room(&project, RoomShape::Direct, cx);
        }
    }

    fn on_new_terminal(&mut self, _: &NewTerminal, _: &mut Window, cx: &mut Context<Self>) {
        let cwd = default_terminal_cwd(self.state.read(cx).current_project());
        self.open_terminal(cwd, cx);
    }

    fn on_close_tab(&mut self, _: &CloseTab, _: &mut Window, cx: &mut Context<Self>) {
        self.mutate(cx, |s| {
            s.close_active_tab();
        });
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
        div().w_full().flex_shrink_0().border_b_1().border_color(cx.theme().border).child(bar)
    }

    fn render_placeholder(title: impl Into<SharedString>, lines: Vec<SharedString>, cx: &App) -> impl IntoElement {
        v_flex()
            .size_full()
            .items_center()
            .justify_center()
            .gap_2()
            .text_color(cx.theme().muted_foreground)
            .child(div().text_lg().text_color(cx.theme().foreground).child(title.into()))
            .children(lines.into_iter().map(|line| div().text_sm().child(line)))
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
        if let Some(view) = cx.try_global::<crate::app::TabViews>().and_then(|v| v.views.get(&tab.id).cloned()) {
            return div().size_full().child(view).into_any_element();
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
            .size_full()
            .child(self.render_title_bar(&title, state.sidebar_collapsed, cx))
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

/// Open the main window with a workspace over `state`.
pub fn open_main_window(
    state: Entity<AppState>,
    actions: Arc<dyn ShellActions>,
    cx: &mut App,
) -> anyhow::Result<WindowHandle<Root>> {
    // TODO(lead): restore the last window bounds from disk here and save them on move/resize.
    let mut window_size = size(px(1280.), px(840.));
    if let Some(display) = cx.primary_display() {
        let display_size = display.bounds().size;
        window_size.width = window_size.width.min(display_size.width * 0.9);
        window_size.height = window_size.height.min(display_size.height * 0.9);
    }
    let bounds = Bounds::centered(None, window_size, cx);
    let options = WindowOptions {
        window_bounds: Some(WindowBounds::Windowed(bounds)),
        window_min_size: Some(size(px(720.), px(480.))),
        kind: WindowKind::Normal,
        ..TitleBar::window_options()
    };
    let title = state.read(cx).window_title();
    let window = cx.open_window(options, |window, cx| {
        let workspace = cx.new(|cx| Workspace::new(state, actions, window, cx));
        let focus = workspace.focus_handle(cx);
        window.defer(cx, move |window, cx| {
            if window.focused(cx).is_none() {
                focus.focus(window, cx);
            }
        });
        cx.new(|cx| Root::new(workspace, window, cx))
    })?;
    window.update(cx, |_, window, _| {
        window.activate_window();
        window.set_window_title(&title);
    })?;
    Ok(window)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shell::NoopActions;
    use gpui::TestAppContext;

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
}
