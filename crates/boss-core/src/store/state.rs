//! Projects, threads, and rooms: the sidebar's model tree, on disk as three
//! JSON files.
//!
//! Ported from `state-store.ts` (projects) and the storage half of
//! `room-manager.ts`. Each file is a versioned envelope so a later shape can
//! migrate; a file that exists but will not parse refuses to load rather
//! than starting empty and overwriting every thread on the next save.

use super::json::JsonFile;
use super::{Result, StoreError};
use crate::ids::{ProjectId, RoomId, ThreadId};
use crate::thread::{Project, Room, Thread};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use time::OffsetDateTime;

/// Current on-disk envelope version for all three files.
pub const STATE_FILE_VERSION: u32 = 1;

/// `{ "version": 1, "items": [...] }`.
#[derive(Debug, Serialize, Deserialize)]
struct Envelope<T> {
    version: u32,
    #[serde(default = "Vec::new")]
    items: Vec<T>,
}

impl<T> Default for Envelope<T> {
    fn default() -> Self {
        Self { version: STATE_FILE_VERSION, items: Vec::new() }
    }
}

#[derive(Debug, Default)]
struct State {
    projects: Vec<Project>,
    threads: Vec<Thread>,
    rooms: Vec<Room>,
}

/// In-memory projects, threads, and rooms, saved on every mutation.
/// `Send + Sync`; share it in an `Arc` and call it from `spawn_blocking`.
#[derive(Debug)]
pub struct StateStore {
    projects_file: JsonFile,
    threads_file: JsonFile,
    rooms_file: JsonFile,
    state: Mutex<State>,
}

impl StateStore {
    /// Load `projects.json`, `threads.json`, `rooms.json` from `base`, or
    /// from the user data dir when `base` is `None`.
    pub fn open(base: Option<&Path>) -> Result<Self> {
        let projects_file = JsonFile::in_dir(base, "projects.json");
        let threads_file = JsonFile::in_dir(base, "threads.json");
        let rooms_file = JsonFile::in_dir(base, "rooms.json");
        let state = State {
            projects: load_items(&projects_file)?,
            threads: load_items(&threads_file)?,
            rooms: load_items(&rooms_file)?,
        };
        Ok(Self { projects_file, threads_file, rooms_file, state: Mutex::new(state) })
    }

    /// Open under the user data dir.
    pub fn open_default() -> Result<Self> {
        Self::open(None)
    }

    // ---- projects ----------------------------------------------------

    /// All projects in the order they were added.
    pub fn projects(&self) -> Vec<Project> {
        self.lock().projects.clone()
    }

    /// One project by id.
    pub fn project(&self, id: &ProjectId) -> Option<Project> {
        self.lock().projects.iter().find(|p| &p.id == id).cloned()
    }

    /// The project whose root is `root`, if one exists.
    pub fn project_by_root(&self, root: &Path) -> Option<Project> {
        self.lock().projects.iter().find(|p| p.root == root).cloned()
    }

