//! What the shell shows: projects, threads, rooms, open tabs, selection and
//! the settings snapshot. Plain `boss_core` types, no persistence, no GPUI
//! types in the data so every mutation can be unit-tested.

use boss_core::store::{McpConnection, McpTransport, Settings, Theme};
use boss_core::*;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use time::{Duration, OffsetDateTime};

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

/// One open tab.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Tab {
    /// Stable id, used for element ids.
    pub id: TabId,
    /// What the tab shows.
    pub kind: TabKind,
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
    pub fn tab_title(&self, tab: &Tab) -> String {
        match &tab.kind {
            TabKind::Thread(id) => self.thread(id).map(|t| t.title.clone()).unwrap_or_else(|| "Thread".into()),
            TabKind::Terminal { cwd } => {
                let name = cwd.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                if name.is_empty() { "Terminal".into() } else { format!("Terminal · {name}") }
            }
            TabKind::Browser { url } => url.trim_start_matches("https://").trim_start_matches("http://").trim_end_matches('/').to_string(),
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

    /// The project new work should land in: the selected thread's, else the first.
    pub fn current_project(&self) -> Option<&Project> {
        self.selected_thread
            .as_ref()
            .and_then(|id| self.thread(id))
            .and_then(|t| self.project(&t.project_id))
            .or_else(|| self.projects.first())
    }

    // ---- tabs --------------------------------------------------------

    fn mint_tab(&mut self, kind: TabKind) -> Tab {
        let id = TabId(self.next_tab_id);
        self.next_tab_id += 1;
        Tab { id, kind }
    }

    /// Open a tab for `kind`, or activate the existing one. Returns its index.
    pub fn open_tab(&mut self, kind: TabKind) -> usize {
        let ix = match self.tab_index(&kind) {
            Some(ix) => ix,
            None => {
                let tab = self.mint_tab(kind.clone());
                // New tabs open next to the active one, like a browser.
                let at = self.active_tab.map(|a| a + 1).unwrap_or(self.tabs.len()).min(self.tabs.len());
                self.tabs.insert(at, tab);
                at
            }
        };
        self.activate_tab(ix);
        ix
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
            project_id: project.id.clone(),
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
    fn demo_has_two_projects_and_eight_threads_across_engines() {
        let s = AppState::demo();
        assert_eq!(s.projects.len(), 2);
        assert_eq!(s.threads.len(), 8);
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
    fn tab_titles_and_participants() {
        let s = AppState::demo();
        let terminal = Tab { id: TabId(99), kind: TabKind::Terminal { cwd: PathBuf::from("/Users/demo/dev/BOSS") } };
        assert_eq!(s.tab_title(&terminal), "Terminal · BOSS");
        let browser = Tab { id: TabId(98), kind: TabKind::Browser { url: "https://docs.rs/".into() } };
        assert_eq!(s.tab_title(&browser), "docs.rs");
        assert_eq!(s.participants_of(&tid(1)).len(), 4);
        assert_eq!(s.participants_of(&tid(2)).len(), 1);
        assert!(s.participants_of(&ThreadId::from_raw("nope")).is_empty());
    }
}
