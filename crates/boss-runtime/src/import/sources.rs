//! One function per Electron file. Each collects into the report rather
//! than returning an error, so a corrupt `rooms.json` costs the user their
//! rooms and not their transcripts.

use super::convert;
use super::electron::*;
use super::report::ImportReport;
use boss_core::engine::EngineId;
use boss_core::ids::{MessageId, ParticipantId, ProjectId, RoomId, ThreadId};
use boss_core::store::settings::{McpConnection, McpTransport, slugify};
use boss_core::store::{SettingsStore, StateStore, TranscriptStore};
use boss_core::thread::{Project, Room, Thread, ThreadKind};
use rusqlite::OptionalExtension;
use serde::de::DeserializeOwned;
use serde_json::Value;
use std::collections::HashMap;
use std::io::BufReader;
use std::path::{Path, PathBuf};

/// `~/Library/Application Support/BOSS`, the sibling of the native folder.
/// `BOSS_ELECTRON_DATA` overrides, which is how the tests point at a copy.
pub fn default_electron_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("BOSS_ELECTRON_DATA") {
        return PathBuf::from(dir);
    }
    dirs::config_dir().unwrap_or_else(|| PathBuf::from(".")).join("BOSS")
}

/// Read and deserialize a JSON file from the source. Absent is `Ok(None)`;
/// unparseable is an error the caller records.
fn read_json<T: DeserializeOwned>(dir: &Path, name: &str) -> anyhow::Result<Option<T>> {
    let path = dir.join(name);
    if !path.exists() {
        return Ok(None);
    }
    let file = std::fs::File::open(&path)?;
    let value = serde_json::from_reader(BufReader::new(file))?;
    Ok(Some(value))
}

/// Copy a file the native stores read verbatim. Never overwrites: an
/// existing target file is the user's newer data.
pub fn copy_if_absent(source: &Path, target: &Path, name: &str, rep: &mut ImportReport) {
    let from = source.join(name);
    let to = target.join(name);
    if !from.exists() {
        return;
    }
    if to.exists() {
        rep.skipped_existing.push(name.to_string());
        return;
    }
    match std::fs::copy(&from, &to) {
        Ok(_) => rep.copied.push(name.to_string()),
        Err(e) => rep.error(format!("copy {name}: {e}")),
    }
}

/// The Electron project id for a path: the TS app hashed the path, so the
/// import cannot recompute it. Instead it maps by path, which is what
/// `backend-threads.json` also carries on every row.
pub struct Projects {
    /// Electron `projectPath` → native project.
    by_path: HashMap<String, ProjectId>,
}

impl Projects {
    pub fn lookup(&self, path: &str) -> Option<ProjectId> {
        self.by_path.get(path).cloned()
    }
}

/// `state.json` holds the project list as bare paths. A project already in
/// the native store (matched on root) keeps its id.
pub fn import_projects(source: &Path, state: &StateStore, rep: &mut ImportReport) -> Projects {
    let mut by_path = HashMap::new();
    let electron: State = match read_json(source, "state.json") {
        Ok(Some(s)) => s,
        Ok(None) => return Projects { by_path },
        Err(e) => {
            rep.error(format!("state.json: {e}"));
            return Projects { by_path };
        }
    };
    for root in &electron.projects {
        let path = PathBuf::from(root);
        if let Some(existing) = state.project_by_root(&path) {
            by_path.insert(root.clone(), existing.id);
            continue;
        }
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| root.clone());
        let project = Project {
            id: ProjectId::new(),
            name,
            root: path,
            added_at: time::OffsetDateTime::now_utc(),
        };
        match state.upsert_project(project.clone()) {
            Ok(()) => {
                by_path.insert(root.clone(), project.id);
                rep.counts.projects += 1;
            }
            Err(e) => rep.error(format!("project {root}: {e}")),
        }
    }
    Projects { by_path }
}

/// Electron thread ids are bare uuids; native ids carry a `thr_` prefix.
/// Keeping the raw id makes the import idempotent and lets the transcript
/// rows, which are keyed by the same string, line up without a table.
fn thread_id(raw: &str) -> ThreadId {
    ThreadId::from_raw(raw)
}

