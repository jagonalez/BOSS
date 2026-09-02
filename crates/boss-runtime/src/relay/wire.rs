//! The JSON the phone expects: the old `MessageWithParts`, `Part`,
//! `SupervisedThread` and event shapes from `src/shared`, and the phone's
//! `BackendRequest` subset. Maps `boss_core` types onto them.
//!
//! Field names are the old camelCase ones (`sessionID`, `messageID`) because
//! `mobile/src/parts.ts` and `mobile/App.tsx` read exactly those.

use crate::model::{PendingRequest, ThreadModel};
use boss_core::*;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use time::OffsetDateTime;

/// Requests the relay transport serves. Same set as `RELAY_REQUESTS` in
/// `src/shared/mobile.ts`; anything else is refused by name.
pub const RELAY_REQUESTS: &[&str] = &[
    "backend.list",
    "supervision.snapshot",
    "supervision.search",
    "supervision.acknowledge",
    "thread.list",
    "thread.get",
    "thread.messages",
    "thread.part",
    "thread.send",
    "thread.followups.list",
    "thread.followups.add",
    "thread.followups.update",
    "thread.followups.remove",
    "thread.followups.move",
    "thread.followups.steer",
    "thread.abort",
    "thread.todos",
    "thread.permission",
    "thread.diff",
    "automation.list",
    "automation.run",
    "automation.stop",
    "assistant.snapshot",
    "assistant.answer",
    "assistant.task.create",
    "assistant.task.update",
    "assistant.task.assign",
    "assistant.workflow.start",
    "thread.create",
    "thread.models",
    "thread.mode.set",
    "thread.archive",
    "thread.delegate",
    "thread.rename",
    "thread.delete",
];

/// Whether a request type may be served over the relay.
pub fn relay_request_allowed(kind: &str) -> bool {
    RELAY_REQUESTS.contains(&kind)
}

/// Events the desktop forwards to phones. Same set as `FORWARDED_EVENTS` in
/// `src/main/relay-client.ts`.
pub const FORWARDED_EVENTS: &[&str] = &[
    "session.created",
    "session.updated",
    "session.deleted",
    "session.status",
    "session.idle",
    "session.error",
    "message.updated",
    "message.part.updated",
    "message.part.created",
    "permission.asked",
    "permission.updated",
    "permission.replied",
    "automations.updated",
    "assistant.updated",
    "thread.followups.updated",
];

/// Whether an event (by its `type`) is forwarded to phones.
pub fn event_forwarded(event: &Value) -> bool {
    event.get("type").and_then(Value::as_str).is_some_and(|t| FORWARDED_EVENTS.contains(&t))
}

