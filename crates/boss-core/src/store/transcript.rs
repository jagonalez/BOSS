//! Durable transcript: every [`Message`] BOSS has shown, in SQLite.
//!
//! Ported from `transcript-store.ts` with a smaller schema: one row per
//! message with the columns the app filters and sums on, and one row per
//! part holding the part as JSON. Parts are the payload; columns are the
//! index. WAL mode so the UI can read while an engine writes.

use super::Result;
use crate::ids::{MessageId, ParticipantId, ThreadId};
use crate::message::{Message, MessageStatus, Part, Role, Usage};
use rusqlite::{Connection, OptionalExtension, params};
use std::path::Path;
use std::sync::Mutex;
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

/// Tool output longer than this is cut when stored. Same bound as the
/// Electron app.
pub const MAX_TOOL_OUTPUT_CHARS: usize = 100_000;
const TRUNCATED_MARK: &str = "\n[output truncated by BOSS]";

/// Characters of context before a match in a snippet.
const SNIPPET_LEAD: usize = 70;
/// Total snippet length.
const SNIPPET_LEN: usize = 220;

/// Schema steps, applied in order. `schema_migrations.version` is the
/// 1-based index of the last one applied.
const MIGRATIONS: &[&str] = &[
    // v1: messages + parts.
    "CREATE TABLE messages (
        thread_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        role TEXT NOT NULL,
        author TEXT,
        recipient TEXT,
        branch_of TEXT,
        status TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0,
        model TEXT,
        created_at TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        input_tokens INTEGER,
        output_tokens INTEGER,
        cache_read_tokens INTEGER,
        cache_write_tokens INTEGER,
        cost_usd REAL,
        search_text TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (thread_id, message_id)
    );
    CREATE INDEX messages_order ON messages(thread_id, position);
    CREATE INDEX messages_recent ON messages(updated_at DESC);
    CREATE TABLE parts (
        thread_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        part_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        kind TEXT NOT NULL,
        data_json TEXT NOT NULL,
        PRIMARY KEY (thread_id, message_id, part_id)
    );
    CREATE INDEX parts_order ON parts(thread_id, message_id, position);",
];

/// One search match.
#[derive(Clone, Debug, PartialEq)]
pub struct SearchHit {
    /// Thread the message is in.
    pub thread_id: ThreadId,
    /// Matching message.
    pub message_id: MessageId,
    /// Who wrote it.
    pub role: Role,
    /// Around 220 chars around the first match, ellipsised.
    pub snippet: String,
    /// When the message was created.
    pub created_at: OffsetDateTime,
}

/// The transcript database. `Send + Sync`; one connection behind a mutex.
#[derive(Debug)]
pub struct TranscriptStore {
    conn: Mutex<Connection>,
    fts: bool,
}

