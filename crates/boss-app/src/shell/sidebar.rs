//! The left sidebar: projects with their threads, a filter box, and the
//! buttons that start work. Port of `src/renderer/src/components/Sidebar.tsx`,
//! trimmed to what the Rust app has today.

use super::state::AppState;
use super::time_ago;
use boss_core::*;
use gpui::{
    App, ClickEvent, Context, Entity, EventEmitter, FocusHandle, Focusable, MouseButton, Render, SharedString,
    Subscription, WeakEntity, Window, div, prelude::*, px,
};
use gpui_component::{
    ActiveTheme, Icon, IconName, Sizable, h_flex,
    button::{Button, ButtonVariants},
    input::{Input, InputEvent, InputState},
    menu::{ContextMenuExt, DropdownMenu, PopupMenu, PopupMenuItem},
    v_flex,
};
use std::collections::HashSet;
use time::OffsetDateTime;

/// What the sidebar asks the workspace to do. The workspace owns tabs and
/// talks to `ShellActions`; the sidebar only reads state and emits.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SidebarEvent {
    /// A thread row was clicked.
    OpenThread(ThreadId),
    /// "New chat" with an engine, in a project.
    NewChat {
        /// Project to start in.
        project: ProjectId,
        /// Engine to run.
        engine: EngineId,
    },
    /// "New room" with a shape, in a project.
    NewRoom {
        /// Project to start in.
        project: ProjectId,
        /// How the job runs.
        shape: RoomShape,
    },
    /// Context menu: archive.
    Archive(ThreadId),
    /// Context menu: restore an archived thread.
    Unarchive(ThreadId),
    /// Inline rename committed.
    Rename(ThreadId, String),
    /// "Add project" was clicked.
    AddProject,
}

/// One thread as the sidebar draws it.
#[derive(Clone, Debug, PartialEq)]
pub struct ThreadRow {
    /// The thread.
    pub thread: Thread,
    /// The engine, for chats. Rooms show a participant count instead.
    pub engine: Option<EngineId>,
    /// Seats in the room, BOSS included. Zero for chats.
    pub participants: usize,
    /// An agent is working.
    pub busy: bool,
    /// This is the selected thread.
    pub selected: bool,
}

/// A project header and the thread rows under it.
#[derive(Clone, Debug, PartialEq)]
pub struct ProjectSection {
    /// The project.
    pub project: Project,
    /// Threads shown, newest first. Empty when collapsed.
    pub rows: Vec<ThreadRow>,
    /// Threads that match, collapsed or not.
    pub total: usize,
    /// Whether the section is folded.
    pub collapsed: bool,
}

/// Does a thread match the filter box? Matches the title or the project
/// name, so "relay" finds every thread in that project.
pub fn matches(thread: &Thread, project_name: &str, query: &str) -> bool {
    let q = query.trim().to_lowercase();
    q.is_empty() || thread.title.to_lowercase().contains(&q) || project_name.to_lowercase().contains(&q)
}

fn row_for(state: &AppState, thread: &Thread) -> ThreadRow {
    let (engine, participants) = match &thread.kind {
        ThreadKind::Chat { engine } => (Some(*engine), 0),
        ThreadKind::Room { .. } => (None, state.participants_of(&thread.id).len()),
        ThreadKind::Assistant => (None, 0),
    };
    ThreadRow {
        thread: thread.clone(),
        engine,
        participants,
        busy: state.is_busy(&thread.id),
        selected: state.selected_thread.as_ref() == Some(&thread.id),
    }
}

fn newest_first(rows: &mut [ThreadRow]) {
    rows.sort_by(|a, b| b.thread.updated_at.cmp(&a.thread.updated_at).then_with(|| a.thread.title.cmp(&b.thread.title)));
}

/// Active threads grouped by project, in project order, newest first. A
/// non-empty query unfolds every section: search replaces drilling.
pub fn sections(state: &AppState, query: &str, collapsed: &HashSet<ProjectId>) -> Vec<ProjectSection> {
    let filtering = !query.trim().is_empty();
    state
        .projects
        .iter()
        .map(|project| {
            let mut rows: Vec<ThreadRow> = state
                .threads
                .iter()
                .filter(|t| t.project_id == project.id && !t.archived && matches(t, &project.name, query))
                .map(|t| row_for(state, t))
                .collect();
            newest_first(&mut rows);
            let total = rows.len();
            let is_collapsed = !filtering && collapsed.contains(&project.id);
            if is_collapsed {
                rows.clear();
            }
            ProjectSection { project: project.clone(), rows, total, collapsed: is_collapsed }
        })
        .collect()
}

