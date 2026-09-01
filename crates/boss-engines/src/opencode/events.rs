//! opencode's SSE stream and the translation of its events into `EngineEvent`s.
//!
//! Port of `src/main/event-stream.ts` (reader with 1s reconnect) plus the
//! event mapping that the Electron renderer used to do from `EventMessage`.

use super::client::OpencodeClient;
use boss_core::{EngineEvent, MessageId, PartId, RequestId, Role, Todo, Usage};
use futures::StreamExt;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::time::Duration;

/// Incremental parser for `text/event-stream` bytes. Yields each event's
/// `data` payload (multi-line `data:` fields joined with `\n`).
#[derive(Debug, Default)]
pub struct SseParser {
    buffer: Vec<u8>,
}

impl SseParser {
    /// Append bytes and return every complete event payload they finish.
    pub fn feed(&mut self, bytes: &[u8]) -> Vec<String> {
        self.buffer.extend_from_slice(bytes);
        let mut out = Vec::new();
        while let Some(idx) = find_block_end(&self.buffer) {
            let block: Vec<u8> = self.buffer.drain(..idx).collect();
            // Skip the blank-line delimiter (either "\n\n" or "\r\n\r\n").
            let skip = if self.buffer.starts_with(b"\r\n\r\n") { 4 } else { 2 };
            self.buffer.drain(..skip.min(self.buffer.len()));
            let text = String::from_utf8_lossy(&block);
            let mut data: Vec<&str> = Vec::new();
            for line in text.split('\n') {
                let line = line.strip_suffix('\r').unwrap_or(line);
                if let Some(rest) = line.strip_prefix("data:") {
                    data.push(rest.strip_prefix(' ').unwrap_or(rest));
                }
            }
            if !data.is_empty() {
                let payload = data.join("\n");
                if !payload.trim().is_empty() {
                    out.push(payload);
                }
            }
        }
        out
    }
}

fn find_block_end(buf: &[u8]) -> Option<usize> {
    let lf = buf.windows(2).position(|w| w == b"\n\n");
    let crlf = buf.windows(4).position(|w| w == b"\r\n\r\n");
    match (lf, crlf) {
        (Some(a), Some(b)) => Some(a.min(b)),
        (a, b) => a.or(b),
    }
}

/// `/global/event` wraps each event as `{directory, payload}`; return the payload.
pub fn unwrap_global_event(event: Value) -> Value {
    match event {
        Value::Object(mut map) if map.get("payload").is_some_and(Value::is_object) => map.remove("payload").unwrap(),
        other => other,
    }
}

