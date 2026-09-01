//! Claude Code's stream-json protocol, with no IO.
//!
//! Outbound: the `initialize` control request, user messages, the control
//! requests BOSS sends (interrupt, set_permission_mode, set_model) and the
//! `control_response` that answers a `can_use_tool` request. Inbound: the
//! [`Translator`], which turns each stdout line into `EngineEvent`s. Every
//! shape here mirrors what `@anthropic-ai/claude-agent-sdk` writes and reads,
//! so recorded CLI lines can be replayed through it in tests.

use boss_core::{EngineEvent, MessageId, PartId, PermissionDecision, PermissionMode, RequestId, Role, Usage};
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, HashMap};

/// The tool Claude calls to put a question to the user.
pub const ASK_USER_TOOL: &str = "AskUserQuestion";
/// The MCP server name the thread bus is registered under.
pub const BUS_SERVER_NAME: &str = "boss_thread_bus";
/// Message sent to Claude when the user denies a tool without a reason.
pub const DENIED_MESSAGE: &str = "The user denied this tool request.";

/// The mode name the CLI takes for a BOSS permission mode.
pub fn permission_mode_str(mode: PermissionMode) -> &'static str {
    match mode {
        PermissionMode::Default => "default",
        PermissionMode::AcceptEdits => "acceptEdits",
        PermissionMode::Bypass => "bypassPermissions",
        PermissionMode::Plan => "plan",
    }
}

/// Envelope for a control request BOSS sends to the CLI.
pub fn control_request(request_id: &str, request: Value) -> Value {
    json!({ "type": "control_request", "request_id": request_id, "request": request })
}

/// The first control request of a session. System prompts travel here, not
/// as flags: the SDK sends `systemPrompt` as a one-element array (a full
/// replacement) and `appendSystemPrompt` as a string.
pub fn initialize_request(request_id: &str, system_prompt: Option<&str>, append_system_prompt: Option<&str>) -> Value {
    let mut request = Map::new();
    request.insert("subtype".into(), json!("initialize"));
    if let Some(prompt) = system_prompt {
        request.insert("systemPrompt".into(), json!([prompt]));
    }
    if let Some(append) = append_system_prompt {
        request.insert("appendSystemPrompt".into(), json!(append));
    }
    control_request(request_id, Value::Object(request))
}

/// Stop the running turn.
pub fn interrupt_request(request_id: &str) -> Value {
    control_request(request_id, json!({ "subtype": "interrupt" }))
}

/// Change the permission mode for every request after this one.
pub fn set_permission_mode_request(request_id: &str, mode: PermissionMode) -> Value {
    control_request(request_id, json!({ "subtype": "set_permission_mode", "mode": permission_mode_str(mode) }))
}

/// Switch models mid-session.
pub fn set_model_request(request_id: &str, model: &str) -> Value {
    control_request(request_id, json!({ "subtype": "set_model", "model": model }))
}

/// One image the user attached, already read from disk and base64-encoded.
#[derive(Clone, Debug, PartialEq)]
pub struct ImageBlock {
    pub media_type: String,
    pub data: String,
}

/// Content blocks for a user message: images first, then the text, then a
/// line per attachment Claude cannot see so it knows something was attached.
pub fn user_content(text: &str, images: &[ImageBlock], unreadable: &[String]) -> Vec<Value> {
    let mut blocks: Vec<Value> = images
        .iter()
        .map(|image| {
            json!({ "type": "image", "source": { "type": "base64", "media_type": image.media_type, "data": image.data } })
        })
        .collect();
    let mut lines: Vec<String> = Vec::new();
    if !text.is_empty() {
        lines.push(text.to_owned());
    }
    lines.extend(unreadable.iter().map(|name| format!("[Attached file: {name}]")));
    if !lines.is_empty() {
        blocks.push(json!({ "type": "text", "text": lines.join("\n") }));
    }
    blocks
}

/// A stream-json user message, as the SDK writes one.
pub fn user_message(content: Vec<Value>, session_id: Option<&str>) -> Value {
    json!({
        "type": "user",
        "session_id": session_id.unwrap_or(""),
        "message": { "role": "user", "content": content },
        "parent_tool_use_id": null
    })
}

