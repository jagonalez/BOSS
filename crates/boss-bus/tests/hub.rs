//! The MCP hub end to end: a stdio server (a Python one-liner), a streamable
//! HTTP server (in-process axum, JSON and SSE replies, session header), and
//! the hub's aggregation and routing over a fake transport.

use async_trait::async_trait;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use boss_bus::hub::{JsonRpcResponse, McpToolDefinition};
use boss_bus::{
    McpClient, McpConfigSource, McpHub, McpServerConfig, McpServerState, McpTransport, McpTransportConfig, MCP_TOOL_PREFIX,
};
use boss_core::BusContent;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

/// A stdio MCP server: answers initialize, tools/list, tools/call, and echoes arguments.
const PYTHON_SERVER: &str = r#"
import sys, json
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    msg = json.loads(line)
    if 'id' not in msg:
        continue
    m = msg['method']
    if m == 'initialize':
        r = {'protocolVersion': msg['params']['protocolVersion'], 'capabilities': {'tools': {}}, 'serverInfo': {'name': 'py', 'version': '1'}, 'instructions': '  Use echo wisely.  '}
    elif m == 'tools/list':
        r = {'tools': [{'name': 'echo', 'description': 'Echo args', 'inputSchema': {'type': 'object', 'properties': {'text': {'type': 'string'}}}}]}
    elif m == 'tools/call':
        a = msg['params']['arguments']
        if msg['params']['name'] == 'echo':
            r = {'content': [{'type': 'text', 'text': 'echo:' + json.dumps(a, sort_keys=True)}]}
        else:
            sys.stdout.write(json.dumps({'jsonrpc': '2.0', 'id': msg['id'], 'error': {'code': -32602, 'message': 'no such tool'}}) + '\n')
            sys.stdout.flush()
            continue
    else:
        sys.stdout.write(json.dumps({'jsonrpc': '2.0', 'id': msg['id'], 'error': {'code': -32601, 'message': 'Method not found'}}) + '\n')
        sys.stdout.flush()
        continue
    sys.stdout.write('this line is not json and must be skipped\n')
    sys.stdout.write(json.dumps({'jsonrpc': '2.0', 'id': msg['id'], 'result': r}) + '\n')
    sys.stdout.flush()
"#;

fn python_available() -> bool {
    std::process::Command::new("python3").arg("--version").output().map(|o| o.status.success()).unwrap_or(false)
}

#[tokio::test]
async fn stdio_transport_speaks_jsonl_to_a_child_process() {
    if !python_available() {
        eprintln!("python3 not found; skipping stdio transport test");
        return;
    }
    let client = McpClient::stdio("python3", vec!["-c".into(), PYTHON_SERVER.into()], HashMap::new());
    assert_eq!(client.initialize().await.unwrap().as_deref(), Some("Use echo wisely."));
    let tools = client.list_tools().await.unwrap();
    assert_eq!(tools.len(), 1);
    assert_eq!(tools[0].name, "echo");
    assert_eq!(tools[0].input_schema.as_ref().unwrap()["type"], "object");

    let result = client.call_tool("echo", json!({ "text": "hi", "n": 2 })).await.unwrap();
    assert!(!result.is_error);
    assert_eq!(result.content[0]["text"], "echo:{\"n\": 2, \"text\": \"hi\"}");

    let result = client.call_tool("echo", Value::Null).await.unwrap();
    assert_eq!(result.content[0]["text"], "echo:{}");

    let error = client.call_tool("missing", json!({})).await.unwrap_err();
    assert_eq!(error.to_string(), "no such tool");

    client.close().await;
    let error = client.call_tool("echo", json!({})).await.unwrap_err();
    assert!(error.to_string().contains("closing"), "{error}");
}

#[tokio::test]
async fn stdio_transport_reports_a_missing_command() {
    let client = McpClient::stdio("/definitely/not/a/real/binary", vec![], HashMap::new());
    let error = client.initialize().await.unwrap_err();
    assert!(error.to_string().contains("could not start MCP server"), "{error}");
}

#[tokio::test]
async fn stdio_transport_reports_a_server_that_exits() {
    if !python_available() {
        return;
    }
    let client = McpClient::stdio("python3", vec!["-c".into(), "import sys; sys.stdin.readline()".into()], HashMap::new());
    let error = client.initialize().await.unwrap_err();
    assert_eq!(error.to_string(), "The MCP server process exited.");
}

// --- streamable HTTP -------------------------------------------------------

#[derive(Default)]
struct HttpServerState {
    /// Every request's headers and body, for assertions.
    seen: Mutex<Vec<(HeaderMap, Value)>>,
    /// Alternate JSON and SSE responses to prove both are read.
    counter: AtomicUsize,
}