/// Archived threads that match the query, newest first.
pub fn archived_rows(state: &AppState, query: &str) -> Vec<ThreadRow> {
    let mut rows: Vec<ThreadRow> = state
        .threads
        .iter()
        .filter(|t| t.archived)
        .filter(|t| {
            let name = state.project(&t.project_id).map(|p| p.name.as_str()).unwrap_or("");
            matches(t, name, query)
        })
        .map(|t| row_for(state, t))
        .collect();
    newest_first(&mut rows);
    rows
}

/// The user-facing name of a room shape.
pub fn shape_label(shape: RoomShape) -> &'static str {
    match shape {
        RoomShape::Direct => "Just do it",
        RoomShape::Reviewed => "Build and review",
        RoomShape::Full => "The full run",
    }
}

/// Every shape, in the order the picker lists them.
pub const SHAPES: [RoomShape; 3] = [RoomShape::Direct, RoomShape::Reviewed, RoomShape::Full];

/// The sidebar view.
pub struct Sidebar {
    state: Entity<AppState>,
    search: Entity<InputState>,
    rename_input: Entity<InputState>,
    query: String,
    collapsed: HashSet<ProjectId>,
    show_archived: bool,
    renaming: Option<ThreadId>,
    focus_handle: FocusHandle,
    _subscriptions: Vec<Subscription>,
}

impl EventEmitter<SidebarEvent> for Sidebar {}

impl Sidebar {
    /// Build the sidebar over shared state.
    pub fn new(state: Entity<AppState>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let search = cx.new(|cx| InputState::new(window, cx).placeholder("Filter"));
        let rename_input = cx.new(|cx| InputState::new(window, cx).placeholder("Thread title"));
        let subscriptions = vec![
            cx.observe(&state, |_, _, cx| cx.notify()),
            cx.subscribe_in(&search, window, |this, input, event: &InputEvent, _window, cx| {
                if let InputEvent::Change = event {
                    this.query = input.read(cx).value().to_string();
                    cx.notify();
                }
            }),
            cx.subscribe_in(&rename_input, window, |this, input, event: &InputEvent, window, cx| match event {
                InputEvent::PressEnter { .. } => {
                    let title = input.read(cx).value().to_string();
                    this.commit_rename(Some(title), window, cx);
                }
                InputEvent::Blur => this.commit_rename(None, window, cx),
                _ => {}
            }),
        ];
        Self {
            state,
            search,
            rename_input,
            query: String::new(),
            collapsed: HashSet::new(),
            show_archived: false,
            renaming: None,
            focus_handle: cx.focus_handle(),
            _subscriptions: subscriptions,
        }
    }

    /// The current filter text.
    pub fn query(&self) -> &str {
        &self.query
    }

    /// Which thread is being renamed inline, if any.
    pub fn renaming(&self) -> Option<&ThreadId> {
        self.renaming.as_ref()
    }

    /// Move keyboard focus to the filter box.
    pub fn focus_search(&self, window: &mut Window, cx: &mut Context<Self>) {
        self.search.read(cx).focus_handle(cx).focus(window, cx);
    }

    /// Fold or unfold a project section.
    pub fn toggle_project(&mut self, project: &ProjectId, cx: &mut Context<Self>) {
        if !self.collapsed.remove(project) {
            self.collapsed.insert(project.clone());
        }
        cx.notify();
    }

    fn current_project(&self, cx: &App) -> Option<ProjectId> {
        self.state.read(cx).current_project().map(|p| p.id.clone())
    }

    fn new_chat(&mut self, project: Option<ProjectId>, engine: EngineId, cx: &mut Context<Self>) {
        if let Some(project) = project.or_else(|| self.current_project(cx)) {
            cx.emit(SidebarEvent::NewChat { project, engine });
        }
    }

    fn new_room(&mut self, project: Option<ProjectId>, shape: RoomShape, cx: &mut Context<Self>) {
        if let Some(project) = project.or_else(|| self.current_project(cx)) {
            cx.emit(SidebarEvent::NewRoom { project, shape });
        }
    }