/// A successful reply to a control request the CLI sent.
pub fn control_response_success(request_id: &str, response: Value) -> Value {
    json!({
        "type": "control_response",
        "response": { "subtype": "success", "request_id": request_id, "response": response }
    })
}

/// A failed reply to a control request the CLI sent.
pub fn control_response_error(request_id: &str, error: &str) -> Value {
    json!({ "type": "control_response", "response": { "subtype": "error", "request_id": request_id, "error": error } })
}

/// The reply for a control request BOSS does not surface to the user, so the
/// CLI never waits on an answer that will not come. `can_use_tool` is the
/// user's to answer and gets `None`.
pub fn auto_reply(line: &Value) -> Option<Value> {
    if line.get("type").and_then(Value::as_str) != Some("control_request") {
        return None;
    }
    let request_id = line.get("request_id").and_then(Value::as_str)?;
    match line.pointer("/request/subtype").and_then(Value::as_str)? {
        "can_use_tool" => None,
        "elicitation" => Some(control_response_success(request_id, json!({ "action": "decline" }))),
        other => Some(control_response_error(request_id, &format!("{other} is not supported by BOSS"))),
    }
}

/// A `can_use_tool` request the CLI is still waiting on.
#[derive(Clone, Debug, PartialEq)]
pub struct PendingPermission {
    pub request_id: RequestId,
    pub tool: String,
    pub input: Value,
    pub tool_use_id: Option<String>,
}

/// The `control_response` for the user's decision on a pending request.
///
/// Allow carries `updatedInput`: the edited input when the caller gave one,
/// else the original. For [`ASK_USER_TOOL`] an `updated_input` that is an
/// array is read as positional answers (a string or a list of strings per
/// question) and folded into the shape Claude validates; see
/// [`question_input`].
pub fn permission_response(pending: &PendingPermission, decision: &PermissionDecision) -> Value {
    let mut inner = match decision {
        PermissionDecision::Allow { updated_input } => {
            let input = match updated_input {
                Some(value) => resolve_updated_input(pending, value),
                None => pending.input.clone(),
            };
            json!({ "behavior": "allow", "updatedInput": input })
        }
        PermissionDecision::Deny { reason } => {
            let message = if reason.trim().is_empty() { DENIED_MESSAGE } else { reason.as_str() };
            json!({ "behavior": "deny", "message": message, "interrupt": false })
        }
    };
    if let Some(id) = &pending.tool_use_id {
        inner["toolUseID"] = json!(id);
    }
    control_response_success(pending.request_id.as_str(), inner)
}

fn resolve_updated_input(pending: &PendingPermission, value: &Value) -> Value {
    if pending.tool != ASK_USER_TOOL {
        return value.clone();
    }
    match value.as_array() {
        Some(answers) => {
            let answers: Vec<Vec<String>> = answers
                .iter()
                .map(|answer| match answer {
                    Value::String(text) => vec![text.clone()],
                    Value::Array(items) => items.iter().filter_map(|item| item.as_str().map(String::from)).collect(),
                    _ => Vec::new(),
                })
                .collect();
            question_input(&pending.input, &answers)
        }
        None => value.clone(),
    }
}

/// One question from an [`ASK_USER_TOOL`] request.
#[derive(Clone, Debug, PartialEq)]
pub struct Question {
    pub question: String,
    pub options: Vec<String>,
}

/// The questions in an `AskUserQuestion` input. `None` for any other tool or
/// a malformed request, in which case the caller falls back to an ordinary
/// permission prompt.
pub fn parse_questions(tool: &str, input: &Value) -> Option<Vec<Question>> {
    if tool != ASK_USER_TOOL {
        return None;
    }
    let raw = input.get("questions")?.as_array()?;
    let questions: Vec<Question> = raw
        .iter()
        .filter_map(|entry| {
            let question = entry.get("question")?.as_str()?.trim();
            if question.is_empty() {
                return None;
            }
            let options = entry
                .get("options")
                .and_then(Value::as_array)
                .map(|options| options.iter().filter_map(option_label).collect())
                .unwrap_or_default();
            Some(Question { question: question.to_owned(), options })
        })
        .collect();
    if questions.is_empty() { None } else { Some(questions) }
}