/// The phone's `BackendRequest` subset, by `type`.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(tag = "type")]
pub enum Request {
    #[serde(rename = "backend.list")]
    BackendList,
    #[serde(rename = "supervision.snapshot")]
    SupervisionSnapshot,
    #[serde(rename = "supervision.search", rename_all = "camelCase")]
    SupervisionSearch {
        query: String,
        #[serde(default)]
        limit: Option<usize>,
        #[serde(default)]
        thread_id: Option<String>,
    },
    #[serde(rename = "supervision.acknowledge", rename_all = "camelCase")]
    SupervisionAcknowledge { thread_id: String },
    #[serde(rename = "thread.list")]
    ThreadList,
    #[serde(rename = "thread.get", rename_all = "camelCase")]
    ThreadGet { thread_id: String },
    #[serde(rename = "thread.messages", rename_all = "camelCase")]
    ThreadMessages {
        thread_id: String,
        #[serde(default)]
        limit: Option<usize>,
        #[serde(default)]
        trim_output: Option<usize>,
    },
    #[serde(rename = "thread.part", rename_all = "camelCase")]
    ThreadPart { thread_id: String, message_id: String, part_id: String },
    #[serde(rename = "thread.send", rename_all = "camelCase")]
    ThreadSend {
        thread_id: String,
        #[serde(default)]
        parts: Vec<Value>,
        #[serde(default)]
        options: Option<Value>,
    },
    #[serde(rename = "thread.followups.list", rename_all = "camelCase")]
    FollowupsList { thread_id: String },
    #[serde(rename = "thread.followups.add", rename_all = "camelCase")]
    FollowupsAdd {
        thread_id: String,
        text: String,
        #[serde(default)]
        options: Option<Value>,
    },
    #[serde(rename = "thread.followups.update", rename_all = "camelCase")]
    FollowupsUpdate { thread_id: String, follow_up_id: String, text: String },
    #[serde(rename = "thread.followups.remove", rename_all = "camelCase")]
    FollowupsRemove { thread_id: String, follow_up_id: String },
    #[serde(rename = "thread.followups.move", rename_all = "camelCase")]
    FollowupsMove { thread_id: String, follow_up_id: String, to_index: usize },
    #[serde(rename = "thread.followups.steer", rename_all = "camelCase")]
    FollowupsSteer { thread_id: String, follow_up_id: String },
    #[serde(rename = "thread.abort", rename_all = "camelCase")]
    ThreadAbort { thread_id: String },
    #[serde(rename = "thread.todos", rename_all = "camelCase")]
    ThreadTodos { thread_id: String },
    #[serde(rename = "thread.permission", rename_all = "camelCase")]
    ThreadPermission { thread_id: String, permission_id: String, response: String },
    #[serde(rename = "thread.diff", rename_all = "camelCase")]
    ThreadDiff {
        thread_id: String,
        #[serde(default)]
        path: Option<String>,
        #[serde(default)]
        summary: Option<bool>,
    },
    #[serde(rename = "automation.list")]
    AutomationList,
    #[serde(rename = "automation.run", rename_all = "camelCase")]
    AutomationRun { automation_id: String },
    #[serde(rename = "automation.stop", rename_all = "camelCase")]
    AutomationStop { automation_id: String },
    #[serde(rename = "thread.create", rename_all = "camelCase")]
    ThreadCreate {
        backend_id: String,
        #[serde(default)]
        title: Option<String>,
        #[serde(default)]
        execution_path: Option<String>,
    },
    #[serde(rename = "thread.models", rename_all = "camelCase")]
    ThreadModels {
        #[serde(default)]
        thread_id: Option<String>,
        #[serde(default)]
        backend_id: Option<String>,
    },
    #[serde(rename = "thread.mode.set", rename_all = "camelCase")]
    ThreadModeSet { thread_id: String, mode: String },
    #[serde(rename = "thread.archive", rename_all = "camelCase")]
    ThreadArchive { thread_id: String, archived: bool },
    #[serde(rename = "thread.rename", rename_all = "camelCase")]
    ThreadRename { thread_id: String, title: String },
    #[serde(rename = "thread.delete", rename_all = "camelCase")]
    ThreadDelete { thread_id: String },
}

/// `MessageInfo` from `src/shared/opencode.ts`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MessageInfo {
    pub id: String,
    #[serde(rename = "sessionID")]
    pub session_id: String,
    pub role: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<SessionModel>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub time: Option<MessageTime>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recipient: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "branchOf")]
    pub branch_of: Option<String>,
}

/// `SessionModel`: which model wrote a message.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SessionModel {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
}

/// Epoch milliseconds, the way JavaScript reports time.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MessageTime {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed: Option<i64>,
}

/// A tool part's state, as the phone's `parts.ts` reads it.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct PartState {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Full length of an output shortened before sending; set only when cut.
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "outputTruncated")]
    pub output_truncated: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mime: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

/// `Part` from `src/shared/opencode.ts`, the fields the phone reads.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct WirePart {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(rename = "sessionID")]
    pub session_id: String,
    #[serde(rename = "messageID")]
    pub message_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state: Option<PartState>,
}

/// `MessageWithParts`: what `thread.messages` returns, one per message.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MessageWithParts {
    pub info: MessageInfo,
    pub parts: Vec<WirePart>,
}

/// `Date.now()`-style milliseconds for an `OffsetDateTime`.
pub fn millis(at: OffsetDateTime) -> i64 {
    (at.unix_timestamp_nanos() / 1_000_000) as i64
}

fn role_name(role: Role) -> &'static str {
    match role {
        Role::User => "user",
        // The old shape only knows user and assistant; a system notice reads
        // as the agent's side of the transcript.
        Role::Assistant | Role::System => "assistant",
    }
}