fn engine_of(backend: &str) -> Option<EngineId> {
    match backend {
        "claude" => Some(EngineId::Claude),
        "codex" => Some(EngineId::Codex),
        "opencode" => Some(EngineId::Opencode),
        "pi" => Some(EngineId::Pi),
        _ => None,
    }
}

/// Messages the sqlite pass already stored, so the `claude-threads.json`
/// pass can tell a message it must fill in from one it would only spoil.
#[derive(Default)]
pub struct Stored {
    seen: std::collections::HashSet<(String, String)>,
}

impl Stored {
    fn insert(&mut self, thread: &ThreadId, message: &MessageId) {
        self.seen.insert((thread.as_str().to_string(), message.as_str().to_string()));
    }
    fn contains(&self, thread: &ThreadId, message: &str) -> bool {
        self.seen.contains(&(thread.as_str().to_string(), message.to_string()))
    }
}

/// What the import learned about each imported thread, so later steps can
/// tell a known thread from a stale transcript row.
pub struct Threads {
    /// Every thread id now in the native store, Electron ids included.
    known: HashMap<String, ThreadId>,
    /// Native session id → thread, for `claude-threads.json`, which is
    /// keyed by session rather than by thread.
    by_session: HashMap<String, ThreadId>,
    /// Project path per thread, for sessions that carry only a path.
    project_of_session: HashMap<String, Option<ProjectId>>,
}

impl Threads {
    pub fn contains(&self, raw: &str) -> bool {
        self.known.contains_key(raw)
    }
    pub fn for_session(&self, session: &str) -> Option<&ThreadId> {
        self.by_session.get(session)
    }
}

/// `backend-threads.json` → native threads. Lab threads are dropped: the
/// Lab engine is out of scope for the native app, so a Lab thread would
/// import as a chat with no engine to run it.
pub fn import_threads(
    source: &Path,
    state: &StateStore,
    projects: &Projects,
    rep: &mut ImportReport,
) -> Threads {
    let mut out = Threads {
        known: HashMap::new(),
        by_session: HashMap::new(),
        project_of_session: HashMap::new(),
    };
    // Threads already in the native store count as known, so a re-run does
    // not import their messages a second time under a new id.
    for existing in state.threads() {
        out.known.insert(existing.id.as_str().to_string(), existing.id.clone());
    }

    let index: BackendThreads = match read_json(source, "backend-threads.json") {
        Ok(Some(v)) => v,
        Ok(None) => return out,
        Err(e) => {
            rep.error(format!("backend-threads.json: {e}"));
            return out;
        }
    };

    for row in index.threads {
        if row.id.is_empty() {
            continue;
        }
        let Some(engine) = engine_of(&row.backend_id) else {
            rep.skip("thread", &row.id, format!("engine {:?} is not in the native app", row.backend_id));
            continue;
        };
        let id = thread_id(&row.id);
        // `projectId: "global"` and an empty `projectPath` both mean a
        // thread with no project, which `Thread.project_id` now allows.
        let project = row
            .project_path
            .as_deref()
            .filter(|p| !p.is_empty())
            .and_then(|p| projects.lookup(p));
        let cwd = row
            .execution_path
            .as_deref()
            .filter(|p| !p.is_empty())
            .map(PathBuf::from)
            .or_else(|| row.project_path.as_deref().filter(|p| !p.is_empty()).map(PathBuf::from))
            .unwrap_or_else(boss_core::thread::scratch_cwd);
        let created = convert::from_millis(row.created_at);
        let thread = Thread {
            id: id.clone(),
            project_id: project.clone(),
            title: row.title.unwrap_or_else(|| "Untitled".into()),
            kind: ThreadKind::Chat { engine },
            created_at: created,
            updated_at: convert::from_millis(row.updated_at.or(row.created_at)),
            cwd,
            archived: row.archived.unwrap_or(false),
        };
        // Upsert, not insert: a re-run rewrites the same row.
        match state.upsert_thread(thread) {
            Ok(()) => {
                if out.known.insert(row.id.clone(), id.clone()).is_none() {
                    rep.counts.threads += 1;
                }
                if let Some(session) = row.native_session_id.filter(|s| !s.is_empty()) {
                    out.project_of_session.insert(session.clone(), project);
                    out.by_session.insert(session, id);
                }
            }
            Err(e) => rep.error(format!("thread {}: {e}", row.id)),
        }
    }
    out
}