fn option_label(option: &Value) -> Option<String> {
    let label = match option {
        Value::String(label) => label.as_str(),
        Value::Object(fields) => fields.get("label")?.as_str()?,
        _ => return None,
    };
    let label = label.trim();
    if label.is_empty() { None } else { Some(label.to_owned()) }
}

/// The tool input Claude should see once the user has answered.
///
/// Claude Code validates this against the AskUserQuestion schema, which still
/// requires every question to carry its question, header, and options. So the
/// questions travel back exactly as they arrived and the answers ride beside
/// them, keyed by question text. A question with no answer is left out; several
/// selections join with a comma because the field holds one string per question.
pub fn question_input(input: &Value, answers: &[Vec<String>]) -> Value {
    let questions = input.get("questions").and_then(Value::as_array).cloned().unwrap_or_default();
    let mut paired = Map::new();
    for (index, entry) in questions.iter().enumerate() {
        let Some(text) = entry.get("question").and_then(Value::as_str).filter(|s| !s.is_empty()) else { continue };
        let Some(choices) = answers.get(index).filter(|c| !c.is_empty()) else { continue };
        paired.insert(text.to_owned(), json!(choices.join(", ")));
    }
    let mut out = input.as_object().cloned().unwrap_or_default();
    out.insert("questions".into(), Value::Array(questions));
    out.insert("answers".into(), Value::Object(paired));
    Value::Object(out)
}

// ---------------------------------------------------------------------------
// Tool labels (port of src/shared/tool-label.ts)

const IDENTIFYING_KEYS: [&str; 11] =
    ["command", "file_path", "filePath", "pattern", "path", "query", "url", "description", "skill", "name", "prompt"];
const MAX_LABEL: usize = 120;
const SHELL_TOOLS: [&str; 5] = ["bash", "shell", "bashoutput", "killshell", "run_terminal_cmd"];
const SEARCH_TOOLS: [&str; 5] = ["grep", "glob", "search", "rg", "ripgrep"];

fn text_arg(value: &Value) -> Option<&str> {
    value.as_str().map(str::trim).filter(|s| !s.is_empty())
}

/// The last two segments of a path: enough to tell two files apart.
pub fn short_path(value: &str) -> String {
    let clean = value.trim_end_matches('/');
    let segments: Vec<&str> = clean.split('/').filter(|s| !s.is_empty()).collect();
    if segments.len() <= 2 {
        return clean.to_owned();
    }
    format!("…/{}", segments[segments.len() - 2..].join("/"))
}

fn one_line(value: &str) -> String {
    let collapsed = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() > MAX_LABEL {
        format!("{}…", collapsed.chars().take(MAX_LABEL - 1).collect::<String>())
    } else {
        collapsed
    }
}

/// A short label for a tool call: the command, the file, the pattern. `None`
/// when the arguments say nothing worth reading, so the caller keeps the name.
pub fn tool_label(tool: &str, input: &Value) -> Option<String> {
    let args = input.as_object()?;
    let name = tool.to_lowercase();
    if let Some(command) = args.get("command").and_then(text_arg)
        && SHELL_TOOLS.contains(&name.as_str())
    {
        return Some(one_line(&format!("$ {command}")));
    }
    for key in IDENTIFYING_KEYS {
        let Some(value) = args.get(key).and_then(text_arg) else { continue };
        let is_path = matches!(key, "file_path" | "filePath" | "path");
        let label = if is_path { short_path(value) } else { one_line(value) };
        if SEARCH_TOOLS.contains(&name.as_str()) && key != "path" {
            let haystack = args.get("path").and_then(text_arg).or_else(|| args.get("glob").and_then(text_arg));
            if let Some(haystack) = haystack {
                return Some(one_line(&format!("{label} in {}", short_path(haystack))));
            }
        }
        return Some(label);
    }
    let strings: Vec<&str> = args.values().filter_map(text_arg).collect();
    if strings.len() == 1 { Some(one_line(strings[0])) } else { None }
}

// ---------------------------------------------------------------------------
// Inbound translation

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum BlockKind {
    Text,
    Thinking,
    ToolUse,
    Other,
}

impl BlockKind {
    fn from_type(kind: &str) -> Self {
        match kind {
            "text" => BlockKind::Text,
            "thinking" => BlockKind::Thinking,
            "tool_use" => BlockKind::ToolUse,
            _ => BlockKind::Other,
        }
    }
}