fn tool_status(state: &ToolState) -> &'static str {
    match state {
        ToolState::Pending => "pending",
        ToolState::Running => "running",
        ToolState::Done => "completed",
        ToolState::Error => "error",
    }
}

/// One part in the old shape.
pub fn part_to_wire(session_id: &str, message_id: &str, part: &Part) -> WirePart {
    let base = |id: &PartId, kind: &str| WirePart {
        id: id.to_string(),
        kind: kind.into(),
        session_id: session_id.into(),
        message_id: message_id.into(),
        tool: None,
        text: None,
        state: None,
    };
    match part {
        Part::Text(t) => WirePart { text: Some(t.text.clone()), ..base(&t.id, "text") },
        Part::Reasoning(r) => WirePart { text: Some(r.text.clone()), ..base(&r.id, "reasoning") },
        Part::ToolCall(tc) => WirePart {
            tool: Some(tc.name.clone()),
            state: Some(PartState {
                status: Some(tool_status(&tc.state).into()),
                tool: Some(tc.name.clone()),
                title: tc.title.clone(),
                input: Some(tc.input.clone()),
                output: tc.output.clone().map(Value::String),
                error: tc.error.clone(),
                ..PartState::default()
            }),
            ..base(&tc.id, "tool")
        },
        Part::Attachment(a) => WirePart {
            state: Some(PartState {
                mime: Some(a.mime.clone()),
                url: Some(a.source.clone()),
                name: a.name.clone(),
                ..PartState::default()
            }),
            ..base(&a.id, "file")
        },
    }
}

/// `MessageInfo` for a message. The session id is the BOSS thread id, as it
/// was in the Electron app.
pub fn info_to_wire(message: &Message) -> MessageInfo {
    MessageInfo {
        id: message.id.to_string(),
        session_id: message.thread_id.to_string(),
        role: role_name(message.role).into(),
        model: message.model.clone().map(|id| SessionModel { id: Some(id), provider: None }),
        time: Some(MessageTime { created: Some(millis(message.created_at)), completed: None }),
        author: message.author.as_ref().map(ToString::to_string),
        recipient: message.recipient.as_ref().map(ToString::to_string),
        branch_of: message.branch_of.as_ref().map(ToString::to_string),
    }
}

/// A whole message in the old shape.
pub fn message_to_wire(message: &Message) -> MessageWithParts {
    let (session_id, message_id) = (message.thread_id.to_string(), message.id.to_string());
    MessageWithParts {
        info: info_to_wire(message),
        parts: message.parts.iter().map(|p| part_to_wire(&session_id, &message_id, p)).collect(),
    }
}

/// Port of `trimToolOutput`: cap tool outputs at `limit` characters and
/// record the full length on anything shortened.
pub fn trim_tool_output(messages: &mut [MessageWithParts], limit: usize) {
    for message in messages {
        for part in &mut message.parts {
            if part.kind != "tool" {
                continue;
            }
            let Some(state) = part.state.as_mut() else { continue };
            let text = match &state.output {
                Some(Value::String(s)) => s.clone(),
                Some(other) => other.to_string(),
                None => String::new(),
            };
            let length = text.chars().count();
            if length <= limit {
                continue;
            }
            state.output = Some(Value::String(text.chars().take(limit).collect()));
            state.output_truncated = Some(length);
        }
    }
}

/// `SupervisedThread`: one row of the phone's thread list.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadRow {
    pub thread_id: String,
    pub backend_id: String,
    pub title: String,
    pub project_path: String,
    pub execution_path: String,
    pub updated_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree_branch: Option<String>,
    pub running: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attention: Option<Attention>,
    pub archived: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "parentID")]
    pub parent_id: Option<String>,
    pub usage: UsageTotals,
}

/// What a thread needs from a person, or how its last run ended.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Attention {
    pub kind: String,
    pub created_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/// `ThreadUsageTotals`. The Rust runtime does not meter runs yet, so zeros.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageTotals {
    pub runs: u64,
    pub duration_ms: u64,
    pub token_runs: u64,
    pub tool_calls: u64,
}

/// The old permission mode names.
pub fn mode_name(mode: PermissionMode) -> &'static str {
    match mode {
        PermissionMode::Default => "ask",
        PermissionMode::AcceptEdits => "accept-edits",
        PermissionMode::Bypass => "auto",
        PermissionMode::Plan => "plan",
    }
}

