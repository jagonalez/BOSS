//! Per-message render cache keyed by `(message.id, message.revision)`.
//!
//! A cache entry holds the *inputs* to the elements for one message: stable
//! element ids, markdown text as `SharedString` (an `Arc<str>`, so cloning
//! into an element each frame is a pointer copy), pretty-printed tool input,
//! and the truncated tool output. Building an entry is the only place that
//! walks a message's parts or formats JSON. A token arriving for message N
//! bumps N's revision and rebuilds N's entry alone; message M's entry is
//! untouched, so its markdown is never re-derived.
//!
//! Markdown *parsing* happens inside gpui-component's `TextView`, which keeps
//! its parsed state per element id and skips re-parsing when the text it is
//! given is unchanged. Stable ids plus stable `SharedString`s from this cache
//! are what make that skip hit.

use boss_core::{Message, MessageId, Part, ToolState};
use gpui::SharedString;
use std::collections::HashMap;
use time::macros::format_description;

/// Lines of tool output shown before the "show more" affordance.
pub const OUTPUT_HEAD_LINES: usize = 12;

/// Element inputs for one part of a message.
#[derive(Debug, Clone, PartialEq)]
pub enum Block {
    /// Markdown text.
    Text { id: SharedString, markdown: SharedString },
    /// Model reasoning; collapsed by default.
    Reasoning { id: SharedString, markdown: SharedString },
    /// A tool call card.
    Tool(ToolBlock),
    /// A file or image attached to the message.
    Attachment { id: SharedString, name: SharedString, mime: SharedString, source: SharedString, is_image: bool },
}

/// Pre-formatted inputs for a tool-call card.
#[derive(Debug, Clone, PartialEq)]
pub struct ToolBlock {
    /// Stable element id (`<message>/<part>`).
    pub id: SharedString,
    /// Tool name, e.g. `Read`.
    pub name: SharedString,
    /// Short label, e.g. the file path.
    pub title: Option<SharedString>,
    /// Lifecycle state at this revision.
    pub state: ToolState,
    /// Pretty-printed input JSON, or the raw partial text while streaming.
    pub input: SharedString,
    /// First `OUTPUT_HEAD_LINES` lines of output.
    pub output_head: SharedString,
    /// Whole output; equals `output_head` when nothing was cut.
    pub output_full: SharedString,
    /// Lines hidden behind "show more".
    pub hidden_lines: usize,
    /// Error text when the call failed.
    pub error: Option<SharedString>,
}

/// Cached render inputs for one message at one revision.
#[derive(Debug, Clone, PartialEq)]
pub struct CachedMessage {
    /// Revision the entry was built from.
    pub revision: u64,
    /// `HH:MM` of `created_at`, in UTC.
    pub time: SharedString,
    /// Blocks in part order.
    pub blocks: Vec<Block>,
}

/// Render cache for a transcript. One entry per message.
#[derive(Debug, Default)]
pub struct RenderCache {
    entries: HashMap<MessageId, CachedMessage>,
    hits: u64,
    misses: u64,
}

impl RenderCache {
    /// Empty cache.
    pub fn new() -> Self {
        Self::default()
    }

    /// The entry for `msg`, rebuilt only when its revision changed.
    pub fn get(&mut self, msg: &Message) -> &CachedMessage {
        let entry = self.entries.entry(msg.id.clone());
        match entry {
            std::collections::hash_map::Entry::Occupied(mut o) => {
                if o.get().revision != msg.revision {
                    self.misses += 1;
                    o.insert(build(msg));
                } else {
                    self.hits += 1;
                }
                o.into_mut()
            }
            std::collections::hash_map::Entry::Vacant(v) => {
                self.misses += 1;
                v.insert(build(msg))
            }
        }
    }

    /// Drop entries for messages that no longer exist.
    pub fn retain(&mut self, live: impl Fn(&MessageId) -> bool) {
        self.entries.retain(|id, _| live(id));
    }

    /// Number of cached messages.
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// True when nothing is cached.
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Lookups served without rebuilding.
    pub fn hits(&self) -> u64 {
        self.hits
    }

    /// Lookups that rebuilt an entry.
    pub fn misses(&self) -> u64 {
        self.misses
    }
}

