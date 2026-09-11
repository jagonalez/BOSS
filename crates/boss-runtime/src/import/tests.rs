//! Fixtures small enough to read, exercising each mapping and the two
//! invariants that matter: the source is never written, and a second run
//! changes nothing.

use super::*;
use boss_core::engine::EngineId;
use boss_core::ids::{RoomId, ThreadId};
use boss_core::message::{MessageStatus, Part, Role, ToolState};
use boss_core::thread::ThreadKind;
use std::collections::HashMap;
use serde_json::json;
use std::path::{Path, PathBuf};

/// Build a miniature Electron folder: two projects, three threads (one on
/// the dropped Lab engine), a room, an MCP connection, and a transcript
/// database with one message per real thread.
fn fixture(dir: &Path) {
    std::fs::create_dir_all(dir).unwrap();
    let write = |name: &str, v: serde_json::Value| {
        std::fs::write(dir.join(name), serde_json::to_string_pretty(&v).unwrap()).unwrap();
    };

    write("state.json", json!({ "projects": ["/tmp/proj-a", "/tmp/proj-b"] }));
    write(
        "backend-threads.json",
        json!({ "version": 3, "threads": [
            { "id": "t-claude", "backendId": "claude", "nativeSessionId": "sess-1",
              "projectId": "p1", "projectPath": "/tmp/proj-a", "executionPath": "/tmp/proj-a",
              "title": "First chat", "createdAt": 1_700_000_000_000i64, "updatedAt": 1_700_000_100_000i64 },
            { "id": "t-codex", "backendId": "codex", "nativeSessionId": "sess-2",
              "projectId": "global", "projectPath": "", "executionPath": "",
              "title": "Scratch", "createdAt": 1_700_000_200_000i64, "archived": true },
            { "id": "t-lab", "backendId": "lab", "projectPath": "/tmp/proj-b", "title": "Lab run" }
        ]}),
    );
    write(
        "rooms.json",
        json!({ "version": 1, "rooms": [
            { "id": "r1", "threadId": "t-claude", "shape": "reviewed",
              "participants": [{ "id": "boss", "name": "BOSS", "engine": "claude", "isBoss": true }] },
            { "id": "r2", "threadId": "t-lab", "shape": "direct", "participants": [] }
        ]}),
    );
    write(
        "mcp-connections.json",
        json!({ "version": 1, "connections": [
            { "id": "c1", "name": "Datadog MCP", "transport": "http", "url": "https://example.test/mcp",
              "headers": { "DD_API_KEY": "ciphertext" }, "secretsEncrypted": true,
              "enabled": true, "createdAt": 1_700_000_000_000i64, "authScheme": "" },
            { "id": "c2", "name": "local fs", "transport": "stdio", "command": "npx",
              "args": ["-y", "server-filesystem"], "enabled": false, "createdAt": 1_700_000_000_000i64 }
        ]}),
    );
    // A file the native store reads verbatim.
    write("remote-access.json", json!({ "enabled": true, "devices": [] }));

    // The Electron transcript database, plus the native tables the app
    // mistakenly added to it, which the import must ignore.
    let db = rusqlite::Connection::open(dir.join("transcripts.sqlite")).unwrap();
    db.execute_batch(
        "CREATE TABLE transcript_messages (thread_id TEXT, message_id TEXT, role TEXT,
            position INTEGER, data_json TEXT, updated_at INTEGER);
         CREATE TABLE transcript_parts (thread_id TEXT, message_id TEXT, part_id TEXT,
            position INTEGER, data_json TEXT, updated_at INTEGER);
         CREATE TABLE messages (thread_id TEXT, message_id TEXT);
         CREATE TABLE parts (thread_id TEXT, message_id TEXT);
         INSERT INTO messages VALUES ('stray', 'stray');",
    )
    .unwrap();
    let msg = |thread: &str, id: &str, role: &str, pos: i64| {
        db.execute(
            "INSERT INTO transcript_messages VALUES (?1, ?2, ?3, ?4, ?5, 0)",
            rusqlite::params![
                thread,
                id,
                role,
                pos,
                json!({ "id": id, "role": role, "time": { "created": 1_700_000_000_000i64 },
                        "model": { "modelID": "opus" } })
                .to_string()
            ],
        )
        .unwrap();
    };
    let part = |thread: &str, message: &str, pos: i64, v: serde_json::Value| {
        db.execute(
            "INSERT INTO transcript_parts VALUES (?1, ?2, ?3, ?4, ?5, 0)",
            rusqlite::params![thread, message, v["id"].as_str().unwrap(), pos, v.to_string()],
        )
        .unwrap();
    };
    msg("t-claude", "m1", "user", 0);
    part("t-claude", "m1", 0, json!({ "id": "p1", "type": "text", "text": "hello" }));
    msg("t-claude", "m2", "assistant", 1);
    part("t-claude", "m2", 0, json!({ "id": "p2", "type": "reasoning", "text": "thinking" }));
    part(
        "t-claude",
        "m2",
        1,
        json!({ "id": "p3", "type": "tool", "state": {
            "status": "completed", "tool": "Read", "input": { "path": "/x" }, "output": "done" } }),
    );
    part(
        "t-claude",
        "m2",
        2,
        json!({ "id": "p4", "type": "step-finish",
                "tokens": { "input": 10, "output": 5, "cache": { "read": 100, "write": 2 } },
                "cost": 0.25 }),
    );
    // Only bookkeeping: no part survives, so no message is written.
    msg("t-claude", "m3", "assistant", 2);
    part("t-claude", "m3", 0, json!({ "id": "p5", "type": "step-start", "snapshot": "abc" }));
    // A message on a thread that was never in the index.
    msg("t-ghost", "m9", "user", 0);
    part("t-ghost", "m9", 0, json!({ "id": "p9", "type": "text", "text": "orphan" }));

    // Sessions that live only in claude-threads.json. sess-2 belongs to the
    // codex thread; sess-none has no thread pointing at it.
    write(
        "claude-threads.json",
        json!({ "version": 1, "sessions": {
            "sess-2": { "title": "Scratch", "projectPath": "", "messages": [
                { "info": { "id": "cm1", "role": "user", "time": { "created": 1_700_000_200_000i64 }, "model": {} },
                  "parts": [{ "id": "cp1", "type": "text", "text": "from json" }] },
                { "info": { "id": "cm2", "role": "assistant", "time": { "created": 1_700_000_201_000i64 }, "model": {} },
                  "parts": [{ "id": "cp2", "type": "file", "state": {
                      "status": "completed", "name": "shot", "mime": "image/png",
                      "url": "boss-image://a/b.png" } }] }
            ]},
            "sess-none": { "title": "Orphan", "messages": [
                { "info": { "id": "x1", "role": "user", "time": {}, "model": {} },
                  "parts": [{ "id": "xp1", "type": "text", "text": "lost" }] }
            ]}
        }}),
    );
}

