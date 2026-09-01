//! Pure translation of pi RPC events into `EngineEvent`s, plus the small
//! encoders for the commands BOSS sends.
//!
//! Protocol: `pi-coding-agent/docs/rpc.md`. pi messages carry no ids, so the
//! translator mints one `MessageId` per assistant `message_start` and derives
//! part ids from it (`<msg>-text-<contentIndex>`). Tool parts use pi's own
//! `toolCallId` as both part id and call id.

use anyhow::{Context, Result};
use boss_core::{Attachment, EngineEvent, MessageId, ModelInfo, PartId, PermissionDecision, Prompt, RequestId, Role, Usage};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};

/// Levels pi accepts for `set_thinking_level` (plus `off`).
pub const THINKING_LEVELS: &[&str] = &["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/// An extension UI dialog pi is waiting on, remembered so the reply can be shaped.
#[derive(Clone, Debug, PartialEq)]
pub struct UiRequest {
    /// `select`, `confirm`, `input`, or `editor`.
    pub method: String,
    /// Choices offered by `select`.
    pub options: Vec<String>,
}

/// Stateful translator for one pi session.
#[derive(Debug, Default)]
pub struct PiTranslator {
    /// Assistant message currently streaming.
    message: Option<MessageId>,
    /// Message each tool call belongs to, by `toolCallId`.
    tool_message: HashMap<String, MessageId>,
    tool_finished: HashSet<String>,
    /// Whether the agent is between `agent_start` and `agent_end`/`agent_settled`.
    pub busy: bool,
    ui: HashMap<String, UiRequest>,
}

impl PiTranslator {
    /// Fresh translator.
    pub fn new() -> Self {
        Self::default()
    }

    /// The dialog behind a `PermissionRequested` this translator emitted.
    pub fn ui_request(&self, id: &str) -> Option<&UiRequest> {
        self.ui.get(id)
    }

    /// Forget a dialog once answered.
    pub fn forget_ui_request(&mut self, id: &str) {
        self.ui.remove(id);
    }

    fn current_message(&mut self, out: &mut Vec<EngineEvent>) -> MessageId {
        if let Some(id) = &self.message {
            return id.clone();
        }
        let id = MessageId::new();
        self.message = Some(id.clone());
        out.push(EngineEvent::MessageStarted { message_id: id.clone(), role: Role::Assistant });
        id
    }

    fn set_busy(&mut self, busy: bool, out: &mut Vec<EngineEvent>) {
        if self.busy != busy {
            self.busy = busy;
            out.push(EngineEvent::Status { busy });
        }
    }

    fn start_tool(&mut self, call_id: &str, name: &str, input: Value, out: &mut Vec<EngineEvent>) -> MessageId {
        if let Some(existing) = self.tool_message.get(call_id) {
            return existing.clone();
        }
        let message_id = self.current_message(out);
        self.tool_message.insert(call_id.to_string(), message_id.clone());
        out.push(EngineEvent::ToolCallStarted {
            message_id: message_id.clone(),
            part_id: PartId::from_raw(call_id),
            call_id: call_id.to_string(),
            name: name.to_string(),
            input,
            title: None,
        });
        message_id
    }

    fn finish_tool(&mut self, call_id: &str, name: &str, content: Option<&Value>, is_error: bool, out: &mut Vec<EngineEvent>) {
        if !self.tool_finished.insert(call_id.to_string()) {
            return;
        }
        let message_id = self.start_tool(call_id, name, Value::Object(Default::default()), out);
        let text = content_text(content);
        out.push(EngineEvent::ToolCallFinished {
            message_id,
            part_id: PartId::from_raw(call_id),
            output: (!is_error).then(|| text.clone()),
            error: is_error.then(|| if text.is_empty() { "Tool failed.".to_string() } else { text }),
        });
    }

    /// Translate one pi event.
    pub fn translate(&mut self, event: &Value) -> Vec<EngineEvent> {
        let mut out = Vec::new();
        let Some(kind) = event.get("type").and_then(Value::as_str) else {
            return out;
        };
        match kind {
            "agent_start" => self.set_busy(true, &mut out),
            "agent_end" => {
                if !event.get("willRetry").and_then(Value::as_bool).unwrap_or(false) {
                    self.set_busy(false, &mut out);
                }
            }
            "agent_settled" => self.set_busy(false, &mut out),
            "message_start" => {
                if event.pointer("/message/role").and_then(Value::as_str) == Some("assistant") {
                    self.message = None;
                    self.current_message(&mut out);
                }
            }
            "message_update" => self.message_update(event.get("assistantMessageEvent").unwrap_or(&Value::Null), &mut out),
            "message_end" => self.message_end(event.get("message").unwrap_or(&Value::Null), &mut out),
            "tool_execution_start" => {
                let call_id = str_field(event, "toolCallId").unwrap_or_default();
                let name = str_field(event, "toolName").unwrap_or_else(|| "tool".into());
                let input = event.get("args").cloned().unwrap_or(Value::Object(Default::default()));
                let message_id = self.start_tool(&call_id, &name, input, &mut out);
                out.push(EngineEvent::ToolCallRunning { message_id, part_id: PartId::from_raw(call_id) });
            }
            "tool_execution_end" => {
                let call_id = str_field(event, "toolCallId").unwrap_or_default();
                let name = str_field(event, "toolName").unwrap_or_else(|| "tool".into());
                let is_error = event.get("isError").and_then(Value::as_bool).unwrap_or(false);
                self.finish_tool(&call_id, &name, event.pointer("/result/content"), is_error, &mut out);
            }
            "compaction_end" => {
                if let Some(message) = str_field(event, "errorMessage") {
                    out.push(EngineEvent::Error { message, fatal: false });
                }
            }
            "auto_retry_end" => {
                if event.get("success").and_then(Value::as_bool) == Some(false) {
                    let message = str_field(event, "finalError").unwrap_or_else(|| "Pi gave up retrying.".into());
                    out.push(EngineEvent::Error { message, fatal: false });
                }
            }
            "extension_error" => {
                let message = match event.get("error") {
                    Some(Value::String(s)) => s.clone(),
                    Some(other) if !other.is_null() => other.to_string(),
                    _ => "Pi extension error".to_string(),
                };
                out.push(EngineEvent::Error { message, fatal: false });
            }
            "extension_ui_request" => self.ui_request_event(event, &mut out),
            _ => {}
        }
        out
    }

    fn message_update(&mut self, delta: &Value, out: &mut Vec<EngineEvent>) {
        let Some(kind) = delta.get("type").and_then(Value::as_str) else {
            return;
        };
        let index = delta.get("contentIndex").and_then(Value::as_u64).unwrap_or(0);
        match kind {
            "text_delta" | "thinking_delta" => {
                let Some(text) = delta.get("delta").and_then(Value::as_str).filter(|d| !d.is_empty()) else {
                    return;
                };
                let message_id = self.current_message(out);
                let (label, reasoning) = if kind == "text_delta" { ("text", false) } else { ("thinking", true) };
                let part_id = PartId::from_raw(format!("{message_id}-{label}-{index}"));
                out.push(if reasoning {
                    EngineEvent::ReasoningDelta { message_id, part_id, delta: text.to_string() }
                } else {
                    EngineEvent::TextDelta { message_id, part_id, delta: text.to_string() }
                });
            }
            "toolcall_end" => {
                if let Some(call) = delta.get("toolCall") {
                    self.tool_call(call, out);
                }
            }
            _ => {}
        }
    }

    fn tool_call(&mut self, call: &Value, out: &mut Vec<EngineEvent>) {
        let Some(id) = str_field(call, "id") else {
            return;
        };
        let name = str_field(call, "name").unwrap_or_else(|| "tool".into());
        let input = call.get("arguments").or_else(|| call.get("input")).cloned().unwrap_or(Value::Object(Default::default()));
        self.start_tool(&id, &name, input, out);
    }

    fn message_end(&mut self, message: &Value, out: &mut Vec<EngineEvent>) {
        match message.get("role").and_then(Value::as_str) {
            Some("assistant") => {
                let message_id = self.current_message(out);
                if let Some(blocks) = message.get("content").and_then(Value::as_array) {
                    for block in blocks {
                        if block.get("type").and_then(Value::as_str) == Some("toolCall") {
                            self.tool_call(block, out);
                        }
                    }
                }
                let stop = message.get("stopReason").and_then(Value::as_str).unwrap_or("stop");
                if stop == "error" {
                    let text = str_field(message, "errorMessage").unwrap_or_else(|| "Pi reported an error.".into());
                    out.push(EngineEvent::Error { message: text, fatal: false });
                }
                let model = match (str_field(message, "provider"), str_field(message, "model")) {
                    (Some(p), Some(m)) => Some(format!("{p}/{m}")),
                    (None, Some(m)) => Some(m),
                    _ => None,
                };
                out.push(EngineEvent::MessageCompleted { message_id, usage: usage(message.get("usage")), model });
                self.message = None;
            }
            Some("toolResult") => {
                let call_id = str_field(message, "toolCallId").unwrap_or_default();
                let name = str_field(message, "toolName").unwrap_or_else(|| "tool".into());
                let is_error = message.get("isError").and_then(Value::as_bool).unwrap_or(false);
                self.finish_tool(&call_id, &name, message.get("content"), is_error, out);
            }
            _ => {}
        }
    }

    fn ui_request_event(&mut self, event: &Value, out: &mut Vec<EngineEvent>) {
        let (Some(id), Some(method)) = (str_field(event, "id"), str_field(event, "method")) else {
            return;
        };
        match method.as_str() {
            "select" | "confirm" | "input" | "editor" => {
                let options: Vec<String> = event
                    .get("options")
                    .and_then(Value::as_array)
                    .map(|o| o.iter().filter_map(Value::as_str).map(str::to_string).collect())
                    .unwrap_or_default();
                let title = str_field(event, "title");
                let mut input = serde_json::Map::new();
                for key in ["title", "message", "placeholder", "prefill", "timeout"] {
                    if let Some(v) = event.get(key).filter(|v| !v.is_null()) {
                        input.insert(key.into(), v.clone());
                    }
                }
                if !options.is_empty() {
                    input.insert("options".into(), json!(options));
                }
                self.ui.insert(id.clone(), UiRequest { method: method.clone(), options });
                out.push(EngineEvent::PermissionRequested {
                    request: RequestId::from_raw(id),
                    tool: format!("ui.{method}"),
                    input: Value::Object(input),
                    title,
                    message_id: self.message.clone(),
                });
            }
            "notify" if str_field(event, "notifyType").as_deref() == Some("error") => {
                out.push(EngineEvent::Error { message: str_field(event, "message").unwrap_or_default(), fatal: false });
            }
            _ => {}
        }
    }
}

/// Build the `extension_ui_response` for a dialog from the user's decision.
///
/// `confirm` answers `confirmed`; `select` answers with `updated_input` as the
/// chosen label (falling back to the first option); `input`/`editor` answer
/// with `updated_input` text. Deny, or Allow with nothing to say, cancels.
pub fn ui_response(id: &str, request: &UiRequest, decision: &PermissionDecision) -> Value {
    let cancelled = json!({ "type": "extension_ui_response", "id": id, "cancelled": true });
    match (request.method.as_str(), decision) {
        ("confirm", PermissionDecision::Allow { .. }) => json!({ "type": "extension_ui_response", "id": id, "confirmed": true }),
        ("confirm", PermissionDecision::Deny { .. }) => json!({ "type": "extension_ui_response", "id": id, "confirmed": false }),
        ("select", PermissionDecision::Allow { updated_input }) => {
            let chosen = match updated_input {
                Some(Value::String(s)) => Some(s.clone()),
                Some(Value::Number(n)) => n.as_u64().and_then(|i| request.options.get(i as usize).cloned()),
                _ => request.options.first().cloned(),
            };
            match chosen {
                Some(value) => json!({ "type": "extension_ui_response", "id": id, "value": value }),
                None => cancelled,
            }
        }
        (_, PermissionDecision::Allow { updated_input: Some(Value::String(s)) }) => {
            json!({ "type": "extension_ui_response", "id": id, "value": s })
        }
        _ => cancelled,
    }
}

/// Encode a BOSS prompt as pi's `prompt` (or `steer`, while the agent is busy).
/// Image attachments become `images`; other files are mentioned in the text.
pub fn prompt_command(prompt: &Prompt, steer: bool) -> Result<Value> {
    use base64::Engine as _;
    let mut lines = Vec::new();
    if !prompt.text.is_empty() {
        lines.push(prompt.text.clone());
    }
    let mut images = Vec::new();
    for Attachment { mime, path } in &prompt.attachments {
        if mime.starts_with("image/") {
            let bytes = std::fs::read(path).with_context(|| format!("read attachment {}", path.display()))?;
            images.push(json!({ "type": "image", "mimeType": mime, "data": base64::engine::general_purpose::STANDARD.encode(bytes) }));
        } else {
            let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| mime.clone());
            lines.push(format!("[Attached file: {name}]"));
        }
    }
    let mut command = json!({ "type": if steer { "steer" } else { "prompt" }, "message": lines.join("\n") });
    if !images.is_empty() {
        command["images"] = Value::Array(images);
    }
    Ok(command)
}