#[derive(Debug)]
struct Block {
    part_id: PartId,
    kind: BlockKind,
    /// Streamed text, thinking, or partial input JSON. Cleared once the
    /// finished block has reconciled it.
    text: String,
    call_id: Option<String>,
    name: Option<String>,
    /// The tool input BOSS has announced so far, so the finished message only
    /// re-announces when the input changed.
    emitted_input: Option<Value>,
    reconciled: bool,
}

#[derive(Debug)]
struct MessageState {
    id: MessageId,
    model: Option<String>,
    blocks: BTreeMap<u64, Block>,
    usage: Usage,
}

impl MessageState {
    fn new(id: MessageId) -> Self {
        Self { id, model: None, blocks: BTreeMap::new(), usage: Usage::default() }
    }

    fn next_index(&self) -> u64 {
        self.blocks.keys().next_back().map_or(0, |last| last + 1)
    }

    fn block_mut(&mut self, index: u64, kind: BlockKind) -> &mut Block {
        let part_id = PartId::from_raw(format!("{}:{index}", self.id));
        self.blocks.entry(index).or_insert_with(|| Block {
            part_id,
            kind,
            text: String::new(),
            call_id: None,
            name: None,
            emitted_input: None,
            reconciled: false,
        })
    }
}

/// Turns Claude Code stdout lines into `EngineEvent`s.
///
/// Stateful because the wire format is not self-describing: deltas name a
/// block by index, tool results name a call by id, and the finished
/// `assistant` message repeats blocks that were already streamed. Message ids
/// are Claude's own (`msg_...`); part ids are `<message id>:<block index>`.
///
/// Event semantics worth knowing: a `ToolCallStarted` repeated for the same
/// part carries the final input once it is known; `MessageCompleted` is sent
/// at `message_stop` with that message's token usage and again at `result`
/// with the turn's usage and cost.
#[derive(Debug, Default)]
pub struct Translator {
    session_id: Option<String>,
    messages: HashMap<MessageId, MessageState>,
    last_message: Option<MessageId>,
    /// Claude's tool_use id to the message and part that shows the call.
    calls: HashMap<String, (MessageId, PartId)>,
    pending: HashMap<RequestId, PendingPermission>,
    interrupted: bool,
}

impl Translator {
    /// A translator with no session yet.
    pub fn new() -> Self {
        Self::default()
    }

    /// Claude's session id, once `system/init` has arrived.
    pub fn session_id(&self) -> Option<&str> {
        self.session_id.as_deref()
    }

    /// A permission request the CLI is still waiting on.
    pub fn pending(&self, request: &RequestId) -> Option<&PendingPermission> {
        self.pending.get(request)
    }

    /// Forget a permission request once it has been answered.
    pub fn take_pending(&mut self, request: &RequestId) -> Option<PendingPermission> {
        self.pending.remove(request)
    }

    /// Every permission request still waiting, for cleanup when a session ends.
    pub fn pending_requests(&self) -> Vec<RequestId> {
        self.pending.keys().cloned().collect()
    }

    /// BOSS stopped the turn on purpose, so the failed result that follows is
    /// not an error worth showing. Cleared at the next `result`.
    pub fn set_interrupted(&mut self, interrupted: bool) {
        self.interrupted = interrupted;
    }

    /// Translate one stdout line. Unknown message types produce no events.
    pub fn translate(&mut self, line: Value) -> Vec<EngineEvent> {
        let mut out = Vec::new();
        let Some(kind) = line.get("type").and_then(Value::as_str) else { return out };
        match kind {
            "system" => self.on_system(&line, &mut out),
            "stream_event" if !is_subagent(&line) => self.on_stream_event(&line, &mut out),
            "assistant" if !is_subagent(&line) => self.on_assistant(&line, &mut out),
            "user" if !is_subagent(&line) => self.on_user(&line, &mut out),
            "result" => self.on_result(&line, &mut out),
            "control_request" => self.on_control_request(&line, &mut out),
            "control_response" => self.on_control_response(&line, &mut out),
            _ => {}
        }
        out
    }

