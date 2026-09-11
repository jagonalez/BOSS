//! What the shell shows: projects, threads, rooms, open tabs, selection and
//! the settings snapshot. Plain `boss_core` types, no persistence, no GPUI
//! types in the data so every mutation can be unit-tested.

use boss_core::store::{McpConnection, McpTransport, Settings, Theme};
use boss_core::*;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use time::{Duration, OffsetDateTime};

/// How many closed tabs Cmd+Shift+T can walk back through.
pub const MAX_CLOSED_TABS: usize = 20;

/// Stable id of an open tab. Never reused within a session.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct TabId(pub u64);

/// What a tab in the center area holds.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TabKind {
    /// A chat or room transcript.
    Thread(ThreadId),
    /// A terminal rooted at `cwd`.
    Terminal {
        /// Working directory the shell was started in.
        cwd: PathBuf,
    },
    /// An embedded browser page.
    Browser {
        /// Page the tab opened with.
        url: String,
    },
    /// The settings page. At most one is open.
    Settings,
}

/// Where a terminal or browser tab came from, so the header strip above it
/// can say what it belongs to instead of leaving the user guessing.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TabContext {
    /// Project the tab was opened from, if any.
    pub project: Option<ProjectId>,
    /// Thread the tab was opened from, if any.
    pub thread: Option<ThreadId>,
}

impl TabContext {
    /// A context that names neither a project nor a thread.
    pub fn none() -> Self {
        Self::default()
    }

    /// A context for a project.
    pub fn project(id: ProjectId) -> Self {
        Self { project: Some(id), thread: None }
    }

    /// Nothing is known about where this tab came from.
    pub fn is_empty(&self) -> bool {
        self.project.is_none() && self.thread.is_none()
    }
}

/// What a terminal tab reports about the shell running inside it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TerminalStatus {
    /// Title the shell set, once it sets one.
    pub title: Option<String>,
    /// Exit code, once the shell has exited.
    pub exited: Option<u32>,
}

/// What a browser tab reports about the page it is showing.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct BrowserStatus {
    /// Document title.
    pub title: String,
    /// Current URL.
    pub url: String,
    /// The id agents use for this tab through `boss_browser_*`.
    pub agent_id: Option<String>,
}

/// One open tab.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Tab {
    /// Stable id, used for element ids.
    pub id: TabId,
    /// What the tab shows.
    pub kind: TabKind,
    /// Project and thread the tab was opened from. Empty for scratch tabs.
    pub context: TabContext,
    /// Live terminal state, for `TabKind::Terminal` tabs.
    pub terminal: Option<TerminalStatus>,
    /// Live page state, for `TabKind::Browser` tabs.
    pub browser: Option<BrowserStatus>,
}

impl Tab {
    /// A tab with no context and no live status yet.
    pub fn new(id: TabId, kind: TabKind) -> Self {
        Self { id, kind, context: TabContext::none(), terminal: None, browser: None }
    }
}

/// The shell's whole view of the app.
#[derive(Clone, Debug)]
pub struct AppState {
    /// Projects, in sidebar order.
    pub projects: Vec<Project>,
    /// Every thread, archived ones included.
    pub threads: Vec<Thread>,
    /// Rooms, one per `ThreadKind::Room` thread.
    pub rooms: Vec<Room>,
    /// Participants of chat threads (rooms carry their own).
    pub participants: HashMap<ThreadId, Vec<Participant>>,
    /// Threads whose agents are working right now.
    pub busy: HashSet<ThreadId>,
    /// Open tabs, left to right.
    pub tabs: Vec<Tab>,
    /// Index into `tabs` of the active tab.
    pub active_tab: Option<usize>,
    /// The thread the sidebar highlights and the window is titled after.
    pub selected_thread: Option<ThreadId>,
    /// Snapshot of the user's settings.
    pub settings: Settings,
    /// Whether the sidebar is hidden.
    pub sidebar_collapsed: bool,
    /// Tabs the user closed, most recent last. Cmd+Shift+T pops this.
    closed_tabs: Vec<TabKind>,
    next_tab_id: u64,
}

impl Default for AppState {
    fn default() -> Self {
        Self::empty()
    }
}

impl AppState {
    /// No projects, no threads, default settings.
    pub fn empty() -> Self {
        Self {
            projects: Vec::new(),
            threads: Vec::new(),
            rooms: Vec::new(),
            participants: HashMap::new(),
            busy: HashSet::new(),
            tabs: Vec::new(),
            active_tab: None,
            selected_thread: None,
            settings: Settings::default(),
            sidebar_collapsed: false,
            closed_tabs: Vec::new(),
            next_tab_id: 1,
        }
    }

    // ---- queries -----------------------------------------------------

    /// One project by id.
    pub fn project(&self, id: &ProjectId) -> Option<&Project> {
        self.projects.iter().find(|p| &p.id == id)
    }

    /// One thread by id.
    pub fn thread(&self, id: &ThreadId) -> Option<&Thread> {
        self.threads.iter().find(|t| &t.id == id)
    }