/// `rooms.json` in either shape. The native app overwrote the Electron file
/// with its own `{ version, items }` at one point, so the format is sniffed
/// rather than assumed: `items` is native and imports directly, `rooms` is
/// the Electron list.
pub fn import_rooms(source: &Path, state: &StateStore, threads: &Threads, rep: &mut ImportReport) {
    let raw: Value = match read_json(source, "rooms.json") {
        Ok(Some(v)) => v,
        Ok(None) => return,
        Err(e) => {
            rep.error(format!("rooms.json: {e}"));
            return;
        }
    };
    let native_shape = raw.get("items").is_some();
    let list = raw
        .get("items")
        .or_else(|| raw.get("rooms"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    for entry in list {
        let room = if native_shape {
            match serde_json::from_value::<Room>(entry.clone()) {
                Ok(r) => r,
                Err(e) => {
                    rep.error(format!("room: {e}"));
                    continue;
                }
            }
        } else {
            match electron_room(&entry) {
                Some(r) => r,
                None => {
                    let id = entry.get("id").and_then(Value::as_str).unwrap_or("?");
                    rep.skip("room", id, "unrecognised room shape");
                    continue;
                }
            }
        };
        // A room whose thread did not import would be unreachable.
        if !threads.contains(room.thread_id.as_str()) && state.thread(&room.thread_id).is_none() {
            rep.skip("room", room.id.as_str(), "thread was not imported");
            continue;
        }
        match state.upsert_room(room) {
            Ok(()) => rep.counts.rooms += 1,
            Err(e) => rep.error(format!("room: {e}")),
        }
    }
}

/// An Electron room row: `{ id, threadId, shape, participants: [...] }`.
fn electron_room(entry: &Value) -> Option<Room> {
    let id = entry.get("id").and_then(Value::as_str)?;
    let thread = entry.get("threadId").or_else(|| entry.get("thread_id")).and_then(Value::as_str)?;
    let shape = match entry.get("shape").and_then(Value::as_str) {
        Some("full") => boss_core::thread::RoomShape::Full,
        Some("direct") => boss_core::thread::RoomShape::Direct,
        _ => boss_core::thread::RoomShape::Reviewed,
    };
    let participants = entry
        .get("participants")
        .and_then(Value::as_array)
        .map(|list| list.iter().filter_map(electron_participant).collect())
        .unwrap_or_default();
    Some(Room { id: RoomId::from_raw(id), thread_id: ThreadId::from_raw(thread), shape, participants })
}

fn electron_participant(entry: &Value) -> Option<boss_core::thread::Participant> {
    let id = entry.get("id").and_then(Value::as_str)?;
    let engine = engine_of(
        entry
            .get("engine")
            .or_else(|| entry.get("backendId"))
            .and_then(Value::as_str)
            .unwrap_or("claude"),
    )?;
    Some(boss_core::thread::Participant {
        id: ParticipantId::from_raw(id),
        name: entry.get("name").and_then(Value::as_str).unwrap_or(id).to_string(),
        engine,
        model: entry.get("model").and_then(Value::as_str).map(str::to_string),
        is_boss: entry.get("isBoss").or_else(|| entry.get("is_boss")).and_then(Value::as_bool).unwrap_or(false),
        native_session_id: entry
            .get("nativeSessionId")
            .or_else(|| entry.get("native_session_id"))
            .and_then(Value::as_str)
            .map(str::to_string),
    })
}

/// `mcp-connections.json` → `Settings.mcp_connections`. Encrypted secrets
/// stay behind: `safeStorage` ciphertext can only be read by Electron on
/// the machine that wrote it, so the user re-enters those tokens.
pub fn import_mcp_connections(source: &Path, settings: &SettingsStore, rep: &mut ImportReport) {
    let file: McpConnections = match read_json(source, "mcp-connections.json") {
        Ok(Some(v)) => v,
        Ok(None) => return,
        Err(e) => {
            rep.error(format!("mcp-connections.json: {e}"));
            return;
        }
    };
    let mut added = 0usize;
    let mut pending = Vec::new();
    let existing = settings.get();
    for row in file.connections {
        let id = row.id.clone().unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        if existing.mcp_connections.iter().any(|c| c.id == id) {
            continue;
        }
        let encrypted = row.secrets_encrypted.unwrap_or(false);
        if encrypted && (row.auth_token.is_some() || !row.headers.is_empty()) {
            rep.skip(
                "mcp_secret",
                &row.name,
                "safeStorage ciphertext cannot be decrypted outside Electron; re-enter the token",
            );
        }
        pending.push(McpConnection {
            slug: row.slug.unwrap_or_else(|| slugify(&row.name)),
            id,
            enabled: row.enabled.unwrap_or(true),
            transport: match row.transport.as_deref() {
                Some("http") => McpTransport::Http,
                _ => McpTransport::Stdio,
            },
            command: row.command,
            args: row.args,
            env: row.env,
            url: row.url,
            auth_scheme: row.auth_scheme.filter(|s| !s.is_empty()),
            // Header values are ciphertext when `secretsEncrypted` is set;
            // keeping them would send garbage in an Authorization header.
            headers: if encrypted { Default::default() } else { row.headers },
            created_at: convert::from_millis(row.created_at),
            name: row.name,
        });
        added += 1;
    }
    if added == 0 {
        return;
    }
    // `update`, not a read-modify-write: it holds the store's lock across
    // the edit, so a setting changed elsewhere is not clobbered.
    match settings.update(|s| {
        for connection in pending {
            if !s.mcp_connections.iter().any(|c| c.id == connection.id) {
                s.mcp_connections.push(connection);
            }
        }
    }) {
        Ok(_) => rep.counts.mcp_connections += added,
        Err(e) => rep.error(format!("settings: {e}")),
    }
}

/// Open the Electron transcripts database without touching the folder it
/// lives in.
///
/// `mode=ro` is not enough. The Electron app leaves the database in WAL
/// mode, and a WAL reader needs to create a `-shm` file to join the shared
/// index — so `mode=ro` on a WAL database beside a `-wal` either fails
/// outright or writes two files into the user's data folder, which this
/// import promised not to do. Verified on the user's own copy: `mode=ro`
/// left a `transcripts.sqlite-shm` and `-wal` behind.
///
/// `immutable=1` tells SQLite the file cannot change, so it reads the
/// database directly with no locking and no sidecars. The trade-off is
/// that data sitting in an un-checkpointed `-wal` is not visible; that is
/// the right call here, because the alternative is writing to the folder.
fn open_read_only(path: &Path, rep: &mut ImportReport) -> Option<rusqlite::Connection> {
    let uri = format!("file:{}?immutable=1", path.display());
    match rusqlite::Connection::open_with_flags(
        &uri,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_URI,
    ) {
        Ok(conn) => Some(conn),
        Err(e) => {
            rep.error(format!("open transcripts.sqlite read-only: {e}"));
            None
        }
    }
}

/// `transcripts.sqlite` → the native `messages`/`parts` tables.
///
/// The database is opened read-only and *immutably*, so nothing is written
/// or created beside the user's file — see [`open_read_only`]. Only the
/// `transcript_*` tables are read: the native app wrote its
/// own `messages`/`parts` into this same database before the folders were
/// split, and those rows are already in the native store.
pub fn import_transcripts(
    source: &Path,
    target: &TranscriptStore,
    threads: &Threads,
    rep: &mut ImportReport,
) -> Stored {
    let mut stored = Stored::default();
    let path = source.join("transcripts.sqlite");
    if !path.exists() {
        return stored;
    }
    let Some(conn) = open_read_only(&path, rep) else { return stored };
    // A source without the Electron tables is nothing to import.
    let has: Option<String> = conn
        .query_row("SELECT name FROM sqlite_master WHERE name = 'transcript_messages'", [], |r| r.get(0))
        .optional()
        .unwrap_or(None);
    if has.is_none() {
        return stored;
    }

    // Parts, grouped per message, so each message is written once with all
    // of its parts. Streamed in thread/position order rather than loaded
    // whole: the user's database is 229 MB.
    let mut parts_by_message: HashMap<(String, String), Vec<Value>> = HashMap::new();
    match conn.prepare("SELECT thread_id, message_id, data_json FROM transcript_parts ORDER BY thread_id, message_id, position") {
        Ok(mut stmt) => {
            let rows = stmt.query_map([], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?))
            });
            match rows {
                Ok(rows) => {
                    for row in rows.flatten() {
                        let (thread, message, json) = row;
                        if let Ok(value) = serde_json::from_str::<Value>(&json) {
                            parts_by_message.entry((thread, message)).or_default().push(value);
                        }
                    }
                }
                Err(e) => rep.error(format!("read transcript_parts: {e}")),
            }
        }
        Err(e) => rep.error(format!("prepare transcript_parts: {e}")),
    }

    let mut stmt = match conn
        .prepare("SELECT thread_id, message_id, data_json FROM transcript_messages ORDER BY thread_id, position")
    {
        Ok(s) => s,
        Err(e) => {
            rep.error(format!("prepare transcript_messages: {e}"));
            return stored;
        }
    };
    let rows = match stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?)))
    {
        Ok(rows) => rows,
        Err(e) => {
            rep.error(format!("read transcript_messages: {e}"));
            return stored;
        }
    };
    for row in rows.flatten() {
        let (thread_raw, message_raw, json) = row;
        if !threads.contains(&thread_raw) {
            rep.skip("message", &message_raw, "thread was not imported");
            continue;
        }
        let info: MessageInfo = match serde_json::from_str(&json) {
            Ok(v) => v,
            Err(e) => {
                rep.error(format!("message {message_raw}: {e}"));
                continue;
            }
        };
        let parts = parts_by_message.remove(&(thread_raw.clone(), message_raw.clone())).unwrap_or_default();
        let thread = ThreadId::from_raw(thread_raw);
        if let Some(id) = write_message(target, &thread, &info, &parts, &message_raw, rep) {
            stored.insert(&thread, &id);
        }
    }
    stored
}