    /// Show the inline rename box on a thread row.
    pub fn begin_rename(&mut self, thread: &ThreadId, window: &mut Window, cx: &mut Context<Self>) {
        let Some(title) = self.state.read(cx).thread(thread).map(|t| t.title.clone()) else { return };
        self.renaming = Some(thread.clone());
        self.rename_input.update(cx, |input, cx| input.set_value(title, window, cx));
        // The context menu that asked for this is still closing; focus once it has.
        let input = self.rename_input.clone();
        cx.defer_in(window, move |_, window, cx| {
            input.read(cx).focus_handle(cx).focus(window, cx);
        });
        cx.notify();
    }

    /// End an inline rename. `Some(title)` commits; `None` (blur) commits
    /// only if the text changed, so an accidental blur loses nothing.
    pub fn commit_rename(&mut self, title: Option<String>, _window: &mut Window, cx: &mut Context<Self>) {
        let Some(thread) = self.renaming.take() else { return };
        let title = title.unwrap_or_else(|| self.rename_input.read(cx).value().to_string());
        let unchanged = self.state.read(cx).thread(&thread).is_some_and(|t| t.title == title);
        if !title.trim().is_empty() && !unchanged {
            cx.emit(SidebarEvent::Rename(thread, title.trim().to_owned()));
        }
        cx.notify();
    }

    fn engine_menu(weak: WeakEntity<Self>, project: Option<ProjectId>, mut menu: PopupMenu) -> PopupMenu {
        for engine in EngineId::ALL {
            let weak = weak.clone();
            let project = project.clone();
            menu = menu.item(PopupMenuItem::new(engine.label()).on_click(move |_, _, cx| {
                let _ = weak.update(cx, |this, cx| this.new_chat(project.clone(), engine, cx));
            }));
        }
        menu
    }

    fn shape_menu(weak: WeakEntity<Self>, project: Option<ProjectId>, mut menu: PopupMenu) -> PopupMenu {
        for shape in SHAPES {
            let weak = weak.clone();
            let project = project.clone();
            menu = menu.item(PopupMenuItem::new(shape_label(shape)).on_click(move |_, _, cx| {
                let _ = weak.update(cx, |this, cx| this.new_room(project.clone(), shape, cx));
            }));
        }
        menu
    }

    fn render_header(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let weak = cx.weak_entity();
        let weak_rooms = cx.weak_entity();
        v_flex()
            .gap_2()
            .px_3()
            .pt_2()
            .child(
                h_flex()
                    .items_center()
                    .justify_between()
                    .child(div().text_sm().font_weight(gpui::FontWeight::BOLD).child("BOSS"))
                    .child(
                        Button::new("add-project")
                            .icon(IconName::FolderOpen)
                            .ghost()
                            .xsmall()
                            .tooltip("Add project")
                            .on_click(cx.listener(|_, _, _, cx| cx.emit(SidebarEvent::AddProject))),
                    ),
            )
            .child(
                h_flex()
                    .gap_2()
                    .child(
                        Button::new("new-chat")
                            .icon(IconName::Bot)
                            .label("New chat")
                            .small()
                            .flex_1()
                            .dropdown_menu(move |menu, _, _| Self::engine_menu(weak.clone(), None, menu)),
                    )
                    .child(
                        Button::new("new-room")
                            .icon(IconName::Network)
                            .label("New room")
                            .small()
                            .flex_1()
                            .dropdown_menu(move |menu, _, _| Self::shape_menu(weak_rooms.clone(), None, menu)),
                    ),
            )
            .child(Input::new(&self.search).small().prefix(Icon::new(IconName::Search).xsmall()).cleanable(true))
    }