    fn thread_mut(&mut self, id: &ThreadId) -> Option<&mut Thread> {
        self.threads.iter_mut().find(|t| &t.id == id)
    }

    /// The room behind a room thread.
    pub fn room_for(&self, thread: &ThreadId) -> Option<&Room> {
        self.rooms.iter().find(|r| &r.thread_id == thread)
    }

    /// Participants of a thread: the room's seats, or the chat's one agent.
    pub fn participants_of(&self, thread: &ThreadId) -> &[Participant] {
        if let Some(room) = self.room_for(thread) {
            return &room.participants;
        }
        self.participants.get(thread).map(Vec::as_slice).unwrap_or(&[])
    }

    /// Is an agent in this thread working?
    pub fn is_busy(&self, thread: &ThreadId) -> bool {
        self.busy.contains(thread)
    }

    /// The active tab, if any.
    pub fn active_tab(&self) -> Option<&Tab> {
        self.active_tab.and_then(|ix| self.tabs.get(ix))
    }

    /// Index of the tab showing `kind`.
    pub fn tab_index(&self, kind: &TabKind) -> Option<usize> {
        self.tabs.iter().position(|t| &t.kind == kind)
    }

    /// Short label for a tab.
    ///
    /// Terminals start as the folder they opened in and switch to whatever
    /// the shell sets its title to; browsers follow the page title.
    pub fn tab_title(&self, tab: &Tab) -> String {
        match &tab.kind {
            TabKind::Thread(id) => self.thread(id).map(|t| t.title.clone()).unwrap_or_else(|| "Thread".into()),
            TabKind::Terminal { cwd } => {
                let base = match tab.terminal.as_ref().and_then(|t| t.title.clone()) {
                    Some(title) => title,
                    None => {
                        let name = cwd.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                        if name.is_empty() { "Terminal".into() } else { name }
                    }
                };
                match tab.terminal.as_ref().and_then(|t| t.exited) {
                    Some(_) => format!("{base} (exited)"),
                    None => base,
                }
            }
            TabKind::Browser { url } => {
                let title = tab.browser.as_ref().map(|b| b.title.trim().to_owned()).unwrap_or_default();
                if !title.is_empty() {
                    return title;
                }
                let shown = tab.browser.as_ref().map(|b| b.url.clone()).filter(|u| !u.is_empty()).unwrap_or_else(|| url.clone());
                shown.trim_start_matches("https://").trim_start_matches("http://").trim_end_matches('/').to_string()
            }
            TabKind::Settings => "Settings".into(),
        }
    }

    /// What the OS window is called: the selected thread, else the app.
    pub fn window_title(&self) -> String {
        match self.selected_thread.as_ref().and_then(|id| self.thread(id)) {
            Some(thread) => format!("{} — BOSS", thread.title),
            None => "BOSS".into(),
        }
    }

    /// The project new work should land in: the selected thread's, else the
    /// first one added. `None` when there are no projects, or when the
    /// selected thread is a scratch thread — new work then joins it there
    /// rather than being pulled into a project the user did not pick.
    pub fn current_project(&self) -> Option<&Project> {
        if let Some(thread) = self.selected_thread.as_ref().and_then(|id| self.thread(id)) {
            return thread.project_id.as_ref().and_then(|id| self.project(id));
        }
        self.projects.first()
    }

    // ---- tabs --------------------------------------------------------

    fn mint_tab(&mut self, kind: TabKind) -> Tab {
        let id = TabId(self.next_tab_id);
        self.next_tab_id += 1;
        Tab::new(id, kind)
    }

    /// Open a tab for `kind`, or activate the existing one. Returns its index.
    pub fn open_tab(&mut self, kind: TabKind) -> usize {
        self.open_tab_with_context(kind, TabContext::none())
    }

    /// Open a tab for `kind` and record where it came from. Reusing an open
    /// tab keeps its original context, since that is where it really came
    /// from; only a freshly minted tab takes the new one.
    pub fn open_tab_with_context(&mut self, kind: TabKind, context: TabContext) -> usize {
        let ix = match self.tab_index(&kind) {
            Some(ix) => ix,
            None => {
                let mut tab = self.mint_tab(kind.clone());
                tab.context = context;
                if let TabKind::Terminal { .. } = &tab.kind {
                    tab.terminal = Some(TerminalStatus::default());
                }
                if let TabKind::Browser { url } = &tab.kind {
                    tab.browser = Some(BrowserStatus { url: url.clone(), ..BrowserStatus::default() });
                }
                // New tabs open next to the active one, like a browser.
                let at = self.active_tab.map(|a| a + 1).unwrap_or(self.tabs.len()).min(self.tabs.len());
                self.tabs.insert(at, tab);
                at
            }
        };
        self.activate_tab(ix);
        ix
    }

    /// The tab with this id.
    pub fn tab(&self, id: TabId) -> Option<&Tab> {
        self.tabs.iter().find(|t| t.id == id)
    }

