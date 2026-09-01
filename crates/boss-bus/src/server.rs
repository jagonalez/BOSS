//! The thread-bus MCP server: `POST /mcp` on loopback, JSON-RPC in, JSON out.
//!
//! Port of `handleMcp` in `src/main/thread-bus.ts`. Every request carries a
//! bearer token minted by [`BusTokens`]; the server names the caller from it
//! and hands the call to the app's [`BusHandler`]. It knows nothing about
//! policy or which tools a caller may see — the handler owns that.

use crate::tokens::BusTokens;
use crate::tools::{is_read_only, QA_GUIDANCE};
use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, State};
use axum::http::{header, HeaderMap, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::any;
use axum::Router;
use boss_core::{BusCaller, BusContent, BusHandler, BusToolResult};
use serde_json::{json, Value};
use std::future::IntoFuture;
use std::sync::Arc;
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

/// Requests above this are refused, as in the TS server (64 KB).
const MAX_BODY_BYTES: usize = 64_000;
/// Newest protocol revision the server speaks.
const PROTOCOL_VERSION: &str = "2025-06-18";
/// Older revision still accepted when a client asks for it.
const LEGACY_PROTOCOL_VERSION: &str = "2025-03-26";

/// A running bus server. Dropping it (or calling [`BusServer::stop`]) shuts it down.
pub struct BusServer {
    url: String,
    tokens: BusTokens,
    shutdown: Option<oneshot::Sender<()>>,
    task: Option<JoinHandle<()>>,
}

struct AppState {
    handler: Arc<dyn BusHandler>,
    tokens: BusTokens,
    instructions: String,
}

impl BusServer {
    /// Bind `127.0.0.1:0` and serve `/mcp` with [`QA_GUIDANCE`] as the MCP instructions.
    pub async fn start(handler: Arc<dyn BusHandler>, secret: [u8; 32]) -> anyhow::Result<Self> {
        Self::start_with_instructions(handler, secret, QA_GUIDANCE.to_owned()).await
    }

    /// Like [`BusServer::start`], with custom `initialize.instructions` (e.g.
    /// QA guidance followed by the MCP hub's server instructions).
    pub async fn start_with_instructions(
        handler: Arc<dyn BusHandler>,
        secret: [u8; 32],
        instructions: String,
    ) -> anyhow::Result<Self> {
        let tokens = BusTokens::new(secret);
        let state = Arc::new(AppState { handler, tokens: tokens.clone(), instructions });
        let app = Router::new()
            .route("/mcp", any(handle_mcp))
            .with_state(state)
            .layer(DefaultBodyLimit::max(MAX_BODY_BYTES));
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let addr = listener.local_addr()?;
        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
        let serve = axum::serve(listener, app).with_graceful_shutdown(async move {
            let _ = shutdown_rx.await;
        });
        let task = tokio::spawn(async move {
            if let Err(error) = serve.into_future().await {
                tracing::error!(%error, "thread bus server stopped");
            }
        });
        tracing::info!(%addr, "thread bus listening");
        Ok(Self { url: format!("http://{addr}"), tokens, shutdown: Some(shutdown_tx), task: Some(task) })
    }

    /// Base URL, `http://127.0.0.1:<port>`. Engines append `/mcp`.
    pub fn url(&self) -> &str {
        &self.url
    }

    /// Full MCP endpoint URL.
    pub fn mcp_url(&self) -> String {
        format!("{}/mcp", self.url)
    }

    /// Token minter for this server's secret, to hand out [`boss_core::BusAccess`].
    pub fn tokens(&self) -> &BusTokens {
        &self.tokens
    }

    /// Stop accepting connections and wait for the server task to finish.
    pub async fn stop(mut self) {
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(());
        }
        if let Some(task) = self.task.take() {
            let _ = task.await;
        }
    }
}

impl Drop for BusServer {
    fn drop(&mut self) {
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(());
        }
    }
}

fn json_response(status: StatusCode, value: Value) -> Response {
    (status, [(header::CONTENT_TYPE, "application/json")], value.to_string()).into_response()
}

fn rpc_error(status: StatusCode, id: Value, code: i64, message: impl Into<String>) -> Response {
    json_response(status, json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message.into() } }))
}

fn rpc_result(id: &Value, result: Value) -> Response {
    json_response(StatusCode::OK, json!({ "jsonrpc": "2.0", "id": id, "result": result }))
}