    fn render_project(&self, section: &ProjectSection, cx: &mut Context<Self>) -> impl IntoElement {
        let project_id = section.project.id.clone();
        let toggle_id = project_id.clone();
        let weak = cx.weak_entity();
        let chevron = if section.collapsed { IconName::ChevronRight } else { IconName::ChevronDown };
        let menu_project = project_id.clone();
        h_flex()
            .id(SharedString::from(format!("project-{project_id}")))
            .h_7()
            .px_1()
            .gap_1()
            .items_center()
            .rounded(cx.theme().radius)
            .cursor_pointer()
            .hover(|s| s.bg(cx.theme().sidebar_accent))
            .text_xs()
            .text_color(cx.theme().sidebar_foreground.opacity(0.75))
            .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| this.toggle_project(&toggle_id, cx)))
            .child(Icon::new(chevron).xsmall())
            .child(Icon::new(IconName::Folder).xsmall())
            .child(div().flex_1().truncate().font_weight(gpui::FontWeight::SEMIBOLD).child(section.project.name.clone()))
            .child(div().child(section.total.to_string()))
            .context_menu(move |menu, _, _| {
                let menu = menu.label("New chat");
                let menu = Self::engine_menu(weak.clone(), Some(menu_project.clone()), menu);
                let menu = menu.separator().label("New room");
                Self::shape_menu(weak.clone(), Some(menu_project.clone()), menu)
            })
    }

    fn render_thread(&self, row: &ThreadRow, now: OffsetDateTime, cx: &mut Context<Self>) -> impl IntoElement {
        let id = row.thread.id.clone();
        let is_room = matches!(row.thread.kind, ThreadKind::Room { .. });
        let archived = row.thread.archived;
        let renaming = self.renaming.as_ref() == Some(&id);
        let kind_icon = if is_room { IconName::Network } else { IconName::Bot };
        let badge: SharedString = match (row.engine, row.participants) {
            (Some(engine), _) => engine.as_str().into(),
            (None, n) if n > 0 => format!("{n} agents").into(),
            _ => "".into(),
        };
        let open_id = id.clone();
        let weak = cx.weak_entity();
        let menu_id = id.clone();

        h_flex()
            .id(SharedString::from(format!("thread-{id}")))
            .h_7()
            .pl_3()
            .pr_1()
            .gap_1p5()
            .items_center()
            .rounded(cx.theme().radius)
            .cursor_pointer()
            .text_sm()
            .when(row.selected, |s| s.bg(cx.theme().sidebar_accent).text_color(cx.theme().sidebar_accent_foreground))
            .when(!row.selected, |s| s.hover(|s| s.bg(cx.theme().sidebar_accent.opacity(0.6))))
            .when(archived, |s| s.text_color(cx.theme().muted_foreground))
            .on_click(cx.listener(move |_, _: &ClickEvent, _, cx| cx.emit(SidebarEvent::OpenThread(open_id.clone()))))
            .child(div().size(px(6.)).rounded_full().flex_shrink_0().when(row.busy, |d| d.bg(cx.theme().success)))
            .child(Icon::new(kind_icon).xsmall().text_color(cx.theme().muted_foreground))
            .map(|this| {
                if renaming {
                    this.child(
                        div()
                            .flex_1()
                            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                            .child(Input::new(&self.rename_input).xsmall()),
                    )
                } else {
                    this.child(div().flex_1().truncate().child(row.thread.title.clone()))
                }
            })
            .when(!badge.is_empty(), |this| {
                this.child(
                    div()
                        .px_1()
                        .rounded(cx.theme().radius)
                        .bg(cx.theme().muted)
                        .text_xs()
                        .text_color(cx.theme().muted_foreground)
                        .flex_shrink_0()
                        .child(badge),
                )
            })
            .child(
                div()
                    .w(px(24.))
                    .text_xs()
                    .text_color(cx.theme().muted_foreground)
                    .text_right()
                    .flex_shrink_0()
                    .child(time_ago(row.thread.updated_at, now)),
            )
            .context_menu(move |menu, _, _| {
                let rename_id = menu_id.clone();
                let rename_weak = weak.clone();
                let archive_id = menu_id.clone();
                let archive_weak = weak.clone();
                menu.item(PopupMenuItem::new("Rename…").on_click(move |_, window, cx| {
                    let _ = rename_weak.update(cx, |this, cx| this.begin_rename(&rename_id, window, cx));
                }))
                .separator()
                .item(PopupMenuItem::new(if archived { "Restore" } else { "Archive" }).on_click(move |_, _, cx| {
                    let _ = archive_weak.update(cx, |_, cx| {
                        cx.emit(if archived {
                            SidebarEvent::Unarchive(archive_id.clone())
                        } else {
                            SidebarEvent::Archive(archive_id.clone())
                        })
                    });
                }))
            })
    }

    fn render_empty(&self, text: &'static str, cx: &Context<Self>) -> impl IntoElement {
        div().px_3().py_2().text_xs().text_color(cx.theme().muted_foreground).child(text)
    }
}