/// A model reference as BOSS names it: `provider/model[:thinking]`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ModelSpec {
    /// pi provider id.
    pub provider: String,
    /// pi model id (may itself contain `/`).
    pub model: String,
    /// Optional thinking level suffix.
    pub thinking: Option<String>,
}

/// Parse `provider/model[:thinking]`. `None` when there is no provider.
pub fn parse_model_spec(spec: &str) -> Option<ModelSpec> {
    let (provider, rest) = spec.split_once('/')?;
    if provider.is_empty() || rest.is_empty() {
        return None;
    }
    let (model, thinking) = match rest.rsplit_once(':') {
        Some((m, level)) if THINKING_LEVELS.contains(&level) && !m.is_empty() => (m.to_string(), Some(level.to_string())),
        _ => (rest.to_string(), None),
    };
    Some(ModelSpec { provider: provider.to_string(), model, thinking })
}

/// Models from `get_available_models` (`{models: Model[]}` or a bare array).
pub fn models_from_rpc(data: &Value) -> Vec<ModelInfo> {
    let list = data.as_array().or_else(|| data.get("models").and_then(Value::as_array));
    list.map(|models| {
        models
            .iter()
            .filter_map(|m| {
                let id = m.get("id").and_then(Value::as_str)?;
                Some(ModelInfo {
                    id: id.to_string(),
                    label: m.get("name").and_then(Value::as_str).unwrap_or(id).to_string(),
                    provider: m.get("provider").and_then(Value::as_str).map(str::to_string),
                })
            })
            .collect()
    })
    .unwrap_or_default()
}