/// Convert and store one message, counting what landed. Returns the id it
/// wrote, so the caller can record that this message is already covered.
fn write_message(
    target: &TranscriptStore,
    thread: &ThreadId,
    info: &MessageInfo,
    parts: &[Value],
    fallback_id: &str,
    rep: &mut ImportReport,
) -> Option<MessageId> {
    let mut message = match convert::message(thread, info, parts) {
        Some(m) => m,
        None => {
            rep.skip("message", fallback_id, "no content after conversion");
            return None;
        }
    };
    if message.id.as_str().is_empty() {
        message.id = MessageId::from_raw(fallback_id);
    }
    let part_count = message.parts.len();
    match target.upsert_message(&message) {
        Ok(()) => {
            rep.counts.messages += 1;
            rep.counts.parts += part_count;
            Some(message.id)
        }
        Err(e) => {
            rep.error(format!("store message {}: {e}", message.id));
            None
        }
    }
}

/// `claude-threads.json` → transcripts, but only for messages the sqlite
/// pass did not already store.
///
/// This file is a *fallback*, not a second opinion. Where the two sources
/// describe the same message, the JSON copy is the poorer one: measured on
/// the user's data, 14,498 of 20,479 shared messages carry fewer parts here
/// than in `transcript_parts` (tool calls and reasoning that the sqlite
/// tables kept). Writing it over the sqlite row would silently drop them,
/// so `stored` gates every write and the file only fills genuine gaps.
///
/// The user's copy is 129 MB, so it is never turned into a
/// `serde_json::Value`. `serde_json::Deserializer::from_reader` walks the
/// `sessions` map with a visitor that deserializes one session at a time
/// into typed structs and drops it before reading the next, which keeps
/// memory to the size of the largest session rather than the file.
pub fn import_claude_threads(
    source: &Path,
    target: &TranscriptStore,
    threads: &Threads,
    stored: &Stored,
    rep: &mut ImportReport,
) {
    let path = source.join("claude-threads.json");
    if !path.exists() {
        return;
    }
    let file = match std::fs::File::open(&path) {
        Ok(f) => f,
        Err(e) => {
            rep.error(format!("open claude-threads.json: {e}"));
            return;
        }
    };
    // 1 MiB of buffer: the file is one long line, so the reader is doing
    // nothing but sequential fills.
    let reader = BufReader::with_capacity(1 << 20, file);
    let mut de = serde_json::Deserializer::from_reader(reader);
    let visitor = SessionsVisitor { target, threads, stored, rep };
    if let Err(e) = serde::de::DeserializeSeed::deserialize(visitor, &mut de) {
        // The seed's own errors are already in the report; this catches a
        // truncated or malformed file.
        rep.error(format!("claude-threads.json: {e}"));
    }
}

