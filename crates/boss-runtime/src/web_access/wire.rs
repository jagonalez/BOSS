//! The JSON the phone page already speaks.
//!
//! These are the shapes from `src/shared/opencode.ts` (`SessionInfo`,
//! `MessageWithParts`, `Part`), `src/shared/supervision.ts`
//! (`SupervisionSnapshot`), and the `{ type, properties }` events the page's
//! `applyEvent` switches on. The page is served verbatim from `assets/`, so
//! the field names here are a contract, not a preference — camelCase and all.
//!
//! Overlap note: work package 8e ports the relay client and will land
//! `crates/boss-runtime/src/relay/wire.rs` with the same `MessageWithParts`
//! and event shapes. That module did not exist when this one was written.
//! When it lands, one of the two should re-export the other; the conversions
//! below (`message_to_wire`, `thread_to_session`, `engine_event_to_wire`) are
//! the pieces worth keeping.

use crate::sessions::SessionEvent;
use boss_core::*;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use time::OffsetDateTime;

/// Milliseconds since the epoch, the only timestamp the page understands.
fn millis(at: OffsetDateTime) -> i64 {
    (at.unix_timestamp_nanos() / 1_000_000) as i64
}

/// One thread as `thread.list` returns it (`SessionInfo` in the TS).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionInfo {
    pub id: String,
    pub title: String,
    #[serde(rename = "backendId")]
    pub backend_id: String,
    #[serde(rename = "projectPath")]
    pub project_path: String,
    pub time: SessionTime,
    pub busy: bool,
    pub archived: bool,
}

/// Created/updated timestamps in milliseconds.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionTime {
    pub created: i64,
    pub updated: i64,
}

/// A thread as the phone's list renders it (`SupervisedThread` in the TS).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SupervisedThread {
    #[serde(rename = "threadId")]
    pub thread_id: String,
    #[serde(rename = "backendId")]
    pub backend_id: String,
    pub title: String,
    #[serde(rename = "projectPath")]
    pub project_path: String,
    #[serde(rename = "executionPath")]
    pub execution_path: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: i64,
    pub running: bool,
    #[serde(default)]
    pub archived: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attention: Option<ThreadAttention>,
    pub usage: ThreadUsageTotals,
}

/// Why a thread wants the user. The page sorts these to the top.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ThreadAttention {
    /// `permission`, `question`, `completed`, `error`, or `interrupted`.
    pub kind: String,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/// Run and token counters. Always present so the page can add them up.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ThreadUsageTotals {
    pub runs: u64,
    #[serde(rename = "durationMs")]
    pub duration_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tokens: Option<u64>,
    #[serde(rename = "tokenRuns")]
    pub token_runs: u64,
    #[serde(rename = "toolCalls")]
    pub tool_calls: u64,
}

/// What `supervision.snapshot` returns.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SupervisionSnapshot {
    #[serde(rename = "generatedAt")]
    pub generated_at: i64,
    pub threads: Vec<SupervisedThread>,
    pub totals: ThreadUsageTotals,
}

/// One message plus its parts, as `thread.messages` returns it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageWithParts {
    pub info: MessageInfo,
    pub parts: Vec<WirePart>,
}

/// Message header the page reads for role, author, and time.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageInfo {
    pub id: String,
    #[serde(rename = "sessionID")]
    pub session_id: String,
    /// `user` or `assistant`; a system message is reported as `assistant`.
    pub role: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub time: Option<MessageTime>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recipient: Option<String>,
    #[serde(rename = "branchOf", skip_serializing_if = "Option::is_none")]
    pub branch_of: Option<String>,
}

/// Created and completed times in milliseconds.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageTime {
    pub created: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed: Option<i64>,
}

/// A message part. `type` is `text`, `reasoning`, `tool`, or `file`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WirePart {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(rename = "sessionID")]
    pub session_id: String,
    #[serde(rename = "messageID")]
    pub message_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<Value>,
}

/// An event as the page's `applyEvent` expects it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WireEvent {
    #[serde(rename = "type")]
    pub kind: String,
    pub properties: Value,
}

/// Convert a stored thread into the `thread.list` entry the page renders.
pub fn thread_to_session(thread: &Thread, project_path: &str, busy: bool) -> SessionInfo {
    SessionInfo {
        id: thread.id.to_string(),
        title: thread.title.clone(),
        backend_id: backend_id(thread),
        project_path: project_path.to_string(),
        time: SessionTime { created: millis(thread.created_at), updated: millis(thread.updated_at) },
        busy,
        archived: thread.archived,
    }
}