    /// The tab with this id, mutably.
    pub fn tab_mut(&mut self, id: TabId) -> Option<&mut Tab> {
        self.tabs.iter_mut().find(|t| t.id == id)
    }

    /// Record the title a terminal's shell set.
    pub fn set_terminal_title(&mut self, id: TabId, title: String) -> bool {
        let Some(tab) = self.tab_mut(id) else { return false };
        let status = tab.terminal.get_or_insert_with(TerminalStatus::default);
        let title = title.trim().to_owned();
        status.title = if title.is_empty() { None } else { Some(title) };
        true
    }

    /// Mark a terminal's shell as exited, or (with `None`) alive again.
    pub fn set_terminal_exited(&mut self, id: TabId, code: Option<u32>) -> bool {
        let Some(tab) = self.tab_mut(id) else { return false };
        let status = tab.terminal.get_or_insert_with(TerminalStatus::default);
        status.exited = code;
        true
    }

    /// Record what a browser tab is showing and the id agents address it by.
    pub fn set_browser_page(&mut self, id: TabId, title: String, url: String) -> bool {
        let Some(tab) = self.tab_mut(id) else { return false };
        let status = tab.browser.get_or_insert_with(BrowserStatus::default);
        status.title = title;
        if !url.is_empty() {
            status.url = url;
        }
        true
    }

    /// Record the `boss_browser_*` id for a browser tab.
    pub fn set_browser_agent_id(&mut self, id: TabId, agent_id: String) -> bool {
        let Some(tab) = self.tab_mut(id) else { return false };
        tab.browser.get_or_insert_with(BrowserStatus::default).agent_id = Some(agent_id);
        true
    }

    /// The header strip above a terminal or browser pane: what the tab
    /// belongs to, so "which project is this shell in?" is never a guess.
    ///
    /// Returns `(heading, detail)`. A tab with no project reads "Scratch".
    pub fn tab_context_lines(&self, tab: &Tab) -> Option<(String, String)> {
        match &tab.kind {
            TabKind::Terminal { cwd } => {
                let heading = match tab.context.project.as_ref().and_then(|id| self.project(id)) {
                    Some(project) => project.name.clone(),
                    None => "Scratch".to_owned(),
                };
                let heading = match tab.context.thread.as_ref().and_then(|id| self.thread(id)) {
                    Some(thread) => format!("{heading} · {}", thread.title),
                    None => heading,
                };
                Some((heading, cwd.display().to_string()))
            }
            TabKind::Browser { url } => {
                let status = tab.browser.as_ref();
                let title = status.map(|s| s.title.clone()).unwrap_or_default();
                let shown_url = status.map(|s| s.url.clone()).filter(|u| !u.is_empty()).unwrap_or_else(|| url.clone());
                let heading = if title.trim().is_empty() { shown_url.clone() } else { title };
                let detail = match status.and_then(|s| s.agent_id.clone()) {
                    Some(agent) => format!("{shown_url} · Agents see this as browser tab {agent}"),
                    None => shown_url,
                };
                Some((heading, detail))
            }
            TabKind::Thread(_) | TabKind::Settings => None,
        }
    }

    /// Open (or focus) the thread's tab and select it in the sidebar.
    pub fn open_thread(&mut self, thread: ThreadId) -> Option<usize> {
        self.thread(&thread)?;
        self.selected_thread = Some(thread.clone());
        Some(self.open_tab(TabKind::Thread(thread)))
    }

    /// Make tab `ix` active and sync the selected thread to it.
    pub fn activate_tab(&mut self, ix: usize) {
        if ix >= self.tabs.len() {
            return;
        }
        self.active_tab = Some(ix);
        if let TabKind::Thread(id) = &self.tabs[ix].kind {
            self.selected_thread = Some(id.clone());
        }
    }

    /// Activate the tab after the active one, wrapping.
    pub fn next_tab(&mut self) {
        if self.tabs.is_empty() {
            return;
        }
        let ix = self.active_tab.map(|a| (a + 1) % self.tabs.len()).unwrap_or(0);
        self.activate_tab(ix);
    }

    /// Activate the tab before the active one, wrapping.
    pub fn prev_tab(&mut self) {
        if self.tabs.is_empty() {
            return;
        }
        let n = self.tabs.len();
        let ix = self.active_tab.map(|a| (a + n - 1) % n).unwrap_or(n - 1);
        self.activate_tab(ix);
    }

    /// Close tab `ix`. The neighbour to the left (or the new last tab) becomes active.
    pub fn close_tab(&mut self, ix: usize) -> Option<Tab> {
        if ix >= self.tabs.len() {
            return None;
        }
        let removed = self.tabs.remove(ix);
        self.remember_closed(removed.kind.clone());
        self.active_tab = if self.tabs.is_empty() {
            None
        } else {
            match self.active_tab {
                Some(a) if a > ix => Some(a - 1),
                Some(a) if a == ix => Some(ix.min(self.tabs.len() - 1)),
                other => other,
            }
        };
        if let Some(a) = self.active_tab {
            self.activate_tab(a);
        }
        Some(removed)
    }

