//! Where MCP server definitions come from.
//!
//! Port of `importScan` in `src/main/mcp-hub.ts` plus BOSS's own
//! `mcp-connections.json`. Sources, in the order they are read:
//! Claude Code user config (`~/.claude.json`: `mcpServers` and each
//! `projects[<path>].mcpServers`), the project's `.mcp.json`, Claude Desktop,
//! Codex (`~/.codex/config.toml`), and BOSS's own connections. The first
//! source to name a given command line or URL wins; later duplicates drop.

use serde_json::Value;
use std::collections::{BTreeMap, HashSet};
use std::fmt;
use std::path::{Path, PathBuf};

/// How to reach one MCP server.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum McpTransportConfig {
    /// Spawn a process and speak JSON-RPC over its stdio.
    Stdio { command: String, args: Vec<String>, env: BTreeMap<String, String> },
    /// POST JSON-RPC to a streamable HTTP endpoint.
    Http { url: String, headers: BTreeMap<String, String> },
}

impl McpTransportConfig {
    /// Identity used for de-duplication across sources: the command line or the URL.
    pub fn key(&self) -> String {
        match self {
            McpTransportConfig::Stdio { command, args, .. } => format!("stdio:{command} {}", args.join(" ")),
            McpTransportConfig::Http { url, .. } => format!("http:{url}"),
        }
    }
}

/// Which file a server definition was read from.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum McpConfigSource {
    /// `~/.claude.json` top-level `mcpServers`.
    ClaudeCodeUser,
    /// `~/.claude.json` `projects[<path>].mcpServers`.
    ClaudeCodeProject(String),
    /// A project's `.mcp.json`.
    ProjectMcpJson(PathBuf),
    /// Claude Desktop's `claude_desktop_config.json`.
    ClaudeDesktop,
    /// Codex's `~/.codex/config.toml`.
    Codex,
    /// BOSS's own `mcp-connections.json`.
    Boss,
}

impl fmt::Display for McpConfigSource {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            McpConfigSource::ClaudeCodeUser => f.write_str("Claude Code (user)"),
            McpConfigSource::ClaudeCodeProject(path) => write!(f, "Claude Code ({path})"),
            McpConfigSource::ProjectMcpJson(path) => write!(f, "Project ({})", path.display()),
            McpConfigSource::ClaudeDesktop => f.write_str("Claude Desktop"),
            McpConfigSource::Codex => f.write_str("Codex"),
            McpConfigSource::Boss => f.write_str("BOSS"),
        }
    }
}

/// One MCP server the hub may connect to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct McpServerConfig {
    pub name: String,
    pub transport: McpTransportConfig,
    pub enabled: bool,
    pub source: McpConfigSource,
    /// Tool namespace already assigned by BOSS (`mcp_<slug>_*`). `None` for imports.
    pub slug: Option<String>,
}

/// The files to read. Every path is optional so tests can point at fixtures.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct McpConfigPaths {
    pub claude_code: Option<PathBuf>,
    pub project_mcp_json: Option<PathBuf>,
    pub claude_desktop: Option<PathBuf>,
    pub codex: Option<PathBuf>,
    pub boss_connections: Option<PathBuf>,
}

impl McpConfigPaths {
    /// The standard locations on this machine, plus `<project_root>/.mcp.json` when given.
    pub fn discover(project_root: Option<&Path>) -> Self {
        let home = dirs::home_dir();
        Self {
            claude_code: home.as_ref().map(|h| h.join(".claude.json")),
            project_mcp_json: project_root.map(|root| root.join(".mcp.json")),
            // `%APPDATA%` on Windows, `~/Library/Application Support` on macOS, `~/.config` on Linux.
            claude_desktop: dirs::config_dir().map(|dir| dir.join("Claude").join("claude_desktop_config.json")),
            codex: home.as_ref().map(|h| h.join(".codex").join("config.toml")),
            boss_connections: Some(boss_core::paths::user_data_dir().join("mcp-connections.json")),
        }
    }
}

/// Read every configured source and merge, de-duplicating by command line or URL.
/// Unreadable or malformed files contribute nothing; they never fail the load.
pub fn load_configs(paths: &McpConfigPaths) -> Vec<McpServerConfig> {
    let read = |path: &Option<PathBuf>| path.as_ref().and_then(|p| std::fs::read_to_string(p).ok());
    let mut all = Vec::new();
    if let Some(text) = read(&paths.claude_code) {
        all.extend(parse_claude_code(&text));
    }
    if let (Some(path), Some(text)) = (&paths.project_mcp_json, read(&paths.project_mcp_json)) {
        all.extend(parse_project_mcp_json(&text, path));
    }
    if let Some(text) = read(&paths.claude_desktop) {
        all.extend(parse_claude_desktop(&text));
    }
    if let Some(text) = read(&paths.codex) {
        all.extend(parse_codex_toml(&text));
    }
    if let Some(text) = read(&paths.boss_connections) {
        all.extend(parse_boss_connections(&text));
    }
    dedupe(all)
}