    fn on_system(&mut self, line: &Value, out: &mut Vec<EngineEvent>) {
        match line.get("subtype").and_then(Value::as_str) {
            Some("init") => {
                if let Some(id) = line.get("session_id").and_then(Value::as_str)
                    && self.session_id.as_deref() != Some(id)
                {
                    self.session_id = Some(id.to_owned());
                    out.push(EngineEvent::SessionReady { native_session_id: id.to_owned() });
                }
                let failed: Vec<String> = line
                    .get("mcp_servers")
                    .and_then(Value::as_array)
                    .map(|servers| servers.iter().filter_map(failed_bus_server).collect())
                    .unwrap_or_default();
                if !failed.is_empty() {
                    out.push(EngineEvent::Error {
                        message: format!("Claude Code could not load BOSS agent tools: {}", failed.join("; ")),
                        fatal: false,
                    });
                }
            }
            Some("status") if line.get("compact_result").and_then(Value::as_str) == Some("failed") => {
                let message = line
                    .get("compact_error")
                    .and_then(Value::as_str)
                    .unwrap_or("Claude Code could not compact the context.")
                    .to_owned();
                out.push(EngineEvent::Error { message, fatal: false });
            }
            _ => {}
        }
    }

    fn start_message(&mut self, id: MessageId, model: Option<String>, out: &mut Vec<EngineEvent>) {
        if let Some(state) = self.messages.get_mut(&id) {
            if let Some(model) = model {
                state.model.get_or_insert(model);
            }
        } else {
            let mut state = MessageState::new(id.clone());
            state.model = model;
            self.messages.insert(id.clone(), state);
            out.push(EngineEvent::MessageStarted { message_id: id.clone(), role: Role::Assistant });
        }
        self.last_message = Some(id);
    }

    fn current(&mut self) -> Option<&mut MessageState> {
        let id = self.last_message.clone()?;
        self.messages.get_mut(&id)
    }

    fn on_stream_event(&mut self, line: &Value, out: &mut Vec<EngineEvent>) {
        let Some(event) = line.get("event") else { return };
        let index = event.get("index").and_then(Value::as_u64);
        match event.get("type").and_then(Value::as_str) {
            Some("message_start") => {
                let message = event.get("message").cloned().unwrap_or(Value::Null);
                let id = message_id_of(&message, line);
                let model = message.get("model").and_then(Value::as_str).map(String::from);
                self.start_message(id, model, out);
                if let (Some(usage), Some(state)) = (message.get("usage"), self.current()) {
                    merge_usage(&mut state.usage, usage);
                }
            }
            Some("content_block_start") => {
                let Some(index) = index else { return };
                let block = event.get("content_block").cloned().unwrap_or(Value::Null);
                let kind = BlockKind::from_type(block.get("type").and_then(Value::as_str).unwrap_or(""));
                let Some(state) = self.current() else { return };
                let message_id = state.id.clone();
                let entry = state.block_mut(index, kind);
                entry.kind = kind;
                if kind == BlockKind::ToolUse {
                    let call_id = block.get("id").and_then(Value::as_str).unwrap_or("").to_owned();
                    let name = block.get("name").and_then(Value::as_str).unwrap_or("tool").to_owned();
                    let input = block.get("input").cloned().unwrap_or_else(|| json!({}));
                    entry.call_id = Some(call_id.clone());
                    entry.name = Some(name.clone());
                    entry.emitted_input = Some(input.clone());
                    let part_id = entry.part_id.clone();
                    self.calls.insert(call_id.clone(), (message_id.clone(), part_id.clone()));
                    out.push(EngineEvent::ToolCallStarted {
                        message_id,
                        part_id,
                        call_id,
                        title: tool_label(&name, &input),
                        name,
                        input,
                    });
                }
            }
            Some("content_block_delta") => {
                let Some(index) = index else { return };
                let delta = event.get("delta").cloned().unwrap_or(Value::Null);
                let (kind, field) = match delta.get("type").and_then(Value::as_str).unwrap_or("") {
                    "text_delta" => (BlockKind::Text, "text"),
                    "thinking_delta" => (BlockKind::Thinking, "thinking"),
                    "input_json_delta" => (BlockKind::ToolUse, "partial_json"),
                    _ => return,
                };
                let text = delta.get(field).and_then(Value::as_str).unwrap_or("").to_owned();
                let Some(state) = self.current() else { return };
                let message_id = state.id.clone();
                let entry = state.block_mut(index, kind);
                entry.text.push_str(&text);
                let part_id = entry.part_id.clone();
                out.push(match kind {
                    BlockKind::Text => EngineEvent::TextDelta { message_id, part_id, delta: text },
                    BlockKind::Thinking => EngineEvent::ReasoningDelta { message_id, part_id, delta: text },
                    _ => EngineEvent::ToolCallInputDelta { message_id, part_id, delta: text },
                });
            }
            Some("content_block_stop") => {
                let Some(index) = index else { return };
                let Some(state) = self.current() else { return };
                let message_id = state.id.clone();
                let Some(entry) = state.blocks.get_mut(&index) else { return };
                if entry.kind != BlockKind::ToolUse {
                    return;
                }
                let Ok(input) = serde_json::from_str::<Value>(&entry.text) else { return };
                if entry.emitted_input.as_ref() == Some(&input) {
                    return;
                }
                entry.emitted_input = Some(input.clone());
                let name = entry.name.clone().unwrap_or_else(|| "tool".into());
                out.push(EngineEvent::ToolCallStarted {
                    message_id,
                    part_id: entry.part_id.clone(),
                    call_id: entry.call_id.clone().unwrap_or_default(),
                    title: tool_label(&name, &input),
                    name,
                    input,
                });
            }
            Some("message_delta") => {
                if let (Some(usage), Some(state)) = (event.get("usage"), self.current()) {
                    merge_usage(&mut state.usage, usage);
                }
            }
            Some("message_stop") => {
                let Some(state) = self.current() else { return };
                out.push(EngineEvent::MessageCompleted {
                    message_id: state.id.clone(),
                    usage: Some(state.usage.clone()),
                    model: state.model.clone(),
                });
            }
            _ => {}
        }
    }