/// Parse an old permission mode name.
pub fn parse_mode(mode: &str) -> Option<PermissionMode> {
    match mode {
        "ask" => Some(PermissionMode::Default),
        "accept-edits" => Some(PermissionMode::AcceptEdits),
        "auto" => Some(PermissionMode::Bypass),
        "plan" => Some(PermissionMode::Plan),
        _ => None,
    }
}

/// Parse an old backend id. `lab` is gone.
pub fn parse_engine(backend_id: &str) -> Option<EngineId> {
    EngineId::ALL.into_iter().find(|e| e.as_str() == backend_id)
}

/// A thread row for the phone list.
pub fn thread_row(thread: &Thread, project: Option<&Project>, engine: EngineId, running: bool, attention: Option<Attention>, mode: PermissionMode) -> ThreadRow {
    let project_path = project.map(|p| p.root.to_string_lossy().into_owned()).unwrap_or_default();
    let execution_path = thread.cwd.to_string_lossy().into_owned();
    ThreadRow {
        thread_id: thread.id.to_string(),
        backend_id: engine.as_str().into(),
        title: thread.title.clone(),
        worktree_branch: None,
        project_path,
        execution_path,
        updated_at: millis(thread.updated_at),
        running,
        attention,
        archived: thread.archived,
        mode: Some(mode_name(mode).into()),
        parent_id: None,
        usage: UsageTotals::default(),
    }
}

/// `SessionInfo` for a thread, as `thread.create` and `thread.get` return it.
pub fn session_info(thread: &Thread, project: Option<&Project>, engine: EngineId, busy: bool) -> Value {
    json!({
        "id": thread.id.to_string(),
        "backendId": engine.as_str(),
        "title": thread.title,
        "projectPath": project.map(|p| p.root.to_string_lossy().into_owned()).unwrap_or_default(),
        "executionPath": thread.cwd.to_string_lossy(),
        "archived": thread.archived,
        "busy": busy,
        "time": { "created": millis(thread.created_at), "updated": millis(thread.updated_at) }
    })
}

/// The phone's `Todo` rows.
pub fn todos_to_wire(todos: &[Todo]) -> Value {
    Value::Array(
        todos
            .iter()
            .enumerate()
            .map(|(i, t)| {
                let status = if t.done {
                    "completed"
                } else if t.active {
                    "in_progress"
                } else {
                    "pending"
                };
                json!({ "id": i.to_string(), "content": t.text, "status": status })
            })
            .collect(),
    )
}

/// The `BackendDescriptor` rows `backend.list` returns.
pub fn backend_descriptor(engine: EngineId, probe: &EngineProbe) -> Value {
    let modes = [PermissionMode::Default, PermissionMode::Bypass, PermissionMode::Plan, PermissionMode::AcceptEdits];
    let unavailable = if !probe.installed {
        Some(format!("{} is not installed.", engine.label()))
    } else {
        probe.auth_error.clone()
    };
    json!({
        "id": engine.as_str(),
        "label": engine.label(),
        "description": format!("{} through its local CLI.", engine.label()),
        "available": probe.installed && probe.auth_error.is_none(),
        "healthy": probe.installed,
        "version": probe.version,
        "unavailableReason": unavailable,
        "capabilities": {
            "streaming": true, "models": true, "permissions": true, "nativeFork": false,
            "steering": "stop-and-redirect", "branching": "context-copy", "images": true,
            "mcp": true, "interactiveQuestions": true, "nativeAutoMode": false,
            "revert": false, "compact": false
        },
        "modes": modes.iter().map(|m| json!({
            "id": mode_name(*m),
            "label": match m {
                PermissionMode::Default => "Ask",
                PermissionMode::Bypass => "Auto",
                PermissionMode::Plan => "Plan",
                PermissionMode::AcceptEdits => "Accept edits",
            },
            "description": match m {
                PermissionMode::Default => "Ask before each tool the agent would ask about.",
                PermissionMode::Bypass => "Approve everything.",
                PermissionMode::Plan => "Read-only planning.",
                PermissionMode::AcceptEdits => "Approve file edits automatically.",
            }
        })).collect::<Vec<_>>()
    })
}