async fn fake_http_mcp(State(state): State<Arc<HttpServerState>>, headers: HeaderMap, Json(body): Json<Value>) -> Response {
    state.seen.lock().unwrap().push((headers.clone(), body.clone()));
    if headers.get("x-api-key").and_then(|v| v.to_str().ok()) != Some("secret") {
        return (StatusCode::UNAUTHORIZED, "who are you").into_response();
    }
    let Some(id) = body.get("id").cloned() else {
        return StatusCode::ACCEPTED.into_response();
    };
    let result = match body["method"].as_str().unwrap() {
        "initialize" => json!({ "protocolVersion": "2025-06-18", "capabilities": {}, "serverInfo": { "name": "h", "version": "1" } }),
        "tools/list" => json!({ "tools": [{ "name": "shout", "description": "Loud" }, { "name": "pic" }] }),
        "tools/call" if body["params"]["name"] == "explode" => {
            return Json(json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32602, "message": "explode is not a tool" } })).into_response();
        }
        "tools/call" if body["params"]["name"] == "pic" => json!({
            "content": [{ "type": "image", "data": "QUJD", "mimeType": "image/png" }]
        }),
        "tools/call" => json!({ "content": [{ "type": "text", "text": body["params"]["arguments"]["text"].as_str().unwrap_or("").to_uppercase() }] }),
        _ => return Json(json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": "nope" } })).into_response(),
    };
    let message = json!({ "jsonrpc": "2.0", "id": id, "result": result });
    let n = state.counter.fetch_add(1, Ordering::SeqCst);
    let mut response = if n % 2 == 0 {
        Json(message).into_response()
    } else {
        // A stream carrying an unrelated event, a keepalive, then the reply split over two data lines.
        let text = message.to_string();
        let (a, b) = text.split_at(text.len() / 2);
        let body = format!("event: message\ndata: {{\"jsonrpc\":\"2.0\",\"method\":\"notifications/progress\"}}\n\n: ping\n\ndata: {a}\ndata: {b}\n\n");
        ([(axum::http::header::CONTENT_TYPE, "text/event-stream")], body).into_response()
    };
    response.headers_mut().insert("mcp-session-id", "sess-42".parse().unwrap());
    response
}