impl TranscriptStore {
    /// Open (or create) the database at `path` and bring the schema up to
    /// date. Parent directories are created.
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|source| super::StoreError::Io { path: parent.to_path_buf(), source })?;
        }
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        Self::init(conn)
    }

    /// `transcripts.sqlite` under `base`, or under the user data dir when
    /// `base` is `None`.
    pub fn open_in(base: Option<&Path>) -> Result<Self> {
        let dir = base.map(Path::to_path_buf).unwrap_or_else(crate::paths::user_data_dir);
        Self::open(&dir.join("transcripts.sqlite"))
    }

    /// A throwaway database that lives only in memory.
    pub fn open_in_memory() -> Result<Self> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(mut conn: Connection) -> Result<Self> {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS schema_migrations (
                version INTEGER PRIMARY KEY,
                applied_at TEXT NOT NULL
            );",
        )?;
        let current: u32 =
            conn.query_row("SELECT COALESCE(MAX(version), 0) FROM schema_migrations", [], |r| r.get(0))?;
        for (i, sql) in MIGRATIONS.iter().enumerate() {
            let version = i as u32 + 1;
            if version <= current {
                continue;
            }
            let tx = conn.transaction()?;
            tx.execute_batch(sql)?;
            tx.execute(
                "INSERT INTO schema_migrations(version, applied_at) VALUES (?1, ?2)",
                params![version, now_rfc3339()],
            )?;
            tx.commit()?;
        }
        let fts = has_fts5(&conn);
        if fts {
            ensure_fts(&mut conn)?;
        }
        Ok(Self { conn: Mutex::new(conn), fts })
    }

    /// Whether search runs on FTS5 (true) or `LIKE` (false).
    pub fn uses_fts(&self) -> bool {
        self.fts
    }

    /// Current schema version.
    pub fn schema_version(&self) -> Result<u32> {
        let conn = self.lock();
        Ok(conn.query_row("SELECT COALESCE(MAX(version), 0) FROM schema_migrations", [], |r| r.get(0))?)
    }

    /// Insert or replace a message and all of its parts. A message keeps
    /// its position in the thread across updates; a new one goes last.
    pub fn upsert_message(&self, message: &Message) -> Result<()> {
        let mut conn = self.lock();
        let tx = conn.transaction()?;
        let thread = message.thread_id.as_str();
        let id = message.id.as_str();
        let position: i64 = tx
            .query_row(
                "SELECT position FROM messages WHERE thread_id = ?1 AND message_id = ?2",
                params![thread, id],
                |r| r.get(0),
            )
            .optional()?
            .map(Ok::<i64, rusqlite::Error>)
            .unwrap_or_else(|| {
                tx.query_row(
                    "SELECT COALESCE(MAX(position), -1) + 1 FROM messages WHERE thread_id = ?1",
                    params![thread],
                    |r| r.get(0),
                )
            })?;
        let usage = message.usage.as_ref();
        let search_text = search_text(message);
        tx.execute(
            "INSERT INTO messages (
                thread_id, message_id, position, role, author, recipient, branch_of, status,
                revision, model, created_at, updated_at, input_tokens, output_tokens,
                cache_read_tokens, cache_write_tokens, cost_usd, search_text
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)
            ON CONFLICT(thread_id, message_id) DO UPDATE SET
                role = excluded.role, author = excluded.author, recipient = excluded.recipient,
                branch_of = excluded.branch_of, status = excluded.status, revision = excluded.revision,
                model = excluded.model, created_at = excluded.created_at, updated_at = excluded.updated_at,
                input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens,
                cache_read_tokens = excluded.cache_read_tokens, cache_write_tokens = excluded.cache_write_tokens,
                cost_usd = excluded.cost_usd, search_text = excluded.search_text",
            params![
                thread,
                id,
                position,
                role_str(message.role),
                message.author.as_ref().map(ParticipantId::as_str),
                message.recipient.as_ref().map(ParticipantId::as_str),
                message.branch_of.as_ref().map(MessageId::as_str),
                status_str(message.status),
                message.revision as i64,
                message.model.as_deref(),
                message.created_at.format(&Rfc3339).unwrap_or_default(),
                now_millis(),
                usage.map(|u| u.input_tokens as i64),
                usage.map(|u| u.output_tokens as i64),
                usage.map(|u| u.cache_read_tokens as i64),
                usage.map(|u| u.cache_write_tokens as i64),
                usage.and_then(|u| u.cost_usd),
                search_text,
            ],
        )?;
        tx.execute("DELETE FROM parts WHERE thread_id = ?1 AND message_id = ?2", params![thread, id])?;
        {
            let mut insert = tx.prepare_cached(
                "INSERT INTO parts (thread_id, message_id, part_id, position, kind, data_json)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            )?;
            for (i, part) in message.parts.iter().enumerate() {
                let bounded = bounded_part(part);
                let json = serde_json::to_string(&bounded)?;
                insert.execute(params![thread, id, part.id().as_str(), i as i64, part_kind(part), json])?;
            }
        }
        if self.fts {
            tx.execute("DELETE FROM messages_fts WHERE thread_id = ?1 AND message_id = ?2", params![thread, id])?;
            tx.execute(
                "INSERT INTO messages_fts (thread_id, message_id, body) VALUES (?1, ?2, ?3)",
                params![thread, id, search_text],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    /// One message with its parts.
    pub fn message(&self, thread: &ThreadId, id: &MessageId) -> Result<Option<Message>> {
        let conn = self.lock();
        let mut rows = self.load_messages(
            &conn,
            "WHERE thread_id = ?1 AND message_id = ?2",
            params![thread.as_str(), id.as_str()],
        )?;
        Ok(rows.pop())
    }

    /// Every message in a thread, in transcript order.
    pub fn messages_for_thread(&self, thread: &ThreadId) -> Result<Vec<Message>> {
        let conn = self.lock();
        self.load_messages(&conn, "WHERE thread_id = ?1", params![thread.as_str()])
    }

    /// Ids of every thread that has at least one message.
    pub fn thread_ids(&self) -> Result<Vec<ThreadId>> {
        let conn = self.lock();
        let mut stmt = conn.prepare("SELECT DISTINCT thread_id FROM messages ORDER BY thread_id")?;
        let ids = stmt.query_map([], |r| r.get::<_, String>(0))?.collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(ids.into_iter().map(ThreadId::from_raw).collect())
    }

    /// Remove one message and its parts. Returns whether it existed.
    pub fn delete_message(&self, thread: &ThreadId, id: &MessageId) -> Result<bool> {
        let mut conn = self.lock();
        let tx = conn.transaction()?;
        let key = params![thread.as_str(), id.as_str()];
        tx.execute("DELETE FROM parts WHERE thread_id = ?1 AND message_id = ?2", key)?;
        if self.fts {
            tx.execute("DELETE FROM messages_fts WHERE thread_id = ?1 AND message_id = ?2", key)?;
        }
        let n = tx.execute("DELETE FROM messages WHERE thread_id = ?1 AND message_id = ?2", key)?;
        tx.commit()?;
        Ok(n > 0)
    }

    /// Remove everything recorded for a thread.
    pub fn delete_thread(&self, thread: &ThreadId) -> Result<()> {
        let mut conn = self.lock();
        let tx = conn.transaction()?;
        tx.execute("DELETE FROM parts WHERE thread_id = ?1", params![thread.as_str()])?;
        if self.fts {
            tx.execute("DELETE FROM messages_fts WHERE thread_id = ?1", params![thread.as_str()])?;
        }
        tx.execute("DELETE FROM messages WHERE thread_id = ?1", params![thread.as_str()])?;
        tx.commit()?;
        Ok(())
    }

    /// Messages whose text, reasoning, or tool calls contain `query`, most
    /// recently updated first. Queries under two characters return nothing;
    /// `limit` is clamped to 1..=100. `thread` confines the search so the
    /// limit is not spent on busier threads.
    pub fn search(&self, query: &str, limit: usize, thread: Option<&ThreadId>) -> Result<Vec<SearchHit>> {
        let clean = query.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase();
        if clean.chars().count() < 2 {
            return Ok(Vec::new());
        }
        let limit = limit.clamp(1, 100) as i64;
        let conn = self.lock();
        let thread_filter = thread.map(|t| t.as_str().to_owned());
        let rows: Vec<SearchRow> = if self.fts {
            let sql = format!(
                "SELECT m.thread_id, m.message_id, m.role, m.created_at, m.search_text
                 FROM messages_fts
                 JOIN messages m ON m.thread_id = messages_fts.thread_id AND m.message_id = messages_fts.message_id
                 WHERE messages_fts MATCH ?1 {}
                 ORDER BY m.updated_at DESC LIMIT ?3",
                if thread_filter.is_some() { "AND m.thread_id = ?2" } else { "AND ?2 IS NULL" }
            );
            let mut stmt = conn.prepare(&sql)?;
            let it = stmt.query_map(params![fts_query(&clean), thread_filter, limit], row_tuple)?;
            it.collect::<std::result::Result<_, _>>()?
        } else {
            let pattern = format!("%{}%", escape_like(&clean));
            let sql = format!(
                "SELECT thread_id, message_id, role, created_at, search_text FROM messages
                 WHERE lower(search_text) LIKE ?1 ESCAPE '\\' {}
                 ORDER BY updated_at DESC LIMIT ?3",
                if thread_filter.is_some() { "AND thread_id = ?2" } else { "AND ?2 IS NULL" }
            );
            let mut stmt = conn.prepare(&sql)?;
            let it = stmt.query_map(params![pattern, thread_filter, limit], row_tuple)?;
            it.collect::<std::result::Result<_, _>>()?
        };
        Ok(rows
            .into_iter()
            .map(|(thread_id, message_id, role, created_at, text)| SearchHit {
                thread_id: ThreadId::from_raw(thread_id),
                message_id: MessageId::from_raw(message_id),
                role: parse_role(&role),
                snippet: snippet(&text, &clean),
                created_at: parse_time(&created_at),
            })
            .collect())
    }

    /// Token and cost sums over every message in a thread.
    pub fn usage_totals(&self, thread: &ThreadId) -> Result<Usage> {
        let conn = self.lock();
        let usage = conn.query_row(
            "SELECT COALESCE(SUM(input_tokens), 0), COALESCE(SUM(output_tokens), 0),
                    COALESCE(SUM(cache_read_tokens), 0), COALESCE(SUM(cache_write_tokens), 0),
                    SUM(cost_usd)
             FROM messages WHERE thread_id = ?1",
            params![thread.as_str()],
            |r| {
                Ok(Usage {
                    input_tokens: r.get::<_, i64>(0)? as u64,
                    output_tokens: r.get::<_, i64>(1)? as u64,
                    cache_read_tokens: r.get::<_, i64>(2)? as u64,
                    cache_write_tokens: r.get::<_, i64>(3)? as u64,
                    cost_usd: r.get::<_, Option<f64>>(4)?,
                })
            },
        )?;
        Ok(usage)
    }

    /// How many messages a thread has.
    pub fn message_count(&self, thread: &ThreadId) -> Result<usize> {
        let conn = self.lock();
        let n: i64 =
            conn.query_row("SELECT COUNT(*) FROM messages WHERE thread_id = ?1", params![thread.as_str()], |r| r.get(0))?;
        Ok(n as usize)
    }

    fn load_messages(&self, conn: &Connection, filter: &str, args: &[&dyn rusqlite::ToSql]) -> Result<Vec<Message>> {
        let sql = format!(
            "SELECT thread_id, message_id, role, author, recipient, branch_of, status, revision, model,
                    created_at, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd
             FROM messages {filter} ORDER BY position, created_at"
        );
        let mut stmt = conn.prepare(&sql)?;
        let mut messages: Vec<Message> = stmt
            .query_map(args, |r| {
                let usage = match r.get::<_, Option<i64>>(10)? {
                    None => None,
                    Some(input) => Some(Usage {
                        input_tokens: input as u64,
                        output_tokens: r.get::<_, Option<i64>>(11)?.unwrap_or(0) as u64,
                        cache_read_tokens: r.get::<_, Option<i64>>(12)?.unwrap_or(0) as u64,
                        cache_write_tokens: r.get::<_, Option<i64>>(13)?.unwrap_or(0) as u64,
                        cost_usd: r.get(14)?,
                    }),
                };
                Ok(Message {
                    thread_id: ThreadId::from_raw(r.get::<_, String>(0)?),
                    id: MessageId::from_raw(r.get::<_, String>(1)?),
                    role: parse_role(&r.get::<_, String>(2)?),
                    author: r.get::<_, Option<String>>(3)?.map(ParticipantId::from_raw),
                    recipient: r.get::<_, Option<String>>(4)?.map(ParticipantId::from_raw),
                    branch_of: r.get::<_, Option<String>>(5)?.map(MessageId::from_raw),
                    status: parse_status(&r.get::<_, String>(6)?),
                    revision: r.get::<_, i64>(7)? as u64,
                    model: r.get(8)?,
                    created_at: parse_time(&r.get::<_, String>(9)?),
                    parts: Vec::new(),
                    usage,
                })
            })?
            .collect::<std::result::Result<_, _>>()?;
        let mut parts_stmt = conn.prepare_cached(
            "SELECT data_json FROM parts WHERE thread_id = ?1 AND message_id = ?2 ORDER BY position",
        )?;
        for message in &mut messages {
            let rows = parts_stmt.query_map(params![message.thread_id.as_str(), message.id.as_str()], |r| {
                r.get::<_, String>(0)
            })?;
            for json in rows {
                match serde_json::from_str::<Part>(&json?) {
                    Ok(part) => message.parts.push(part),
                    Err(err) => tracing::warn!(id = %message.id, "dropping unreadable part: {err}"),
                }
            }
        }
        Ok(messages)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

type SearchRow = (String, String, String, String, String);

fn row_tuple(r: &rusqlite::Row<'_>) -> rusqlite::Result<SearchRow> {
    Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
}

fn has_fts5(conn: &Connection) -> bool {
    conn.prepare("SELECT 1 FROM pragma_compile_options WHERE compile_options = 'ENABLE_FTS5'")
        .and_then(|mut s| s.exists([]))
        .unwrap_or(false)
}

/// Create the FTS index if missing and fill it from `messages` when it is
/// empty but messages exist (a database first written without FTS5).
fn ensure_fts(conn: &mut Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts
         USING fts5(thread_id UNINDEXED, message_id UNINDEXED, body, tokenize = 'unicode61');",
    )?;
    let indexed: i64 = conn.query_row("SELECT COUNT(*) FROM messages_fts", [], |r| r.get(0))?;
    let stored: i64 = conn.query_row("SELECT COUNT(*) FROM messages", [], |r| r.get(0))?;
    if indexed == 0 && stored > 0 {
        conn.execute_batch(
            "INSERT INTO messages_fts (thread_id, message_id, body)
             SELECT thread_id, message_id, search_text FROM messages;",
        )?;
    }
    Ok(())
}

/// Every token quoted and prefix-matched, joined with implicit AND.
fn fts_query(clean: &str) -> String {
    clean
        .split_whitespace()
        .map(|tok| format!("\"{}\"*", tok.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" ")
}

fn escape_like(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        if matches!(ch, '\\' | '%' | '_') {
            out.push('\\');
        }
        out.push(ch);
    }
    out
}

/// What search sees for a message: text, reasoning, tool name, title,
/// input, and output, and attachment names, whitespace collapsed.
fn search_text(message: &Message) -> String {
    let mut pieces: Vec<String> = Vec::new();
    for part in &message.parts {
        match part {
            Part::Text(p) => pieces.push(p.text.clone()),
            Part::Reasoning(p) => pieces.push(p.text.clone()),
            Part::ToolCall(p) => {
                let mut bits = vec![p.name.clone()];
                if let Some(t) = &p.title {
                    bits.push(t.clone());
                }
                if !p.input.is_null() {
                    bits.push(p.input.to_string());
                }
                if let Some(o) = &p.output {
                    bits.push(o.clone());
                }
                pieces.push(bits.join(" · "));
            }
            Part::Attachment(p) => {
                if let Some(n) = &p.name {
                    pieces.push(n.clone());
                }
            }
        }
    }
    pieces.join("\n").split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Around 220 chars around the first occurrence of any query token.
fn snippet(text: &str, clean: &str) -> String {
    let lower = text.to_lowercase();
    let hit = std::iter::once(clean).chain(clean.split_whitespace()).find_map(|needle| lower.find(needle)).unwrap_or(0);
    // Work in chars so a multi-byte match does not split a code point.
    let hit_chars = lower[..hit].chars().count();
    let chars: Vec<char> = text.chars().collect();
    let start = hit_chars.saturating_sub(SNIPPET_LEAD);
    let end = (start + SNIPPET_LEN).min(chars.len());
    let mut out = String::new();
    if start > 0 {
        out.push('…');
    }
    out.extend(&chars[start..end]);
    if end < chars.len() {
        out.push('…');
    }
    out
}

fn bounded_part(part: &Part) -> Part {
    match part {
        Part::ToolCall(p) if p.output.as_ref().is_some_and(|o| o.chars().count() > MAX_TOOL_OUTPUT_CHARS) => {
            let mut cut = p.clone();
            let output = cut.output.take().unwrap_or_default();
            let mut head: String = output.chars().take(MAX_TOOL_OUTPUT_CHARS).collect();
            head.push_str(TRUNCATED_MARK);
            cut.output = Some(head);
            Part::ToolCall(cut)
        }
        other => other.clone(),
    }
}

fn part_kind(part: &Part) -> &'static str {
    match part {
        Part::Text(_) => "text",
        Part::Reasoning(_) => "reasoning",
        Part::ToolCall(_) => "tool_call",
        Part::Attachment(_) => "attachment",
    }
}

fn role_str(role: Role) -> &'static str {
    match role {
        Role::User => "user",
        Role::Assistant => "assistant",
        Role::System => "system",
    }
}

fn parse_role(s: &str) -> Role {
    match s {
        "user" => Role::User,
        "system" => Role::System,
        _ => Role::Assistant,
    }
}

fn status_str(status: MessageStatus) -> &'static str {
    match status {
        MessageStatus::Streaming => "streaming",
        MessageStatus::Complete => "complete",
        MessageStatus::Interrupted => "interrupted",
        MessageStatus::Error => "error",
    }
}

/// A stored `streaming` status means the app stopped before the engine
/// finished, so it reads back as `interrupted`.
fn parse_status(s: &str) -> MessageStatus {
    match s {
        "streaming" | "interrupted" => MessageStatus::Interrupted,
        "error" => MessageStatus::Error,
        _ => MessageStatus::Complete,
    }
}

fn parse_time(s: &str) -> OffsetDateTime {
    OffsetDateTime::parse(s, &Rfc3339).unwrap_or(OffsetDateTime::UNIX_EPOCH)
}

fn now_rfc3339() -> String {
    OffsetDateTime::now_utc().format(&Rfc3339).unwrap_or_default()
}

fn now_millis() -> i64 {
    (OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000) as i64
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ids::PartId;
    use crate::message::{AttachmentPart, ReasoningPart, TextPart, ToolCallPart, ToolState};
    use serde_json::json;

    fn full_message(thread: &ThreadId) -> Message {
        let mut m = Message::new(thread.clone(), Role::Assistant);
        m.author = Some(ParticipantId::from_raw("builder"));
        m.recipient = Some(ParticipantId::from_raw("user"));
        m.branch_of = Some(MessageId::from_raw("msg_parent"));
        m.status = MessageStatus::Complete;
        m.revision = 3;
        m.model = Some("claude-opus".into());
        m.usage = Some(Usage {
            input_tokens: 10,
            output_tokens: 20,
            cache_read_tokens: 5,
            cache_write_tokens: 1,
            cost_usd: Some(0.25),
        });
        // Whole-second precision survives RFC3339 round trips exactly.
        m.created_at = OffsetDateTime::from_unix_timestamp(1_700_000_000).unwrap();
        m.parts = vec![
            Part::Text(TextPart { id: PartId::new(), text: "Hello **world**, the quick brown fox".into() }),
            Part::Reasoning(ReasoningPart { id: PartId::new(), text: "thinking about foxes".into() }),
            Part::ToolCall(ToolCallPart {
                id: PartId::new(),
                call_id: "call_1".into(),
                name: "Read".into(),
                input: json!({"path": "/tmp/notes.md"}),
                state: ToolState::Done,
                title: Some("/tmp/notes.md".into()),
                output: Some("file contents here".into()),
                error: None,
            }),
            Part::ToolCall(ToolCallPart {
                id: PartId::new(),
                call_id: "call_2".into(),
                name: "Bash".into(),
                input: json!({"command": "false"}),
                state: ToolState::Error,
                title: None,
                output: None,
                error: Some("exit 1".into()),
            }),
            Part::Attachment(AttachmentPart {
                id: PartId::new(),
                mime: "image/png".into(),
                source: "image://abc".into(),
                name: Some("screenshot.png".into()),
            }),
        ];
        m
    }

    fn open_temp() -> (tempfile::TempDir, TranscriptStore) {
        let dir = tempfile::tempdir().unwrap();
        let store = TranscriptStore::open(&dir.path().join("nested/transcripts.sqlite")).unwrap();
        (dir, store)
    }

    #[test]
    fn opens_in_wal_mode_with_schema_version() {
        let (dir, store) = open_temp();
        assert_eq!(store.schema_version().unwrap(), MIGRATIONS.len() as u32);
        let mode: String = store.lock().query_row("PRAGMA journal_mode", [], |r| r.get(0)).unwrap();
        assert_eq!(mode, "wal");
        drop(store);
        // Reopening applies no further migrations and keeps the version.
        let store = TranscriptStore::open(&dir.path().join("nested/transcripts.sqlite")).unwrap();
        assert_eq!(store.schema_version().unwrap(), MIGRATIONS.len() as u32);
    }

    #[test]
    fn round_trips_a_message_with_every_part_variant() {
        let (_dir, store) = open_temp();
        let thread = ThreadId::new();
        let m = full_message(&thread);
        store.upsert_message(&m).unwrap();
        let back = store.messages_for_thread(&thread).unwrap();
        assert_eq!(back, vec![m.clone()]);
        assert_eq!(store.message(&thread, &m.id).unwrap(), Some(m));
        assert_eq!(store.message(&thread, &MessageId::new()).unwrap(), None);
    }

    #[test]
    fn upsert_keeps_order_and_replaces_parts() {
        let (_dir, store) = open_temp();
        let thread = ThreadId::new();
        let mut a = Message::new(thread.clone(), Role::User);
        a.parts.push(Part::Text(TextPart { id: PartId::new(), text: "first".into() }));
        let mut b = Message::new(thread.clone(), Role::Assistant);
        b.parts.push(Part::Text(TextPart { id: PartId::new(), text: "second".into() }));
        store.upsert_message(&a).unwrap();
        store.upsert_message(&b).unwrap();
        // Update the first: a new part list, status, and revision.
        a.parts = vec![Part::Text(TextPart { id: PartId::new(), text: "first, edited".into() })];
        a.status = MessageStatus::Complete;
        a.touch();
        store.upsert_message(&a).unwrap();
        let back = store.messages_for_thread(&thread).unwrap();
        assert_eq!(back.len(), 2);
        assert_eq!(back[0].id, a.id, "updated message keeps its place");
        assert_eq!(back[0].parts.len(), 1);
        assert_eq!(back[0].text(), "first, edited");
        assert_eq!(back[0].revision, 1);
        assert_eq!(back[1].id, b.id);
        assert_eq!(store.message_count(&thread).unwrap(), 2);
    }

    #[test]
    fn streaming_messages_come_back_interrupted() {
        let (_dir, store) = open_temp();
        let thread = ThreadId::new();
        let m = Message::new(thread.clone(), Role::Assistant);
        assert_eq!(m.status, MessageStatus::Streaming);
        store.upsert_message(&m).unwrap();
        assert_eq!(store.messages_for_thread(&thread).unwrap()[0].status, MessageStatus::Interrupted);
    }

    #[test]
    fn delete_thread_and_message() {
        let (_dir, store) = open_temp();
        let t1 = ThreadId::new();
        let t2 = ThreadId::new();
        let m1 = full_message(&t1);
        let m2 = full_message(&t1);
        let m3 = full_message(&t2);
        for m in [&m1, &m2, &m3] {
            store.upsert_message(m).unwrap();
        }
        let mut ids = store.thread_ids().unwrap();
        ids.sort();
        let mut want = vec![t1.clone(), t2.clone()];
        want.sort();
        assert_eq!(ids, want);

        assert!(store.delete_message(&t1, &m1.id).unwrap());
        assert!(!store.delete_message(&t1, &m1.id).unwrap());
        assert_eq!(store.message_count(&t1).unwrap(), 1);

        store.delete_thread(&t1).unwrap();
        assert!(store.messages_for_thread(&t1).unwrap().is_empty());
        assert_eq!(store.thread_ids().unwrap(), vec![t2.clone()]);
        assert_eq!(store.messages_for_thread(&t2).unwrap().len(), 1);
        let parts: i64 = store.lock().query_row("SELECT COUNT(*) FROM parts", [], |r| r.get(0)).unwrap();
        assert_eq!(parts, 5, "only t2's parts remain");
        assert!(store.search("fox", 10, Some(&t1)).unwrap().is_empty());
    }

    #[test]
    fn search_finds_text_reasoning_and_tools() {
        let (_dir, store) = open_temp();
        let thread = ThreadId::new();
        let m = full_message(&thread);
        store.upsert_message(&m).unwrap();
        let mut other = Message::new(ThreadId::new(), Role::User);
        other.parts.push(Part::Text(TextPart { id: PartId::new(), text: "unrelated quick note".into() }));
        store.upsert_message(&other).unwrap();

        let hits = store.search("Brown FOX", 10, None).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].thread_id, thread);
        assert_eq!(hits[0].message_id, m.id);
        assert_eq!(hits[0].role, Role::Assistant);
        assert_eq!(hits[0].created_at, m.created_at);
        assert!(hits[0].snippet.to_lowercase().contains("brown fox"), "{}", hits[0].snippet);

        assert_eq!(store.search("foxes", 10, None).unwrap().len(), 1, "reasoning is searched");
        assert_eq!(store.search("notes.md", 10, None).unwrap().len(), 1, "tool title/input is searched");
        assert_eq!(store.search("contents", 10, None).unwrap().len(), 1, "tool output is searched");
        assert_eq!(store.search("screenshot", 10, None).unwrap().len(), 1, "attachment name is searched");
        assert_eq!(store.search("quick", 10, None).unwrap().len(), 2);
        assert_eq!(store.search("quick", 10, Some(&other.thread_id)).unwrap().len(), 1, "thread filter");
        assert_eq!(store.search("quick", 1, None).unwrap().len(), 1, "limit");
        assert!(store.search("q", 10, None).unwrap().is_empty(), "too short");
        assert!(store.search("   ", 10, None).unwrap().is_empty());
        assert!(store.search("zebra", 10, None).unwrap().is_empty());
        // Characters special to LIKE and FTS do not break the query.
        assert!(store.search("100% _weird_ \"quote", 10, None).unwrap().is_empty());
    }

    #[test]
    fn snippet_windows_around_the_match() {
        let long = format!("{} needle {}", "a".repeat(500), "b".repeat(500));
        let s = snippet(&long, "needle");
        assert!(s.starts_with('…') && s.ends_with('…'));
        assert!(s.contains("needle"));
        assert_eq!(s.chars().count(), SNIPPET_LEN + 2);
        assert_eq!(snippet("short text", "text"), "short text");
        assert_eq!(snippet("héllo wörld needle", "needle"), "héllo wörld needle");
    }

    #[test]
    fn usage_totals_sum_across_messages() {
        let (_dir, store) = open_temp();
        let thread = ThreadId::new();
        assert_eq!(store.usage_totals(&thread).unwrap(), Usage::default());
        let a = full_message(&thread);
        let mut b = full_message(&thread);
        b.usage = Some(Usage { input_tokens: 1, output_tokens: 2, cache_read_tokens: 3, cache_write_tokens: 4, cost_usd: None });
        let mut c = Message::new(thread.clone(), Role::User);
        c.usage = None;
        for m in [&a, &b, &c] {
            store.upsert_message(m).unwrap();
        }
        let totals = store.usage_totals(&thread).unwrap();
        assert_eq!(totals.input_tokens, 11);
        assert_eq!(totals.output_tokens, 22);
        assert_eq!(totals.cache_read_tokens, 8);
        assert_eq!(totals.cache_write_tokens, 5);
        assert_eq!(totals.cost_usd, Some(0.25));
    }

    #[test]
    fn oversized_tool_output_is_truncated_on_write() {
        let (_dir, store) = open_temp();
        let thread = ThreadId::new();
        let mut m = Message::new(thread.clone(), Role::Assistant);
        m.parts.push(Part::ToolCall(ToolCallPart {
            id: PartId::new(),
            call_id: "c".into(),
            name: "Bash".into(),
            input: json!({}),
            state: ToolState::Done,
            title: None,
            output: Some("x".repeat(MAX_TOOL_OUTPUT_CHARS + 10)),
            error: None,
        }));
        store.upsert_message(&m).unwrap();
        let back = store.messages_for_thread(&thread).unwrap();
        let Part::ToolCall(p) = &back[0].parts[0] else { panic!("tool call expected") };
        let out = p.output.as_deref().unwrap();
        assert!(out.ends_with(TRUNCATED_MARK));
        assert_eq!(out.chars().count(), MAX_TOOL_OUTPUT_CHARS + TRUNCATED_MARK.chars().count());
    }

    #[test]
    fn in_memory_store_works_and_reports_fts() {
        let store = TranscriptStore::open_in_memory().unwrap();
        let thread = ThreadId::new();
        store.upsert_message(&full_message(&thread)).unwrap();
        assert_eq!(store.search("fox", 5, None).unwrap().len(), 1);
        // Bundled SQLite ships FTS5; if that ever changes LIKE still works,
        // but say so loudly.
        assert!(store.uses_fts(), "bundled sqlite lost FTS5");
    }
}
