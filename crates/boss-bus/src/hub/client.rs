//! Minimal MCP client for the hub: initialize, tools/list, tools/call.
//!
//! Two transports, as in `src/main/mcp-client.ts`: stdio (a child process
//! speaking newline-delimited JSON-RPC) and streamable HTTP (JSON-RPC over
//! POST; the reply arrives as `application/json` or as a `text/event-stream`
//! carrying JSON-RPC messages). [`McpClient`] holds the protocol; a transport
//! only moves envelopes.

use super::rpc::{self, JsonRpcResponse, McpCallResult, McpToolDefinition, PROTOCOL_VERSION, REQUEST_TIMEOUT};
use anyhow::{anyhow, Context as _};
use async_trait::async_trait;
use serde_json::Value;
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as SyncMutex};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{oneshot, Mutex};

/// Moves JSON-RPC envelopes to one MCP server and back.
#[async_trait]
pub trait McpTransport: Send + Sync {
    /// Send a request and wait for the response with the same id.
    async fn request(&self, method: &str, params: Option<Value>) -> anyhow::Result<JsonRpcResponse>;
    /// Send a notification; no reply is expected.
    async fn notify(&self, method: &str) -> anyhow::Result<()>;
    /// Release the connection; a stdio server is terminated.
    async fn close(&self);
}

/// One connection to an MCP server, whichever transport carries it.
pub struct McpClient {
    transport: Box<dyn McpTransport>,
}

impl McpClient {
    /// Spawn `command args` with extra `env` and talk JSON-RPC over its stdio.
    pub fn stdio(command: impl Into<String>, args: Vec<String>, env: HashMap<String, String>) -> Self {
        Self::from_transport(Box::new(StdioTransport::new(command, args, env)))
    }

    /// POST JSON-RPC to a streamable HTTP endpoint with extra request headers.
    pub fn http(url: impl Into<String>, headers: HashMap<String, String>) -> Self {
        Self::from_transport(Box::new(HttpTransport::new(url, headers)))
    }

    /// Wrap any transport, for tests or future carriers.
    pub fn from_transport(transport: Box<dyn McpTransport>) -> Self {
        Self { transport }
    }

    /// Perform the handshake. Resolves to the server's usage instructions, when it provides any.
    pub async fn initialize(&self) -> anyhow::Result<Option<String>> {
        let result = self.transport.request("initialize", Some(rpc::initialize_params())).await?.into_result()?;
        self.transport.notify("notifications/initialized").await?;
        Ok(rpc::instructions_from(&result))
    }

    /// Tools the server offers.
    pub async fn list_tools(&self) -> anyhow::Result<Vec<McpToolDefinition>> {
        let result = self.transport.request("tools/list", Some(Value::Object(Default::default()))).await?.into_result()?;
        Ok(rpc::tools_from(&result))
    }

    /// Call one tool by its server-side name. `null` args are sent as `{}`.
    pub async fn call_tool(&self, name: &str, args: Value) -> anyhow::Result<McpCallResult> {
        let args = if args.is_null() { Value::Object(Default::default()) } else { args };
        let params = serde_json::json!({ "name": name, "arguments": args });
        let result = self.transport.request("tools/call", Some(params)).await?.into_result()?;
        Ok(rpc::call_result_from(&result))
    }

    /// Release the connection.
    pub async fn close(&self) {
        self.transport.close().await;
    }
}

type Pending = Arc<SyncMutex<HashMap<u64, oneshot::Sender<JsonRpcResponse>>>>;

struct Running {
    stdin: ChildStdin,
    child: Arc<Mutex<Option<Child>>>,
}

/// An MCP server run as a child process, JSON-RPC one message per line.
pub struct StdioTransport {
    command: String,
    args: Vec<String>,
    env: HashMap<String, String>,
    running: Mutex<Option<Running>>,
    pending: Pending,
    next_id: AtomicU64,
    closed: AtomicBool,
}

impl StdioTransport {
    /// Describe the server; the process starts on the first message.
    pub fn new(command: impl Into<String>, args: Vec<String>, env: HashMap<String, String>) -> Self {
        Self {
            command: command.into(),
            args,
            env,
            running: Mutex::new(None),
            pending: Arc::new(SyncMutex::new(HashMap::new())),
            next_id: AtomicU64::new(1),
            closed: AtomicBool::new(false),
        }
    }

    /// Dropping the senders wakes every waiter with a `RecvError`, which the
    /// request path reports as the process having exited.
    fn fail_pending(pending: &Pending) {
        pending.lock().expect("pending map lock").clear();
    }