    fn on_assistant(&mut self, line: &Value, out: &mut Vec<EngineEvent>) {
        let Some(message) = line.get("message") else { return };
        let id = message_id_of(message, line);
        let model = message.get("model").and_then(Value::as_str).map(String::from);
        self.start_message(id.clone(), model, out);
        if let (Some(usage), Some(state)) = (message.get("usage"), self.messages.get_mut(&id)) {
            merge_usage(&mut state.usage, usage);
        }
        let content = message.get("content").and_then(Value::as_array).cloned().unwrap_or_default();
        for block in &content {
            let kind = BlockKind::from_type(block.get("type").and_then(Value::as_str).unwrap_or(""));
            match kind {
                BlockKind::ToolUse => self.reconcile_tool_use(&id, block, out),
                BlockKind::Text | BlockKind::Thinking => {
                    let field = if kind == BlockKind::Text { "text" } else { "thinking" };
                    let text = block.get(field).and_then(Value::as_str).unwrap_or("");
                    self.reconcile_text(&id, kind, text, out);
                }
                BlockKind::Other => {}
            }
        }
        if let Some(error) = line.get("error").and_then(Value::as_str) {
            let text = content.iter().filter_map(|b| b.get("text").and_then(Value::as_str)).collect::<Vec<_>>().join("\n");
            let message = if text.is_empty() { format!("Claude Code: {error}") } else { format!("{text} ({error})") };
            out.push(EngineEvent::Error { message, fatal: false });
        }
    }

    fn reconcile_tool_use(&mut self, message_id: &MessageId, block: &Value, out: &mut Vec<EngineEvent>) {
        let call_id = block.get("id").and_then(Value::as_str).unwrap_or("").to_owned();
        let name = block.get("name").and_then(Value::as_str).unwrap_or("tool").to_owned();
        let input = block.get("input").cloned().unwrap_or_else(|| json!({}));
        let Some(state) = self.messages.get_mut(message_id) else { return };
        let existing = state.blocks.iter().find(|(_, b)| b.call_id.as_deref() == Some(call_id.as_str())).map(|(i, _)| *i);
        let index = existing.unwrap_or_else(|| state.next_index());
        let entry = state.block_mut(index, BlockKind::ToolUse);
        entry.kind = BlockKind::ToolUse;
        entry.call_id = Some(call_id.clone());
        entry.name = Some(name.clone());
        entry.reconciled = true;
        entry.text.clear();
        let part_id = entry.part_id.clone();
        let announce = entry.emitted_input.as_ref() != Some(&input);
        entry.emitted_input = Some(input.clone());
        self.calls.insert(call_id.clone(), (message_id.clone(), part_id.clone()));
        if announce {
            out.push(EngineEvent::ToolCallStarted {
                message_id: message_id.clone(),
                part_id: part_id.clone(),
                call_id,
                title: tool_label(&name, &input),
                name,
                input,
            });
        }
        out.push(EngineEvent::ToolCallRunning { message_id: message_id.clone(), part_id });
    }