    /// Close the active tab.
    pub fn close_active_tab(&mut self) -> Option<Tab> {
        self.active_tab.and_then(|ix| self.close_tab(ix))
    }

    /// How many closed tabs are on the reopen stack.
    pub fn closed_tab_count(&self) -> usize {
        self.closed_tabs.len()
    }

    /// What Cmd+Shift+T would reopen, without reopening it.
    pub fn last_closed_tab(&self) -> Option<&TabKind> {
        self.closed_tabs.last()
    }

    /// Reopen the tab closed most recently and return what it shows.
    ///
    /// A thread that has since been archived, or a tab that is somehow open
    /// again, is skipped rather than reopened, so the shortcut keeps working
    /// down the stack instead of doing nothing.
    pub fn reopen_closed_tab(&mut self) -> Option<TabKind> {
        while let Some(kind) = self.closed_tabs.pop() {
            if self.tab_index(&kind).is_some() {
                continue;
            }
            if let TabKind::Thread(id) = &kind
                && !self.thread(id).is_some_and(|t| !t.archived)
            {
                continue;
            }
            match &kind {
                TabKind::Thread(id) => {
                    self.open_thread(id.clone())?;
                }
                other => {
                    self.open_tab(other.clone());
                }
            }
            return Some(kind);
        }
        None
    }

    /// Push a closed tab onto the reopen stack, newest last, bounded so a
    /// long session cannot grow it without limit.
    fn remember_closed(&mut self, kind: TabKind) {
        self.closed_tabs.retain(|k| k != &kind);
        self.closed_tabs.push(kind);
        if self.closed_tabs.len() > MAX_CLOSED_TABS {
            self.closed_tabs.remove(0);
        }
    }

    /// Move tab `from` so it sits at index `to`. The active tab follows its content.
    pub fn move_tab(&mut self, from: usize, to: usize) {
        let n = self.tabs.len();
        if from >= n || to >= n || from == to {
            return;
        }
        let active_id = self.active_tab.map(|a| self.tabs[a].id);
        let tab = self.tabs.remove(from);
        self.tabs.insert(to, tab);
        self.active_tab = active_id.and_then(|id| self.tabs.iter().position(|t| t.id == id));
    }

    // ---- threads -----------------------------------------------------

    /// Highlight a thread without opening it.
    pub fn select_thread(&mut self, thread: Option<ThreadId>) {
        self.selected_thread = thread;
    }

    /// Add a thread with its chat participant (rooms use `add_room`).
    pub fn add_thread(&mut self, thread: Thread, participants: Vec<Participant>) {
        self.participants.insert(thread.id.clone(), participants);
        self.threads.push(thread);
    }

    /// Add a room and its thread.
    pub fn add_room(&mut self, thread: Thread, room: Room) {
        self.threads.push(thread);
        self.rooms.push(room);
    }

    /// Set or clear the archived flag. Archiving closes the thread's tab.
    pub fn set_archived(&mut self, thread: &ThreadId, archived: bool) -> bool {
        let Some(t) = self.thread_mut(thread) else { return false };
        t.archived = archived;
        t.updated_at = OffsetDateTime::now_utc();
        if archived {
            if let Some(ix) = self.tab_index(&TabKind::Thread(thread.clone())) {
                self.close_tab(ix);
            }
            if self.selected_thread.as_ref() == Some(thread) {
                self.selected_thread = self.active_tab().and_then(|t| match &t.kind {
                    TabKind::Thread(id) => Some(id.clone()),
                    _ => None,
                });
            }
        }
        true
    }

    /// Archive a thread.
    pub fn archive_thread(&mut self, thread: &ThreadId) -> bool {
        self.set_archived(thread, true)
    }

    /// Give a thread a new title. Blank titles are ignored.
    pub fn rename_thread(&mut self, thread: &ThreadId, title: &str) -> bool {
        let title = title.trim();
        if title.is_empty() {
            return false;
        }
        match self.thread_mut(thread) {
            Some(t) => {
                t.title = title.to_owned();
                true
            }
            None => false,
        }
    }

    /// Mark a thread busy or idle.
    pub fn set_busy(&mut self, thread: &ThreadId, busy: bool) {
        if busy {
            self.busy.insert(thread.clone());
        } else {
            self.busy.remove(thread);
        }
    }

    // ---- settings + chrome -------------------------------------------

    /// Replace the settings snapshot.
    pub fn set_settings(&mut self, settings: Settings) {
        self.settings = settings;
    }

    /// Change the theme preference.
    pub fn set_theme(&mut self, theme: Theme) {
        self.settings.theme = theme;
    }

    /// Show or hide the sidebar.
    pub fn toggle_sidebar(&mut self) {
        self.sidebar_collapsed = !self.sidebar_collapsed;
    }

    // ---- demo --------------------------------------------------------