fn run() -> (tempfile::TempDir, tempfile::TempDir, ImportReport) {
    let source = tempfile::tempdir().unwrap();
    let target = tempfile::tempdir().unwrap();
    fixture(source.path());
    let report = import(target.path(), source.path()).unwrap();
    (source, target, report)
}

#[test]
fn imports_projects_from_the_bare_path_list() {
    let (_s, target, report) = run();
    assert_eq!(report.counts.projects, 2);
    let state = StateStore::open(Some(target.path())).unwrap();
    let mut names: Vec<_> = state.projects().into_iter().map(|p| p.name).collect();
    names.sort();
    assert_eq!(names, ["proj-a", "proj-b"]);
}

#[test]
fn imports_threads_and_drops_lab() {
    let (_s, target, report) = run();
    assert_eq!(report.counts.threads, 2);
    let state = StateStore::open(Some(target.path())).unwrap();
    assert!(state.thread(&ThreadId::from_raw("t-lab")).is_none());
    assert!(report.skipped.iter().any(|s| s.id == "t-lab" && s.kind == "thread"));

    let claude = state.thread(&ThreadId::from_raw("t-claude")).unwrap();
    assert_eq!(claude.title, "First chat");
    assert!(matches!(claude.kind, ThreadKind::Chat { engine: EngineId::Claude }));
    assert!(claude.project_id.is_some());
    assert_eq!(claude.cwd, PathBuf::from("/tmp/proj-a"));
    assert!(!claude.archived);
}


#[test]
fn a_thread_with_no_project_keeps_none_and_runs_in_the_scratch_directory() {
    let (_s, target, _r) = run();
    let state = StateStore::open(Some(target.path())).unwrap();
    let scratch = state.thread(&ThreadId::from_raw("t-codex")).unwrap();
    assert_eq!(scratch.project_id, None);
    assert_eq!(scratch.cwd, boss_core::thread::scratch_cwd());
    assert!(scratch.archived);
}

