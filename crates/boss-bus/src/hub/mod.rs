//! The MCP hub: BOSS's connections to external MCP servers.
//!
//! Port of `src/main/mcp-hub.ts` minus persistence and secret storage, which
//! the app owns. The hub connects to configured servers, aggregates their
//! tools under `mcp_<slug>_<tool>` names, routes calls back, and reports
//! per-server status.

mod client;
mod config;
mod rpc;

pub use client::{HttpTransport, McpClient, McpTransport, StdioTransport};
pub use config::{
    dedupe, load_configs, parse_boss_connections, parse_claude_code, parse_claude_desktop, parse_codex_toml,
    parse_project_mcp_json, McpConfigPaths, McpConfigSource, McpServerConfig, McpTransportConfig,
};
pub use rpc::{JsonRpcError, JsonRpcResponse, McpCallResult, McpToolDefinition};

use boss_core::{BusContent, BusTool, BusToolResult};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::sync::RwLock;

/// Every hub tool an agent sees starts with this: `mcp_<slug>_<tool>`.
pub const MCP_TOOL_PREFIX: &str = "mcp_";

/// Image formats the app can show; anything else is described in words.
const DISPLAYABLE_IMAGE_MIMES: [&str; 4] = ["image/png", "image/jpeg", "image/webp", "image/gif"];

/// Where one server is in its life.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum McpServerState {
    /// Configured but not enabled.
    Disabled,
    /// Handshake in progress.
    Starting,
    /// Initialized and tools listed.
    Connected,
    /// Handshake or listing failed; the text says why.
    Error { message: String },
}

/// One server's status for the settings page.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct McpServerStatus {
    pub name: String,
    pub slug: String,
    pub source: String,
    pub state: McpServerState,
    /// Server-side tool names, once connected.
    pub tools: Vec<String>,
}

struct Live {
    client: Arc<McpClient>,
    tools: Vec<McpToolDefinition>,
    instructions: Option<String>,
}

struct Server {
    config: McpServerConfig,
    slug: String,
    state: McpServerState,
    live: Option<Live>,
}

/// Connections to external MCP servers, addressed by slug.
#[derive(Default)]
pub struct McpHub {
    servers: RwLock<Vec<Server>>,
}

/// `mcp_<slug>_<tool>` namespace slug: lowercase, `[a-z0-9]` runs kept, 24 chars max.
pub fn slugify(name: &str) -> String {
    let mut slug = String::new();
    let mut pending_separator = false;
    for c in name.to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            if pending_separator && !slug.is_empty() {
                slug.push('_');
            }
            pending_separator = false;
            slug.push(c);
        } else {
            pending_separator = true;
        }
    }
    // Same order as the TS: trim the edges, then cut to 24 characters.
    let slug: String = slug.chars().take(24).collect();
    if slug.is_empty() { "server".to_owned() } else { slug }
}

/// Split an MCP tool result into the text the model reads and the first image
/// worth showing, as `mcpToolResultContent` in `src/shared/qa.ts` does.
///
/// Only one image is carried; others are named so nothing vanishes silently.
/// Unknown block types are kept as JSON text rather than dropped.
pub fn bus_result_from_mcp(result: &McpCallResult) -> BusToolResult {
    let mut text: Vec<String> = Vec::new();
    let mut image: Option<BusContent> = None;
    for item in &result.content {
        let Some(item) = item.as_object() else { continue };
        if let Some(Value::String(t)) = item.get("text") {
            if !t.is_empty() {
                text.push(t.clone());
            }
            continue;
        }
        if item.get("type").and_then(Value::as_str) == Some("image") {
            // Claude nests bytes under source.data with source.media_type; MCP puts data/mimeType at the top.
            let found = match item.get("source").and_then(Value::as_object) {
                Some(source) => source.get("data").and_then(Value::as_str).zip(source.get("media_type").and_then(Value::as_str)),
                None => item.get("data").and_then(Value::as_str).zip(item.get("mimeType").and_then(Value::as_str)),
            };
            if let Some((data, mime)) = found {
                if !DISPLAYABLE_IMAGE_MIMES.contains(&mime) {
                    text.push(format!("[Image omitted: {mime} is not a format this app can display.]"));
                } else if image.is_some() {
                    text.push(format!("[Additional {mime} image omitted: only the first is shown.]"));
                } else {
                    image = Some(BusContent::Image { data: data.to_owned(), mime_type: mime.to_owned() });
                }
                continue;
            }
        }
        text.push(Value::Object(item.clone()).to_string());
    }
    let joined = text.join("\n");
    if result.is_error {
        let message = if joined.is_empty() { "The MCP tool reported an error.".to_owned() } else { joined };
        return BusToolResult::error(message);
    }
    let fallback = if image.is_some() { "(image result)" } else { "(empty result)" };
    let mut content = vec![BusContent::Text { text: if joined.is_empty() { fallback.to_owned() } else { joined } }];
    content.extend(image);
    BusToolResult { content, is_error: false }
}