    /// Two projects, eight threads (chats and rooms across every engine),
    /// two open tabs. What the shell shows before anything is wired up.
    pub fn demo() -> Self {
        let now = OffsetDateTime::now_utc();
        let mut s = Self::empty();

        let boss = Project {
            id: ProjectId::from_raw("prj_demo_boss"),
            name: "boss".into(),
            root: PathBuf::from("/Users/demo/dev/BOSS"),
            added_at: now - Duration::days(40),
        };
        let relay = Project {
            id: ProjectId::from_raw("prj_demo_relay"),
            name: "relay".into(),
            root: PathBuf::from("/Users/demo/dev/relay"),
            added_at: now - Duration::days(12),
        };
        s.projects = vec![boss.clone(), relay.clone()];

        let thread = |id: &str, project: &Project, title: &str, kind: ThreadKind, ago: Duration| Thread {
            id: ThreadId::from_raw(id),
            project_id: Some(project.id.clone()),
            title: title.into(),
            kind,
            created_at: now - ago - Duration::hours(3),
            updated_at: now - ago,
            cwd: project.root.clone(),
            archived: false,
        };
        let seat = |id: &str, name: &str, engine: EngineId, model: Option<&str>, is_boss: bool| Participant {
            id: ParticipantId::from_raw(id),
            name: name.into(),
            engine,
            model: model.map(str::to_owned),
            is_boss,
            native_session_id: None,
        };
        let chat = |s: &mut Self, id: &str, project: &Project, title: &str, engine: EngineId, model: Option<&str>, ago: Duration| {
            let t = thread(id, project, title, ThreadKind::Chat { engine }, ago);
            let who = seat(&format!("who_{id}"), engine.label(), engine, model, false);
            s.add_thread(t, vec![who]);
        };
        let room = |s: &mut Self, id: &str, project: &Project, title: &str, shape: RoomShape, seats: Vec<Participant>, ago: Duration| {
            let room_id = RoomId::from_raw(format!("room_{id}"));
            let t = thread(id, project, title, ThreadKind::Room { room_id: room_id.clone() }, ago);
            let r = Room { id: room_id, thread_id: t.id.clone(), shape, participants: seats };
            s.add_room(t, r);
        };

        // boss
        room(
            &mut s,
            "thr_demo_1",
            &boss,
            "Port the sidebar to GPUI",
            RoomShape::Full,
            vec![
                seat("who_1_boss", "BOSS", EngineId::Claude, Some("claude-opus-4"), true),
                seat("who_1_res", "researcher", EngineId::Codex, Some("gpt-5"), false),
                seat("who_1_build", "builder", EngineId::Claude, Some("claude-sonnet-4"), false),
                seat("who_1_rev", "reviewer", EngineId::Pi, None, false),
            ],
            Duration::minutes(2),
        );
        chat(&mut s, "thr_demo_2", &boss, "Why does the list jump on scroll?", EngineId::Claude, Some("claude-sonnet-4"), Duration::minutes(25));
        room(
            &mut s,
            "thr_demo_3",
            &boss,
            "Settings page: theme + fonts",
            RoomShape::Reviewed,
            vec![
                seat("who_3_boss", "BOSS", EngineId::Claude, None, true),
                seat("who_3_build", "builder", EngineId::Opencode, Some("anthropic/claude-sonnet-4"), false),
                seat("who_3_rev", "reviewer", EngineId::Codex, Some("gpt-5"), false),
            ],
            Duration::hours(3),
        );
        chat(&mut s, "thr_demo_4", &boss, "Explain the thread bus tokens", EngineId::Pi, None, Duration::hours(9));
        chat(&mut s, "thr_demo_5", &boss, "Old spike: wry on Linux", EngineId::Codex, Some("gpt-5-codex"), Duration::days(6));

        // relay
        room(
            &mut s,
            "thr_demo_6",
            &relay,
            "Rotate the relay signing key",
            RoomShape::Direct,
            vec![
                seat("who_6_boss", "BOSS", EngineId::Claude, None, true),
                seat("who_6_build", "builder", EngineId::Claude, Some("claude-sonnet-4"), false),
            ],
            Duration::minutes(48),
        );
        chat(&mut s, "thr_demo_7", &relay, "Add rate limits to /push", EngineId::Opencode, Some("openai/gpt-5"), Duration::hours(1));
        chat(&mut s, "thr_demo_8", &relay, "Mobile handshake notes", EngineId::Codex, Some("gpt-5"), Duration::days(2));

        // Scratch: started before any project was added, so it belongs to none.
        let scratch = Thread {
            id: ThreadId::from_raw("thr_demo_9"),
            project_id: None,
            title: "Quick question about rustfmt".into(),
            kind: ThreadKind::Chat { engine: EngineId::Claude },
            created_at: now - Duration::minutes(20),
            updated_at: now - Duration::minutes(10),
            cwd: scratch_cwd(),
            archived: false,
        };
        s.add_thread(scratch, vec![seat("who_thr_demo_9", "Claude Code", EngineId::Claude, None, false)]);

        s.set_busy(&ThreadId::from_raw("thr_demo_1"), true);
        s.set_busy(&ThreadId::from_raw("thr_demo_6"), true);
        s.set_archived(&ThreadId::from_raw("thr_demo_5"), true);

        s.settings.set_default_model(EngineId::Claude, Some("claude-sonnet-4".into()));
        s.settings.mcp_connections = vec![
            McpConnection {
                id: "mcp_demo_github".into(),
                name: "GitHub".into(),
                slug: "github".into(),
                enabled: true,
                transport: McpTransport::Http,
                url: Some("https://api.githubcopilot.com/mcp/".into()),
                created_at: now - Duration::days(20),
                ..McpConnection::default()
            },
            McpConnection {
                id: "mcp_demo_fs".into(),
                name: "Filesystem".into(),
                slug: "filesystem".into(),
                enabled: false,
                transport: McpTransport::Stdio,
                command: Some("npx".into()),
                args: vec!["-y".into(), "@modelcontextprotocol/server-filesystem".into(), "/Users/demo".into()],
                created_at: now - Duration::days(5),
                ..McpConnection::default()
            },
        ];

        s.open_thread(ThreadId::from_raw("thr_demo_2"));
        s.open_thread(ThreadId::from_raw("thr_demo_1"));
        s
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tid(n: u8) -> ThreadId {
        ThreadId::from_raw(format!("thr_demo_{n}"))
    }

    #[test]
    fn demo_has_two_projects_and_nine_threads_across_engines() {
        let s = AppState::demo();
        assert_eq!(s.projects.len(), 2);
        // Eight in a project, plus one scratch thread with no project.
        assert_eq!(s.threads.len(), 9);
        assert_eq!(s.threads.iter().filter(|t| t.project_id.is_none()).count(), 1);
        let rooms = s.threads.iter().filter(|t| matches!(t.kind, ThreadKind::Room { .. })).count();
        assert_eq!(rooms, 3);
        for room in &s.rooms {
            assert!((2..=4).contains(&room.participants.len()));
            assert!(room.participants.iter().any(|p| p.is_boss));
        }
        let engines: HashSet<EngineId> = s
            .threads
            .iter()
            .flat_map(|t| s.participants_of(&t.id).iter().map(|p| p.engine))
            .collect();
        assert_eq!(engines.len(), EngineId::ALL.len());
        assert_eq!(s.tabs.len(), 2);
        assert_eq!(s.selected_thread, Some(tid(1)));
        assert!(s.window_title().starts_with("Port the sidebar"));
    }

    #[test]
    fn open_thread_reuses_its_tab_and_selects_it() {
        let mut s = AppState::demo();
        let before = s.tabs.len();
        let ix = s.open_thread(tid(2)).unwrap();
        assert_eq!(s.tabs.len(), before);
        assert_eq!(s.active_tab, Some(ix));
        assert_eq!(s.selected_thread, Some(tid(2)));
        assert_eq!(s.open_thread(ThreadId::from_raw("nope")), None);
    }

    #[test]
    fn new_tabs_open_beside_the_active_one() {
        let mut s = AppState::demo();
        s.activate_tab(0);
        let ix = s.open_tab(TabKind::Settings);
        assert_eq!(ix, 1);
        assert_eq!(s.tabs.len(), 3);
        // A second request focuses the same tab.
        assert_eq!(s.open_tab(TabKind::Settings), 1);
        assert_eq!(s.tabs.len(), 3);
    }

    #[test]
    fn closing_tabs_moves_the_active_index_sensibly() {
        let mut s = AppState::demo();
        s.open_tab(TabKind::Terminal { cwd: PathBuf::from("/tmp") });
        s.open_tab(TabKind::Browser { url: "https://example.com".into() });
        assert_eq!(s.tabs.len(), 4);
        s.activate_tab(3);
        s.close_tab(1); // closing to the left shifts the active index down
        assert_eq!(s.active_tab, Some(2));
        s.close_active_tab(); // closing the last tab activates the new last
        assert_eq!(s.active_tab, Some(1));
        s.activate_tab(0);
        s.close_tab(0); // closing the first keeps index 0
        assert_eq!(s.active_tab, Some(0));
        s.close_tab(0);
        assert_eq!(s.active_tab, None);
        assert!(s.close_active_tab().is_none());
    }

    #[test]
    fn next_and_prev_wrap() {
        let mut s = AppState::demo();
        s.activate_tab(1);
        s.next_tab();
        assert_eq!(s.active_tab, Some(0));
        s.prev_tab();
        assert_eq!(s.active_tab, Some(1));
        let mut empty = AppState::empty();
        empty.next_tab();
        assert_eq!(empty.active_tab, None);
    }

    #[test]
    fn move_tab_keeps_the_active_content_active() {
        let mut s = AppState::demo();
        s.open_tab(TabKind::Settings);
        let active = s.active_tab().unwrap().id;
        s.move_tab(2, 0);
        assert_eq!(s.tabs[0].kind, TabKind::Settings);
        assert_eq!(s.active_tab().unwrap().id, active);
        s.move_tab(0, 9); // out of range is a no-op
        assert_eq!(s.tabs[0].kind, TabKind::Settings);
    }

    #[test]
    fn archiving_closes_the_tab_and_moves_selection() {
        let mut s = AppState::demo();
        assert!(s.archive_thread(&tid(1)));
        assert!(s.thread(&tid(1)).unwrap().archived);
        assert!(s.tab_index(&TabKind::Thread(tid(1))).is_none());
        assert_eq!(s.selected_thread, Some(tid(2)));
        assert!(!s.archive_thread(&ThreadId::from_raw("nope")));
        assert!(s.set_archived(&tid(1), false));
        assert!(!s.thread(&tid(1)).unwrap().archived);
    }

    #[test]
    fn rename_ignores_blank_titles() {
        let mut s = AppState::demo();
        assert!(!s.rename_thread(&tid(2), "   "));
        assert!(s.rename_thread(&tid(2), "  Scroll jump  "));
        assert_eq!(s.thread(&tid(2)).unwrap().title, "Scroll jump");
    }

    #[test]
    fn closing_and_reopening_walks_back_through_the_stack() {
        let mut s = AppState::demo();
        s.open_tab(TabKind::Settings);
        s.open_tab(TabKind::Terminal { cwd: PathBuf::from("/tmp") });
        let before: Vec<TabKind> = s.tabs.iter().map(|t| t.kind.clone()).collect();
        assert_eq!(s.closed_tab_count(), 0);

        // Close the terminal, then the settings tab.
        let terminal_ix = s.tab_index(&TabKind::Terminal { cwd: PathBuf::from("/tmp") }).unwrap();
        s.close_tab(terminal_ix);
        let settings_ix = s.tab_index(&TabKind::Settings).unwrap();
        s.close_tab(settings_ix);
        assert_eq!(s.closed_tab_count(), 2);
        assert_eq!(s.last_closed_tab(), Some(&TabKind::Settings));

        // Reopening is last-closed-first.
        assert_eq!(s.reopen_closed_tab(), Some(TabKind::Settings));
        assert_eq!(s.active_tab().map(|t| t.kind.clone()), Some(TabKind::Settings));
        assert_eq!(s.reopen_closed_tab(), Some(TabKind::Terminal { cwd: PathBuf::from("/tmp") }));
        assert_eq!(s.reopen_closed_tab(), None, "the stack is empty");

        let after: Vec<TabKind> = s.tabs.iter().map(|t| t.kind.clone()).collect();
        assert_eq!(after.len(), before.len());
        for kind in before {
            assert!(after.contains(&kind), "{kind:?} came back");
        }
    }

    #[test]
    fn reopen_skips_tabs_that_are_open_again_or_gone() {
        let mut s = AppState::demo();
        // Close a thread tab, then open it again by hand.
        s.close_tab(0);
        let reopened_by_hand = match s.closed_tabs.last().cloned() {
            Some(TabKind::Thread(id)) => id,
            other => panic!("expected a thread tab, got {other:?}"),
        };
        s.open_thread(reopened_by_hand.clone());
        // The stack entry is stale: it is skipped, not opened twice.
        assert_eq!(s.reopen_closed_tab(), None);
        let expected = TabKind::Thread(reopened_by_hand);
        assert_eq!(s.tabs.iter().filter(|t| t.kind == expected).count(), 1);

        // Archiving closes the tab; reopening must not resurrect it.
        let mut s = AppState::demo();
        let archived = tid(1);
        s.archive_thread(&archived);
        assert!(s.closed_tab_count() >= 1);
        assert_eq!(s.reopen_closed_tab(), None);
        assert!(s.tab_index(&TabKind::Thread(archived)).is_none());
    }

    #[test]
    fn the_reopen_stack_is_bounded_and_deduplicated() {
        let mut s = AppState::empty();
        for n in 0..MAX_CLOSED_TABS + 5 {
            let ix = s.open_tab(TabKind::Browser { url: format!("https://example.com/{n}") });
            s.close_tab(ix);
        }
        assert_eq!(s.closed_tab_count(), MAX_CLOSED_TABS);
        // The newest close is on top; the oldest fell off.
        let newest = format!("https://example.com/{}", MAX_CLOSED_TABS + 4);
        assert_eq!(s.last_closed_tab(), Some(&TabKind::Browser { url: newest }));

        // Closing the same tab twice leaves one entry.
        let mut s = AppState::empty();
        for _ in 0..3 {
            let ix = s.open_tab(TabKind::Settings);
            s.close_tab(ix);
        }
        assert_eq!(s.closed_tab_count(), 1);
    }

    #[test]
    fn tab_titles_and_participants() {
        let s = AppState::demo();
        let terminal = Tab::new(TabId(99), TabKind::Terminal { cwd: PathBuf::from("/Users/demo/dev/BOSS") });
        assert_eq!(s.tab_title(&terminal), "BOSS");
        let browser = Tab::new(TabId(98), TabKind::Browser { url: "https://docs.rs/".into() });
        assert_eq!(s.tab_title(&browser), "docs.rs");
        assert_eq!(s.participants_of(&tid(1)).len(), 4);
        assert_eq!(s.participants_of(&tid(2)).len(), 1);
        assert!(s.participants_of(&ThreadId::from_raw("nope")).is_empty());
    }

    #[test]
    fn a_terminal_tab_title_follows_the_shell_then_notes_the_exit() {
        let mut s = AppState::demo();
        let ix = s.open_tab(TabKind::Terminal { cwd: PathBuf::from("/Users/demo/dev/BOSS") });
        let id = s.tabs[ix].id;
        // Until the shell sets a title, the folder name stands in.
        assert_eq!(s.tab_title(&s.tabs[ix]), "BOSS");
        assert!(s.set_terminal_title(id, "npm run dev".into()));
        assert_eq!(s.tab_title(s.tab(id).unwrap()), "npm run dev");
        // A blank title from the shell falls back rather than blanking the tab.
        s.set_terminal_title(id, "   ".into());
        assert_eq!(s.tab_title(s.tab(id).unwrap()), "BOSS");
        s.set_terminal_title(id, "zsh".into());
        s.set_terminal_exited(id, Some(130));
        assert_eq!(s.tab_title(s.tab(id).unwrap()), "zsh (exited)");
        // Reopening a shell clears the marker.
        s.set_terminal_exited(id, None);
        assert_eq!(s.tab_title(s.tab(id).unwrap()), "zsh");
        assert!(!s.set_terminal_title(TabId(9999), "x".into()), "an unknown tab is a no-op");
    }

    #[test]
    fn a_browser_tab_title_follows_the_page() {
        let mut s = AppState::demo();
        let ix = s.open_tab(TabKind::Browser { url: "https://docs.rs/gpui".into() });
        let id = s.tabs[ix].id;
        assert_eq!(s.tab_title(&s.tabs[ix]), "docs.rs/gpui");
        s.set_browser_page(id, "gpui - Rust".into(), "https://docs.rs/gpui/latest/gpui/".into());
        assert_eq!(s.tab_title(s.tab(id).unwrap()), "gpui - Rust");
        // A page with no title falls back to the URL it actually landed on.
        s.set_browser_page(id, String::new(), "https://docs.rs/gpui/latest/gpui/".into());
        assert_eq!(s.tab_title(s.tab(id).unwrap()), "docs.rs/gpui/latest/gpui");
    }

    #[test]
    fn the_header_strip_says_what_a_tab_belongs_to() {
        let mut s = AppState::demo();
        let project = s.projects[0].id.clone();
        let ix = s.open_tab_with_context(
            TabKind::Terminal { cwd: PathBuf::from("/Users/demo/dev/BOSS") },
            TabContext { project: Some(project), thread: Some(tid(2)) },
        );
        let (heading, detail) = s.tab_context_lines(&s.tabs[ix]).unwrap();
        assert_eq!(heading, "boss · Why does the list jump on scroll?");
        assert_eq!(detail, "/Users/demo/dev/BOSS");

        // A terminal opened from nowhere says so rather than showing nothing.
        let ix = s.open_tab(TabKind::Terminal { cwd: PathBuf::from("/tmp") });
        assert_eq!(s.tab_context_lines(&s.tabs[ix]).unwrap().0, "Scratch");

        // Browsers carry the id agents drive them by.
        let ix = s.open_tab(TabKind::Browser { url: "https://example.com".into() });
        let id = s.tabs[ix].id;
        s.set_browser_page(id, "Example".into(), "https://example.com/".into());
        s.set_browser_agent_id(id, "browser-3".into());
        let (heading, detail) = s.tab_context_lines(s.tab(id).unwrap()).unwrap();
        assert_eq!(heading, "Example");
        assert_eq!(detail, "https://example.com/ · Agents see this as browser tab browser-3");

        // Threads and settings have no strip.
        assert!(s.tab_context_lines(&Tab::new(TabId(1), TabKind::Settings)).is_none());
        assert!(s.tab_context_lines(&Tab::new(TabId(2), TabKind::Thread(tid(1)))).is_none());
    }

    #[test]
    fn reusing_a_tab_keeps_the_context_it_was_opened_with() {
        let mut s = AppState::empty();
        let kind = TabKind::Terminal { cwd: PathBuf::from("/tmp") };
        let first = TabContext { project: Some(ProjectId::from_raw("prj_a")), thread: None };
        let ix = s.open_tab_with_context(kind.clone(), first.clone());
        let id = s.tabs[ix].id;
        let again = s.open_tab_with_context(kind, TabContext { project: Some(ProjectId::from_raw("prj_b")), thread: None });
        assert_eq!(again, ix, "the same tab is focused, not duplicated");
        assert_eq!(s.tab(id).unwrap().context, first);
    }
}