    async fn ensure_started(&self, running: &mut Option<Running>) -> anyhow::Result<()> {
        if running.is_some() {
            return Ok(());
        }
        if self.closed.load(Ordering::SeqCst) {
            return Err(anyhow!("The MCP connection is closing."));
        }
        let mut child = Command::new(&self.command)
            .args(&self.args)
            .envs(&self.env)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .with_context(|| format!("could not start MCP server `{}`", self.command))?;
        let stdin = child.stdin.take().ok_or_else(|| anyhow!("MCP server has no stdin"))?;
        let stdout = child.stdout.take().ok_or_else(|| anyhow!("MCP server has no stdout"))?;
        let child = Arc::new(Mutex::new(Some(child)));
        let pending = Arc::clone(&self.pending);
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let line = line.trim();
                if line.is_empty() {
                    continue;
                }
                let Ok(message) = serde_json::from_str::<JsonRpcResponse>(line) else { continue };
                let Some(id) = message.id.as_ref().and_then(Value::as_u64) else { continue };
                let waiter = pending.lock().expect("pending map lock").remove(&id);
                if let Some(waiter) = waiter {
                    let _ = waiter.send(message);
                }
            }
            // stdout closed: the server is gone. Anyone still waiting learns now.
            Self::fail_pending(&pending);
        });
        *running = Some(Running { stdin, child });
        Ok(())
    }

    async fn write(&self, payload: &Value) -> anyhow::Result<()> {
        let mut running = self.running.lock().await;
        self.ensure_started(&mut running).await?;
        let stdin = &mut running.as_mut().expect("started above").stdin;
        let mut line = serde_json::to_vec(payload)?;
        line.push(b'\n');
        stdin.write_all(&line).await.context("The MCP server process is not accepting input.")?;
        stdin.flush().await.ok();
        Ok(())
    }
}

#[async_trait]
impl McpTransport for StdioTransport {
    async fn request(&self, method: &str, params: Option<Value>) -> anyhow::Result<JsonRpcResponse> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().expect("pending map lock").insert(id, tx);
        if let Err(error) = self.write(&rpc::request(id, method, params)).await {
            self.pending.lock().expect("pending map lock").remove(&id);
            return Err(error);
        }
        match tokio::time::timeout(REQUEST_TIMEOUT, rx).await {
            Ok(Ok(response)) => Ok(response),
            Ok(Err(_)) => Err(anyhow!("The MCP server process exited.")),
            Err(_) => {
                self.pending.lock().expect("pending map lock").remove(&id);
                Err(anyhow!("The MCP server did not answer {method} within {}s.", REQUEST_TIMEOUT.as_secs()))
            }
        }
    }

    async fn notify(&self, method: &str) -> anyhow::Result<()> {
        self.write(&rpc::notification(method)).await
    }

    async fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
        let running = self.running.lock().await.take();
        Self::fail_pending(&self.pending);
        let Some(running) = running else { return };
        drop(running.stdin);
        let mut slot = running.child.lock().await;
        let Some(mut child) = slot.take() else { return };
        if child.start_kill().is_err() {
            return;
        }
        let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
    }
}

/// An MCP server reached over streamable HTTP.
pub struct HttpTransport {
    http: reqwest::Client,
    url: String,
    headers: HashMap<String, String>,
    session_id: SyncMutex<Option<String>>,
    next_id: AtomicU64,
}

impl HttpTransport {
    /// Point at a server URL with extra request headers (auth and the like).
    pub fn new(url: impl Into<String>, headers: HashMap<String, String>) -> Self {
        Self {
            http: reqwest::Client::builder().timeout(REQUEST_TIMEOUT).build().expect("reqwest client"),
            url: url.into(),
            headers,
            session_id: SyncMutex::new(None),
            next_id: AtomicU64::new(1),
        }
    }

    async fn post(&self, payload: &Value, expect_reply: bool) -> anyhow::Result<Option<JsonRpcResponse>> {
        let mut request = self
            .http
            .post(&self.url)
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .header(reqwest::header::ACCEPT, "application/json, text/event-stream")
            .header("mcp-protocol-version", PROTOCOL_VERSION);
        if let Some(session) = self.session_id.lock().expect("session lock").clone() {
            request = request.header("mcp-session-id", session);
        }
        for (name, value) in &self.headers {
            request = request.header(name.as_str(), value.as_str());
        }
        let response = request.json(payload).send().await.context("The MCP server could not be reached.")?;
        if let Some(session) = response.headers().get("mcp-session-id").and_then(|v| v.to_str().ok()) {
            *self.session_id.lock().expect("session lock") = Some(session.to_owned());
        }
        let status = response.status();
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default()
            .to_owned();
        if !status.is_success() {
            let detail: String = response.text().await.unwrap_or_default().chars().take(300).collect();
            let suffix = if detail.is_empty() { String::new() } else { format!(" {detail}") };
            return Err(anyhow!("The MCP server answered {}.{suffix}", status.as_u16()));
        }
        if !expect_reply {
            return Ok(None);
        }
        let body = response.text().await?;
        if content_type.contains("text/event-stream") {
            let id = payload.get("id").and_then(Value::as_u64).unwrap_or_default();
            return rpc::response_from_sse(&body, id)
                .map(Some)
                .ok_or_else(|| anyhow!("The MCP server stream ended without a response."));
        }
        Ok(Some(serde_json::from_str(&body).context("The MCP server sent malformed JSON.")?))
    }
}

#[async_trait]
impl McpTransport for HttpTransport {
    async fn request(&self, method: &str, params: Option<Value>) -> anyhow::Result<JsonRpcResponse> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        self.post(&rpc::request(id, method, params), true).await?.ok_or_else(|| anyhow!("The MCP server sent no response."))
    }

    async fn notify(&self, method: &str) -> anyhow::Result<()> {
        // Some servers reject the notification; tools still work, so a failure here is not one.
        let _ = self.post(&rpc::notification(method), false).await;
        Ok(())
    }

    async fn close(&self) {
        *self.session_id.lock().expect("session lock") = None;
    }
}