/// The `ModelOption` rows `thread.models` returns.
pub fn models_to_wire(models: &[ModelInfo]) -> Value {
    Value::Array(models.iter().map(|m| json!({ "id": m.id, "name": m.label, "provider": m.provider })).collect())
}

fn envelope(kind: &str, properties: Value) -> Value {
    json!({ "type": kind, "properties": properties })
}

/// The old events one engine event becomes, after `model.apply` has folded
/// it. The phone keys everything by `sessionID`, which is the thread id.
pub fn events_for(model: &ThreadModel, event: &EngineEvent) -> Vec<Value> {
    let sid = model.thread.id.to_string();
    let message_info = |id: &MessageId| model.message(id).map(|m| envelope("message.updated", json!({ "info": info_to_wire(m) })));
    let part_updated = |message_id: &MessageId, part_id: &PartId| {
        let message = model.message(message_id)?;
        let part = message.parts.iter().find(|p| p.id() == part_id)?;
        Some(envelope("message.part.updated", json!({ "part": part_to_wire(&sid, message_id.as_str(), part) })))
    };
    match event {
        EngineEvent::SessionReady { .. } | EngineEvent::ToolCallInputDelta { .. } => vec![],
        EngineEvent::MessageStarted { message_id, .. } | EngineEvent::MessageCompleted { message_id, .. } => {
            message_info(message_id).into_iter().collect()
        }
        EngineEvent::TextDelta { message_id, part_id, .. }
        | EngineEvent::ReasoningDelta { message_id, part_id, .. }
        | EngineEvent::ToolCallStarted { message_id, part_id, .. }
        | EngineEvent::ToolCallRunning { message_id, part_id }
        | EngineEvent::ToolCallFinished { message_id, part_id, .. } => part_updated(message_id, part_id).into_iter().collect(),
        EngineEvent::PermissionRequested { request, tool, input, title, message_id } => {
            let mut metadata = match input {
                Value::Object(map) => map.clone(),
                other => serde_json::Map::from_iter([("input".to_string(), other.clone())]),
            };
            if let Some(title) = title {
                metadata.insert("title".into(), Value::String(title.clone()));
            }
            vec![envelope(
                "permission.asked",
                json!({
                    "id": request.to_string(),
                    "sessionID": sid,
                    "permission": tool,
                    "patterns": title.iter().collect::<Vec<_>>(),
                    "metadata": metadata,
                    "tool": { "messageID": message_id.as_ref().map(ToString::to_string) },
                    "time": { "created": super::protocol::now_ms() }
                }),
            )]
        }
        EngineEvent::QuestionAsked { request, prompt, options } => vec![envelope(
            "question.asked",
            json!({
                "id": request.to_string(),
                "sessionID": sid,
                "questions": [{ "question": prompt, "options": options.iter().map(|o| json!({ "label": o })).collect::<Vec<_>>(), "custom": true }]
            }),
        )],
        EngineEvent::RequestWithdrawn { request } => vec![envelope(
            "permission.replied",
            json!({ "sessionID": sid, "permissionID": request.to_string(), "response": "reject" }),
        )],
        EngineEvent::Todos { items } => vec![envelope("todo.updated", json!({ "sessionID": sid, "todos": todos_to_wire(items) }))],
        EngineEvent::Status { busy } => status_events(&sid, *busy),
        EngineEvent::Error { message, .. } => vec![envelope("session.error", json!({ "sessionID": sid, "error": message }))],
        EngineEvent::Closed => status_events(&sid, false),
    }
}

/// `session.status`, plus `session.idle` when a run ended.
pub fn status_events(session_id: &str, busy: bool) -> Vec<Value> {
    let mut out = vec![envelope(
        "session.status",
        json!({ "sessionID": session_id, "status": { "type": if busy { "busy" } else { "idle" } } }),
    )];
    if !busy {
        out.push(envelope("session.idle", json!({ "sessionID": session_id })));
    }
    out
}

/// `permission.replied` after the phone answered.
pub fn permission_replied(session_id: &str, permission_id: &str, response: &str) -> Value {
    envelope("permission.replied", json!({ "sessionID": session_id, "permissionID": permission_id, "response": response }))
}

/// `thread.followups.updated`, carrying the whole queue.
pub fn followups_updated(thread_id: &str, queue: &Value) -> Value {
    envelope("thread.followups.updated", json!({ "threadId": thread_id, "followUps": queue }))
}