    fn reconcile_text(&mut self, message_id: &MessageId, kind: BlockKind, text: &str, out: &mut Vec<EngineEvent>) {
        let Some(state) = self.messages.get_mut(message_id) else { return };
        // The block that streamed this text: same kind, not yet reconciled, and
        // its accumulated deltas are a prefix of the finished text.
        let streamed = state
            .blocks
            .iter()
            .find(|(_, b)| b.kind == kind && !b.reconciled && text.starts_with(b.text.as_str()))
            .map(|(i, _)| *i);
        let (index, already) = match streamed {
            Some(index) => (index, state.blocks[&index].text.len()),
            None => (state.next_index(), 0),
        };
        let entry = state.block_mut(index, kind);
        entry.reconciled = true;
        entry.text.clear();
        let part_id = entry.part_id.clone();
        let remainder = &text[already..];
        if remainder.is_empty() && streamed.is_some() {
            return;
        }
        let delta = remainder.to_owned();
        out.push(match kind {
            BlockKind::Thinking => EngineEvent::ReasoningDelta { message_id: message_id.clone(), part_id, delta },
            _ => EngineEvent::TextDelta { message_id: message_id.clone(), part_id, delta },
        });
    }

    fn on_user(&mut self, line: &Value, out: &mut Vec<EngineEvent>) {
        let Some(content) = line.pointer("/message/content").and_then(Value::as_array) else { return };
        for block in content {
            if block.get("type").and_then(Value::as_str) != Some("tool_result") {
                continue;
            }
            let Some(call_id) = block.get("tool_use_id").and_then(Value::as_str) else { continue };
            let Some((message_id, part_id)) = self.calls.get(call_id).cloned() else { continue };
            let text = tool_result_text(block.get("content").unwrap_or(&Value::Null));
            let is_error = block.get("is_error").and_then(Value::as_bool).unwrap_or(false);
            let (output, error) = if is_error { (None, Some(text)) } else { (Some(text), None) };
            out.push(EngineEvent::ToolCallFinished { message_id, part_id, output, error });
        }
    }

    fn on_result(&mut self, line: &Value, out: &mut Vec<EngineEvent>) {
        let subtype = line.get("subtype").and_then(Value::as_str).unwrap_or("");
        let is_error = line.get("is_error").and_then(Value::as_bool).unwrap_or(false);
        if (subtype != "success" || is_error) && !self.interrupted {
            out.push(EngineEvent::Error { message: result_error(line), fatal: false });
        }
        self.interrupted = false;
        if let Some(id) = self.last_message.clone()
            && let Some(state) = self.messages.get_mut(&id)
        {
            if let Some(turn) = line.get("usage") {
                merge_usage(&mut state.usage, turn);
            }
            state.usage.cost_usd = line.get("total_cost_usd").and_then(Value::as_f64);
            out.push(EngineEvent::MessageCompleted {
                message_id: id,
                usage: Some(state.usage.clone()),
                model: state.model.clone(),
            });
        }
        // Streamed text has served its purpose; only the ids and call map stay.
        for state in self.messages.values_mut() {
            for block in state.blocks.values_mut() {
                block.text.clear();
            }
        }
        out.push(EngineEvent::Status { busy: false });
    }