async fn start_fake_http() -> (String, Arc<HttpServerState>) {
    let state = Arc::new(HttpServerState::default());
    let app = Router::new().route("/mcp", post(fake_http_mcp)).with_state(state.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/mcp", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (url, state)
}

#[tokio::test]
async fn http_transport_reads_json_and_sse_and_tracks_the_session() {
    let (url, state) = start_fake_http().await;
    let client = McpClient::http(&url, HashMap::from([("x-api-key".to_owned(), "secret".to_owned())]));
    assert_eq!(client.initialize().await.unwrap(), None);
    let tools = client.list_tools().await.unwrap();
    assert_eq!(tools.iter().map(|t| t.name.as_str()).collect::<Vec<_>>(), vec!["shout", "pic"]);
    let result = client.call_tool("shout", json!({ "text": "quiet" })).await.unwrap();
    assert_eq!(result.content[0]["text"], "QUIET");
    let result = client.call_tool("shout", json!({ "text": "again" })).await.unwrap();
    assert_eq!(result.content[0]["text"], "AGAIN");

    client.close().await;
    let seen = state.seen.lock().unwrap();
    // initialize, notifications/initialized, tools/list, tools/call x2
    assert_eq!(seen.len(), 5);
    assert_eq!(seen[1].1["method"], "notifications/initialized");
    assert!(seen[0].0.get("mcp-session-id").is_none(), "no session before the first reply");
    for (headers, _) in &seen[1..] {
        assert_eq!(headers["mcp-session-id"], "sess-42");
        assert_eq!(headers["mcp-protocol-version"], "2025-06-18");
        assert!(headers["accept"].to_str().unwrap().contains("text/event-stream"));
    }
}

#[tokio::test]
async fn http_transport_surfaces_status_and_rpc_errors() {
    let (url, _state) = start_fake_http().await;
    let client = McpClient::http(&url, HashMap::new());
    let error = client.initialize().await.unwrap_err();
    assert_eq!(error.to_string(), "The MCP server answered 401. who are you");

    let client = McpClient::http(&url, HashMap::from([("x-api-key".to_owned(), "secret".to_owned())]));
    client.initialize().await.unwrap();
    let error = client.call_tool("explode", json!({})).await.unwrap_err();
    assert_eq!(error.to_string(), "explode is not a tool", "a JSON-RPC error becomes an Err");

    let dead = McpClient::http("http://127.0.0.1:1/mcp", HashMap::new());
    let error = dead.initialize().await.unwrap_err();
    assert!(error.to_string().contains("could not be reached"), "{error}");
}

// --- hub -------------------------------------------------------------------

/// Tool calls a fake transport received: (tool name, arguments).
type Calls = Arc<Mutex<Vec<(String, Value)>>>;

/// Answers from a script; records calls.
struct FakeTransport {
    instructions: Option<&'static str>,
    tools: Vec<McpToolDefinition>,
    fail_initialize: bool,
    calls: Calls,
    call_result: Value,
}

#[async_trait]
impl McpTransport for FakeTransport {
    async fn request(&self, method: &str, params: Option<Value>) -> anyhow::Result<JsonRpcResponse> {
        let result = match method {
            "initialize" if self.fail_initialize => return Err(anyhow::anyhow!("handshake refused")),
            "initialize" => json!({ "protocolVersion": "2025-06-18", "instructions": self.instructions }),
            "tools/list" => json!({ "tools": self.tools.iter().map(|t| json!({ "name": t.name, "description": t.description, "inputSchema": t.input_schema })).collect::<Vec<_>>() }),
            "tools/call" => {
                let params = params.unwrap();
                self.calls.lock().unwrap().push((params["name"].as_str().unwrap().to_owned(), params["arguments"].clone()));
                self.call_result.clone()
            }
            _ => unreachable!(),
        };
        Ok(JsonRpcResponse { id: Some(json!(1)), result: Some(result), error: None })
    }
    async fn notify(&self, _method: &str) -> anyhow::Result<()> {
        Ok(())
    }
    async fn close(&self) {}
}

fn config(name: &str, enabled: bool) -> McpServerConfig {
    McpServerConfig {
        name: name.to_owned(),
        transport: McpTransportConfig::Http { url: format!("http://{name}/mcp"), headers: BTreeMap::new() },
        enabled,
        source: McpConfigSource::ClaudeCodeUser,
        slug: None,
    }
}

fn tool(name: &str, description: Option<&str>) -> McpToolDefinition {
    McpToolDefinition { name: name.into(), description: description.map(str::to_owned), input_schema: None }
}

fn fake(tools: Vec<McpToolDefinition>, instructions: Option<&'static str>, result: Value) -> (McpClient, Calls) {
    let calls = Arc::new(Mutex::new(Vec::new()));
    let transport = FakeTransport { instructions, tools, fail_initialize: false, calls: calls.clone(), call_result: result };
    (McpClient::from_transport(Box::new(transport)), calls)
}

#[tokio::test]
async fn hub_aggregates_tools_routes_calls_and_reports_status() {
    let hub = McpHub::new();
    let (datadog, dd_calls) = fake(
        vec![tool("search_logs", Some("Search logs")), tool("get_monitor", None)],
        Some("Query Datadog carefully."),
        json!({ "content": [{ "type": "text", "text": "3 logs" }] }),
    );
    let status = hub.connect_with_client(config("Datadog MCP", true), datadog).await;
    assert_eq!(status.state, McpServerState::Connected);
    assert_eq!(status.slug, "datadog_mcp");
    assert_eq!(status.tools, vec!["search_logs", "get_monitor"]);

    let (slack, _) = fake(vec![tool("send", Some("Send a message"))], None, json!({ "content": [] }));
    let mut slack_config = config("Slack", true);
    slack_config.slug = Some("team_slack".into());
    hub.connect_with_client(slack_config, slack).await;

    let failing = McpClient::from_transport(Box::new(FakeTransport {
        instructions: None,
        tools: vec![],
        fail_initialize: true,
        calls: Arc::default(),
        call_result: Value::Null,
    }));
    let status = hub.connect_with_client(config("Broken", true), failing).await;
    assert_eq!(status.state, McpServerState::Error { message: "handshake refused".into() });

    let status = hub.connect(config("Off", false)).await;
    assert_eq!(status.state, McpServerState::Disabled);

    let names = hub.tool_names().await;
    assert_eq!(names, vec!["mcp_datadog_mcp_search_logs", "mcp_datadog_mcp_get_monitor", "mcp_team_slack_send"]);
    let defs = hub.tool_definitions().await;
    assert_eq!(defs[0].description, "[Datadog MCP] Search logs");
    assert_eq!(defs[1].description, "[Datadog MCP] get_monitor");
    assert_eq!(defs[1].input_schema, json!({ "type": "object", "additionalProperties": true }));
    assert!(names.iter().all(|n| n.starts_with(MCP_TOOL_PREFIX)));

    let result = hub.call_tool("mcp_datadog_mcp_search_logs", json!({ "query": "error" })).await;
    assert_eq!(result.content, vec![BusContent::Text { text: "3 logs".into() }]);
    assert!(!result.is_error);
    assert_eq!(dd_calls.lock().unwrap()[0], ("search_logs".to_owned(), json!({ "query": "error" })));

    let result = hub.call_tool("mcp_team_slack_send", json!({})).await;
    assert_eq!(result.content, vec![BusContent::Text { text: "(empty result)".into() }]);

    let result = hub.call_tool("mcp_datadog_mcp_nope", json!({})).await;
    assert!(result.is_error);
    assert!(result.content[0] == BusContent::Text { text: "Unknown MCP tool: mcp_datadog_mcp_nope. Use boss_mcp_list to see available tools.".into() });
    let result = hub.call_tool("boss_threads_list", json!({})).await;
    assert!(result.is_error);

    assert_eq!(hub.instructions_summary().await, "## Datadog MCP (tools mcp_datadog_mcp_*)\nQuery Datadog carefully.");

    let listing = hub.listing(None).await;
    assert_eq!(listing.as_array().unwrap().len(), 2, "only connected servers are listed");
    assert_eq!(listing[0]["tools"][0]["tool"], "mcp_datadog_mcp_search_logs");
    let one = hub.listing(Some("mcp_team_slack_send")).await;
    assert_eq!(one["connection"], "Slack");
    assert_eq!(one["inputSchema"]["type"], "object");
    assert!(hub.listing(Some("mcp_zzz_x")).await.get("error").is_some());

    let statuses = hub.statuses().await;
    assert_eq!(statuses.len(), 4);
    assert_eq!(statuses.iter().map(|s| s.slug.as_str()).collect::<Vec<_>>(), vec!["datadog_mcp", "team_slack", "broken", "off"]);
    assert_eq!(statuses[3].source, "Claude Code (user)");

    hub.disconnect("datadog_mcp").await;
    assert_eq!(hub.status_of("datadog_mcp").await.unwrap().state, McpServerState::Disabled);
    assert_eq!(hub.tool_names().await, vec!["mcp_team_slack_send"]);
    hub.remove("team_slack").await;
    assert!(hub.status_of("team_slack").await.is_none());
    assert!(hub.tool_names().await.is_empty());
}

#[tokio::test]
async fn hub_gives_same_named_servers_distinct_slugs_and_converts_images() {
    let hub = McpHub::new();
    let image = json!({ "content": [{ "type": "text", "text": "here" }, { "type": "image", "data": "QUJD", "mimeType": "image/png" }] });
    let (a, _) = fake(vec![tool("shot", None)], None, image.clone());
    let (b, _) = fake(vec![tool("shot", None)], None, json!({ "content": [{ "type": "text", "text": "bad" }], "isError": true }));
    let first = hub.connect_with_client(config("Browser", true), a).await;
    let mut second_config = config("Browser!", true);
    second_config.transport = McpTransportConfig::Http { url: "http://other/mcp".into(), headers: BTreeMap::new() };
    let second = hub.connect_with_client(second_config, b).await;
    assert_eq!(first.slug, "browser");
    assert_eq!(second.slug, "browser_2");

    let result = hub.call_tool("mcp_browser_shot", json!({})).await;
    assert_eq!(result.content.len(), 2);
    assert_eq!(result.content[1], BusContent::Image { data: "QUJD".into(), mime_type: "image/png".into() });

    let result = hub.call_tool("mcp_browser_2_shot", json!({})).await;
    assert!(result.is_error);
    assert_eq!(result.content[0], BusContent::Text { text: "bad".into() });
}

#[tokio::test]
async fn hub_connect_all_uses_real_transports_and_reports_failures() {
    let (url, _state) = start_fake_http().await;
    let hub = McpHub::new();
    let good = McpServerConfig {
        name: "Good".into(),
        transport: McpTransportConfig::Http {
            url: url.clone(),
            headers: BTreeMap::from([("x-api-key".to_owned(), "secret".to_owned())]),
        },
        enabled: true,
        source: McpConfigSource::ClaudeDesktop,
        slug: None,
    };
    let unauthorized = McpServerConfig {
        name: "Unauthorized".into(),
        transport: McpTransportConfig::Http { url, headers: BTreeMap::new() },
        enabled: true,
        source: McpConfigSource::Boss,
        slug: None,
    };
    let statuses = hub.connect_all(vec![good, unauthorized]).await;
    assert_eq!(statuses[0].state, McpServerState::Connected);
    assert_eq!(statuses[0].tools, vec!["shout", "pic"]);
    assert_eq!(statuses[1].state, McpServerState::Error { message: "The MCP server answered 401. who are you".into() });

    let result = hub.call_tool("mcp_good_shout", json!({ "text": "hey" })).await;
    assert_eq!(result.content, vec![BusContent::Text { text: "HEY".into() }]);
    let result = hub.call_tool("mcp_good_pic", json!({})).await;
    assert_eq!(result.content[0], BusContent::Text { text: "(image result)".into() });
    assert!(matches!(&result.content[1], BusContent::Image { mime_type, .. } if mime_type == "image/png"));
    hub.close_all().await;
    assert!(hub.tool_names().await.is_empty());
}