/// Convert a stored thread into a supervision row.
pub fn thread_to_supervised(
    thread: &Thread,
    project_path: &str,
    busy: bool,
    attention: Option<ThreadAttention>,
) -> SupervisedThread {
    SupervisedThread {
        thread_id: thread.id.to_string(),
        backend_id: backend_id(thread),
        title: thread.title.clone(),
        project_path: project_path.to_string(),
        execution_path: thread.cwd.display().to_string(),
        updated_at: millis(thread.updated_at),
        running: busy,
        archived: thread.archived,
        attention,
        usage: ThreadUsageTotals::default(),
    }
}

/// The engine name the page shows under a thread title.
fn backend_id(thread: &Thread) -> String {
    match &thread.kind {
        ThreadKind::Chat { engine } => engine.as_str().to_string(),
        ThreadKind::Room { .. } => "room".into(),
        ThreadKind::Assistant => "assistant".into(),
    }
}

/// Convert a stored message into `MessageWithParts`.
pub fn message_to_wire(message: &Message) -> MessageWithParts {
    let session_id = message.thread_id.to_string();
    let message_id = message.id.to_string();
    let parts = message.parts.iter().map(|p| part_to_wire(p, &session_id, &message_id)).collect();
    let completed = matches!(message.status, MessageStatus::Complete)
        .then(|| millis(message.created_at));
    MessageWithParts {
        info: MessageInfo {
            id: message_id,
            session_id,
            role: match message.role {
                Role::User => "user".into(),
                // The page renders two roles only; a system note reads as the
                // agent speaking rather than disappearing.
                Role::Assistant | Role::System => "assistant".into(),
            },
            time: Some(MessageTime { created: millis(message.created_at), completed }),
            tokens: message.usage.as_ref().map(|u| u.input_tokens + u.output_tokens),
            model: message.model.as_ref().map(|m| json!({ "id": m })),
            author: message.author.as_ref().map(|a| a.to_string()),
            recipient: message.recipient.as_ref().map(|r| r.to_string()),
            branch_of: message.branch_of.as_ref().map(|b| b.to_string()),
        },
        parts,
    }
}

fn part_to_wire(part: &Part, session_id: &str, message_id: &str) -> WirePart {
    let base = |kind: &str| WirePart {
        id: part.id().to_string(),
        kind: kind.to_string(),
        session_id: session_id.to_string(),
        message_id: message_id.to_string(),
        tool: None,
        text: None,
        state: None,
    };
    match part {
        Part::Text(p) => WirePart { text: Some(p.text.clone()), ..base("text") },
        Part::Reasoning(p) => WirePart { text: Some(p.text.clone()), ..base("reasoning") },
        Part::ToolCall(p) => WirePart {
            tool: Some(p.name.clone()),
            state: Some(json!({
                "status": match p.state {
                    ToolState::Pending => "pending",
                    ToolState::Running => "running",
                    ToolState::Done => "completed",
                    ToolState::Error => "error",
                },
                "tool": p.name,
                "title": p.title,
                "input": p.input,
                "output": p.output,
                "error": p.error,
            })),
            ..base("tool")
        },
        Part::Attachment(p) => WirePart {
            state: Some(json!({ "mime": p.mime, "url": p.source, "name": p.name })),
            ..base("file")
        },
    }
}