    /// Add a project rooted at `root`. Adding a root that is already a
    /// project returns the existing one; `name` defaults to the directory
    /// name.
    pub fn add_project(&self, root: PathBuf, name: Option<String>) -> Result<Project> {
        if let Some(existing) = self.project_by_root(&root) {
            return Ok(existing);
        }
        let name = name.unwrap_or_else(|| {
            root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| root.display().to_string())
        });
        let project = Project { id: ProjectId::new(), name, root, added_at: OffsetDateTime::now_utc() };
        self.upsert_project(project.clone())?;
        Ok(project)
    }

    /// Insert or replace a project by id, keeping its position.
    pub fn upsert_project(&self, project: Project) -> Result<()> {
        let mut state = self.lock();
        upsert_by(&mut state.projects, project, |a, b| a.id == b.id);
        save_items(&self.projects_file, &state.projects)
    }

    /// Remove a project and every thread and room under it. Returns whether
    /// the project existed.
    pub fn remove_project(&self, id: &ProjectId) -> Result<bool> {
        let mut state = self.lock();
        let before = state.projects.len();
        state.projects.retain(|p| &p.id != id);
        if state.projects.len() == before {
            return Ok(false);
        }
        let gone: Vec<ThreadId> =
            state.threads.iter().filter(|t| &t.project_id == id).map(|t| t.id.clone()).collect();
        state.threads.retain(|t| &t.project_id != id);
        state.rooms.retain(|r| !gone.contains(&r.thread_id));
        save_items(&self.projects_file, &state.projects)?;
        save_items(&self.threads_file, &state.threads)?;
        save_items(&self.rooms_file, &state.rooms)?;
        Ok(true)
    }

    // ---- threads -----------------------------------------------------

    /// All threads, including archived ones.
    pub fn threads(&self) -> Vec<Thread> {
        self.lock().threads.clone()
    }

    /// Threads in one project, including archived ones.
    pub fn threads_for_project(&self, project: &ProjectId) -> Vec<Thread> {
        self.lock().threads.iter().filter(|t| &t.project_id == project).cloned().collect()
    }

    /// One thread by id.
    pub fn thread(&self, id: &ThreadId) -> Option<Thread> {
        self.lock().threads.iter().find(|t| &t.id == id).cloned()
    }

    /// Insert or replace a thread by id, keeping its position.
    pub fn upsert_thread(&self, thread: Thread) -> Result<()> {
        let mut state = self.lock();
        upsert_by(&mut state.threads, thread, |a, b| a.id == b.id);
        save_items(&self.threads_file, &state.threads)
    }

    /// Edit a thread in place and bump `updated_at`. Returns the new value,
    /// or `None` when there is no such thread.
    pub fn update_thread(&self, id: &ThreadId, edit: impl FnOnce(&mut Thread)) -> Result<Option<Thread>> {
        let mut state = self.lock();
        let Some(thread) = state.threads.iter_mut().find(|t| &t.id == id) else {
            return Ok(None);
        };
        edit(thread);
        thread.updated_at = OffsetDateTime::now_utc();
        let updated = thread.clone();
        save_items(&self.threads_file, &state.threads)?;
        Ok(Some(updated))
    }

    /// Remove a thread and its room, if any. Returns whether it existed.
    pub fn remove_thread(&self, id: &ThreadId) -> Result<bool> {
        let mut state = self.lock();
        let before = state.threads.len();
        state.threads.retain(|t| &t.id != id);
        if state.threads.len() == before {
            return Ok(false);
        }
        let rooms_before = state.rooms.len();
        state.rooms.retain(|r| &r.thread_id != id);
        save_items(&self.threads_file, &state.threads)?;
        if state.rooms.len() != rooms_before {
            save_items(&self.rooms_file, &state.rooms)?;
        }
        Ok(true)
    }

    // ---- rooms -------------------------------------------------------

    /// All rooms.
    pub fn rooms(&self) -> Vec<Room> {
        self.lock().rooms.clone()
    }

    /// One room by id.
    pub fn room(&self, id: &RoomId) -> Option<Room> {
        self.lock().rooms.iter().find(|r| &r.id == id).cloned()
    }

    /// The room attached to a thread.
    pub fn room_for_thread(&self, thread: &ThreadId) -> Option<Room> {
        self.lock().rooms.iter().find(|r| &r.thread_id == thread).cloned()
    }

    /// Rooms whose thread belongs to `project`.
    pub fn rooms_for_project(&self, project: &ProjectId) -> Vec<Room> {
        let state = self.lock();
        let threads: Vec<&ThreadId> =
            state.threads.iter().filter(|t| &t.project_id == project).map(|t| &t.id).collect();
        state.rooms.iter().filter(|r| threads.contains(&&r.thread_id)).cloned().collect()
    }

    /// Insert or replace a room by id, keeping its position.
    pub fn upsert_room(&self, room: Room) -> Result<()> {
        let mut state = self.lock();
        upsert_by(&mut state.rooms, room, |a, b| a.id == b.id);
        save_items(&self.rooms_file, &state.rooms)
    }

    /// Edit a room in place. Returns the new value, or `None` when there is
    /// no such room.
    pub fn update_room(&self, id: &RoomId, edit: impl FnOnce(&mut Room)) -> Result<Option<Room>> {
        let mut state = self.lock();
        let Some(room) = state.rooms.iter_mut().find(|r| &r.id == id) else {
            return Ok(None);
        };
        edit(room);
        let updated = room.clone();
        save_items(&self.rooms_file, &state.rooms)?;
        Ok(Some(updated))
    }

    /// Remove a room. The thread stays. Returns whether the room existed.
    pub fn remove_room(&self, id: &RoomId) -> Result<bool> {
        let mut state = self.lock();
        let before = state.rooms.len();
        state.rooms.retain(|r| &r.id != id);
        if state.rooms.len() == before {
            return Ok(false);
        }
        save_items(&self.rooms_file, &state.rooms)?;
        Ok(true)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

fn load_items<T: serde::de::DeserializeOwned>(file: &JsonFile) -> Result<Vec<T>> {
    let envelope = file.load_or_default::<Envelope<T>>()?;
    if envelope.version > STATE_FILE_VERSION {
        return Err(StoreError::Version {
            path: file.path().to_path_buf(),
            found: envelope.version,
            supported: STATE_FILE_VERSION,
        });
    }
    Ok(envelope.items)
}

fn save_items<T: Serialize>(file: &JsonFile, items: &[T]) -> Result<()> {
    #[derive(Serialize)]
    struct Out<'a, T> {
        version: u32,
        items: &'a [T],
    }
    file.save(&Out { version: STATE_FILE_VERSION, items })
}