/// Who is calling, from the bearer token. `X-Boss-Thread` / `X-Boss-Participant`,
/// when present, must agree with the token; they never widen it.
fn authenticate(state: &AppState, headers: &HeaderMap) -> Option<BusCaller> {
    let authorization = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let token = authorization.strip_prefix("Bearer ")?;
    let caller = state.tokens.verify(token.trim())?;
    if let Some(thread) = headers.get("x-boss-thread")
        && thread.to_str().ok()? != caller.thread_id.as_str()
    {
        return None;
    }
    if let Some(participant) = headers.get("x-boss-participant")
        && participant.to_str().ok()? != caller.participant_id.as_str()
    {
        return None;
    }
    Some(caller)
}

/// Browsers send `Origin`; only loopback origins may talk to the bus.
fn local_origin(headers: &HeaderMap) -> bool {
    let Some(origin) = headers.get(header::ORIGIN) else { return true };
    let Ok(origin) = origin.to_str() else { return false };
    let Ok(url) = reqwest::Url::parse(origin) else { return false };
    matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]" | "::1"))
}

/// `BusToolResult` in MCP wire shape: `content` blocks with `mimeType`, and `isError`.
pub fn mcp_call_result(result: &BusToolResult) -> Value {
    let content: Vec<Value> = result
        .content
        .iter()
        .map(|block| match block {
            BusContent::Text { text } => json!({ "type": "text", "text": text }),
            BusContent::Image { data, mime_type } => json!({ "type": "image", "mimeType": mime_type, "data": data }),
        })
        .collect();
    json!({ "content": content, "isError": result.is_error })
}

async fn handle_mcp(State(state): State<Arc<AppState>>, method: Method, headers: HeaderMap, body: Bytes) -> Response {
    let Some(caller) = authenticate(&state, &headers) else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    if !local_origin(&headers) {
        return StatusCode::FORBIDDEN.into_response();
    }
    if method == Method::GET || method == Method::DELETE {
        return (StatusCode::METHOD_NOT_ALLOWED, [(header::ALLOW, "POST")]).into_response();
    }
    if method != Method::POST {
        return StatusCode::NOT_FOUND.into_response();
    }

    let input: Value = match serde_json::from_slice(&body) {
        Ok(value) => value,
        Err(error) => return rpc_error(StatusCode::BAD_REQUEST, Value::Null, -32700, error.to_string()),
    };
    let id = input.get("id").cloned().unwrap_or(Value::Null);
    let rpc_method = input.get("method").and_then(Value::as_str).unwrap_or("");
    if input.get("jsonrpc").and_then(Value::as_str) != Some("2.0") || rpc_method.is_empty() {
        return rpc_error(StatusCode::BAD_REQUEST, id, -32600, "Invalid JSON-RPC request.");
    }
    // Notifications (no id) are acknowledged and otherwise ignored.
    if input.get("id").is_none() {
        return StatusCode::ACCEPTED.into_response();
    }
    let params = input.get("params").cloned().unwrap_or(Value::Null);

    match rpc_method {
        "initialize" => {
            let requested = params.get("protocolVersion").and_then(Value::as_str).unwrap_or("");
            let version = if requested == LEGACY_PROTOCOL_VERSION { requested } else { PROTOCOL_VERSION };
            rpc_result(
                &id,
                json!({
                    "protocolVersion": version,
                    "capabilities": { "tools": { "listChanged": false } },
                    "serverInfo": { "name": "boss-agent-tools", "version": "1.0.0" },
                    "instructions": state.instructions,
                }),
            )
        }
        "ping" => rpc_result(&id, json!({})),
        "tools/list" => {
            let tools: Vec<Value> = state
                .handler
                .list_tools(&caller)
                .await
                .into_iter()
                .map(|tool| {
                    let mut entry = json!({
                        "name": tool.name,
                        "description": tool.description,
                        "inputSchema": tool.input_schema,
                    });
                    if is_read_only(&tool.name) {
                        entry["annotations"] = json!({ "readOnlyHint": true });
                    }
                    entry
                })
                .collect();
            rpc_result(&id, json!({ "tools": tools }))
        }
        "tools/call" => {
            let Some(name) = params.get("name").and_then(Value::as_str) else {
                return rpc_result(&id, mcp_call_result(&BusToolResult::error("A tool name is required.")));
            };
            let args = match params.get("arguments") {
                Some(Value::Null) | None => json!({}),
                Some(value) => value.clone(),
            };
            let result = state.handler.call_tool(&caller, name, args).await;
            rpc_result(&id, mcp_call_result(&result))
        }
        _ => rpc_error(StatusCode::OK, id, -32601, "Method not found."),
    }
}
