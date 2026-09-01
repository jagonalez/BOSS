//! boss-bus: the thread-bus MCP server that agents call back into, and the
//! MCP hub client that connects BOSS to external MCP servers.
//!
//! Server half: [`BusServer`] binds `127.0.0.1:0`, serves `POST /mcp` as MCP
//! streamable HTTP (JSON responses), and authenticates every request with an
//! HMAC bearer token minted by [`BusTokens`] for one (thread, participant).
//! The app implements [`boss_core::BusHandler`]; the server only routes.
//!
//! Hub half: [`hub::McpHub`] connects to configured MCP servers over stdio or
//! streamable HTTP, aggregates their tools under `mcp_<slug>_<tool>` names,
//! and routes calls back to the right server.

pub mod hub;
pub mod server;
pub mod tokens;
pub mod tools;

pub use hub::{
    HttpTransport, McpCallResult, McpClient, McpConfigPaths, McpConfigSource, McpHub, McpServerConfig, McpServerState,
    McpServerStatus, McpToolDefinition, McpTransport, McpTransportConfig, StdioTransport, MCP_TOOL_PREFIX,
};
pub use server::BusServer;
pub use tokens::BusTokens;
pub use tools::{is_read_only, tool_definitions, QA_GUIDANCE};