fn upsert_by<T>(items: &mut Vec<T>, item: T, same: impl Fn(&T, &T) -> bool) {
    match items.iter_mut().find(|existing| same(existing, &item)) {
        Some(slot) => *slot = item,
        None => items.push(item),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::EngineId;
    use crate::ids::ParticipantId;
    use crate::thread::{Participant, RoomShape, ThreadKind};

    fn thread(project: &ProjectId, kind: ThreadKind) -> Thread {
        let now = OffsetDateTime::now_utc();
        Thread {
            id: ThreadId::new(),
            project_id: project.clone(),
            title: "t".into(),
            kind,
            created_at: now,
            updated_at: now,
            cwd: PathBuf::from("/tmp/x"),
            archived: false,
        }
    }

    fn room(thread: &ThreadId) -> Room {
        let id = RoomId::new();
        Room {
            id: id.clone(),
            thread_id: thread.clone(),
            shape: RoomShape::Reviewed,
            participants: vec![Participant {
                id: ParticipantId::new(),
                name: "builder".into(),
                engine: EngineId::Claude,
                model: None,
                is_boss: false,
                native_session_id: None,
            }],
        }
    }

    #[test]
    fn empty_dir_opens_empty() {
        let dir = tempfile::tempdir().unwrap();
        let store = StateStore::open(Some(dir.path())).unwrap();
        assert!(store.projects().is_empty());
        assert!(store.threads().is_empty());
        assert!(store.rooms().is_empty());
    }

    #[test]
    fn add_project_dedupes_by_root_and_names_from_dir() {
        let dir = tempfile::tempdir().unwrap();
        let store = StateStore::open(Some(dir.path())).unwrap();
        let a = store.add_project(PathBuf::from("/code/boss"), None).unwrap();
        let b = store.add_project(PathBuf::from("/code/boss"), Some("other".into())).unwrap();
        assert_eq!(a, b);
        assert_eq!(a.name, "boss");
        assert_eq!(store.projects().len(), 1);
        assert_eq!(store.project_by_root(Path::new("/code/boss")).unwrap().id, a.id);
    }

    #[test]
    fn persists_across_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let (project, thread_id, room_id) = {
            let store = StateStore::open(Some(dir.path())).unwrap();
            let project = store.add_project(PathBuf::from("/code/a"), None).unwrap();
            let t = thread(&project.id, ThreadKind::Chat { engine: EngineId::Pi });
            store.upsert_thread(t.clone()).unwrap();
            let r = room(&t.id);
            store.upsert_room(r.clone()).unwrap();
            (project, t.id, r.id)
        };
        let store = StateStore::open(Some(dir.path())).unwrap();
        assert_eq!(store.project(&project.id).unwrap().root, PathBuf::from("/code/a"));
        assert_eq!(store.thread(&thread_id).unwrap().project_id, project.id);
        assert_eq!(store.room(&room_id).unwrap().thread_id, thread_id);
        assert_eq!(store.room_for_thread(&thread_id).unwrap().id, room_id);
        assert_eq!(store.rooms_for_project(&project.id).len(), 1);
        // Files are versioned envelopes.
        let raw: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.path().join("threads.json")).unwrap()).unwrap();
        assert_eq!(raw["version"], STATE_FILE_VERSION);
        assert_eq!(raw["items"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn upsert_replaces_in_place_and_update_bumps_updated_at() {
        let dir = tempfile::tempdir().unwrap();
        let store = StateStore::open(Some(dir.path())).unwrap();
        let project = store.add_project(PathBuf::from("/code/a"), None).unwrap();
        let t1 = thread(&project.id, ThreadKind::Assistant);
        let t2 = thread(&project.id, ThreadKind::Assistant);
        store.upsert_thread(t1.clone()).unwrap();
        store.upsert_thread(t2.clone()).unwrap();
        let mut renamed = t1.clone();
        renamed.title = "renamed".into();
        store.upsert_thread(renamed).unwrap();
        let ids: Vec<_> = store.threads().into_iter().map(|t| t.id).collect();
        assert_eq!(ids, vec![t1.id.clone(), t2.id.clone()]);
        assert_eq!(store.thread(&t1.id).unwrap().title, "renamed");

        let before = store.thread(&t2.id).unwrap().updated_at;
        std::thread::sleep(std::time::Duration::from_millis(2));
        let updated = store.update_thread(&t2.id, |t| t.archived = true).unwrap().unwrap();
        assert!(updated.archived);
        assert!(updated.updated_at > before);
        assert!(store.update_thread(&ThreadId::new(), |_| {}).unwrap().is_none());
    }

    #[test]
    fn removing_cascades() {
        let dir = tempfile::tempdir().unwrap();
        let store = StateStore::open(Some(dir.path())).unwrap();
        let a = store.add_project(PathBuf::from("/code/a"), None).unwrap();
        let b = store.add_project(PathBuf::from("/code/b"), None).unwrap();
        let ta = thread(&a.id, ThreadKind::Assistant);
        let tb = thread(&b.id, ThreadKind::Assistant);
        store.upsert_thread(ta.clone()).unwrap();
        store.upsert_thread(tb.clone()).unwrap();
        let ra = room(&ta.id);
        let rb = room(&tb.id);
        store.upsert_room(ra.clone()).unwrap();
        store.upsert_room(rb.clone()).unwrap();

        // Thread removal takes its room.
        assert!(store.remove_thread(&ta.id).unwrap());
        assert!(!store.remove_thread(&ta.id).unwrap());
        assert!(store.room(&ra.id).is_none());
        assert_eq!(store.threads_for_project(&a.id).len(), 0);

        // Project removal takes threads and rooms.
        assert!(store.remove_project(&b.id).unwrap());
        assert!(store.thread(&tb.id).is_none());
        assert!(store.room(&rb.id).is_none());
        assert_eq!(store.projects().len(), 1);

        // Room removal leaves the thread.
        let t = thread(&a.id, ThreadKind::Assistant);
        store.upsert_thread(t.clone()).unwrap();
        let r = room(&t.id);
        store.upsert_room(r.clone()).unwrap();
        assert!(store.remove_room(&r.id).unwrap());
        assert!(store.thread(&t.id).is_some());
        assert!(store.update_room(&r.id, |_| {}).unwrap().is_none());
    }

    #[test]
    fn newer_file_refuses_to_open() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("threads.json"), br#"{ "version": 99, "items": [] }"#).unwrap();
        assert!(matches!(StateStore::open(Some(dir.path())), Err(StoreError::Version { found: 99, .. })));
    }

    #[test]
    fn damaged_file_refuses_to_open() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("rooms.json"), b"{ broken").unwrap();
        assert!(StateStore::open(Some(dir.path())).is_err());
    }
}
