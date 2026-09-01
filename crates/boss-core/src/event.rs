use crate::ids::*;
use crate::message::{Role, Usage};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// What an engine tells BOSS. Adapters translate their own wire formats
/// into this one enum. The app folds these into `Message`s.
///
/// Every event carries the engine-side `message_id` and `part_id` so the
/// app can update in place without a lookup table per adapter.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum EngineEvent {
    /// The engine created or resumed its native session.
    SessionReady { native_session_id: String },
    MessageStarted { message_id: MessageId, role: Role },
    TextDelta { message_id: MessageId, part_id: PartId, delta: String },
    ReasoningDelta { message_id: MessageId, part_id: PartId, delta: String },
    ToolCallStarted { message_id: MessageId, part_id: PartId, call_id: String, name: String, input: Value, title: Option<String> },
    /// Partial input JSON while the model is still writing the call.
    ToolCallInputDelta { message_id: MessageId, part_id: PartId, delta: String },
    ToolCallRunning { message_id: MessageId, part_id: PartId },
    ToolCallFinished { message_id: MessageId, part_id: PartId, output: Option<String>, error: Option<String> },
    MessageCompleted { message_id: MessageId, usage: Option<Usage>, model: Option<String> },
    /// The engine wants a permission decision from the user.
    PermissionRequested { request: RequestId, tool: String, input: Value, title: Option<String>, message_id: Option<MessageId> },
    /// The engine asked the user a question (ask_user_question and friends).
    QuestionAsked { request: RequestId, prompt: String, options: Vec<String> },
    /// Todo list for the session, whole list each time.
    Todos { items: Vec<Todo> },
    Status { busy: bool },
    Error { message: String, fatal: bool },
    /// The engine process ended.
    Closed,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Todo {
    pub text: String,
    pub done: bool,
    #[serde(default)]
    pub active: bool,
}
