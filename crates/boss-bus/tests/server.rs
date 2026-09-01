//! The bus server as an MCP client sees it: handshake, listing, calls, and
//! the doors that must stay shut.

use async_trait::async_trait;
use boss_bus::{tool_definitions, BusServer, QA_GUIDANCE};
use boss_core::{BusCaller, BusHandler, BusTool, BusToolResult, ParticipantId, ThreadId};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};

/// Records calls and answers with canned results.
#[derive(Default)]
struct FakeHandler {
    calls: Mutex<Vec<(BusCaller, String, Value)>>,
}

#[async_trait]
impl BusHandler for FakeHandler {
    async fn list_tools(&self, caller: &BusCaller) -> Vec<BusTool> {
        // The handler decides what each caller sees: this one hides workflows from "who_limited".
        tool_definitions()
            .into_iter()
            .filter(|t| caller.participant_id.as_str() != "who_limited" || !t.name.starts_with("boss_workflow_"))
            .collect()
    }

    async fn call_tool(&self, caller: &BusCaller, name: &str, args: Value) -> BusToolResult {
        self.calls.lock().unwrap().push((caller.clone(), name.to_owned(), args.clone()));
        match name {
            "boss_threads_list" => BusToolResult::text(json!([{ "id": "thr_other", "title": "Other", "busy": false }]).to_string()),
            "boss_threads_use_worktree" => BusToolResult::text("Moved onto a worktree.\nEdit there from your next message."),
            "boss_browser_screenshot" => BusToolResult {
                content: vec![
                    boss_core::BusContent::Text { text: "Screenshot of tab 1".into() },
                    boss_core::BusContent::Image { data: "iVBORw0KGgo=".into(), mime_type: "image/png".into() },
                ],
                is_error: false,
            },
            _ => BusToolResult::error(format!("Unknown BOSS thread tool: {name}.")),
        }
    }
}

struct Harness {
    server: BusServer,
    handler: Arc<FakeHandler>,
    http: reqwest::Client,
    token: String,
}

impl Harness {
    async fn start() -> Self {
        let handler = Arc::new(FakeHandler::default());
        let server = BusServer::start(handler.clone(), [3u8; 32]).await.expect("server starts");
        let token = server.tokens().issue(&ThreadId::from_raw("thr_1"), &ParticipantId::from_raw("who_1"));
        Self { server, handler, http: reqwest::Client::new(), token }
    }

    fn post(&self, body: Value) -> reqwest::RequestBuilder {
        self.http.post(self.server.mcp_url()).bearer_auth(&self.token).json(&body)
    }

    async fn rpc(&self, id: u64, method: &str, params: Value) -> Value {
        let response = self.post(json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })).send().await.unwrap();
        assert_eq!(response.status(), 200, "{method}");
        assert!(response.headers()["content-type"].to_str().unwrap().starts_with("application/json"));
        response.json().await.unwrap()
    }
}

#[tokio::test]
async fn url_is_loopback_and_initialize_negotiates() {
    let h = Harness::start().await;
    assert!(h.server.url().starts_with("http://127.0.0.1:"));

    let reply = h.rpc(1, "initialize", json!({ "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": { "name": "t", "version": "0" } })).await;
    assert_eq!(reply["jsonrpc"], "2.0");
    assert_eq!(reply["id"], 1);
    assert_eq!(reply["result"]["protocolVersion"], "2025-06-18");
    assert_eq!(reply["result"]["capabilities"]["tools"]["listChanged"], false);
    assert_eq!(reply["result"]["serverInfo"]["name"], "boss-agent-tools");
    assert_eq!(reply["result"]["instructions"], QA_GUIDANCE);
    assert!(reply.get("error").is_none());

    let legacy = h.rpc(2, "initialize", json!({ "protocolVersion": "2025-03-26" })).await;
    assert_eq!(legacy["result"]["protocolVersion"], "2025-03-26");
    let unknown = h.rpc(3, "initialize", json!({ "protocolVersion": "1999-01-01" })).await;
    assert_eq!(unknown["result"]["protocolVersion"], "2025-06-18");

    // The initialized notification has no id and gets an empty 202.
    let response = h.post(json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })).send().await.unwrap();
    assert_eq!(response.status(), 202);
    assert!(response.bytes().await.unwrap().is_empty());

    let ping = h.rpc(4, "ping", json!({})).await;
    assert_eq!(ping["result"], json!({}));
    h.server.stop().await;
}