fn build(msg: &Message) -> CachedMessage {
    let time = msg
        .created_at
        .format(format_description!("[hour]:[minute]"))
        .unwrap_or_default()
        .into();
    let blocks = msg
        .parts
        .iter()
        .map(|part| {
            let id: SharedString = format!("{}/{}", msg.id, part.id()).into();
            match part {
                Part::Text(t) => Block::Text { id, markdown: t.text.clone().into() },
                Part::Reasoning(r) => Block::Reasoning { id, markdown: r.text.clone().into() },
                Part::ToolCall(tc) => {
                    let input = match &tc.input {
                        serde_json::Value::String(raw) => raw.clone(),
                        serde_json::Value::Null => String::new(),
                        other => serde_json::to_string_pretty(other).unwrap_or_default(),
                    };
                    let output_full = tc.output.clone().unwrap_or_default();
                    let (output_head, hidden_lines) = head_lines(&output_full, OUTPUT_HEAD_LINES);
                    Block::Tool(ToolBlock {
                        id,
                        name: tc.name.clone().into(),
                        title: tc.title.clone().map(Into::into),
                        state: tc.state.clone(),
                        input: input.into(),
                        output_head: output_head.into(),
                        output_full: output_full.into(),
                        hidden_lines,
                        error: tc.error.clone().map(Into::into),
                    })
                }
                Part::Attachment(a) => {
                    let name = a.name.clone().unwrap_or_else(|| a.source.rsplit('/').next().unwrap_or(&a.source).to_owned());
                    Block::Attachment {
                        id,
                        name: name.into(),
                        mime: a.mime.clone().into(),
                        source: a.source.clone().into(),
                        is_image: a.mime.starts_with("image/") && !a.source.starts_with("image://"),
                    }
                }
            }
        })
        .collect();
    CachedMessage { revision: msg.revision, time, blocks }
}

/// First `n` lines of `text` and how many lines were left out.
pub(crate) fn head_lines(text: &str, n: usize) -> (String, usize) {
    let total = text.lines().count();
    if total <= n {
        return (text.to_owned(), 0);
    }
    let head = text.lines().take(n).collect::<Vec<_>>().join("\n");
    (head, total - n)
}

#[cfg(test)]
mod tests {
    use super::*;
    use boss_core::*;

    fn message() -> Message {
        let mut m = Message::new(ThreadId::from_raw("t"), Role::Assistant);
        m.parts.push(Part::Text(TextPart { id: PartId::from_raw("p1"), text: "hello".into() }));
        m
    }

    #[test]
    fn unchanged_revision_is_a_hit() {
        let mut cache = RenderCache::new();
        let msg = message();
        let a = cache.get(&msg).clone();
        let b = cache.get(&msg).clone();
        assert_eq!(a, b);
        assert_eq!(cache.misses(), 1);
        assert_eq!(cache.hits(), 1);
    }

    #[test]
    fn revision_change_rebuilds_only_that_message() {
        let mut cache = RenderCache::new();
        let mut a = message();
        let b = message();
        cache.get(&a);
        cache.get(&b);
        assert_eq!(cache.misses(), 2);

        if let Part::Text(t) = &mut a.parts[0] {
            t.text.push_str(" world");
        }
        a.touch();
        let rebuilt = cache.get(&a).clone();
        assert_eq!(cache.misses(), 3);
        assert!(matches!(&rebuilt.blocks[0], Block::Text { markdown, .. } if markdown.as_ref() == "hello world"));

        cache.get(&b);
        assert_eq!(cache.misses(), 3, "b was not rebuilt");
        assert_eq!(cache.hits(), 1);
    }

    #[test]
    fn element_ids_are_stable_across_revisions() {
        let mut cache = RenderCache::new();
        let mut m = message();
        let id_before = match &cache.get(&m).blocks[0] {
            Block::Text { id, .. } => id.clone(),
            _ => unreachable!(),
        };
        m.touch();
        let id_after = match &cache.get(&m).blocks[0] {
            Block::Text { id, .. } => id.clone(),
            _ => unreachable!(),
        };
        assert_eq!(id_before, id_after);
    }

    #[test]
    fn tool_output_is_truncated_and_input_pretty_printed() {
        let mut cache = RenderCache::new();
        let mut m = Message::new(ThreadId::from_raw("t"), Role::Assistant);
        let output = (1..=20).map(|i| format!("line {i}")).collect::<Vec<_>>().join("\n");
        m.parts.push(Part::ToolCall(ToolCallPart {
            id: PartId::from_raw("tc"),
            call_id: "c".into(),
            name: "Bash".into(),
            input: serde_json::json!({"command": "ls"}),
            state: ToolState::Done,
            title: Some("ls".into()),
            output: Some(output),
            error: None,
        }));
        match &cache.get(&m).blocks[0] {
            Block::Tool(tb) => {
                assert_eq!(tb.hidden_lines, 20 - OUTPUT_HEAD_LINES);
                assert_eq!(tb.output_head.lines().count(), OUTPUT_HEAD_LINES);
                assert!(tb.input.contains("\"command\": \"ls\""));
            }
            _ => panic!("expected tool block"),
        }
    }

    #[test]
    fn retain_drops_dead_entries() {
        let mut cache = RenderCache::new();
        let a = message();
        let b = message();
        cache.get(&a);
        cache.get(&b);
        cache.retain(|id| *id == a.id);
        assert_eq!(cache.len(), 1);
    }
}
