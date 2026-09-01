use crate::ids::*;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use time::OffsetDateTime;

/// Who wrote a message. In a room, several assistants share one thread,
/// so `author` names the participant rather than the engine.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    User,
    Assistant,
    System,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MessageStatus {
    Streaming,
    Complete,
    Interrupted,
    Error,
}

/// One message in a thread. `revision` increases on every change; views
/// use it as the cache key for rendered output.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Message {
    pub id: MessageId,
    pub thread_id: ThreadId,
    pub role: Role,
    /// Participant name shown in the transcript. `None` for the user.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<ParticipantId>,
    /// Exactly one recipient per message in a room. `None` in plain chats.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recipient: Option<ParticipantId>,
    /// Message this one replies to (a "branch" in the rooms design).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch_of: Option<MessageId>,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
    pub status: MessageStatus,
    pub parts: Vec<Part>,
    #[serde(default)]
    pub revision: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<Usage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

impl Message {
    pub fn new(thread_id: ThreadId, role: Role) -> Self {
        Self {
            id: MessageId::new(),
            thread_id,
            role,
            author: None,
            recipient: None,
            branch_of: None,
            created_at: OffsetDateTime::now_utc(),
            status: MessageStatus::Streaming,
            parts: Vec::new(),
            revision: 0,
            usage: None,
            model: None,
        }
    }

    pub fn touch(&mut self) {
        self.revision += 1;
    }

    pub fn part_mut(&mut self, id: &PartId) -> Option<&mut Part> {
        self.parts.iter_mut().find(|p| p.id() == id)
    }

    /// Plain text of all text parts, used for search and previews.
    pub fn text(&self) -> String {
        let mut out = String::new();
        for p in &self.parts {
            if let Part::Text(t) = p {
                if !out.is_empty() {
                    out.push('\n');
                }
                out.push_str(&t.text);
            }
        }
        out
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Usage {
    #[serde(default)]
    pub input_tokens: u64,
    #[serde(default)]
    pub output_tokens: u64,
    #[serde(default)]
    pub cache_read_tokens: u64,
    #[serde(default)]
    pub cache_write_tokens: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost_usd: Option<f64>,
}

/// A piece of a message. Engines stream into parts; the UI renders parts.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Part {
    Text(TextPart),
    Reasoning(ReasoningPart),
    ToolCall(ToolCallPart),
    Attachment(AttachmentPart),
}

impl Part {
    pub fn id(&self) -> &PartId {
        match self {
            Part::Text(p) => &p.id,
            Part::Reasoning(p) => &p.id,
            Part::ToolCall(p) => &p.id,
            Part::Attachment(p) => &p.id,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TextPart {
    pub id: PartId,
    pub text: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ReasoningPart {
    pub id: PartId,
    pub text: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolState {
    Pending,
    Running,
    Done,
    Error,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ToolCallPart {
    pub id: PartId,
    /// The engine's own call id, used to match results and permissions.
    pub call_id: String,
    pub name: String,
    #[serde(default)]
    pub input: Value,
    pub state: ToolState,
    /// Short label shown on the card, e.g. the file path for Read.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AttachmentPart {
    pub id: PartId,
    pub mime: String,
    /// Path on disk, or `image://<key>` for the image store.
    pub source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}