/// Drop later entries whose transport key repeats an earlier one.
pub fn dedupe(configs: Vec<McpServerConfig>) -> Vec<McpServerConfig> {
    let mut seen = HashSet::new();
    configs.into_iter().filter(|config| seen.insert(config.transport.key())).collect()
}

fn string_map(value: Option<&Value>) -> BTreeMap<String, String> {
    value
        .and_then(Value::as_object)
        .map(|map| map.iter().filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_owned()))).collect())
        .unwrap_or_default()
}

fn string_list(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items.iter().map(|item| item.as_str().map(str::to_owned).unwrap_or_else(|| item.to_string())).collect()
        })
        .unwrap_or_default()
}

/// One `mcpServers` map in the Claude Code / Claude Desktop shape.
/// `{ "type": "http"|"sse", "url", "headers" }` or `{ "command", "args", "env" }`.
fn servers_from_map(servers: Option<&Value>, source: McpConfigSource) -> Vec<McpServerConfig> {
    let Some(servers) = servers.and_then(Value::as_object) else { return Vec::new() };
    servers
        .iter()
        .filter_map(|(name, raw)| {
            let raw = raw.as_object()?;
            let kind = raw.get("type").and_then(Value::as_str);
            let url = raw.get("url").and_then(Value::as_str).filter(|u| !u.is_empty());
            let command = raw.get("command").and_then(Value::as_str).filter(|c| !c.is_empty());
            let transport = match (url, command) {
                (Some(url), _) if matches!(kind, Some("http" | "sse")) || command.is_none() => {
                    McpTransportConfig::Http { url: url.to_owned(), headers: string_map(raw.get("headers")) }
                }
                (_, Some(command)) => McpTransportConfig::Stdio {
                    command: command.to_owned(),
                    args: string_list(raw.get("args")),
                    env: string_map(raw.get("env")),
                },
                _ => return None,
            };
            Some(McpServerConfig { name: name.clone(), transport, enabled: true, source: source.clone(), slug: None })
        })
        .collect()
}

/// `~/.claude.json`: top-level `mcpServers` plus each project's `mcpServers`.
pub fn parse_claude_code(json: &str) -> Vec<McpServerConfig> {
    let Ok(root) = serde_json::from_str::<Value>(json) else { return Vec::new() };
    let mut out = servers_from_map(root.get("mcpServers"), McpConfigSource::ClaudeCodeUser);
    if let Some(projects) = root.get("projects").and_then(Value::as_object) {
        for (path, project) in projects {
            out.extend(servers_from_map(project.get("mcpServers"), McpConfigSource::ClaudeCodeProject(path.clone())));
        }
    }
    out
}

/// A project's `.mcp.json` (`{ "mcpServers": { ... } }`).
pub fn parse_project_mcp_json(json: &str, path: &Path) -> Vec<McpServerConfig> {
    let Ok(root) = serde_json::from_str::<Value>(json) else { return Vec::new() };
    servers_from_map(root.get("mcpServers"), McpConfigSource::ProjectMcpJson(path.to_path_buf()))
}

/// Claude Desktop's `claude_desktop_config.json` (`mcpServers`).
pub fn parse_claude_desktop(json: &str) -> Vec<McpServerConfig> {
    let Ok(root) = serde_json::from_str::<Value>(json) else { return Vec::new() };
    servers_from_map(root.get("mcpServers"), McpConfigSource::ClaudeDesktop)
}