impl McpHub {
    /// An empty hub; add servers with [`McpHub::connect`] or [`McpHub::connect_all`].
    pub fn new() -> Self {
        Self::default()
    }

    /// Register every config and connect the enabled ones concurrently.
    pub async fn connect_all(&self, configs: Vec<McpServerConfig>) -> Vec<McpServerStatus> {
        let slugs: Vec<String> = {
            let mut servers = self.servers.write().await;
            configs.into_iter().map(|config| Self::register(&mut servers, config)).collect()
        };
        futures::future::join_all(slugs.iter().map(|slug| self.reconnect(slug))).await;
        self.statuses().await
    }

    /// Register one server (replacing any with the same slug) and connect it if enabled.
    pub async fn connect(&self, config: McpServerConfig) -> McpServerStatus {
        let slug = Self::register(&mut *self.servers.write().await, config);
        self.reconnect(&slug).await;
        self.status_of(&slug).await.expect("registered above")
    }

    /// Register a server and attach an already-built client, for tests and custom transports.
    pub async fn connect_with_client(&self, config: McpServerConfig, client: McpClient) -> McpServerStatus {
        let slug = Self::register(&mut *self.servers.write().await, config);
        self.attach(&slug, Arc::new(client)).await;
        self.status_of(&slug).await.expect("registered above")
    }

    fn register(servers: &mut Vec<Server>, config: McpServerConfig) -> String {
        let slug = match &config.slug {
            Some(slug) if !slug.is_empty() => slug.clone(),
            _ => {
                let base = slugify(&config.name);
                let mut slug = base.clone();
                let mut suffix = 2;
                while servers.iter().any(|s| s.slug == slug && s.config.name != config.name) {
                    slug = format!("{base}_{suffix}");
                    suffix += 1;
                }
                slug
            }
        };
        let state = if config.enabled { McpServerState::Starting } else { McpServerState::Disabled };
        if let Some(existing) = servers.iter_mut().find(|s| s.slug == slug) {
            existing.config = config;
            existing.state = state;
            existing.live = None;
        } else {
            servers.push(Server { config, slug: slug.clone(), state, live: None });
        }
        slug
    }

    async fn reconnect(&self, slug: &str) {
        let config = {
            let servers = self.servers.read().await;
            let Some(server) = servers.iter().find(|s| s.slug == slug) else { return };
            if !server.config.enabled {
                return;
            }
            server.config.clone()
        };
        let client = match config.transport {
            McpTransportConfig::Stdio { command, args, env } => McpClient::stdio(command, args, env.into_iter().collect()),
            McpTransportConfig::Http { url, headers } => McpClient::http(url, headers.into_iter().collect()),
        };
        self.attach(slug, Arc::new(client)).await;
    }

    async fn attach(&self, slug: &str, client: Arc<McpClient>) {
        let previous = {
            let mut servers = self.servers.write().await;
            let Some(server) = servers.iter_mut().find(|s| s.slug == slug) else { return };
            server.state = McpServerState::Starting;
            server.live.take()
        };
        if let Some(previous) = previous {
            previous.client.close().await;
        }
        let outcome = async {
            let instructions = client.initialize().await?;
            let tools = client.list_tools().await?;
            anyhow::Ok((instructions, tools))
        }
        .await;
        let mut servers = self.servers.write().await;
        let Some(server) = servers.iter_mut().find(|s| s.slug == slug) else { return };
        match outcome {
            Ok((instructions, tools)) => {
                server.live = Some(Live { client, tools, instructions });
                server.state = McpServerState::Connected;
            }
            Err(error) => {
                client.close().await;
                server.state = McpServerState::Error { message: error.to_string() };
                tracing::warn!(slug, %error, "MCP server failed to connect");
            }
        }
    }

    /// Close one server's connection and mark it disabled. It stays registered.
    pub async fn disconnect(&self, slug: &str) {
        let live = {
            let mut servers = self.servers.write().await;
            let Some(server) = servers.iter_mut().find(|s| s.slug == slug) else { return };
            server.state = McpServerState::Disabled;
            server.config.enabled = false;
            server.live.take()
        };
        if let Some(live) = live {
            live.client.close().await;
        }
    }