#[tokio::test]
async fn tools_list_reflects_the_handler_and_marks_read_only_tools() {
    let h = Harness::start().await;
    let reply = h.rpc(5, "tools/list", json!({})).await;
    let tools = reply["result"]["tools"].as_array().unwrap();
    assert_eq!(tools.len(), tool_definitions().len());
    let list = tools.iter().find(|t| t["name"] == "boss_threads_list").unwrap();
    assert_eq!(list["annotations"]["readOnlyHint"], true);
    assert_eq!(list["inputSchema"]["type"], "object");
    assert!(list["description"].as_str().unwrap().starts_with("Find the other threads"));
    let send = tools.iter().find(|t| t["name"] == "boss_threads_send").unwrap();
    assert!(send.get("annotations").is_none());
    assert_eq!(send["inputSchema"]["required"], json!(["threadId", "message"]));

    // A different participant gets the handler's view for that caller.
    let limited = h.server.tokens().issue(&ThreadId::from_raw("thr_1"), &ParticipantId::from_raw("who_limited"));
    let reply: Value = h
        .http
        .post(h.server.mcp_url())
        .bearer_auth(limited)
        .json(&json!({ "jsonrpc": "2.0", "id": 6, "method": "tools/list" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let names: Vec<&str> = reply["result"]["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
    assert!(!names.iter().any(|n| n.starts_with("boss_workflow_")));
    assert!(names.contains(&"boss_threads_list"));
}

#[tokio::test]
async fn tools_call_routes_to_the_handler_with_the_caller() {
    let h = Harness::start().await;
    let reply = h.rpc(7, "tools/call", json!({ "name": "boss_threads_list", "arguments": {} })).await;
    assert_eq!(reply["result"]["isError"], false);
    assert_eq!(reply["result"]["content"][0]["type"], "text");
    let text: Value = serde_json::from_str(reply["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(text[0]["id"], "thr_other");

    // Arguments default to {} when omitted or null.
    h.rpc(8, "tools/call", json!({ "name": "boss_threads_list" })).await;
    h.rpc(9, "tools/call", json!({ "name": "boss_threads_list", "arguments": null })).await;

    let calls = h.handler.calls.lock().unwrap();
    assert_eq!(calls.len(), 3);
    assert_eq!(calls[0].0, BusCaller { thread_id: "thr_1".into(), participant_id: "who_1".into() });
    assert_eq!(calls[0].1, "boss_threads_list");
    assert_eq!(calls[1].2, json!({}));
    assert_eq!(calls[2].2, json!({}));
}

#[tokio::test]
async fn tools_call_carries_images_and_errors_in_mcp_shape() {
    let h = Harness::start().await;
    let reply = h.rpc(10, "tools/call", json!({ "name": "boss_browser_screenshot", "arguments": { "tabId": "1" } })).await;
    let content = reply["result"]["content"].as_array().unwrap();
    assert_eq!(content[0], json!({ "type": "text", "text": "Screenshot of tab 1" }));
    assert_eq!(content[1], json!({ "type": "image", "mimeType": "image/png", "data": "iVBORw0KGgo=" }));

    let reply = h.rpc(11, "tools/call", json!({ "name": "boss_nope", "arguments": {} })).await;
    assert_eq!(reply["result"]["isError"], true);
    assert_eq!(reply["result"]["content"][0]["text"], "Unknown BOSS thread tool: boss_nope.");
    assert!(reply.get("error").is_none(), "tool failures are results, not JSON-RPC errors");

    let reply = h.rpc(12, "tools/call", json!({ "arguments": {} })).await;
    assert_eq!(reply["result"]["isError"], true);
}

#[tokio::test]
async fn json_rpc_errors_have_the_expected_shapes() {
    let h = Harness::start().await;
    let reply = h.rpc(13, "resources/list", json!({})).await;
    assert_eq!(reply["error"]["code"], -32601);
    assert_eq!(reply["id"], 13);
    assert!(reply.get("result").is_none());

    let response = h.http.post(h.server.mcp_url()).bearer_auth(&h.token).body("{not json").send().await.unwrap();
    assert_eq!(response.status(), 400);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["error"]["code"], -32700);
    assert_eq!(body["id"], Value::Null);

    let response = h.post(json!({ "id": 14, "method": "ping" })).send().await.unwrap();
    assert_eq!(response.status(), 400);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["error"]["code"], -32600);
    assert_eq!(body["id"], 14);

    let response = h.post(json!({ "jsonrpc": "2.0", "id": 15 })).send().await.unwrap();
    assert_eq!(response.status(), 400);

    let big = "x".repeat(70_000);
    let response = h.post(json!({ "jsonrpc": "2.0", "id": 16, "method": "ping", "params": { "pad": big } })).send().await.unwrap();
    assert_eq!(response.status(), 413);
}

#[tokio::test]
async fn auth_rejects_missing_bad_and_mismatched_credentials() {
    let h = Harness::start().await;
    let body = json!({ "jsonrpc": "2.0", "id": 1, "method": "ping" });
    let url = h.server.mcp_url();

    let response = h.http.post(&url).json(&body).send().await.unwrap();
    assert_eq!(response.status(), 401, "no token");

    let response = h.http.post(&url).bearer_auth("not-a-token").json(&body).send().await.unwrap();
    assert_eq!(response.status(), 401, "garbage token");

    let other_secret = boss_bus::BusTokens::new([9u8; 32]).issue(&"thr_1".into(), &"who_1".into());
    let response = h.http.post(&url).bearer_auth(other_secret).json(&body).send().await.unwrap();
    assert_eq!(response.status(), 401, "token from another secret");

    let response = h.http.post(&url).header("authorization", format!("Token {}", h.token)).json(&body).send().await.unwrap();
    assert_eq!(response.status(), 401, "wrong scheme");

    // Headers may name the caller, but only in agreement with the token.
    let response = h.post(body.clone()).header("x-boss-thread", "thr_1").header("x-boss-participant", "who_1").send().await.unwrap();
    assert_eq!(response.status(), 200, "matching headers");
    let response = h.post(body.clone()).header("x-boss-thread", "thr_2").send().await.unwrap();
    assert_eq!(response.status(), 401, "thread header disagrees with token");
    let response = h.post(body.clone()).header("x-boss-participant", "who_2").send().await.unwrap();
    assert_eq!(response.status(), 401, "participant header disagrees with token");

    assert!(h.handler.calls.lock().unwrap().is_empty());
}

#[tokio::test]
async fn origin_and_method_gates() {
    let h = Harness::start().await;
    let body = json!({ "jsonrpc": "2.0", "id": 1, "method": "ping" });
    let response = h.post(body.clone()).header("origin", "http://localhost:5173").send().await.unwrap();
    assert_eq!(response.status(), 200);
    let response = h.post(body.clone()).header("origin", "https://evil.example").send().await.unwrap();
    assert_eq!(response.status(), 403);
    let response = h.post(body.clone()).header("origin", "not a url").send().await.unwrap();
    assert_eq!(response.status(), 403);

    let response = h.http.get(h.server.mcp_url()).bearer_auth(&h.token).send().await.unwrap();
    assert_eq!(response.status(), 405);
    assert_eq!(response.headers()["allow"], "POST");
    let response = h.http.delete(h.server.mcp_url()).bearer_auth(&h.token).send().await.unwrap();
    assert_eq!(response.status(), 405);
    let response = h.http.put(h.server.mcp_url()).bearer_auth(&h.token).json(&body).send().await.unwrap();
    assert_eq!(response.status(), 404);

    // Unauthenticated GET is still refused before anything else is considered.
    let response = h.http.get(h.server.mcp_url()).send().await.unwrap();
    assert_eq!(response.status(), 401);
    let response = h.http.post(h.server.url()).json(&body).send().await.unwrap();
    assert_eq!(response.status(), 404, "only /mcp exists");
}

#[tokio::test]
async fn stop_releases_the_port() {
    let h = Harness::start().await;
    let url = h.server.mcp_url();
    let Harness { server, http, token, .. } = h;
    server.stop().await;
    let result = http.post(&url).bearer_auth(token).json(&json!({ "jsonrpc": "2.0", "id": 1, "method": "ping" })).send().await;
    assert!(result.is_err(), "server should be gone");
}

#[tokio::test]
async fn agent_call_serves_the_generated_plugins() {
    let h = Harness::start().await;
    let url = h.server.agent_call_url();
    assert_eq!(url, format!("{}/agent-call", h.server.url()));
    let body = |tool: &str, args: Value| {
        json!({ "backendId": "opencode", "nativeThreadId": "ses_123", "tool": tool, "arguments": args })
    };

    // A JSON result comes back as the raw value, as the TS bus returned it.
    let response = h.http.post(&url).bearer_auth(&h.token).json(&body("boss_threads_list", json!({}))).send().await.unwrap();
    assert_eq!(response.status(), 200);
    let payload: Value = response.json().await.unwrap();
    assert_eq!(payload["ok"], true);
    assert_eq!(payload["result"], json!([{ "id": "thr_other", "title": "Other", "busy": false }]));

    // Prose comes back in the __bossToolResult shape so the plugin prints result.text verbatim.
    let response = h.http.post(&url).bearer_auth(&h.token).json(&body("boss_threads_use_worktree", json!(null))).send().await.unwrap();
    let payload: Value = response.json().await.unwrap();
    assert_eq!(payload["result"]["__bossToolResult"], true);
    assert_eq!(payload["result"]["text"], "Moved onto a worktree.\nEdit there from your next message.");
    assert!(payload["result"].get("image").is_none());

    // Images ride along as { mimeType, data }, which both plugins turn into an attachment.
    let response = h.http.post(&url).bearer_auth(&h.token).json(&body("boss_browser_screenshot", json!({ "tabId": "1" }))).send().await.unwrap();
    let payload: Value = response.json().await.unwrap();
    assert_eq!(payload["result"]["__bossToolResult"], true);
    assert_eq!(payload["result"]["text"], "Screenshot of tab 1");
    assert_eq!(payload["result"]["image"], json!({ "mimeType": "image/png", "data": "iVBORw0KGgo=" }));

    // The handler saw the caller from the token, the tool, and {} for null arguments.
    let calls = h.handler.calls.lock().unwrap();
    assert_eq!(calls.len(), 3);
    assert_eq!(calls[0].0, BusCaller { thread_id: "thr_1".into(), participant_id: "who_1".into() });
    assert_eq!(calls[1].1, "boss_threads_use_worktree");
    assert_eq!(calls[1].2, json!({}));
    assert_eq!(calls[2].2, json!({ "tabId": "1" }));
}

#[tokio::test]
async fn agent_call_reports_failures_the_way_the_plugins_read_them() {
    let h = Harness::start().await;
    let url = h.server.agent_call_url();
    let good = json!({ "backendId": "pi", "nativeThreadId": "sid", "tool": "boss_threads_list", "arguments": {} });

    // A tool error is a 400 with ok:false and the message the plugin throws.
    let response = h
        .http
        .post(&url)
        .bearer_auth(&h.token)
        .json(&json!({ "backendId": "pi", "nativeThreadId": "sid", "tool": "boss_nope", "arguments": {} }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 400);
    let payload: Value = response.json().await.unwrap();
    assert_eq!(payload, json!({ "ok": false, "error": "Unknown BOSS thread tool: boss_nope." }));

    // Missing fields and bad JSON are 400s too.
    for bad in [
        json!({ "nativeThreadId": "sid", "tool": "boss_threads_list" }),
        json!({ "backendId": "pi", "tool": "boss_threads_list" }),
        json!({ "backendId": "pi", "nativeThreadId": "sid" }),
        json!({ "backendId": "pi", "nativeThreadId": "", "tool": "boss_threads_list" }),
    ] {
        let response = h.http.post(&url).bearer_auth(&h.token).json(&bad).send().await.unwrap();
        assert_eq!(response.status(), 400, "{bad}");
        let payload: Value = response.json().await.unwrap();
        assert_eq!(payload["ok"], false);
        assert_eq!(payload["error"], "Invalid thread-bus request.");
    }
    let response = h.http.post(&url).bearer_auth(&h.token).body("nope").send().await.unwrap();
    assert_eq!(response.status(), 400);
    assert_eq!(response.json::<Value>().await.unwrap()["ok"], false);

    // Same bearer scheme as /mcp: no token or a foreign token is refused before anything runs.
    let response = h.http.post(&url).json(&good).send().await.unwrap();
    assert_eq!(response.status(), 401);
    let other = boss_bus::BusTokens::new([9u8; 32]).issue(&"thr_1".into(), &"who_1".into());
    let response = h.http.post(&url).bearer_auth(other).json(&good).send().await.unwrap();
    assert_eq!(response.status(), 401);

    // Only POST exists here, as in the TS.
    let response = h.http.get(&url).bearer_auth(&h.token).send().await.unwrap();
    assert_eq!(response.status(), 404);

    assert_eq!(h.handler.calls.lock().unwrap().len(), 1, "only the boss_nope call reached the handler");
}
