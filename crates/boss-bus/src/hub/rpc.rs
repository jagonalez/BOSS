//! JSON-RPC 2.0 framing shared by both MCP client transports.

use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;

/// MCP protocol revision this client speaks.
pub const PROTOCOL_VERSION: &str = "2025-06-18";
/// How long a single request may take before the client gives up.
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);

/// A tool as an MCP server describes it in `tools/list`.
#[derive(Clone, Debug, PartialEq)]
pub struct McpToolDefinition {
    pub name: String,
    pub description: Option<String>,
    pub input_schema: Option<Value>,
}

/// A `tools/call` result: raw content blocks plus the error flag.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct McpCallResult {
    pub content: Vec<Value>,
    pub is_error: bool,
}

/// The parts of a JSON-RPC response the client reads.
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
pub struct JsonRpcResponse {
    #[serde(default)]
    pub id: Option<Value>,
    #[serde(default)]
    pub result: Option<Value>,
    #[serde(default)]
    pub error: Option<JsonRpcError>,
}

/// The `error` member of a failed response.
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
pub struct JsonRpcError {
    #[serde(default)]
    pub code: Option<i64>,
    #[serde(default)]
    pub message: Option<String>,
}

impl JsonRpcResponse {
    /// The result, or the server's error message as an `Err`.
    pub fn into_result(self) -> anyhow::Result<Value> {
        if let Some(error) = self.error {
            let message = match error.message.filter(|m| !m.is_empty()) {
                Some(message) => message,
                None => format!("MCP error {}", error.code.map(|c| c.to_string()).unwrap_or_default()).trim().to_owned(),
            };
            return Err(anyhow::anyhow!(message));
        }
        Ok(self.result.unwrap_or(Value::Null))
    }
}

/// Build a request envelope.
pub fn request(id: u64, method: &str, params: Option<Value>) -> Value {
    let mut value = json!({ "jsonrpc": "2.0", "id": id, "method": method });
    if let Some(params) = params {
        value["params"] = params;
    }
    value
}

/// Build a notification envelope (no id, no reply expected).
pub fn notification(method: &str) -> Value {
    json!({ "jsonrpc": "2.0", "method": method })
}

/// Params for `initialize`, identifying this client.
pub fn initialize_params() -> Value {
    json!({
        "protocolVersion": PROTOCOL_VERSION,
        "capabilities": {},
        "clientInfo": { "name": "boss-mcp-hub", "version": "1.0.0" }
    })
}

/// Trimmed `instructions` from an `initialize` result, if the server sent any.
pub fn instructions_from(result: &Value) -> Option<String> {
    let text = result.get("instructions")?.as_str()?.trim();
    (!text.is_empty()).then(|| text.to_owned())
}

/// Tools from a `tools/list` result; entries without a name are dropped.
pub fn tools_from(result: &Value) -> Vec<McpToolDefinition> {
    let Some(tools) = result.get("tools").and_then(Value::as_array) else { return Vec::new() };
    tools
        .iter()
        .filter_map(|tool| {
            let name = match tool.get("name") {
                Some(Value::String(name)) => name.clone(),
                Some(other) if !other.is_null() && !other.is_object() && !other.is_array() => other.to_string(),
                _ => String::new(),
            };
            if name.is_empty() {
                return None;
            }
            Some(McpToolDefinition {
                name,
                description: tool.get("description").and_then(Value::as_str).map(str::to_owned),
                input_schema: tool.get("inputSchema").filter(|schema| schema.is_object()).cloned(),
            })
        })
        .collect()
}

/// A `tools/call` result in the shape the hub handles.
pub fn call_result_from(result: &Value) -> McpCallResult {
    McpCallResult {
        content: result.get("content").and_then(Value::as_array).cloned().unwrap_or_default(),
        is_error: result.get("isError") == Some(&Value::Bool(true)),
    }
}

/// Find the response to request `id` in a `text/event-stream` body.
///
/// Each event's `data:` lines are joined and parsed as one JSON-RPC message;
/// non-JSON events and messages for other ids are skipped.
pub fn response_from_sse(body: &str, id: u64) -> Option<JsonRpcResponse> {
    let wanted = Value::from(id);
    for block in body.split("\n\n") {
        let data: String = block
            .lines()
            .filter_map(|line| line.strip_prefix("data:"))
            .map(str::trim)
            .collect::<Vec<_>>()
            .join("");
        if data.is_empty() {
            continue;
        }
        if let Ok(message) = serde_json::from_str::<JsonRpcResponse>(&data)
            && message.id.as_ref() == Some(&wanted)
        {
            return Some(message);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_and_notification_envelopes() {
        assert_eq!(
            request(3, "tools/list", Some(json!({}))),
            json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/list", "params": {} })
        );
        assert_eq!(request(4, "ping", None), json!({ "jsonrpc": "2.0", "id": 4, "method": "ping" }));
        assert_eq!(notification("notifications/initialized"), json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }));
    }

    #[test]
    fn error_responses_become_errors() {
        let response: JsonRpcResponse = serde_json::from_value(json!({ "id": 1, "error": { "code": -32601, "message": "nope" } })).unwrap();
        assert_eq!(response.into_result().unwrap_err().to_string(), "nope");
        let response: JsonRpcResponse = serde_json::from_value(json!({ "id": 1, "error": { "code": -5 } })).unwrap();
        assert_eq!(response.into_result().unwrap_err().to_string(), "MCP error -5");
        let response: JsonRpcResponse = serde_json::from_value(json!({ "id": 1, "result": { "ok": true } })).unwrap();
        assert_eq!(response.into_result().unwrap(), json!({ "ok": true }));
    }

    #[test]
    fn tools_are_read_leniently() {
        let tools = tools_from(&json!({ "tools": [
            { "name": "a", "description": "A", "inputSchema": { "type": "object" } },
            { "name": "b", "inputSchema": "not an object" },
            { "description": "no name" },
            "junk",
            { "name": 7 }
        ] }));
        assert_eq!(tools.len(), 3);
        assert_eq!(tools[0].description.as_deref(), Some("A"));
        assert_eq!(tools[1].input_schema, None);
        assert_eq!(tools[2].name, "7");
        assert!(tools_from(&json!({})).is_empty());
    }

    #[test]
    fn call_result_and_instructions() {
        let result = call_result_from(&json!({ "content": [{ "type": "text", "text": "hi" }], "isError": true }));
        assert_eq!(result.content.len(), 1);
        assert!(result.is_error);
        assert_eq!(call_result_from(&json!(null)), McpCallResult::default());
        assert_eq!(instructions_from(&json!({ "instructions": "  use me  " })).as_deref(), Some("use me"));
        assert_eq!(instructions_from(&json!({ "instructions": "   " })), None);
        assert_eq!(instructions_from(&json!({})), None);
    }

    #[test]
    fn sse_bodies_yield_the_matching_response() {
        let body = "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":9,\"result\":{}}\n\n: keepalive\n\ndata: {\"jsonrpc\":\"2.0\",\ndata: \"id\":2,\"result\":{\"x\":1}}\n\ndata: not json\n\n";
        assert_eq!(response_from_sse(body, 2).unwrap().result, Some(json!({ "x": 1 })));
        assert_eq!(response_from_sse(body, 9).unwrap().result, Some(json!({})));
        assert!(response_from_sse(body, 5).is_none());
    }
}