#[test]
fn maps_parts_and_mines_usage_from_step_finish() {
    let (_s, target, report) = run();
    let store = TranscriptStore::open_in(Some(target.path())).unwrap();
    let messages = store.messages_for_thread(&ThreadId::from_raw("t-claude")).unwrap();
    assert_eq!(messages.len(), 2, "m3 had only a step-start and is not content");

    let user = &messages[0];
    assert_eq!(user.role, Role::User);
    assert_eq!(user.status, MessageStatus::Complete);
    assert!(matches!(&user.parts[0], Part::Text(t) if t.text == "hello"));
    assert_eq!(user.model.as_deref(), Some("opus"));

    let assistant = &messages[1];
    assert_eq!(assistant.parts.len(), 2, "step-finish is usage, not a part");
    assert!(matches!(&assistant.parts[0], Part::Reasoning(r) if r.text == "thinking"));
    let Part::ToolCall(tool) = &assistant.parts[1] else { panic!("expected a tool call") };
    assert_eq!(tool.name, "Read");
    assert_eq!(tool.state, ToolState::Done);
    assert_eq!(tool.output.as_deref(), Some("done"));
    let usage = assistant.usage.as_ref().unwrap();
    assert_eq!((usage.input_tokens, usage.output_tokens), (10, 5));
    assert_eq!((usage.cache_read_tokens, usage.cache_write_tokens), (100, 2));
    assert_eq!(usage.cost_usd, Some(0.25));

    assert!(report.skipped.iter().any(|s| s.id == "m9" && s.reason.contains("thread")));
    assert!(report.skipped.iter().any(|s| s.id == "m3"));
}

#[test]
fn imports_sessions_that_live_only_in_claude_threads_json() {
    let (_s, target, report) = run();
    let store = TranscriptStore::open_in(Some(target.path())).unwrap();
    let messages = store.messages_for_thread(&ThreadId::from_raw("t-codex")).unwrap();
    assert_eq!(messages.len(), 2);
    assert!(matches!(&messages[0].parts[0], Part::Text(t) if t.text == "from json"));
    let Part::Attachment(file) = &messages[1].parts[0] else { panic!("expected an attachment") };
    assert_eq!(file.mime, "image/png");
    assert_eq!(file.source, "boss-image://a/b.png");
    assert_eq!(file.name.as_deref(), Some("shot"));
    assert!(report.skipped.iter().any(|s| s.kind == "session" && s.id == "sess-none"));
}

#[test]
fn imports_rooms_and_drops_one_whose_thread_did_not_come_across() {
    let (_s, target, report) = run();
    assert_eq!(report.counts.rooms, 1);
    let state = StateStore::open(Some(target.path())).unwrap();
    let room = state.room(&RoomId::from_raw("r1")).unwrap();
    assert_eq!(room.thread_id.as_str(), "t-claude");
    assert_eq!(room.participants.len(), 1);
    assert!(room.participants[0].is_boss);
    assert!(report.skipped.iter().any(|s| s.kind == "room" && s.id == "r2"));
}


#[test]
fn reads_the_native_rooms_shape_the_app_wrote_over_the_electron_file() {
    let source = tempfile::tempdir().unwrap();
    let target = tempfile::tempdir().unwrap();
    fixture(source.path());
    // The native app overwrote rooms.json with `{ version, items }`.
    std::fs::write(
        source.path().join("rooms.json"),
        json!({ "version": 1, "items": [
            { "id": "room_abc", "thread_id": "t-claude", "shape": "direct",
              "participants": [{ "id": "boss", "name": "BOSS", "engine": "claude", "is_boss": true }] }
        ]})
        .to_string(),
    )
    .unwrap();
    let report = import(target.path(), source.path()).unwrap();
    assert_eq!(report.counts.rooms, 1);
    let state = StateStore::open(Some(target.path())).unwrap();
    assert!(state.room(&RoomId::from_raw("room_abc")).is_some());
}

#[test]
fn imports_mcp_connections_and_leaves_electron_ciphertext_behind() {
    let (_s, target, report) = run();
    assert_eq!(report.counts.mcp_connections, 2);
    let settings = SettingsStore::open(Some(target.path())).unwrap().get();
    let dd = settings.mcp_connections.iter().find(|c| c.id == "c1").unwrap();
    assert_eq!(dd.slug, "datadog_mcp");
    assert!(dd.headers.is_empty(), "safeStorage ciphertext must not travel");
    assert_eq!(dd.auth_scheme, None, "an empty authScheme is not a scheme");
    let fs = settings.mcp_connections.iter().find(|c| c.id == "c2").unwrap();
    assert_eq!(fs.command.as_deref(), Some("npx"));
    assert_eq!(fs.args.len(), 2);
    assert!(!fs.enabled);
    assert!(report.skipped.iter().any(|s| s.kind == "mcp_secret"));
}