/// BOSS's own `mcp-connections.json` (`{ "version": 1, "connections": [...] }`).
///
/// Secrets the Electron app encrypted with `safeStorage` cannot be read here,
/// so a connection with `secretsEncrypted: true` loses its env, headers, and
/// auth token; the user re-enters them. Plaintext secrets carry over, and an
/// auth token becomes the `Authorization` header as the TS hub did.
pub fn parse_boss_connections(json: &str) -> Vec<McpServerConfig> {
    let Ok(root) = serde_json::from_str::<Value>(json) else { return Vec::new() };
    if root.get("version").and_then(Value::as_u64) != Some(1) {
        return Vec::new();
    }
    let Some(connections) = root.get("connections").and_then(Value::as_array) else { return Vec::new() };
    connections
        .iter()
        .filter_map(|raw| {
            let raw = raw.as_object()?;
            let name = raw.get("name").and_then(Value::as_str)?.to_owned();
            let encrypted = raw.get("secretsEncrypted") == Some(&Value::Bool(true));
            let transport = match raw.get("transport").and_then(Value::as_str)? {
                "stdio" => McpTransportConfig::Stdio {
                    command: raw.get("command").and_then(Value::as_str)?.to_owned(),
                    args: string_list(raw.get("args")),
                    env: if encrypted { BTreeMap::new() } else { string_map(raw.get("env")) },
                },
                "http" => {
                    let mut headers = if encrypted { BTreeMap::new() } else { string_map(raw.get("headers")) };
                    if !encrypted
                        && let Some(token) = raw.get("authToken").and_then(Value::as_str).filter(|t| !t.is_empty())
                    {
                        let scheme = raw.get("authScheme").and_then(Value::as_str).map(str::trim).unwrap_or("");
                        let value = if scheme.is_empty() { token.to_owned() } else { format!("{scheme} {token}") };
                        headers.insert("Authorization".to_owned(), value);
                    }
                    McpTransportConfig::Http { url: raw.get("url").and_then(Value::as_str)?.to_owned(), headers }
                }
                _ => return None,
            };
            Some(McpServerConfig {
                name,
                transport,
                enabled: raw.get("enabled").and_then(Value::as_bool).unwrap_or(true),
                source: McpConfigSource::Boss,
                slug: raw.get("slug").and_then(Value::as_str).map(str::to_owned),
            })
        })
        .collect()
}

/// Codex's `config.toml`: `[mcp_servers.<name>]` tables with `command`/`args` or `url`.
/// A deliberately small reader — string and string-array values only — as in the TS.
pub fn parse_codex_toml(toml: &str) -> Vec<McpServerConfig> {
    struct Table {
        name: String,
        values: BTreeMap<String, Value>,
    }
    let mut tables: Vec<Table> = Vec::new();
    let mut in_server_table = false;
    for raw_line in toml.lines() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some(header) = line.strip_prefix('[').and_then(|l| l.strip_suffix(']')) {
            match header.trim().strip_prefix("mcp_servers.") {
                Some(name) => {
                    tables.push(Table { name: name.trim_matches('"').to_owned(), values: BTreeMap::new() });
                    in_server_table = true;
                }
                None => in_server_table = false,
            }
            continue;
        }
        if !in_server_table {
            continue;
        }
        let Some((key, raw_value)) = line.split_once('=') else { continue };
        let key = key.trim();
        if key.is_empty() || !key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
            continue;
        }
        let raw_value = raw_value.trim();
        let value = if raw_value.starts_with('[') {
            Value::Array(quoted_strings(raw_value).into_iter().map(Value::String).collect())
        } else if raw_value.starts_with('"') {
            Value::String(quoted_strings(raw_value).into_iter().next().unwrap_or_default())
        } else {
            Value::String(raw_value.to_owned())
        };
        if let Some(table) = tables.last_mut() {
            table.values.insert(key.to_owned(), value);
        }
    }
    tables
        .into_iter()
        .filter_map(|table| {
            let url = table.values.get("url").and_then(Value::as_str).filter(|u| !u.is_empty());
            let transport = if let Some(url) = url {
                McpTransportConfig::Http { url: url.to_owned(), headers: BTreeMap::new() }
            } else {
                McpTransportConfig::Stdio {
                    command: table.values.get("command").and_then(Value::as_str)?.to_owned(),
                    args: string_list(table.values.get("args")),
                    env: BTreeMap::new(),
                }
            };
            Some(McpServerConfig { name: table.name, transport, enabled: true, source: McpConfigSource::Codex, slug: None })
        })
        .collect()
}

