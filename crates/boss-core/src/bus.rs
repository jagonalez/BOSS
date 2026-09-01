use crate::ids::*;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Who is calling a bus tool. Derived from the bearer token by boss-bus.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BusCaller {
    pub thread_id: ThreadId,
    pub participant_id: ParticipantId,
}

/// A tool the bus exposes over MCP. Descriptions live with the handler.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct BusTool {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct BusToolResult {
    /// Text blocks returned to the agent.
    pub content: Vec<BusContent>,
    #[serde(default)]
    pub is_error: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum BusContent {
    Text { text: String },
    Image { data: String, mime_type: String },
}

impl BusToolResult {
    pub fn text(text: impl Into<String>) -> Self {
        Self { content: vec![BusContent::Text { text: text.into() }], is_error: false }
    }
    pub fn error(text: impl Into<String>) -> Self {
        Self { content: vec![BusContent::Text { text: text.into() }], is_error: true }
    }
}

/// The app implements this; boss-bus serves it over HTTP MCP.
#[async_trait]
pub trait BusHandler: Send + Sync {
    async fn list_tools(&self, caller: &BusCaller) -> Vec<BusTool>;
    async fn call_tool(&self, caller: &BusCaller, name: &str, args: Value) -> BusToolResult;
}