#[test]
fn copies_byte_compatible_files_but_never_over_an_existing_one() {
    let source = tempfile::tempdir().unwrap();
    let target = tempfile::tempdir().unwrap();
    fixture(source.path());
    std::fs::create_dir_all(target.path()).unwrap();
    std::fs::write(target.path().join("mobile-access.json"), "{\"mine\":true}").unwrap();
    std::fs::write(source.path().join("mobile-access.json"), "{\"theirs\":true}").unwrap();

    let report = import(target.path(), source.path()).unwrap();
    assert!(report.copied.contains(&"remote-access.json".to_string()));
    assert!(report.skipped_existing.contains(&"mobile-access.json".to_string()));
    let kept = std::fs::read_to_string(target.path().join("mobile-access.json")).unwrap();
    assert_eq!(kept, "{\"mine\":true}", "the target's own file wins");
}

#[test]
fn writes_a_report_next_to_the_data() {
    let (_s, target, _r) = run();
    let raw = std::fs::read_to_string(target.path().join("import-report.json")).unwrap();
    let parsed: ImportReport = serde_json::from_str(&raw).unwrap();
    assert_eq!(parsed.counts.threads, 2);
    assert!(parsed.errors.is_empty(), "clean fixture: {:?}", parsed.errors);
    assert!(!parsed.finished_at.is_empty());
}

#[test]
fn running_twice_adds_nothing_and_leaves_the_source_untouched() {
    let source = tempfile::tempdir().unwrap();
    let target = tempfile::tempdir().unwrap();
    fixture(source.path());

    let before = fingerprint(source.path());
    let first = import(target.path(), source.path()).unwrap();
    let second = import(target.path(), source.path()).unwrap();

    assert_eq!(second.counts.projects, 0);
    assert_eq!(second.counts.threads, 0);
    assert_eq!(second.counts.mcp_connections, 0);
    assert_eq!(second.counts.messages, first.counts.messages, "upserted onto the same ids");
    assert!(second.copied.is_empty());

    let state = StateStore::open(Some(target.path())).unwrap();
    assert_eq!(state.threads().len(), 2);
    assert_eq!(state.projects().len(), 2);
    let store = TranscriptStore::open_in(Some(target.path())).unwrap();
    assert_eq!(store.messages_for_thread(&ThreadId::from_raw("t-claude")).unwrap().len(), 2);

    assert_eq!(fingerprint(source.path()), before, "the Electron folder is read-only");
}

/// Every file in a directory with its length and modified time, so a test
/// can prove nothing in the source was written, created, or removed.
fn fingerprint(dir: &Path) -> Vec<(String, u64, std::time::SystemTime)> {
    let mut out: Vec<_> = std::fs::read_dir(dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| {
            let m = e.metadata().unwrap();
            (e.file_name().to_string_lossy().into_owned(), m.len(), m.modified().unwrap())
        })
        .collect();
    out.sort();
    out
}

/// Where a message is in both `transcripts.sqlite` and
/// `claude-threads.json`, the sqlite row is the fuller one — on the user's
/// data 14,498 of 20,479 shared messages had more parts there. The JSON
/// pass runs second, so without a guard it would overwrite tool calls and
/// reasoning with a bare text part.
#[test]
fn the_json_fallback_never_overwrites_a_richer_sqlite_message() {
    let source = tempfile::tempdir().unwrap();
    let target = tempfile::tempdir().unwrap();
    fixture(source.path());

    // sess-1 is the claude thread, whose m2 has reasoning + a tool call in
    // sqlite. Offer a one-part version of the same message id in the JSON.
    std::fs::write(
        source.path().join("claude-threads.json"),
        json!({ "version": 1, "sessions": {
            "sess-1": { "title": "First chat", "messages": [
                { "info": { "id": "m2", "role": "assistant", "time": { "created": 1_700_000_000_000i64 }, "model": {} },
                  "parts": [{ "id": "poor", "type": "text", "text": "lossy copy" }] },
                { "info": { "id": "only-json", "role": "user", "time": { "created": 1_700_000_000_000i64 }, "model": {} },
                  "parts": [{ "id": "jp", "type": "text", "text": "gap filler" }] }
            ]}
        }})
        .to_string(),
    )
    .unwrap();

    import(target.path(), source.path()).unwrap();
    let store = TranscriptStore::open_in(Some(target.path())).unwrap();
    let messages = store.messages_for_thread(&ThreadId::from_raw("t-claude")).unwrap();

    let rich = messages.iter().find(|m| m.id.as_str() == "m2").unwrap();
    assert_eq!(rich.parts.len(), 2, "the sqlite version survived");
    assert!(matches!(&rich.parts[0], Part::Reasoning(_)));
    assert!(matches!(&rich.parts[1], Part::ToolCall(_)));

    // A message only the JSON has is still imported: it fills a real gap.
    let filled = messages.iter().find(|m| m.id.as_str() == "only-json").unwrap();
    assert!(matches!(&filled.parts[0], Part::Text(t) if t.text == "gap filler"));
}