    /// Forget a server entirely, closing its connection.
    pub async fn remove(&self, slug: &str) {
        let removed = {
            let mut servers = self.servers.write().await;
            let index = servers.iter().position(|s| s.slug == slug);
            index.map(|i| servers.remove(i))
        };
        if let Some(Server { live: Some(live), .. }) = removed {
            live.client.close().await;
        }
    }

    /// Close every connection. Servers stay registered for a later `connect_all`.
    pub async fn close_all(&self) {
        let lives: Vec<Live> = self.servers.write().await.iter_mut().filter_map(|s| s.live.take()).collect();
        for live in lives {
            live.client.close().await;
        }
    }

    /// Status of every registered server, in registration order.
    pub async fn statuses(&self) -> Vec<McpServerStatus> {
        self.servers.read().await.iter().map(Self::status_view).collect()
    }

    /// Status of one server, by slug.
    pub async fn status_of(&self, slug: &str) -> Option<McpServerStatus> {
        self.servers.read().await.iter().find(|s| s.slug == slug).map(Self::status_view)
    }

    fn status_view(server: &Server) -> McpServerStatus {
        McpServerStatus {
            name: server.config.name.clone(),
            slug: server.slug.clone(),
            source: server.config.source.to_string(),
            state: server.state.clone(),
            tools: server.live.as_ref().map(|l| l.tools.iter().map(|t| t.name.clone()).collect()).unwrap_or_default(),
        }
    }

    /// Tool definitions for agents, namespaced `mcp_<slug>_<tool>`, from connected servers.
    pub async fn tool_definitions(&self) -> Vec<BusTool> {
        let servers = self.servers.read().await;
        let mut out = Vec::new();
        for server in servers.iter().filter(|s| s.config.enabled) {
            let Some(live) = &server.live else { continue };
            for tool in &live.tools {
                let description = format!("[{}] {}", server.config.name, tool.description.as_deref().unwrap_or(&tool.name));
                out.push(BusTool {
                    name: format!("{MCP_TOOL_PREFIX}{}_{}", server.slug, tool.name),
                    description: description.chars().take(1_000).collect(),
                    input_schema: tool.input_schema.clone().unwrap_or_else(|| json!({ "type": "object", "additionalProperties": true })),
                });
            }
        }
        out
    }

    /// Names of every tool [`McpHub::tool_definitions`] would return.
    pub async fn tool_names(&self) -> Vec<String> {
        self.tool_definitions().await.into_iter().map(|t| t.name).collect()
    }

    /// Resolve `mcp_<slug>_<tool>` to its server and tool. Slugs may contain
    /// underscores, so the match is by registered slug prefix plus a known tool.
    async fn resolve(&self, namespaced: &str) -> anyhow::Result<(Arc<McpClient>, String)> {
        let Some(name) = namespaced.strip_prefix(MCP_TOOL_PREFIX) else {
            return Err(anyhow::anyhow!("Unknown MCP tool: {namespaced}."));
        };
        let servers = self.servers.read().await;
        for server in servers.iter().filter(|s| s.config.enabled) {
            let Some(rest) = name.strip_prefix(&server.slug).and_then(|r| r.strip_prefix('_')) else { continue };
            let Some(live) = &server.live else {
                return Err(anyhow::anyhow!("The \"{}\" connection is not ready.", server.config.name));
            };
            if live.tools.iter().any(|t| t.name == rest) {
                return Ok((Arc::clone(&live.client), rest.to_owned()));
            }
        }
        Err(anyhow::anyhow!("Unknown MCP tool: {namespaced}. Use boss_mcp_list to see available tools."))
    }

    /// Call a namespaced tool. Routing failures and MCP `isError` results both come back as error results.
    pub async fn call_tool(&self, namespaced: &str, args: Value) -> BusToolResult {
        let (client, tool) = match self.resolve(namespaced).await {
            Ok(found) => found,
            Err(error) => return BusToolResult::error(error.to_string()),
        };
        match client.call_tool(&tool, args).await {
            Ok(result) => bus_result_from_mcp(&result),
            Err(error) => BusToolResult::error(error.to_string()),
        }
    }