/// Streams the top-level object, handling `sessions` entry by entry.
struct SessionsVisitor<'a> {
    target: &'a TranscriptStore,
    threads: &'a Threads,
    /// Messages the sqlite pass already wrote, which must not be overwritten.
    stored: &'a Stored,
    rep: &'a mut ImportReport,
}

impl<'de> serde::de::DeserializeSeed<'de> for SessionsVisitor<'_> {
    type Value = ();
    fn deserialize<D: serde::Deserializer<'de>>(self, d: D) -> Result<(), D::Error> {
        d.deserialize_map(self)
    }
}

impl<'de> serde::de::Visitor<'de> for SessionsVisitor<'_> {
    type Value = ();

    fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        f.write_str("the claude-threads.json object")
    }

    fn visit_map<A: serde::de::MapAccess<'de>>(mut self, mut map: A) -> Result<(), A::Error> {
        while let Some(key) = map.next_key::<String>()? {
            if key != "sessions" {
                // `version`, and anything a later version added.
                let _: serde::de::IgnoredAny = map.next_value()?;
                continue;
            }
            map.next_value_seed(SessionMapSeed { inner: &mut self })?;
        }
        Ok(())
    }
}

struct SessionMapSeed<'a, 'b> {
    inner: &'a mut SessionsVisitor<'b>,
}