/// The Electron app leaves `transcripts.sqlite` in WAL mode. Opening a WAL
/// database with `mode=ro` makes SQLite create a `-shm` (and a `-wal`) next
/// to it, which would be BOSS writing into the folder it promised only to
/// read. `immutable=1` avoids that, and this test is the guard.
#[test]
fn reading_the_wal_transcript_database_creates_no_files_beside_it() {
    let source = tempfile::tempdir().unwrap();
    let target = tempfile::tempdir().unwrap();
    fixture(source.path());
    // Put the source database into WAL, exactly as the Electron app does.
    {
        let db = rusqlite::Connection::open(source.path().join("transcripts.sqlite")).unwrap();
        db.pragma_update(None, "journal_mode", "WAL").unwrap();
    }
    for suffix in ["-wal", "-shm"] {
        let sidecar = source.path().join(format!("transcripts.sqlite{suffix}"));
        if sidecar.exists() {
            std::fs::remove_file(&sidecar).unwrap();
        }
    }

    let report = import(target.path(), source.path()).unwrap();
    assert!(report.errors.is_empty(), "{:?}", report.errors);
    assert!(report.counts.messages > 0, "the WAL database still reads");
    assert!(!source.path().join("transcripts.sqlite-shm").exists(), "no -shm in the source");
    assert!(!source.path().join("transcripts.sqlite-wal").exists(), "no -wal in the source");
}

#[test]
fn should_import_only_on_a_fresh_native_folder_beside_an_electron_one() {
    let source = tempfile::tempdir().unwrap();
    let target = tempfile::tempdir().unwrap();
    assert!(!should_import(target.path(), source.path()), "no Electron data");

    fixture(source.path());
    assert!(should_import(target.path(), source.path()));

    std::fs::write(target.path().join("projects.json"), "{}").unwrap();
    assert!(!should_import(target.path(), source.path()), "the native app has already run");
}

/// Runs the importer against a copy of the user's real Electron folder and
/// prints the counts. Ignored: it needs `BOSS_ELECTRON_DATA` pointing at a
/// copy, and it moves hundreds of megabytes.
///
/// ```text
/// BOSS_ELECTRON_DATA=/tmp/claude/electron-copy \
///   cargo test -p boss-runtime -- --ignored --nocapture real_electron_folder
/// ```
#[test]
#[ignore = "needs a copy of a real Electron data folder"]
fn imports_a_real_electron_folder() {
    let Ok(source) = std::env::var("BOSS_ELECTRON_DATA") else {
        panic!("set BOSS_ELECTRON_DATA to a copy of the Electron folder");
    };
    let source = PathBuf::from(source);
    let target = tempfile::tempdir().unwrap();

    let started = std::time::Instant::now();
    let report = import(target.path(), &source).unwrap();
    let elapsed = started.elapsed();

    println!("imported in {:.1}s", elapsed.as_secs_f64());
    println!("{:#?}", report.counts);
    println!("copied: {:?}", report.copied);
    println!("errors: {}", report.errors.len());
    for e in report.errors.iter().take(10) {
        println!("  error: {e}");
    }
    let mut by_reason: HashMap<&str, usize> = HashMap::new();
    for s in &report.skipped {
        *by_reason.entry(s.kind.as_str()).or_default() += 1;
    }
    println!("skipped by kind: {by_reason:?}");

    assert!(report.counts.threads > 0);
    assert!(report.counts.messages > 0);
    assert!(!source.join("transcripts.sqlite-shm").exists(), "no -shm written into the source");
}