/// The attention a thread's pending requests imply, if any.
pub fn attention_for_pending(pending: &[PendingRequest]) -> Option<Attention> {
    let now = super::protocol::now_ms();
    pending.last().map(|p| match p {
        PendingRequest::Permission { tool, title, .. } => Attention {
            kind: "permission".into(),
            created_at: now,
            detail: Some(title.clone().unwrap_or_else(|| tool.clone())),
        },
        PendingRequest::Question { prompt, .. } => Attention { kind: "question".into(), created_at: now, detail: Some(prompt.clone()) },
    })
}

/// The text of a `thread.send` request's parts: every `{type:'text'}` joined.
pub fn prompt_text(parts: &[Value]) -> String {
    parts
        .iter()
        .filter(|p| p.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|p| p.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use time::macros::datetime;

    fn thread() -> Thread {
        Thread {
            id: ThreadId::from_raw("thr_1"),
            project_id: ProjectId::from_raw("prj_1"),
            title: "Fix the build".into(),
            kind: ThreadKind::Chat { engine: EngineId::Claude },
            created_at: datetime!(2024-01-01 00:00:00 UTC),
            updated_at: datetime!(2024-01-01 00:00:05 UTC),
            cwd: "/repo".into(),
            archived: false,
        }
    }

    fn sample_message() -> Message {
        Message {
            id: MessageId::from_raw("msg_1"),
            thread_id: ThreadId::from_raw("thr_1"),
            role: Role::Assistant,
            author: None,
            recipient: None,
            branch_of: None,
            created_at: datetime!(2024-01-01 00:00:01 UTC),
            status: MessageStatus::Complete,
            parts: vec![
                Part::Text(TextPart { id: PartId::from_raw("prt_t"), text: "Hello".into() }),
                Part::Reasoning(ReasoningPart { id: PartId::from_raw("prt_r"), text: "thinking".into() }),
                Part::ToolCall(ToolCallPart {
                    id: PartId::from_raw("prt_c"),
                    call_id: "call_1".into(),
                    name: "Bash".into(),
                    input: json!({ "command": "ls" }),
                    state: ToolState::Done,
                    title: Some("ls".into()),
                    output: Some("a\nb".into()),
                    error: None,
                }),
            ],
            revision: 3,
            usage: None,
            model: Some("claude-sonnet".into()),
        }
    }

    #[test]
    fn a_message_maps_to_the_old_message_with_parts_shape() {
        let wire = serde_json::to_value(message_to_wire(&sample_message())).unwrap();
        assert_eq!(
            wire,
            json!({
                "info": {
                    "id": "msg_1", "sessionID": "thr_1", "role": "assistant",
                    "model": { "id": "claude-sonnet" },
                    "time": { "created": 1704067201000i64 }
                },
                "parts": [
                    { "id": "prt_t", "type": "text", "sessionID": "thr_1", "messageID": "msg_1", "text": "Hello" },
                    { "id": "prt_r", "type": "reasoning", "sessionID": "thr_1", "messageID": "msg_1", "text": "thinking" },
                    { "id": "prt_c", "type": "tool", "sessionID": "thr_1", "messageID": "msg_1", "tool": "Bash",
                      "state": { "status": "completed", "tool": "Bash", "title": "ls", "input": { "command": "ls" }, "output": "a\nb" } }
                ]
            })
        );
    }

    #[test]
    fn samples_from_the_electron_backends_round_trip_through_the_structs() {
        // Shapes copied from claude-backend.ts and codex-backend.ts.
        let samples = [
            json!({ "info": { "id": "m1", "sessionID": "s1", "role": "assistant", "time": { "created": 1 } },
                    "parts": [{ "id": "m1-tool-0", "type": "tool", "sessionID": "s1", "messageID": "m1",
                                "state": { "status": "running", "tool": "Read", "title": "src/main.ts", "input": { "file_path": "src/main.ts" } } }] }),
            json!({ "info": { "id": "m2", "sessionID": "s1", "role": "user" },
                    "parts": [{ "id": "p", "type": "text", "sessionID": "s1", "messageID": "m2", "text": "hi" }] }),
            json!({ "info": { "id": "m3", "sessionID": "s1", "role": "assistant" },
                    "parts": [{ "id": "r", "type": "tool", "sessionID": "s1", "messageID": "m3",
                                "state": { "status": "error", "output": [{ "type": "text", "text": "boom" }] } }] }),
        ];
        for sample in samples {
            let parsed: MessageWithParts = serde_json::from_value(sample.clone()).unwrap();
            assert_eq!(serde_json::to_value(&parsed).unwrap(), sample);
        }
    }

    #[test]
    fn trimming_cuts_long_tool_output_and_records_the_full_length() {
        let mut messages = vec![message_to_wire(&sample_message())];
        messages[0].parts[2].state.as_mut().unwrap().output = Some(Value::String("é".repeat(50)));
        trim_tool_output(&mut messages, 10);
        let state = messages[0].parts[2].state.as_ref().unwrap();
        assert_eq!(state.output, Some(Value::String("é".repeat(10))));
        assert_eq!(state.output_truncated, Some(50));
        // Short outputs and non-tool parts are untouched.
        assert_eq!(messages[0].parts[0].text.as_deref(), Some("Hello"));
        let mut short = vec![message_to_wire(&sample_message())];
        trim_tool_output(&mut short, 10);
        assert_eq!(short[0].parts[2].state.as_ref().unwrap().output_truncated, None);
    }

    #[test]
    fn requests_parse_by_type_with_camel_case_fields() {
        let r: Request = serde_json::from_value(json!({ "type": "thread.messages", "threadId": "t", "limit": 60, "trimOutput": 2000 })).unwrap();
        assert_eq!(r, Request::ThreadMessages { thread_id: "t".into(), limit: Some(60), trim_output: Some(2000) });
        let r: Request = serde_json::from_value(json!({ "type": "thread.permission", "threadId": "t", "permissionId": "p", "response": "once" })).unwrap();
        assert_eq!(r, Request::ThreadPermission { thread_id: "t".into(), permission_id: "p".into(), response: "once".into() });
        let r: Request = serde_json::from_value(json!({ "type": "thread.followups.move", "threadId": "t", "followUpId": "f", "toIndex": 2 })).unwrap();
        assert_eq!(r, Request::FollowupsMove { thread_id: "t".into(), follow_up_id: "f".into(), to_index: 2 });
        let r: Request = serde_json::from_value(json!({ "type": "thread.create", "backendId": "claude", "executionPath": "/repo" })).unwrap();
        assert_eq!(r, Request::ThreadCreate { backend_id: "claude".into(), title: None, execution_path: Some("/repo".into()) });
        assert!(serde_json::from_value::<Request>(json!({ "type": "thread.fork", "threadId": "t" })).is_err());
        assert!(relay_request_allowed("thread.delegate"));
        assert!(!relay_request_allowed("thread.fork"));
        assert!(!relay_request_allowed("remote.set"));
    }

    #[test]
    fn engine_events_become_the_old_envelopes() {
        let mut model = ThreadModel::new(thread(), vec![], vec![]);
        let mid = MessageId::from_raw("msg_a");
        let pid = PartId::from_raw("prt_a");

        let started = EngineEvent::MessageStarted { message_id: mid.clone(), role: Role::Assistant };
        model.apply(None, started.clone());
        let events = events_for(&model, &started);
        assert_eq!(events[0]["type"], "message.updated");
        assert_eq!(events[0]["properties"]["info"]["sessionID"], "thr_1");
        assert_eq!(events[0]["properties"]["info"]["id"], "msg_a");

        let delta = EngineEvent::TextDelta { message_id: mid.clone(), part_id: pid.clone(), delta: "Hi".into() };
        model.apply(None, delta.clone());
        let events = events_for(&model, &delta);
        assert_eq!(events[0]["type"], "message.part.updated");
        assert_eq!(events[0]["properties"]["part"], json!({ "id": "prt_a", "type": "text", "sessionID": "thr_1", "messageID": "msg_a", "text": "Hi" }));

        assert_eq!(
            events_for(&model, &EngineEvent::Status { busy: true }),
            vec![json!({ "type": "session.status", "properties": { "sessionID": "thr_1", "status": { "type": "busy" } } })]
        );
        let idle = events_for(&model, &EngineEvent::Status { busy: false });
        assert_eq!(idle[0]["properties"]["status"]["type"], "idle");
        assert_eq!(idle[1], json!({ "type": "session.idle", "properties": { "sessionID": "thr_1" } }));

        let asked = EngineEvent::PermissionRequested {
            request: RequestId::from_raw("req_1"),
            tool: "Bash".into(),
            input: json!({ "command": "rm -rf build" }),
            title: Some("rm -rf build".into()),
            message_id: Some(mid.clone()),
        };
        model.apply(None, asked.clone());
        let events = events_for(&model, &asked);
        let props = &events[0]["properties"];
        assert_eq!(events[0]["type"], "permission.asked");
        assert_eq!(props["id"], "req_1");
        assert_eq!(props["sessionID"], "thr_1");
        assert_eq!(props["permission"], "Bash");
        assert_eq!(props["patterns"], json!(["rm -rf build"]));
        assert_eq!(props["metadata"]["command"], "rm -rf build");
        assert_eq!(props["metadata"]["title"], "rm -rf build");
        assert_eq!(attention_for_pending(&model.pending).unwrap().kind, "permission");

        let withdrawn = events_for(&model, &EngineEvent::RequestWithdrawn { request: RequestId::from_raw("req_1") });
        assert_eq!(withdrawn[0], json!({ "type": "permission.replied", "properties": { "sessionID": "thr_1", "permissionID": "req_1", "response": "reject" } }));

        let error = events_for(&model, &EngineEvent::Error { message: "boom".into(), fatal: true });
        assert_eq!(error[0], json!({ "type": "session.error", "properties": { "sessionID": "thr_1", "error": "boom" } }));
        assert!(event_forwarded(&error[0]));
        assert!(!event_forwarded(&json!({ "type": "todo.updated" })));
    }

    #[test]
    fn thread_rows_carry_what_the_phone_list_reads() {
        let project = Project { id: ProjectId::from_raw("prj_1"), name: "repo".into(), root: "/repo".into(), added_at: datetime!(2024-01-01 00:00:00 UTC) };
        let row = thread_row(&thread(), Some(&project), EngineId::Claude, true, None, PermissionMode::AcceptEdits);
        assert_eq!(
            serde_json::to_value(&row).unwrap(),
            json!({
                "threadId": "thr_1", "backendId": "claude", "title": "Fix the build",
                "projectPath": "/repo", "executionPath": "/repo", "updatedAt": 1704067205000i64,
                "running": true, "archived": false, "mode": "accept-edits",
                "usage": { "runs": 0, "durationMs": 0, "tokenRuns": 0, "toolCalls": 0 }
            })
        );
        assert_eq!(parse_mode("auto"), Some(PermissionMode::Bypass));
        assert_eq!(parse_mode("weird"), None);
        assert_eq!(parse_engine("codex"), Some(EngineId::Codex));
        assert_eq!(parse_engine("lab"), None);
    }

    #[test]
    fn todos_and_prompt_text_map() {
        let todos = vec![Todo { text: "a".into(), done: true, active: false }, Todo { text: "b".into(), done: false, active: true }, Todo { text: "c".into(), done: false, active: false }];
        assert_eq!(
            todos_to_wire(&todos),
            json!([{ "id": "0", "content": "a", "status": "completed" }, { "id": "1", "content": "b", "status": "in_progress" }, { "id": "2", "content": "c", "status": "pending" }])
        );
        assert_eq!(prompt_text(&[json!({ "type": "text", "text": "one" }), json!({ "type": "file" }), json!({ "type": "text", "text": "two" })]), "one\ntwo");
    }

    #[test]
    fn backend_descriptors_carry_modes_and_availability() {
        let probe = EngineProbe { installed: true, version: Some("1.0".into()), auth_error: None };
        let d = backend_descriptor(EngineId::Codex, &probe);
        assert_eq!(d["id"], "codex");
        assert_eq!(d["available"], true);
        assert_eq!(d["modes"].as_array().unwrap().len(), 4);
        assert_eq!(d["capabilities"]["steering"], "stop-and-redirect");
        let missing = backend_descriptor(EngineId::Pi, &EngineProbe::default());
        assert_eq!(missing["available"], false);
        assert_eq!(missing["unavailableReason"], "pi is not installed.");
    }
}