impl<'de> serde::de::DeserializeSeed<'de> for SessionMapSeed<'_, '_> {
    type Value = ();
    fn deserialize<D: serde::Deserializer<'de>>(self, d: D) -> Result<(), D::Error> {
        d.deserialize_map(self)
    }
}

impl<'de> serde::de::Visitor<'de> for SessionMapSeed<'_, '_> {
    type Value = ();

    fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        f.write_str("a map of session id to session")
    }

    fn visit_map<A: serde::de::MapAccess<'de>>(self, mut map: A) -> Result<(), A::Error> {
        while let Some(session_id) = map.next_key::<String>()? {
            // One session in memory at a time, then dropped.
            let session: ClaudeSession = map.next_value()?;
            let Some(thread) = self.inner.threads.for_session(&session_id).cloned() else {
                self.inner.rep.skip(
                    "session",
                    &session_id,
                    "no thread in backend-threads.json points at this session",
                );
                continue;
            };
            for message in &session.messages {
                let id = message.info.id.as_deref().unwrap_or("");
                // The sqlite row for this message is richer; leave it alone.
                if self.inner.stored.contains(&thread, id) {
                    continue;
                }
                write_message(
                    self.inner.target,
                    &thread,
                    &message.info,
                    &message.parts,
                    id,
                    self.inner.rep,
                );
            }
        }
        Ok(())
    }
}