/// Translate a runtime session event into the `{ type, properties }` frame the
/// page reacts to, or `None` when the page has no use for it.
///
/// Only the types in [`super::server::FORWARDED_EVENTS`] can come out of this.
pub fn engine_event_to_wire(event: &SessionEvent) -> Option<WireEvent> {
    let session = event.key.thread_id.to_string();
    let (kind, properties) = match &event.event {
        EngineEvent::Status { busy } => (
            "session.status",
            json!({ "sessionID": session, "status": { "type": if *busy { "busy" } else { "idle" } } }),
        ),
        EngineEvent::Error { message, .. } => {
            ("session.error", json!({ "sessionID": session, "error": message }))
        }
        EngineEvent::Closed => ("session.idle", json!({ "sessionID": session })),
        // The page only needs to know the message changed; it refetches.
        EngineEvent::MessageStarted { message_id, role } => (
            "message.updated",
            json!({ "info": { "id": message_id.to_string(), "sessionID": session,
                "role": if matches!(role, Role::User) { "user" } else { "assistant" } } }),
        ),
        EngineEvent::MessageCompleted { message_id, .. } => (
            "message.updated",
            json!({ "info": { "id": message_id.to_string(), "sessionID": session, "role": "assistant" } }),
        ),
        EngineEvent::TextDelta { message_id, part_id, .. }
        | EngineEvent::ReasoningDelta { message_id, part_id, .. }
        | EngineEvent::ToolCallInputDelta { message_id, part_id, .. }
        | EngineEvent::ToolCallRunning { message_id, part_id }
        | EngineEvent::ToolCallFinished { message_id, part_id, .. } => (
            "message.part.updated",
            json!({ "part": { "id": part_id.to_string(), "sessionID": session,
                "messageID": message_id.to_string() } }),
        ),
        EngineEvent::ToolCallStarted { message_id, part_id, name, .. } => (
            "message.part.created",
            json!({ "part": { "id": part_id.to_string(), "sessionID": session,
                "messageID": message_id.to_string(), "type": "tool", "tool": name } }),
        ),
        EngineEvent::PermissionRequested { request, tool, input, title, .. } => (
            "permission.asked",
            json!({ "sessionID": session, "id": request.to_string(), "tool": tool,
                "input": input, "title": title }),
        ),
        EngineEvent::QuestionAsked { request, prompt, options } => (
            "permission.asked",
            json!({ "sessionID": session, "id": request.to_string(), "tool": "question",
                "title": prompt, "options": options }),
        ),
        EngineEvent::RequestWithdrawn { request } => (
            "permission.replied",
            json!({ "sessionID": session, "id": request.to_string() }),
        ),
        // Todos and session-ready carry nothing the phone renders.
        EngineEvent::Todos { .. } | EngineEvent::SessionReady { .. } => return None,
    };
    Some(WireEvent { kind: kind.to_string(), properties })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key() -> crate::sessions::SessionKey {
        crate::sessions::SessionKey {
            thread_id: ThreadId::from_raw("t1"),
            participant_id: ParticipantId::from_raw("p1"),
        }
    }

    #[test]
    fn message_becomes_the_shape_the_page_reads() {
        let mut message = Message::new(ThreadId::from_raw("t1"), Role::Assistant);
        message.parts.push(Part::Text(TextPart { id: PartId::new(), text: "hi".into() }));
        let wire = message_to_wire(&message);
        assert_eq!(wire.info.role, "assistant");
        assert_eq!(wire.info.session_id, "t1");
        assert_eq!(wire.parts.len(), 1);
        assert_eq!(wire.parts[0].kind, "text");
        assert_eq!(wire.parts[0].text.as_deref(), Some("hi"));
        // The page reads part.sessionID to route the event to a thread.
        assert_eq!(wire.parts[0].session_id, "t1");
    }

    #[test]
    fn tool_part_carries_name_in_both_spellings() {
        let mut message = Message::new(ThreadId::from_raw("t1"), Role::Assistant);
        message.parts.push(Part::ToolCall(ToolCallPart {
            id: PartId::new(),
            call_id: "c1".into(),
            name: "Read".into(),
            input: json!({ "path": "/tmp/x" }),
            state: ToolState::Done,
            title: Some("x".into()),
            output: Some("body".into()),
            error: None,
        }));
        let part = &message_to_wire(&message).parts[0];
        assert_eq!(part.kind, "tool");
        assert_eq!(part.tool.as_deref(), Some("Read"));
        let state = part.state.as_ref().unwrap();
        assert_eq!(state["status"], "completed");
        assert_eq!(state["tool"], "Read");
    }

    #[test]
    fn status_event_maps_to_session_status() {
        let event = SessionEvent { key: key(), event: EngineEvent::Status { busy: true } };
        let wire = engine_event_to_wire(&event).unwrap();
        assert_eq!(wire.kind, "session.status");
        assert_eq!(wire.properties["sessionID"], "t1");
        assert_eq!(wire.properties["status"]["type"], "busy");
    }

    #[test]
    fn permission_event_carries_the_id_the_page_replies_with() {
        let event = SessionEvent {
            key: key(),
            event: EngineEvent::PermissionRequested {
                request: RequestId::from_raw("r1"),
                tool: "Bash".into(),
                input: json!({}),
                title: None,
                message_id: None,
            },
        };
        let wire = engine_event_to_wire(&event).unwrap();
        assert_eq!(wire.kind, "permission.asked");
        assert_eq!(wire.properties["id"], "r1");
    }

    #[test]
    fn events_the_phone_ignores_are_dropped() {
        let event = SessionEvent {
            key: key(),
            event: EngineEvent::SessionReady { native_session_id: "n".into() },
        };
        assert!(engine_event_to_wire(&event).is_none());
    }
}