/// Every `"..."` literal in a TOML value, with `\"` and `\\` unescaped.
fn quoted_strings(raw: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut chars = raw.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '"' {
            continue;
        }
        let mut current = String::new();
        loop {
            match chars.next() {
                None | Some('"') => break,
                Some('\\') => {
                    if let Some(next) = chars.next() {
                        current.push(next);
                    }
                }
                Some(other) => current.push(other),
            }
        }
        out.push(current);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stdio(config: &McpServerConfig) -> (&str, &[String], &BTreeMap<String, String>) {
        match &config.transport {
            McpTransportConfig::Stdio { command, args, env } => (command, args, env),
            other => panic!("expected stdio, got {other:?}"),
        }
    }

    fn http(config: &McpServerConfig) -> (&str, &BTreeMap<String, String>) {
        match &config.transport {
            McpTransportConfig::Http { url, headers } => (url, headers),
            other => panic!("expected http, got {other:?}"),
        }
    }

    const CLAUDE_CODE: &str = r#"{
      "numStartups": 4,
      "mcpServers": {
        "context7": { "type": "http", "url": "https://mcp.context7.com/mcp", "headers": { "X-Key": "k" } },
        "fs": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"], "env": { "A": "1" } },
        "broken": { "type": "stdio" }
      },
      "projects": {
        "/Users/me/proj": {
          "allowedTools": [],
          "mcpServers": {
            "local": { "command": "./bin/mcp", "args": ["--port", 8080] },
            "sse-legacy": { "type": "sse", "url": "http://localhost:3000/sse" }
          }
        },
        "/Users/me/other": { "mcpServers": {} }
      }
    }"#;

    #[test]
    fn claude_code_user_and_project_servers() {
        let configs = parse_claude_code(CLAUDE_CODE);
        assert_eq!(configs.len(), 4, "{configs:#?}");
        let ctx = configs.iter().find(|c| c.name == "context7").unwrap();
        assert_eq!(ctx.source, McpConfigSource::ClaudeCodeUser);
        let (url, headers) = http(ctx);
        assert_eq!(url, "https://mcp.context7.com/mcp");
        assert_eq!(headers.get("X-Key").map(String::as_str), Some("k"));
        let fs = configs.iter().find(|c| c.name == "fs").unwrap();
        let (command, args, env) = stdio(fs);
        assert_eq!(command, "npx");
        assert_eq!(args.len(), 3);
        assert_eq!(env.get("A").map(String::as_str), Some("1"));
        let local = configs.iter().find(|c| c.name == "local").unwrap();
        assert_eq!(local.source, McpConfigSource::ClaudeCodeProject("/Users/me/proj".into()));
        assert_eq!(stdio(local).1, &["--port".to_owned(), "8080".to_owned()]);
        let sse = configs.iter().find(|c| c.name == "sse-legacy").unwrap();
        assert_eq!(http(sse).0, "http://localhost:3000/sse");
        assert!(configs.iter().all(|c| c.enabled && c.slug.is_none()));
    }

    #[test]
    fn project_mcp_json() {
        let path = Path::new("/repo/.mcp.json");
        let configs = parse_project_mcp_json(
            r#"{ "mcpServers": { "gh": { "command": "gh-mcp", "args": [] }, "api": { "url": "https://x/mcp" } } }"#,
            path,
        );
        assert_eq!(configs.len(), 2);
        assert!(configs.iter().all(|c| c.source == McpConfigSource::ProjectMcpJson(path.to_path_buf())));
        assert_eq!(http(configs.iter().find(|c| c.name == "api").unwrap()).0, "https://x/mcp");
        assert!(parse_project_mcp_json("not json", path).is_empty());
        assert!(parse_project_mcp_json("{}", path).is_empty());
    }

    #[test]
    fn claude_desktop() {
        let configs = parse_claude_desktop(
            r#"{ "mcpServers": { "puppeteer": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-puppeteer"] } } }"#,
        );
        assert_eq!(configs.len(), 1);
        assert_eq!(configs[0].source, McpConfigSource::ClaudeDesktop);
        assert_eq!(configs[0].source.to_string(), "Claude Desktop");
        assert_eq!(stdio(&configs[0]).0, "npx");
    }

    #[test]
    fn boss_connections_keep_slug_and_enabled_and_plaintext_secrets() {
        let configs = parse_boss_connections(
            r#"{ "version": 1, "connections": [
              { "id": "1", "slug": "datadog", "name": "Datadog", "transport": "http", "url": "https://dd/mcp",
                "authToken": "tok", "authScheme": "Bearer", "headers": { "X-Org": "acme" }, "enabled": true,
                "createdAt": 1, "secretsEncrypted": false },
              { "id": "2", "slug": "slack", "name": "Slack", "transport": "http", "url": "https://slack/mcp",
                "authToken": "Y2lwaGVy", "headers": { "X-Secret": "Y2lwaGVy" }, "enabled": false,
                "createdAt": 2, "secretsEncrypted": true },
              { "id": "3", "slug": "local", "name": "Local", "transport": "stdio", "command": "node", "args": ["s.js"],
                "env": { "TOKEN": "plain" }, "enabled": true, "createdAt": 3, "secretsEncrypted": false },
              { "id": "4", "slug": "bare", "name": "Bare", "transport": "http", "url": "https://bare/mcp",
                "authToken": "raw", "authScheme": "", "enabled": true, "createdAt": 4, "secretsEncrypted": false }
            ] }"#,
        );
        assert_eq!(configs.len(), 4);
        let dd = &configs[0];
        assert_eq!(dd.slug.as_deref(), Some("datadog"));
        assert_eq!(dd.source, McpConfigSource::Boss);
        let (_, headers) = http(dd);
        assert_eq!(headers.get("Authorization").map(String::as_str), Some("Bearer tok"));
        assert_eq!(headers.get("X-Org").map(String::as_str), Some("acme"));
        let slack = &configs[1];
        assert!(!slack.enabled);
        assert!(http(slack).1.is_empty(), "encrypted secrets are dropped, not forwarded as ciphertext");
        let local = &configs[2];
        assert_eq!(stdio(local).2.get("TOKEN").map(String::as_str), Some("plain"));
        assert_eq!(http(&configs[3]).1.get("Authorization").map(String::as_str), Some("raw"));
        assert!(parse_boss_connections(r#"{ "version": 2, "connections": [] }"#).is_empty());
    }

    #[test]
    fn codex_toml() {
        let configs = parse_codex_toml(
            r#"
model = "o3"

[mcp_servers.github]
command = "npx"
args = ["-y", "@modelcontextprotocol/server-github"]
env = { GITHUB_TOKEN = "x" }

[mcp_servers."with space"]
url = "https://remote/mcp"

[other]
command = "ignored"

[mcp_servers.empty]
timeout = 5
"#,
        );
        assert_eq!(configs.len(), 2, "{configs:#?}");
        assert_eq!(configs[0].name, "github");
        assert_eq!(configs[0].source, McpConfigSource::Codex);
        let (command, args, _) = stdio(&configs[0]);
        assert_eq!(command, "npx");
        assert_eq!(args, &["-y".to_owned(), "@modelcontextprotocol/server-github".to_owned()]);
        assert_eq!(configs[1].name, "with space");
        assert_eq!(http(&configs[1]).0, "https://remote/mcp");
    }

    #[test]
    fn load_merges_all_sources_and_dedupes_by_transport() {
        let dir = tempfile::tempdir().unwrap();
        let write = |name: &str, text: &str| {
            let path = dir.path().join(name);
            std::fs::write(&path, text).unwrap();
            path
        };
        let paths = McpConfigPaths {
            claude_code: Some(write(
                "claude.json",
                r#"{ "mcpServers": { "shared": { "command": "npx", "args": ["shared"] } } }"#,
            )),
            project_mcp_json: Some(write(
                ".mcp.json",
                r#"{ "mcpServers": { "shared-again": { "command": "npx", "args": ["shared"] }, "proj": { "url": "http://p/mcp" } } }"#,
            )),
            claude_desktop: Some(write("desktop.json", r#"{ "mcpServers": { "desk": { "command": "desk" } } }"#)),
            codex: Some(write("config.toml", "[mcp_servers.cx]\nurl = \"http://p/mcp\"\n")),
            boss_connections: Some(write(
                "mcp-connections.json",
                r#"{ "version": 1, "connections": [ { "slug": "own", "name": "Own", "transport": "stdio", "command": "own", "enabled": true, "secretsEncrypted": false } ] }"#,
            )),
        };
        let configs = load_configs(&paths);
        let names: Vec<&str> = configs.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, vec!["shared", "proj", "desk", "Own"]);
        assert_eq!(configs[0].source, McpConfigSource::ClaudeCodeUser);
        assert_eq!(configs[3].slug.as_deref(), Some("own"));
    }

    #[test]
    fn missing_files_load_nothing() {
        let paths = McpConfigPaths {
            claude_code: Some(PathBuf::from("/definitely/not/here.json")),
            ..McpConfigPaths::default()
        };
        assert!(load_configs(&paths).is_empty());
        assert!(load_configs(&McpConfigPaths::default()).is_empty());
    }

    #[test]
    fn discover_fills_standard_paths() {
        let paths = McpConfigPaths::discover(Some(Path::new("/repo")));
        assert_eq!(paths.project_mcp_json, Some(PathBuf::from("/repo/.mcp.json")));
        assert!(paths.claude_code.unwrap().ends_with(".claude.json"));
        assert!(paths.claude_desktop.unwrap().ends_with("Claude/claude_desktop_config.json"));
        assert!(paths.codex.unwrap().ends_with(".codex/config.toml"));
        assert!(paths.boss_connections.unwrap().ends_with("mcp-connections.json"));
    }
}