/// Parse the table `pi --offline --list-models` prints: a header line, then
/// rows of columns separated by two or more spaces, `provider` first and the
/// model id second. Rows with fewer than six columns are skipped, as the TS did.
pub fn parse_list_models(output: &str) -> Vec<ModelInfo> {
    output
        .lines()
        .skip(1)
        .filter_map(|line| {
            let fields = split_columns(line.trim());
            if fields.len() < 6 {
                return None;
            }
            Some(ModelInfo { id: fields[1].to_string(), label: fields[1].to_string(), provider: Some(fields[0].to_string()) })
        })
        .collect()
}

fn split_columns(line: &str) -> Vec<&str> {
    let mut fields = Vec::new();
    let mut start = None;
    let mut spaces = 0usize;
    let mut field_end = 0usize;
    for (i, ch) in line.char_indices() {
        if ch == ' ' {
            spaces += 1;
            if spaces == 1 {
                field_end = i;
            }
            if spaces >= 2
                && let Some(s) = start.take()
            {
                fields.push(&line[s..field_end]);
            }
        } else {
            // A single space stays inside the field; only a run of two or more splits.
            spaces = 0;
            if start.is_none() {
                start = Some(i);
            }
        }
    }
    if let Some(s) = start {
        let end = if spaces == 1 { field_end } else { line.len() };
        fields.push(&line[s..end]);
    }
    fields
}