    /// Compact catalogue for a `boss_mcp_list`-style tool: names and trimmed
    /// descriptions, or one tool's full definition when `tool` is given.
    pub async fn listing(&self, tool: Option<&str>) -> Value {
        let servers = self.servers.read().await;
        if let Some(wanted) = tool {
            let name = wanted.strip_prefix(MCP_TOOL_PREFIX).unwrap_or(wanted);
            for server in servers.iter().filter(|s| s.config.enabled) {
                let Some(rest) = name.strip_prefix(&server.slug).and_then(|r| r.strip_prefix('_')) else { continue };
                let Some(found) = server.live.as_ref().and_then(|l| l.tools.iter().find(|t| t.name == rest)) else { continue };
                return json!({
                    "connection": server.config.name,
                    "tool": format!("{MCP_TOOL_PREFIX}{}_{}", server.slug, found.name),
                    "description": found.description,
                    "inputSchema": found.input_schema.clone().unwrap_or_else(|| json!({ "type": "object", "additionalProperties": true })),
                });
            }
            return json!({ "error": format!("Unknown tool \"{wanted}\". Call boss_mcp_list without arguments for the catalog.") });
        }
        let listing: Vec<Value> = servers
            .iter()
            .filter(|s| s.config.enabled)
            .filter_map(|server| {
                let live = server.live.as_ref()?;
                Some(json!({
                    "connection": server.config.name,
                    "instructions": live.instructions,
                    "note": "Call boss_mcp_list with {\"tool\": \"<name>\"} to get a tool's full input schema before calling it.",
                    "tools": live.tools.iter().map(|t| json!({
                        "tool": format!("{MCP_TOOL_PREFIX}{}_{}", server.slug, t.name),
                        "description": t.description.as_deref().unwrap_or("").chars().take(200).collect::<String>(),
                    })).collect::<Vec<_>>(),
                }))
            })
            .collect();
        Value::Array(listing)
    }

    /// Instructions of connected servers, one `##` section each, for the bus's `initialize.instructions`.
    pub async fn instructions_summary(&self) -> String {
        self.servers
            .read()
            .await
            .iter()
            .filter(|s| s.config.enabled)
            .filter_map(|server| {
                let text = server.live.as_ref()?.instructions.as_deref()?;
                Some(format!("## {} (tools {MCP_TOOL_PREFIX}{}_*)\n{text}", server.config.name, server.slug))
            })
            .collect::<Vec<_>>()
            .join("\n\n")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugify_matches_the_ts_rules() {
        assert_eq!(slugify("Datadog MCP"), "datadog_mcp");
        assert_eq!(slugify("  --Weird__Name!! "), "weird_name");
        assert_eq!(slugify("!!!"), "server");
        assert_eq!(slugify("a-very-long-server-name-that-keeps-going"), "a_very_long_server_name_");
        assert!(slugify("ends-with-sep-at-24-chars-x").len() <= 24);
    }

    #[test]
    fn mcp_results_split_text_and_first_image() {
        let result = McpCallResult {
            content: vec![
                json!({ "type": "text", "text": "hello" }),
                json!({ "type": "text", "text": "" }),
                json!({ "type": "image", "data": "AAA", "mimeType": "image/png" }),
                json!({ "type": "image", "data": "BBB", "mimeType": "image/png" }),
                json!({ "type": "image", "data": "CCC", "mimeType": "image/tiff" }),
                json!({ "type": "image", "source": { "type": "base64", "data": "DDD", "media_type": "image/jpeg" } }),
                json!({ "type": "resource_link", "uri": "file:///x" }),
            ],
            is_error: false,
        };
        let bus = bus_result_from_mcp(&result);
        assert!(!bus.is_error);
        assert_eq!(bus.content.len(), 2);
        let BusContent::Text { text } = &bus.content[0] else { panic!() };
        assert_eq!(
            text,
            "hello\n[Additional image/png image omitted: only the first is shown.]\n[Image omitted: image/tiff is not a format this app can display.]\n[Additional image/jpeg image omitted: only the first is shown.]\n{\"type\":\"resource_link\",\"uri\":\"file:///x\"}"
        );
        assert_eq!(bus.content[1], BusContent::Image { data: "AAA".into(), mime_type: "image/png".into() });
    }

    #[test]
    fn mcp_results_fill_in_empties_and_errors() {
        let empty = bus_result_from_mcp(&McpCallResult::default());
        assert_eq!(empty, BusToolResult::text("(empty result)"));
        let image_only = bus_result_from_mcp(&McpCallResult {
            content: vec![json!({ "type": "image", "data": "A", "mimeType": "image/png" })],
            is_error: false,
        });
        let BusContent::Text { text } = &image_only.content[0] else { panic!() };
        assert_eq!(text, "(image result)");
        let failed = bus_result_from_mcp(&McpCallResult { content: vec![json!({ "type": "text", "text": "boom" })], is_error: true });
        assert_eq!(failed, BusToolResult::error("boom"));
        let failed_silent = bus_result_from_mcp(&McpCallResult { content: vec![], is_error: true });
        assert_eq!(failed_silent, BusToolResult::error("The MCP tool reported an error."));
    }
}
