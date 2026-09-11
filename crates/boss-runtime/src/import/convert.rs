//! Electron message and part JSON → `boss_core::message` types.
//!
//! The Electron app stored parts as opencode-flavoured JSON: a `type` tag
//! plus a `state` object for anything that runs. Eight types appear in the
//! user's data — text, reasoning, tool, file, patch, step-start,
//! step-finish, compaction. The first four become parts; the rest are
//! bookkeeping the native model does not have, so `step-finish` is mined
//! for token usage and the others are dropped.

use boss_core::ids::{MessageId, PartId, ThreadId};
use boss_core::message::{
    AttachmentPart, Message, MessageStatus, Part, ReasoningPart, Role, TextPart, ToolCallPart,
    ToolState,
};
use serde_json::Value;
use time::OffsetDateTime;

use super::electron::MessageInfo;

/// Epoch milliseconds → `OffsetDateTime`, falling back to the epoch so a
/// missing timestamp never drops a message.
pub fn from_millis(ms: Option<i64>) -> OffsetDateTime {
    ms.and_then(|ms| OffsetDateTime::from_unix_timestamp_nanos(ms as i128 * 1_000_000).ok())
        .unwrap_or(OffsetDateTime::UNIX_EPOCH)
}

fn role_of(raw: Option<&str>) -> Role {
    match raw {
        Some("assistant") => Role::Assistant,
        Some("system") => Role::System,
        _ => Role::User,
    }
}

/// Build a native message from an Electron `info` object and its parts.
/// Returns `None` when there is nothing worth keeping: no id, or no part
/// that survives conversion. The `usage` comes from the `step-finish`
/// parts, which is where the TS app recorded tokens and cost.
pub fn message(thread: &ThreadId, info: &MessageInfo, parts: &[Value]) -> Option<Message> {
    let id = info.id.as_deref()?;
    let role = role_of(info.role.as_deref());
    let mut out = Message {
        id: MessageId::from_raw(id),
        thread_id: thread.clone(),
        role,
        author: None,
        recipient: None,
        branch_of: None,
        created_at: from_millis(info.time.created),
        // Everything on disk finished running one way or another. A message
        // with an error object kept its error; the rest are complete.
        status: if info.error.is_some() {
            MessageStatus::Error
        } else {
            MessageStatus::Complete
        },
        parts: Vec::new(),
        revision: 0,
        usage: None,
        model: info.model_name(),
    };

    let mut usage = boss_core::message::Usage::default();
    let mut saw_usage = false;
    for raw in parts {
        match raw.get("type").and_then(Value::as_str) {
            Some("step-finish") => {
                saw_usage = true;
                accumulate_usage(&mut usage, raw);
            }
            _ => {
                if let Some(part) = convert_part(raw) {
                    out.parts.push(part);
                }
            }
        }
    }
    if saw_usage {
        out.usage = Some(usage);
    }
    if out.parts.is_empty() {
        return None;
    }
    Some(out)
}

/// `step-finish` carries `{ tokens: { input, output, cache: { read, write } }, cost }`.
/// A message can have several steps; they add up.
fn accumulate_usage(usage: &mut boss_core::message::Usage, raw: &Value) {
    let n = |v: Option<&Value>| v.and_then(Value::as_f64).unwrap_or(0.0).max(0.0) as u64;
    let tokens = raw.get("tokens");
    usage.input_tokens += n(tokens.and_then(|t| t.get("input")));
    usage.output_tokens += n(tokens.and_then(|t| t.get("output")));
    let cache = tokens.and_then(|t| t.get("cache"));
    usage.cache_read_tokens += n(cache.and_then(|c| c.get("read")));
    usage.cache_write_tokens += n(cache.and_then(|c| c.get("write")));
    if let Some(cost) = raw.get("cost").and_then(Value::as_f64) {
        usage.cost_usd = Some(usage.cost_usd.unwrap_or(0.0) + cost);
    }
}

/// One Electron part → one native part, or `None` for the types the
/// native model does not carry (`step-start`, `patch`, `compaction`).
pub fn convert_part(raw: &Value) -> Option<Part> {
    let id = PartId::from_raw(raw.get("id").and_then(Value::as_str)?);
    match raw.get("type").and_then(Value::as_str)? {
        "text" => {
            let text = raw.get("text").and_then(Value::as_str).unwrap_or_default();
            // Empty text parts are streaming leftovers, not content.
            if text.is_empty() {
                return None;
            }
            Some(Part::Text(TextPart {
                id,
                text: text.to_string(),
            }))
        }
        "reasoning" => {
            let text = raw.get("text").and_then(Value::as_str).unwrap_or_default();
            if text.is_empty() {
                return None;
            }
            Some(Part::Reasoning(ReasoningPart {
                id,
                text: text.to_string(),
            }))
        }
        "tool" => Some(Part::ToolCall(tool_call(id, raw))),
        // A `file` part is an attachment the engine produced, usually a
        // screenshot behind a `boss-image://` URL.
        "file" => {
            let state = raw.get("state");
            let source = state
                .and_then(|s| s.get("url"))
                .or_else(|| raw.get("url"))
                .and_then(Value::as_str)
                .unwrap_or_default();
            if source.is_empty() {
                return None;
            }
            let mime = state
                .and_then(|s| s.get("mime"))
                .or_else(|| raw.get("mime"))
                .and_then(Value::as_str)
                .unwrap_or("application/octet-stream");
            let name = state
                .and_then(|s| s.get("name"))
                .or_else(|| raw.get("filename"))
                .and_then(Value::as_str)
                .map(str::to_string);
            Some(Part::Attachment(AttachmentPart {
                id,
                mime: mime.to_string(),
                source: source.to_string(),
                name,
            }))
        }
        _ => None,
    }
}

/// `{ type: "tool", id, state: { status, tool, input, output, error, title } }`.
/// Older rows put `tool` at the top level, so both places are checked.
fn tool_call(id: PartId, raw: &Value) -> ToolCallPart {
    let state = raw.get("state");
    let pick = |key: &str| {
        state
            .and_then(|s| s.get(key))
            .or_else(|| raw.get(key))
            .and_then(Value::as_str)
            .map(str::to_string)
    };
    let status = pick("status").unwrap_or_default();
    let name = pick("tool")
        .or_else(|| pick("name"))
        .unwrap_or_else(|| "tool".into());
    let error = pick("error");
    let call_id = raw
        .get("callID")
        .or_else(|| raw.get("callId"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| id.as_str().to_string());
    ToolCallPart {
        id,
        call_id,
        name,
        input: state
            .and_then(|s| s.get("input"))
            .or_else(|| raw.get("input"))
            .cloned()
            .unwrap_or(Value::Null),
        state: match status.as_str() {
            _ if error.is_some() => ToolState::Error,
            "completed" => ToolState::Done,
            "error" => ToolState::Error,
            "running" => ToolState::Running,
            _ => ToolState::Pending,
        },
        title: state
            .and_then(|s| s.get("title"))
            .and_then(Value::as_str)
            .map(str::to_string),
        output: state
            .and_then(|s| s.get("output"))
            .or_else(|| raw.get("output"))
            .and_then(Value::as_str)
            .map(str::to_string),
        error,
    }
}