fn str_field(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_string)
}

fn content_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::Array(blocks)) => blocks
            .iter()
            .filter_map(|b| match b.get("type").and_then(Value::as_str) {
                Some("text") => b.get("text").and_then(Value::as_str).map(str::to_string),
                Some("image") => Some("[image]".to_string()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n"),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Null) | None => String::new(),
        Some(other) => other.to_string(),
    }
}

fn usage(value: Option<&Value>) -> Option<Usage> {
    let usage = value?.as_object()?;
    let n = |key: &str| usage.get(key).and_then(Value::as_u64).unwrap_or(0);
    Some(Usage {
        input_tokens: n("input"),
        output_tokens: n("output"),
        cache_read_tokens: n("cacheRead"),
        cache_write_tokens: n("cacheWrite"),
        cost_usd: usage.get("cost").and_then(|c| c.get("total")).and_then(Value::as_f64),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(events: &[Value]) -> (PiTranslator, Vec<EngineEvent>) {
        let mut t = PiTranslator::new();
        let out = events.iter().flat_map(|e| t.translate(e)).collect();
        (t, out)
    }

    fn message_id(events: &[EngineEvent]) -> MessageId {
        events
            .iter()
            .find_map(|e| match e {
                EngineEvent::MessageStarted { message_id, .. } => Some(message_id.clone()),
                _ => None,
            })
            .expect("a message started")
    }

    #[test]
    fn streaming_text_turn() {
        let (t, got) = run(&[
            json!({ "type": "agent_start" }),
            json!({ "type": "turn_start" }),
            json!({ "type": "message_start", "message": { "role": "assistant", "content": [], "provider": "anthropic", "model": "claude-sonnet-4", "usage": {}, "stopReason": "pending", "timestamp": 1 } }),
            json!({ "type": "message_update", "assistantMessageEvent": { "type": "text_start", "contentIndex": 0 } }),
            json!({ "type": "message_update", "assistantMessageEvent": { "type": "text_delta", "contentIndex": 0, "delta": "Hello" } }),
            json!({ "type": "message_update", "assistantMessageEvent": { "type": "text_delta", "contentIndex": 0, "delta": " world" } }),
            json!({ "type": "message_update", "assistantMessageEvent": { "type": "text_end", "contentIndex": 0, "content": "Hello world" } }),
            json!({ "type": "message_end", "message": { "role": "assistant", "content": [{ "type": "text", "text": "Hello world" }], "provider": "anthropic", "model": "claude-sonnet-4", "stopReason": "stop", "timestamp": 2,
                "usage": { "input": 12, "output": 3, "cacheRead": 4, "cacheWrite": 0, "totalTokens": 19, "cost": { "input": 0.1, "output": 0.2, "cacheRead": 0, "cacheWrite": 0, "total": 0.3 } } } }),
            json!({ "type": "turn_end" }),
            json!({ "type": "agent_end", "messages": [], "willRetry": false }),
            json!({ "type": "agent_settled" }),
        ]);
        let id = message_id(&got);
        let part = PartId::from_raw(format!("{id}-text-0"));
        assert_eq!(
            got,
            vec![
                EngineEvent::Status { busy: true },
                EngineEvent::MessageStarted { message_id: id.clone(), role: Role::Assistant },
                EngineEvent::TextDelta { message_id: id.clone(), part_id: part.clone(), delta: "Hello".into() },
                EngineEvent::TextDelta { message_id: id.clone(), part_id: part, delta: " world".into() },
                EngineEvent::MessageCompleted {
                    message_id: id,
                    usage: Some(Usage { input_tokens: 12, output_tokens: 3, cache_read_tokens: 4, cache_write_tokens: 0, cost_usd: Some(0.3) }),
                    model: Some("anthropic/claude-sonnet-4".into()),
                },
                EngineEvent::Status { busy: false },
            ]
        );
        assert!(!t.busy);
    }

    #[test]
    fn thinking_and_tool_call_lifecycle() {
        let (_, got) = run(&[
            json!({ "type": "message_start", "message": { "role": "assistant", "content": [] } }),
            json!({ "type": "message_update", "assistantMessageEvent": { "type": "thinking_delta", "contentIndex": 0, "delta": "hmm" } }),
            json!({ "type": "message_update", "assistantMessageEvent": { "type": "toolcall_start", "contentIndex": 1 } }),
            json!({ "type": "message_update", "assistantMessageEvent": { "type": "toolcall_delta", "contentIndex": 1, "delta": "{\"comm" } }),
            json!({ "type": "message_update", "assistantMessageEvent": { "type": "toolcall_end", "contentIndex": 1, "toolCall": { "type": "toolCall", "id": "call_abc123", "name": "bash", "arguments": { "command": "ls -la" } } } }),
            json!({ "type": "message_end", "message": { "role": "assistant", "content": [
                { "type": "thinking", "thinking": "hmm" },
                { "type": "toolCall", "id": "call_abc123", "name": "bash", "arguments": { "command": "ls -la" } }
            ], "provider": "openai", "model": "gpt-5", "stopReason": "toolUse", "usage": { "input": 1, "output": 1 } } }),
            json!({ "type": "tool_execution_start", "toolCallId": "call_abc123", "toolName": "bash", "args": { "command": "ls -la" } }),
            json!({ "type": "tool_execution_update", "toolCallId": "call_abc123", "toolName": "bash", "args": { "command": "ls -la" }, "partialResult": { "content": [{ "type": "text", "text": "partial" }] } }),
            json!({ "type": "tool_execution_end", "toolCallId": "call_abc123", "toolName": "bash", "result": { "content": [{ "type": "text", "text": "total 48\n" }], "details": {} }, "isError": false }),
            json!({ "type": "message_end", "message": { "role": "toolResult", "toolCallId": "call_abc123", "toolName": "bash", "content": [{ "type": "text", "text": "total 48\n" }], "isError": false, "timestamp": 3 } }),
        ]);
        let id = message_id(&got);
        let part = PartId::from_raw("call_abc123");
        assert_eq!(
            got,
            vec![
                EngineEvent::MessageStarted { message_id: id.clone(), role: Role::Assistant },
                EngineEvent::ReasoningDelta { message_id: id.clone(), part_id: PartId::from_raw(format!("{id}-thinking-0")), delta: "hmm".into() },
                EngineEvent::ToolCallStarted { message_id: id.clone(), part_id: part.clone(), call_id: "call_abc123".into(), name: "bash".into(), input: json!({ "command": "ls -la" }), title: None },
                EngineEvent::MessageCompleted { message_id: id.clone(), usage: Some(Usage { input_tokens: 1, output_tokens: 1, ..Default::default() }), model: Some("openai/gpt-5".into()) },
                EngineEvent::ToolCallRunning { message_id: id.clone(), part_id: part.clone() },
                EngineEvent::ToolCallFinished { message_id: id, part_id: part, output: Some("total 48\n".into()), error: None },
            ],
            "tool result after the message ended attaches to that message and is reported once"
        );
    }

    #[test]
    fn tool_without_streaming_and_errors() {
        let (_, got) = run(&[
            json!({ "type": "tool_execution_start", "toolCallId": "call_x", "toolName": "read", "args": { "path": "a" } }),
            json!({ "type": "tool_execution_end", "toolCallId": "call_x", "toolName": "read", "result": { "content": [{ "type": "text", "text": "no such file" }] }, "isError": true }),
            json!({ "type": "extension_error", "error": "boom" }),
            json!({ "type": "compaction_end", "reason": "threshold", "result": null, "aborted": false, "errorMessage": "quota" }),
            json!({ "type": "auto_retry_end", "success": false, "attempt": 3, "finalError": "overloaded" }),
            json!({ "type": "message_end", "message": { "role": "assistant", "content": [], "stopReason": "error", "errorMessage": "429", "provider": "p", "model": "m" } }),
        ]);
        let id = message_id(&got);
        assert_eq!(got[0], EngineEvent::MessageStarted { message_id: id.clone(), role: Role::Assistant });
        assert!(matches!(&got[1], EngineEvent::ToolCallStarted { name, input, .. } if name == "read" && input == &json!({ "path": "a" })));
        assert_eq!(got[2], EngineEvent::ToolCallRunning { message_id: id.clone(), part_id: "call_x".into() });
        assert_eq!(got[3], EngineEvent::ToolCallFinished { message_id: id.clone(), part_id: "call_x".into(), output: None, error: Some("no such file".into()) });
        assert_eq!(got[4], EngineEvent::Error { message: "boom".into(), fatal: false });
        assert_eq!(got[5], EngineEvent::Error { message: "quota".into(), fatal: false });
        assert_eq!(got[6], EngineEvent::Error { message: "overloaded".into(), fatal: false });
        assert_eq!(got[7], EngineEvent::Error { message: "429".into(), fatal: false });
        assert!(matches!(&got[8], EngineEvent::MessageCompleted { model: Some(m), .. } if m == "p/m"));
        assert_eq!(got.len(), 9);
    }

    #[test]
    fn user_messages_and_unknown_events_are_ignored() {
        let (t, got) = run(&[
            json!({ "type": "message_start", "message": { "role": "user", "content": "hi", "timestamp": 1 } }),
            json!({ "type": "message_end", "message": { "role": "user", "content": "hi", "timestamp": 1 } }),
            json!({ "type": "queue_update", "steering": [], "followUp": [] }),
            json!({ "type": "bash_execution_update", "id": "req-1", "delta": "x" }),
            json!({ "type": "agent_end", "messages": [], "willRetry": true }),
        ]);
        assert!(got.is_empty());
        assert!(!t.busy);
    }

    #[test]
    fn extension_ui_dialogs_become_permission_requests_and_replies() {
        let mut t = PiTranslator::new();
        let got = t.translate(&json!({ "type": "extension_ui_request", "id": "uuid-1", "method": "select", "title": "Allow dangerous command?", "options": ["Allow", "Block"], "timeout": 10000 }));
        assert_eq!(
            got,
            vec![EngineEvent::PermissionRequested {
                request: "uuid-1".into(),
                tool: "ui.select".into(),
                input: json!({ "title": "Allow dangerous command?", "timeout": 10000, "options": ["Allow", "Block"] }),
                title: Some("Allow dangerous command?".into()),
                message_id: None,
            }]
        );
        let select = t.ui_request("uuid-1").unwrap().clone();
        assert_eq!(ui_response("uuid-1", &select, &PermissionDecision::Allow { updated_input: None }), json!({ "type": "extension_ui_response", "id": "uuid-1", "value": "Allow" }));
        assert_eq!(ui_response("uuid-1", &select, &PermissionDecision::Allow { updated_input: Some(json!("Block")) }), json!({ "type": "extension_ui_response", "id": "uuid-1", "value": "Block" }));
        assert_eq!(ui_response("uuid-1", &select, &PermissionDecision::Allow { updated_input: Some(json!(1)) }), json!({ "type": "extension_ui_response", "id": "uuid-1", "value": "Block" }));
        assert_eq!(ui_response("uuid-1", &select, &PermissionDecision::Deny { reason: String::new() }), json!({ "type": "extension_ui_response", "id": "uuid-1", "cancelled": true }));

        let got = t.translate(&json!({ "type": "extension_ui_request", "id": "uuid-2", "method": "confirm", "title": "Clear session?", "message": "All messages will be lost." }));
        assert!(matches!(&got[0], EngineEvent::PermissionRequested { tool, input, .. } if tool == "ui.confirm" && input["message"] == "All messages will be lost."));
        let confirm = t.ui_request("uuid-2").unwrap().clone();
        assert_eq!(ui_response("uuid-2", &confirm, &PermissionDecision::Allow { updated_input: None }), json!({ "type": "extension_ui_response", "id": "uuid-2", "confirmed": true }));
        assert_eq!(ui_response("uuid-2", &confirm, &PermissionDecision::Deny { reason: "no".into() }), json!({ "type": "extension_ui_response", "id": "uuid-2", "confirmed": false }));

        t.translate(&json!({ "type": "extension_ui_request", "id": "uuid-3", "method": "input", "title": "Enter a value", "placeholder": "type something..." }));
        let input = t.ui_request("uuid-3").unwrap().clone();
        assert_eq!(ui_response("uuid-3", &input, &PermissionDecision::Allow { updated_input: Some(json!("abc")) }), json!({ "type": "extension_ui_response", "id": "uuid-3", "value": "abc" }));
        assert_eq!(ui_response("uuid-3", &input, &PermissionDecision::Allow { updated_input: None }), json!({ "type": "extension_ui_response", "id": "uuid-3", "cancelled": true }));
        t.forget_ui_request("uuid-3");
        assert!(t.ui_request("uuid-3").is_none());

        assert!(t.translate(&json!({ "type": "extension_ui_request", "id": "uuid-5", "method": "notify", "message": "fyi", "notifyType": "info" })).is_empty());
        assert_eq!(
            t.translate(&json!({ "type": "extension_ui_request", "id": "uuid-6", "method": "notify", "message": "bad", "notifyType": "error" })),
            vec![EngineEvent::Error { message: "bad".into(), fatal: false }]
        );
        assert!(t.translate(&json!({ "type": "extension_ui_request", "id": "uuid-7", "method": "setStatus", "statusKey": "k", "statusText": "s" })).is_empty());
    }

    #[test]
    fn prompt_command_carries_text_images_and_file_mentions() {
        let dir = tempfile::tempdir().unwrap();
        let png = dir.path().join("shot.png");
        std::fs::write(&png, b"\x89PNG").unwrap();
        let pdf = dir.path().join("spec.pdf");
        std::fs::write(&pdf, b"%PDF").unwrap();
        let prompt = Prompt {
            text: "look".into(),
            attachments: vec![
                Attachment { mime: "image/png".into(), path: png },
                Attachment { mime: "application/pdf".into(), path: pdf },
            ],
        };
        assert_eq!(
            prompt_command(&prompt, false).unwrap(),
            json!({ "type": "prompt", "message": "look\n[Attached file: spec.pdf]", "images": [{ "type": "image", "mimeType": "image/png", "data": "iVBORw==" }] })
        );
        assert_eq!(
            prompt_command(&Prompt { text: "again".into(), attachments: vec![] }, true).unwrap(),
            json!({ "type": "steer", "message": "again" })
        );
    }

    #[test]
    fn model_specs_and_model_lists() {
        assert_eq!(parse_model_spec("anthropic/claude-sonnet-4"), Some(ModelSpec { provider: "anthropic".into(), model: "claude-sonnet-4".into(), thinking: None }));
        assert_eq!(parse_model_spec("openrouter/anthropic/claude:high"), Some(ModelSpec { provider: "openrouter".into(), model: "anthropic/claude".into(), thinking: Some("high".into()) }));
        assert_eq!(parse_model_spec("ollama/llama3:8b"), Some(ModelSpec { provider: "ollama".into(), model: "llama3:8b".into(), thinking: None }), "a tag that is not a thinking level stays in the id");
        assert_eq!(parse_model_spec("sonnet"), None);

        let rpc = json!({ "models": [
            { "id": "claude-sonnet-4", "name": "Claude Sonnet 4", "provider": "anthropic", "reasoning": true },
            { "id": "gpt-5", "provider": "openai" }
        ] });
        assert_eq!(
            models_from_rpc(&rpc),
            vec![
                ModelInfo { id: "claude-sonnet-4".into(), label: "Claude Sonnet 4".into(), provider: Some("anthropic".into()) },
                ModelInfo { id: "gpt-5".into(), label: "gpt-5".into(), provider: Some("openai".into()) },
            ]
        );
        assert_eq!(models_from_rpc(&json!([{ "id": "m" }])).len(), 1);

        let table = "Provider     Model                 Context   Max Out   Thinking   Input\n\
                     anthropic    claude-sonnet-4       200000    64000     yes        text, image\n\
                     openai       gpt-5                 400000    128000    no         text\n\
                     broken line\n";
        assert_eq!(
            parse_list_models(table),
            vec![
                ModelInfo { id: "claude-sonnet-4".into(), label: "claude-sonnet-4".into(), provider: Some("anthropic".into()) },
                ModelInfo { id: "gpt-5".into(), label: "gpt-5".into(), provider: Some("openai".into()) },
            ]
        );
        assert_eq!(split_columns("a b  c   d e"), vec!["a b", "c", "d e"]);
    }
}
