//! Command line and environment for the `claude` process.
//!
//! Flag spellings follow `@anthropic-ai/claude-agent-sdk`: `--resume=<id>`
//! and `--setting-sources=<list>` use the `=` form, everything else is a
//! separate argument. System prompts are not flags; they go in the
//! `initialize` control request (see `protocol::initialize_request`).

use super::protocol::{BUS_SERVER_NAME, permission_mode_str};
use boss_core::{BusAccess, PermissionMode, SessionOptions};
use serde_json::{Value, json};

/// The SDK marks its child processes with this so the CLI behaves as a
/// programmatic client rather than an interactive terminal.
pub const ENTRYPOINT: (&str, &str) = ("CLAUDE_CODE_ENTRYPOINT", "sdk-ts");

/// Arguments for one session.
///
/// Always: stream-json both ways, `--verbose` (required for stream-json
/// output), permission prompts over stdio, partial messages, and only the
/// project's settings. The user's `~/.claude/settings.json` is deliberately
/// left out: it can carry an output style, which is a whole system prompt.
pub fn build_args(opts: &SessionOptions) -> Vec<String> {
    let mut args: Vec<String> = [
        "--output-format",
        "stream-json",
        "--verbose",
        "--input-format",
        "stream-json",
        "--permission-prompt-tool",
        "stdio",
        "--include-partial-messages",
        "--setting-sources=project",
    ]
    .iter()
    .map(|s| (*s).to_owned())
    .collect();

    if let Some(model) = &opts.model {
        args.push("--model".into());
        args.push(model.clone());
    }
    if let Some(resume) = &opts.resume {
        args.push(format!("--resume={resume}"));
    }
    args.push("--permission-mode".into());
    args.push(permission_mode_str(opts.permission_mode).into());
    if opts.permission_mode == PermissionMode::Bypass {
        args.push("--allow-dangerously-skip-permissions".into());
    }
    if let Some(tools) = &opts.allowed_tools {
        args.push("--tools".into());
        args.push(tools.join(","));
    }
    if let Some(bus) = &opts.bus {
        args.push("--mcp-config".into());
        args.push(mcp_config(bus).to_string());
        args.push("--strict-mcp-config".into());
        // A bare server name pre-approves every tool that server offers, so
        // the list never goes stale when the bus gains a tool.
        args.push("--allowedTools".into());
        args.push(format!("mcp__{BUS_SERVER_NAME}"));
    }
    args
}

/// The MCP endpoint for a bus: `<url>/mcp` unless the url already names it.
pub fn bus_url(bus: &BusAccess) -> String {
    let base = bus.url.trim_end_matches('/');
    if base.ends_with("/mcp") { base.to_owned() } else { format!("{base}/mcp") }
}

/// The inline `--mcp-config` document that points Claude at the thread bus.
pub fn mcp_config(bus: &BusAccess) -> Value {
    json!({
        "mcpServers": {
            BUS_SERVER_NAME: {
                "type": "http",
                "url": bus_url(bus),
                "headers": {
                    "Authorization": format!("Bearer {}", bus.token),
                    "X-Boss-Thread": bus.thread_id.as_str(),
                    "X-Boss-Participant": bus.participant_id.as_str(),
                }
            }
        }
    })
}

/// Extra environment for the child.
pub fn spawn_env() -> Vec<(String, String)> {
    let mut env = Vec::new();
    if std::env::var_os(ENTRYPOINT.0).is_none() {
        env.push((ENTRYPOINT.0.to_owned(), ENTRYPOINT.1.to_owned()));
    }
    env
}