/// Read the server's event stream until `on_event` returns `false`, reconnecting
/// after one second whenever the connection drops.
pub async fn run_event_stream(client: OpencodeClient, mut on_event: impl FnMut(Value) -> bool) {
    loop {
        match client.open_event_stream().await {
            Ok(res) => {
                let mut parser = SseParser::default();
                let mut body = res.bytes_stream();
                while let Some(chunk) = body.next().await {
                    let Ok(chunk) = chunk else { break };
                    for payload in parser.feed(&chunk) {
                        let Ok(raw) = serde_json::from_str::<Value>(&payload) else {
                            tracing::debug!(payload = %payload, "opencode: non-JSON SSE payload");
                            continue;
                        };
                        if !on_event(unwrap_global_event(raw)) {
                            return;
                        }
                    }
                }
            }
            Err(err) => tracing::debug!(error = %err, "opencode: event stream not available"),
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}

/// Session-scoped translator. Remembers which messages and parts it has already
/// reported so that opencode's full-part snapshots become deltas.
#[derive(Debug)]
pub struct OpencodeTranslator {
    session_id: String,
    user_messages: HashSet<String>,
    started: HashSet<String>,
    completed: HashSet<String>,
    /// Bytes of text already emitted per text/reasoning part.
    emitted: HashMap<String, usize>,
    /// Last tool status reported per tool part id.
    tool_status: HashMap<String, String>,
    /// Ids of `question.asked` requests, so a reply can be routed.
    questions: HashSet<String>,
}

impl OpencodeTranslator {
    /// Translator for one opencode session id; events for other sessions are dropped.
    pub fn new(session_id: impl Into<String>) -> Self {
        Self {
            session_id: session_id.into(),
            user_messages: HashSet::new(),
            started: HashSet::new(),
            completed: HashSet::new(),
            emitted: HashMap::new(),
            tool_status: HashMap::new(),
            questions: HashSet::new(),
        }
    }

    /// Whether `request` was raised by `question.asked` (vs a permission).
    pub fn is_question(&self, request: &str) -> bool {
        self.questions.contains(request)
    }

    /// Forget a question once it has been answered.
    pub fn forget_question(&mut self, request: &str) {
        self.questions.remove(request);
    }

    /// Translate one native event (already unwrapped from the global envelope).
    pub fn translate(&mut self, event: &Value) -> Vec<EngineEvent> {
        let Some(kind) = event.get("type").and_then(Value::as_str) else {
            return Vec::new();
        };
        let props = event.get("properties").unwrap_or(&Value::Null);
        match kind {
            "message.updated" => self.message_updated(props.get("info").unwrap_or(props)),
            "message.part.updated" => self.part_updated(props.get("part").unwrap_or(props), props.get("delta").and_then(Value::as_str)),
            "message.part.delta" => self.part_delta(props),
            "session.status" => {
                if !self.is_ours(props.get("sessionID")) {
                    return Vec::new();
                }
                let status = props.pointer("/status/type").and_then(Value::as_str).unwrap_or("idle");
                vec![EngineEvent::Status { busy: matches!(status, "busy" | "retry") }]
            }
            "session.idle" => self.only_ours(props, vec![EngineEvent::Status { busy: false }]),
            "session.error" => {
                if !self.is_ours(props.get("sessionID")) {
                    return Vec::new();
                }
                vec![EngineEvent::Error { message: error_message(props.get("error")), fatal: false }, EngineEvent::Status { busy: false }]
            }
            "permission.updated" | "permission.asked" => self.permission(props),
            "question.asked" => self.question(props),
            "todo.updated" | "session.todo.updated" => self.only_ours(props, vec![EngineEvent::Todos { items: todos(props.get("todos")) }]),
            _ => Vec::new(),
        }
    }

    fn is_ours(&self, session_id: Option<&Value>) -> bool {
        session_id.and_then(Value::as_str) == Some(self.session_id.as_str())
    }

    fn only_ours(&self, props: &Value, events: Vec<EngineEvent>) -> Vec<EngineEvent> {
        if self.is_ours(props.get("sessionID")) { events } else { Vec::new() }
    }

    fn ensure_started(&mut self, message_id: &str, out: &mut Vec<EngineEvent>) {
        if self.started.insert(message_id.to_string()) {
            out.push(EngineEvent::MessageStarted { message_id: MessageId::from_raw(message_id), role: Role::Assistant });
        }
    }

    fn message_updated(&mut self, info: &Value) -> Vec<EngineEvent> {
        if !self.is_ours(info.get("sessionID")) {
            return Vec::new();
        }
        let Some(id) = info.get("id").and_then(Value::as_str) else {
            return Vec::new();
        };
        let mut out = Vec::new();
        match info.get("role").and_then(Value::as_str) {
            Some("user") => {
                self.user_messages.insert(id.to_string());
                return out;
            }
            Some("assistant") => {}
            _ => return out,
        }
        self.ensure_started(id, &mut out);
        if let Some(err) = info.get("error").filter(|e| !e.is_null()) {
            out.push(EngineEvent::Error { message: error_message(Some(err)), fatal: false });
        }
        let completed = info.pointer("/time/completed").is_some_and(|v| !v.is_null()) || info.get("error").is_some_and(|e| !e.is_null());
        if completed && self.completed.insert(id.to_string()) {
            let model = match (info.get("providerID").and_then(Value::as_str), info.get("modelID").and_then(Value::as_str)) {
                (Some(p), Some(m)) => Some(format!("{p}/{m}")),
                (None, Some(m)) => Some(m.to_string()),
                _ => None,
            };
            out.push(EngineEvent::MessageCompleted { message_id: MessageId::from_raw(id), usage: usage(info), model });
        }
        out
    }

    fn part_updated(&mut self, part: &Value, delta: Option<&str>) -> Vec<EngineEvent> {
        if !self.is_ours(part.get("sessionID")) {
            return Vec::new();
        }
        let (Some(part_id), Some(message_id)) = (part.get("id").and_then(Value::as_str), part.get("messageID").and_then(Value::as_str)) else {
            return Vec::new();
        };
        if self.user_messages.contains(message_id) {
            return Vec::new();
        }
        let mut out = Vec::new();
        match part.get("type").and_then(Value::as_str) {
            Some("text") => {
                if part.get("ignored").and_then(Value::as_bool).unwrap_or(false) {
                    return out;
                }
                self.ensure_started(message_id, &mut out);
                if let Some(d) = self.text_delta(part_id, part.get("text").and_then(Value::as_str), delta) {
                    out.push(EngineEvent::TextDelta { message_id: message_id.into(), part_id: part_id.into(), delta: d });
                }
            }
            Some("reasoning") => {
                self.ensure_started(message_id, &mut out);
                if let Some(d) = self.text_delta(part_id, part.get("text").and_then(Value::as_str), delta) {
                    out.push(EngineEvent::ReasoningDelta { message_id: message_id.into(), part_id: part_id.into(), delta: d });
                }
            }
            Some("tool") => {
                self.ensure_started(message_id, &mut out);
                self.tool_part(part, part_id, message_id, &mut out);
            }
            _ => {}
        }
        out
    }

    /// v2 servers stream `message.part.delta` instead of re-sending the part.
    fn part_delta(&mut self, props: &Value) -> Vec<EngineEvent> {
        if !self.is_ours(props.get("sessionID")) {
            return Vec::new();
        }
        let (Some(message_id), Some(part_id), Some(delta)) = (
            props.get("messageID").and_then(Value::as_str),
            props.get("partID").and_then(Value::as_str),
            props.get("delta").and_then(Value::as_str),
        ) else {
            return Vec::new();
        };
        if self.user_messages.contains(message_id) || delta.is_empty() {
            return Vec::new();
        }
        let mut out = Vec::new();
        self.ensure_started(message_id, &mut out);
        *self.emitted.entry(part_id.to_string()).or_default() += delta.len();
        let field = props.get("field").and_then(Value::as_str).unwrap_or("text");
        out.push(match field {
            "reasoning" | "thinking" => {
                EngineEvent::ReasoningDelta { message_id: message_id.into(), part_id: part_id.into(), delta: delta.to_string() }
            }
            _ => EngineEvent::TextDelta { message_id: message_id.into(), part_id: part_id.into(), delta: delta.to_string() },
        });
        out
    }

    /// Turn a full-text snapshot into the not-yet-emitted suffix. Falls back to
    /// the event's own `delta` when there is no text, and to the whole text when
    /// the snapshot no longer extends what was emitted (the part was rewritten).
    fn text_delta(&mut self, part_id: &str, text: Option<&str>, delta: Option<&str>) -> Option<String> {
        let Some(text) = text else {
            let d = delta?;
            if d.is_empty() {
                return None;
            }
            *self.emitted.entry(part_id.to_string()).or_default() += d.len();
            return Some(d.to_string());
        };
        let seen = self.emitted.get(part_id).copied().unwrap_or(0);
        let out = if text.len() >= seen && text.is_char_boundary(seen) { &text[seen..] } else { text };
        if out.is_empty() {
            return None;
        }
        self.emitted.insert(part_id.to_string(), text.len());
        Some(out.to_string())
    }

    fn tool_part(&mut self, part: &Value, part_id: &str, message_id: &str, out: &mut Vec<EngineEvent>) {
        let state = part.get("state").unwrap_or(&Value::Null);
        let status = state.get("status").and_then(Value::as_str).unwrap_or("pending");
        let previous = self.tool_status.get(part_id).cloned();
        let message_id = MessageId::from_raw(message_id);
        let pid = PartId::from_raw(part_id);
        if previous.is_none() {
            let name = part.get("tool").and_then(Value::as_str).or_else(|| state.get("tool").and_then(Value::as_str)).unwrap_or("tool");
            out.push(EngineEvent::ToolCallStarted {
                message_id: message_id.clone(),
                part_id: pid.clone(),
                call_id: part.get("callID").and_then(Value::as_str).unwrap_or(part_id).to_string(),
                name: name.to_string(),
                input: state.get("input").cloned().unwrap_or(Value::Object(Default::default())),
                title: state.get("title").and_then(Value::as_str).map(str::to_string),
            });
        }
        if previous.as_deref() == Some(status) {
            return;
        }
        self.tool_status.insert(part_id.to_string(), status.to_string());
        match status {
            "running" => out.push(EngineEvent::ToolCallRunning { message_id, part_id: pid }),
            "completed" => out.push(EngineEvent::ToolCallFinished {
                message_id,
                part_id: pid,
                output: Some(stringify(state.get("output"))),
                error: None,
            }),
            "error" => out.push(EngineEvent::ToolCallFinished {
                message_id,
                part_id: pid,
                output: None,
                error: Some(state.get("error").and_then(Value::as_str).unwrap_or("Tool failed.").to_string()),
            }),
            _ => {}
        }
    }

    fn permission(&mut self, props: &Value) -> Vec<EngineEvent> {
        if !self.is_ours(props.get("sessionID")) {
            return Vec::new();
        }
        let Some(id) = props.get("id").and_then(Value::as_str) else {
            return Vec::new();
        };
        // v1 (`permission.updated`): {type, pattern, title, messageID, callID, metadata}
        // v2 (`permission.asked`): {permission, patterns, always, metadata, tool: {messageID, callID}}
        let tool = props
            .get("permission")
            .or_else(|| props.get("type"))
            .and_then(Value::as_str)
            .unwrap_or("permission")
            .to_string();
        let mut input = props.get("metadata").cloned().filter(Value::is_object).unwrap_or_else(|| Value::Object(Default::default()));
        if let Some(obj) = input.as_object_mut() {
            if let Some(p) = props.get("patterns").or_else(|| props.get("pattern")).filter(|v| !v.is_null()) {
                obj.insert("patterns".into(), p.clone());
            }
            if let Some(call) = props.get("callID").or_else(|| props.pointer("/tool/callID")).and_then(Value::as_str) {
                obj.insert("callID".into(), Value::String(call.to_string()));
            }
        }
        let title = props.get("title").and_then(Value::as_str).map(str::to_string).or_else(|| {
            props
                .get("patterns")
                .and_then(Value::as_array)
                .map(|p| p.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(", "))
                .filter(|s| !s.is_empty())
        });
        let message_id = props
            .get("messageID")
            .or_else(|| props.pointer("/tool/messageID"))
            .and_then(Value::as_str)
            .map(MessageId::from_raw);
        vec![EngineEvent::PermissionRequested { request: RequestId::from_raw(id), tool, input, title, message_id }]
    }

    fn question(&mut self, props: &Value) -> Vec<EngineEvent> {
        if !self.is_ours(props.get("sessionID")) {
            return Vec::new();
        }
        let Some(id) = props.get("id").and_then(Value::as_str) else {
            return Vec::new();
        };
        let questions = props.get("questions").and_then(Value::as_array).cloned().unwrap_or_default();
        let prompt = questions
            .iter()
            .filter_map(|q| q.get("question").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n\n");
        let options = questions
            .first()
            .and_then(|q| q.get("options"))
            .and_then(Value::as_array)
            .map(|opts| opts.iter().filter_map(|o| o.get("label").and_then(Value::as_str).map(str::to_string)).collect())
            .unwrap_or_default();
        self.questions.insert(id.to_string());
        vec![EngineEvent::QuestionAsked { request: RequestId::from_raw(id), prompt, options }]
    }
}

fn stringify(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(other) => other.to_string(),
    }
}

fn error_message(error: Option<&Value>) -> String {
    let Some(error) = error else {
        return "OpenCode reported an error.".to_string();
    };
    if let Some(s) = error.as_str() {
        return s.to_string();
    }
    if let Some(msg) = error.pointer("/data/message").and_then(Value::as_str) {
        return msg.to_string();
    }
    if let Some(name) = error.get("name").and_then(Value::as_str) {
        return name.to_string();
    }
    error.to_string()
}

fn usage(info: &Value) -> Option<Usage> {
    let tokens = info.get("tokens")?;
    let n = |key: &str| tokens.get(key).and_then(Value::as_u64).unwrap_or(0);
    Some(Usage {
        input_tokens: n("input"),
        output_tokens: n("output"),
        cache_read_tokens: tokens.pointer("/cache/read").and_then(Value::as_u64).unwrap_or(0),
        cache_write_tokens: tokens.pointer("/cache/write").and_then(Value::as_u64).unwrap_or(0),
        cost_usd: info.get("cost").and_then(Value::as_f64),
    })
}

fn todos(value: Option<&Value>) -> Vec<Todo> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .map(|t| {
                    let status = t.get("status").and_then(Value::as_str).unwrap_or("pending");
                    Todo {
                        text: t.get("content").and_then(Value::as_str).unwrap_or("").to_string(),
                        done: status == "completed",
                        active: status == "in_progress",
                    }
                })
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ev(kind: &str, props: Value) -> Value {
        json!({ "type": kind, "properties": props })
    }

    #[test]
    fn sse_parser_splits_blocks_and_joins_data_lines() {
        let mut p = SseParser::default();
        assert!(p.feed(b"data: {\"a\":").is_empty());
        let got = p.feed(b"1}\n\n: comment\ndata: x\ndata: y\n\nevent: ping\n\n");
        assert_eq!(got, vec!["{\"a\":1}".to_string(), "x\ny".to_string()]);
        let mut p = SseParser::default();
        assert_eq!(p.feed(b"data:{\"b\":2}\r\n\r\n"), vec!["{\"b\":2}".to_string()]);
    }

    #[test]
    fn global_envelope_is_unwrapped_and_legacy_kept() {
        let native = json!({ "type": "session.idle", "properties": { "sessionID": "ses_1" } });
        assert_eq!(unwrap_global_event(native.clone()), native);
        assert_eq!(unwrap_global_event(json!({ "directory": "/tmp/worktree", "payload": native.clone() })), native);
    }

    #[test]
    fn assistant_message_streams_text_as_deltas_and_completes() {
        let mut t = OpencodeTranslator::new("ses_1");
        let info = json!({ "id": "msg_1", "sessionID": "ses_1", "role": "assistant", "providerID": "anthropic", "modelID": "claude", "time": { "created": 1 }, "cost": 0, "tokens": { "input": 0, "output": 0, "reasoning": 0, "cache": { "read": 0, "write": 0 } } });
        assert_eq!(
            t.translate(&ev("message.updated", json!({ "info": info }))),
            vec![EngineEvent::MessageStarted { message_id: "msg_1".into(), role: Role::Assistant }]
        );
        let part = |text: &str| ev("message.part.updated", json!({ "part": { "id": "prt_1", "sessionID": "ses_1", "messageID": "msg_1", "type": "text", "text": text } }));
        assert_eq!(t.translate(&part("Hel")), vec![EngineEvent::TextDelta { message_id: "msg_1".into(), part_id: "prt_1".into(), delta: "Hel".into() }]);
        assert_eq!(t.translate(&part("Hello wörld")), vec![EngineEvent::TextDelta { message_id: "msg_1".into(), part_id: "prt_1".into(), delta: "lo wörld".into() }]);
        assert!(t.translate(&part("Hello wörld")).is_empty(), "unchanged snapshot emits nothing");
        let done = ev("message.updated", json!({ "info": { "id": "msg_1", "sessionID": "ses_1", "role": "assistant", "providerID": "anthropic", "modelID": "claude", "time": { "created": 1, "completed": 2 }, "cost": 0.5, "tokens": { "input": 10, "output": 5, "reasoning": 0, "cache": { "read": 3, "write": 1 } } } }));
        assert_eq!(
            t.translate(&done),
            vec![EngineEvent::MessageCompleted {
                message_id: "msg_1".into(),
                usage: Some(Usage { input_tokens: 10, output_tokens: 5, cache_read_tokens: 3, cache_write_tokens: 1, cost_usd: Some(0.5) }),
                model: Some("anthropic/claude".into()),
            }]
        );
        assert!(t.translate(&done).is_empty(), "completion is reported once");
    }

    #[test]
    fn user_message_parts_and_other_sessions_are_ignored() {
        let mut t = OpencodeTranslator::new("ses_1");
        assert!(t.translate(&ev("message.updated", json!({ "info": { "id": "msg_u", "sessionID": "ses_1", "role": "user", "time": { "created": 1 } } }))).is_empty());
        assert!(t.translate(&ev("message.part.updated", json!({ "part": { "id": "p", "sessionID": "ses_1", "messageID": "msg_u", "type": "text", "text": "hi" } }))).is_empty());
        assert!(t.translate(&ev("session.idle", json!({ "sessionID": "ses_other" }))).is_empty());
        assert!(t.translate(&ev("message.part.updated", json!({ "part": { "id": "p", "sessionID": "ses_other", "messageID": "m", "type": "text", "text": "hi" } }))).is_empty());
    }

    #[test]
    fn tool_part_lifecycle_maps_to_tool_events() {
        let mut t = OpencodeTranslator::new("ses_1");
        let tool = |state: Value| ev("message.part.updated", json!({ "part": { "id": "prt_t", "sessionID": "ses_1", "messageID": "msg_2", "type": "tool", "callID": "call_9", "tool": "bash", "state": state } }));
        let got = t.translate(&tool(json!({ "status": "pending", "input": { "command": "ls" }, "raw": "" })));
        assert_eq!(
            got,
            vec![
                EngineEvent::MessageStarted { message_id: "msg_2".into(), role: Role::Assistant },
                EngineEvent::ToolCallStarted { message_id: "msg_2".into(), part_id: "prt_t".into(), call_id: "call_9".into(), name: "bash".into(), input: json!({ "command": "ls" }), title: None },
            ]
        );
        assert_eq!(
            t.translate(&tool(json!({ "status": "running", "input": { "command": "ls" }, "title": "ls", "time": { "start": 1 } }))),
            vec![EngineEvent::ToolCallRunning { message_id: "msg_2".into(), part_id: "prt_t".into() }]
        );
        assert_eq!(
            t.translate(&tool(json!({ "status": "completed", "input": {}, "output": "a\nb", "title": "ls", "metadata": {}, "time": { "start": 1, "end": 2 } }))),
            vec![EngineEvent::ToolCallFinished { message_id: "msg_2".into(), part_id: "prt_t".into(), output: Some("a\nb".into()), error: None }]
        );
        let mut t = OpencodeTranslator::new("ses_1");
        let got = t.translate(&tool(json!({ "status": "error", "input": {}, "error": "boom", "time": { "start": 1, "end": 2 } })));
        assert!(matches!(&got[2], EngineEvent::ToolCallFinished { error: Some(e), output: None, .. } if e == "boom"));
    }

    #[test]
    fn reasoning_and_v2_deltas() {
        let mut t = OpencodeTranslator::new("ses_1");
        let got = t.translate(&ev("message.part.updated", json!({ "part": { "id": "r1", "sessionID": "ses_1", "messageID": "m", "type": "reasoning", "text": "think", "time": { "start": 1 } } })));
        assert!(matches!(&got[1], EngineEvent::ReasoningDelta { delta, .. } if delta == "think"));
        let got = t.translate(&ev("message.part.delta", json!({ "sessionID": "ses_1", "messageID": "m", "partID": "p2", "field": "text", "delta": "abc" })));
        assert_eq!(got, vec![EngineEvent::TextDelta { message_id: "m".into(), part_id: "p2".into(), delta: "abc".into() }]);
    }

    #[test]
    fn status_idle_error_and_todos() {
        let mut t = OpencodeTranslator::new("ses_1");
        assert_eq!(t.translate(&ev("session.status", json!({ "sessionID": "ses_1", "status": { "type": "busy" } }))), vec![EngineEvent::Status { busy: true }]);
        assert_eq!(t.translate(&ev("session.status", json!({ "sessionID": "ses_1", "status": { "type": "retry", "attempt": 1, "message": "x", "next": 2 } }))), vec![EngineEvent::Status { busy: true }]);
        assert_eq!(t.translate(&ev("session.status", json!({ "sessionID": "ses_1", "status": { "type": "idle" } }))), vec![EngineEvent::Status { busy: false }]);
        assert_eq!(t.translate(&ev("session.idle", json!({ "sessionID": "ses_1" }))), vec![EngineEvent::Status { busy: false }]);
        assert_eq!(
            t.translate(&ev("session.error", json!({ "sessionID": "ses_1", "error": { "name": "ProviderAuthError", "data": { "providerID": "anthropic", "message": "no key" } } }))),
            vec![EngineEvent::Error { message: "no key".into(), fatal: false }, EngineEvent::Status { busy: false }]
        );
        assert_eq!(
            t.translate(&ev("todo.updated", json!({ "sessionID": "ses_1", "todos": [
                { "content": "first", "status": "completed", "priority": "high" },
                { "content": "second", "status": "in_progress", "priority": "medium" },
                { "content": "third", "status": "pending" }
            ] }))),
            vec![EngineEvent::Todos { items: vec![
                Todo { text: "first".into(), done: true, active: false },
                Todo { text: "second".into(), done: false, active: true },
                Todo { text: "third".into(), done: false, active: false },
            ] }]
        );
    }

    #[test]
    fn permissions_v1_and_v2_and_questions() {
        let mut t = OpencodeTranslator::new("ses_1");
        let v1 = ev("permission.updated", json!({ "id": "per_1", "type": "bash", "pattern": "rm -rf *", "sessionID": "ses_1", "messageID": "msg_1", "callID": "call_1", "title": "Run rm", "metadata": { "cwd": "/tmp" }, "time": { "created": 1 } }));
        assert_eq!(
            t.translate(&v1),
            vec![EngineEvent::PermissionRequested {
                request: "per_1".into(),
                tool: "bash".into(),
                input: json!({ "cwd": "/tmp", "patterns": "rm -rf *", "callID": "call_1" }),
                title: Some("Run rm".into()),
                message_id: Some("msg_1".into()),
            }]
        );
        let v2 = ev("permission.asked", json!({ "id": "per_2", "sessionID": "ses_1", "permission": "edit", "patterns": ["src/a.rs"], "metadata": {}, "always": ["edit"], "tool": { "messageID": "msg_2", "callID": "call_2" } }));
        assert_eq!(
            t.translate(&v2),
            vec![EngineEvent::PermissionRequested {
                request: "per_2".into(),
                tool: "edit".into(),
                input: json!({ "patterns": ["src/a.rs"], "callID": "call_2" }),
                title: Some("src/a.rs".into()),
                message_id: Some("msg_2".into()),
            }]
        );
        let q = ev("question.asked", json!({ "id": "q_1", "sessionID": "ses_1", "questions": [{ "question": "Which db?", "header": "DB", "options": [{ "label": "sqlite" }, { "label": "postgres", "description": "..." }] }] }));
        assert_eq!(
            t.translate(&q),
            vec![EngineEvent::QuestionAsked { request: "q_1".into(), prompt: "Which db?".into(), options: vec!["sqlite".into(), "postgres".into()] }]
        );
        assert!(t.is_question("q_1"));
        assert!(!t.is_question("per_1"));
        t.forget_question("q_1");
        assert!(!t.is_question("q_1"));
    }
}