    fn on_control_request(&mut self, line: &Value, out: &mut Vec<EngineEvent>) {
        let Some(request_id) = line.get("request_id").and_then(Value::as_str) else { return };
        let Some(request) = line.get("request") else { return };
        if request.get("subtype").and_then(Value::as_str) != Some("can_use_tool") {
            return;
        }
        let tool = request.get("tool_name").and_then(Value::as_str).unwrap_or("tool").to_owned();
        let input = request.get("input").cloned().unwrap_or_else(|| json!({}));
        let tool_use_id = request.get("tool_use_id").and_then(Value::as_str).map(String::from);
        let request_id = RequestId::from_raw(request_id);
        let message_id = tool_use_id.as_deref().and_then(|id| self.calls.get(id)).map(|(m, _)| m.clone());
        self.pending.insert(
            request_id.clone(),
            PendingPermission { request_id: request_id.clone(), tool: tool.clone(), input: input.clone(), tool_use_id },
        );
        if let Some(questions) = parse_questions(&tool, &input) {
            let prompt = if questions.len() == 1 {
                questions[0].question.clone()
            } else {
                questions.iter().enumerate().map(|(i, q)| format!("{}. {}", i + 1, q.question)).collect::<Vec<_>>().join("\n")
            };
            let options = if questions.len() == 1 { questions[0].options.clone() } else { Vec::new() };
            out.push(EngineEvent::QuestionAsked { request: request_id, prompt, options });
            return;
        }
        let title = ["title", "description", "display_name"]
            .iter()
            .find_map(|key| request.get(*key).and_then(Value::as_str))
            .map(String::from)
            .or_else(|| tool_label(&tool, &input));
        out.push(EngineEvent::PermissionRequested { request: request_id, tool, input, title, message_id });
    }

    fn on_control_response(&mut self, line: &Value, out: &mut Vec<EngineEvent>) {
        let Some(response) = line.get("response") else { return };
        if response.get("subtype").and_then(Value::as_str) == Some("error") {
            let error = response.get("error").and_then(Value::as_str).unwrap_or("unknown error");
            out.push(EngineEvent::Error { message: format!("Claude Code rejected a control request: {error}"), fatal: false });
        }
    }
}

fn is_subagent(line: &Value) -> bool {
    line.get("parent_tool_use_id").is_some_and(Value::is_string)
}

/// Claude's message id, falling back to the wrapper uuid, then a fresh id.
fn message_id_of(message: &Value, line: &Value) -> MessageId {
    message
        .get("id")
        .and_then(Value::as_str)
        .or_else(|| line.get("uuid").and_then(Value::as_str))
        .map(MessageId::from_raw)
        .unwrap_or_default()
}

fn failed_bus_server(server: &Value) -> Option<String> {
    let name = server.get("name").and_then(Value::as_str)?;
    if name != BUS_SERVER_NAME {
        return None;
    }
    let status = server.get("status").and_then(Value::as_str).unwrap_or("failed");
    if matches!(status, "connected" | "pending" | "needs-auth") {
        return None;
    }
    Some(format!("{name}: {status}"))
}

/// What a failed `result` says went wrong.
pub fn result_error(line: &Value) -> String {
    line.get("error")
        .and_then(Value::as_str)
        .map(String::from)
        .or_else(|| {
            line.get("errors")
                .and_then(Value::as_array)
                .map(|errors| errors.iter().filter_map(Value::as_str).collect::<Vec<_>>().join("; "))
                .filter(|s| !s.is_empty())
        })
        .or_else(|| line.get("result").and_then(Value::as_str).map(String::from))
        .unwrap_or_else(|| "Claude Code failed.".to_owned())
}

fn merge_usage(into: &mut Usage, usage: &Value) {
    let field = |key: &str| usage.get(key).and_then(Value::as_u64);
    if let Some(v) = field("input_tokens") {
        into.input_tokens = v;
    }
    if let Some(v) = field("output_tokens") {
        into.output_tokens = v;
    }
    if let Some(v) = field("cache_read_input_tokens") {
        into.cache_read_tokens = v;
    }
    if let Some(v) = field("cache_creation_input_tokens") {
        into.cache_write_tokens = v;
    }
}

/// The text of a tool result: a plain string, or the text blocks joined, with
/// a marker for each image block.
pub fn tool_result_text(content: &Value) -> String {
    match content {
        Value::String(text) => text.clone(),
        Value::Array(blocks) => blocks
            .iter()
            .map(|block| match block.get("type").and_then(Value::as_str) {
                Some("text") => block.get("text").and_then(Value::as_str).unwrap_or("").to_owned(),
                Some("image") => "[image]".to_owned(),
                _ => block.to_string(),
            })
            .collect::<Vec<_>>()
            .join("\n"),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}