impl Focusable for Sidebar {
    fn focus_handle(&self, _cx: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

impl Render for Sidebar {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let now = OffsetDateTime::now_utc();
        let (sections, archived) = {
            let state = self.state.read(cx);
            (sections(state, &self.query, &self.collapsed), archived_rows(state, &self.query))
        };
        let filtering = !self.query.trim().is_empty();
        let shown: usize = sections.iter().map(|s| s.total).sum();
        let no_projects = sections.is_empty();
        let show_archived = self.show_archived || filtering;

        let mut list = v_flex().id("sidebar-list").flex_1().min_h_0().overflow_y_scroll().px_2().pt_1().gap_0p5();
        for section in &sections {
            list = list.child(self.render_project(section, cx));
            for row in &section.rows {
                list = list.child(self.render_thread(row, now, cx));
            }
        }
        if no_projects {
            list = list.child(self.render_empty("No projects yet. Add one to start.", cx));
        } else if shown == 0 {
            list = list.child(self.render_empty(if filtering { "Nothing matches" } else { "No threads yet" }, cx));
        }
        if !archived.is_empty() {
            let toggle = h_flex()
                .id("archived-toggle")
                .h_7()
                .px_1()
                .mt_2()
                .gap_1()
                .items_center()
                .cursor_pointer()
                .text_xs()
                .text_color(cx.theme().muted_foreground)
                .on_click(cx.listener(|this, _: &ClickEvent, _, cx| {
                    this.show_archived = !this.show_archived;
                    cx.notify();
                }))
                .child(Icon::new(if show_archived { IconName::ChevronDown } else { IconName::ChevronRight }).xsmall())
                .child(div().flex_1().child("Archived"))
                .child(div().child(archived.len().to_string()));
            list = list.child(toggle);
            if show_archived {
                for row in &archived {
                    list = list.child(self.render_thread(row, now, cx));
                }
            }
        }

        v_flex()
            .id("sidebar")
            .track_focus(&self.focus_handle)
            .size_full()
            .bg(cx.theme().sidebar)
            .text_color(cx.theme().sidebar_foreground)
            .border_r_1()
            .border_color(cx.theme().sidebar_border)
            .child(self.render_header(cx))
            .child(list)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn demo() -> AppState {
        AppState::demo()
    }

    #[test]
    fn sections_follow_project_order_and_sort_newest_first() {
        let s = demo();
        let sections = sections(&s, "", &HashSet::new());
        assert_eq!(sections.len(), 2);
        assert_eq!(sections[0].project.name, "boss");
        // Archived thread 5 is hidden; 4 remain.
        assert_eq!(sections[0].total, 4);
        let times: Vec<_> = sections[0].rows.iter().map(|r| r.thread.updated_at).collect();
        let mut sorted = times.clone();
        sorted.sort_by(|a, b| b.cmp(a));
        assert_eq!(times, sorted);
        assert_eq!(sections[0].rows[0].thread.title, "Port the sidebar to GPUI");
        assert!(sections[0].rows[0].busy);
        assert!(sections[0].rows[0].selected);
        assert_eq!(sections[0].rows[0].participants, 4);
        assert_eq!(sections[0].rows[1].engine, Some(EngineId::Claude));
    }

    #[test]
    fn filter_matches_title_or_project_name() {
        let s = demo();
        let by_title = sections(&s, "SCROLL", &HashSet::new());
        assert_eq!(by_title[0].total, 1);
        assert_eq!(by_title[1].total, 0);
        let by_project = sections(&s, "relay", &HashSet::new());
        assert_eq!(by_project[0].total, 0);
        assert_eq!(by_project[1].total, 3);
        let none = sections(&s, "zzz", &HashSet::new());
        assert!(none.iter().all(|sec| sec.total == 0));
    }

    #[test]
    fn collapsed_sections_keep_their_count_but_drop_rows_unless_filtering() {
        let s = demo();
        let collapsed: HashSet<ProjectId> = [s.projects[0].id.clone()].into_iter().collect();
        let folded = sections(&s, "", &collapsed);
        assert!(folded[0].collapsed);
        assert_eq!(folded[0].total, 4);
        assert!(folded[0].rows.is_empty());
        let searching = sections(&s, "the", &collapsed);
        assert!(!searching[0].collapsed);
        assert!(!searching[0].rows.is_empty());
    }

    #[test]
    fn archived_rows_are_separate_and_filtered() {
        let s = demo();
        let rows = archived_rows(&s, "");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].thread.title, "Old spike: wry on Linux");
        assert!(archived_rows(&s, "relay").is_empty());
        assert_eq!(archived_rows(&s, "boss").len(), 1);
    }

    #[test]
    fn shape_labels_match_the_design() {
        assert_eq!(shape_label(RoomShape::Direct), "Just do it");
        assert_eq!(shape_label(RoomShape::Reviewed), "Build and review");
        assert_eq!(shape_label(RoomShape::Full), "The full run");
    }
}
