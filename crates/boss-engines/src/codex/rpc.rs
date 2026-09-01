//! JSON-RPC 2.0 over JSONL for the codex app-server.
//!
//! The app-server omits the `jsonrpc` field. Requests are `{id, method,
//! params}`, responses `{id, result}` or `{id, error}`, notifications
//! `{method, params}`. The server also sends requests of its own (approvals,
//! dynamic tool calls); the adapter answers those with `{id, result}`.

use anyhow::{Result, anyhow};
use async_trait::async_trait;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;
use tokio::sync::oneshot;

/// Sink for outgoing JSON-RPC messages: the child's stdin, or a Vec in tests.
#[async_trait]
pub trait Outbound: Send + Sync {
    /// Write one message as a single JSONL line.
    async fn send(&self, value: &Value) -> Result<()>;
}

#[async_trait]
impl Outbound for crate::jsonl::JsonlChild {
    async fn send(&self, value: &Value) -> Result<()> {
        crate::jsonl::JsonlChild::send(self, value).await
    }
}

/// A JSON-RPC error object returned by the server.
#[derive(Clone, Debug, PartialEq, thiserror::Error)]
#[error("codex app-server error {code}: {message}")]
pub struct RpcError {
    /// JSON-RPC error code (`-32602` invalid params, and so on).
    pub code: i64,
    /// Human-readable message from the server.
    pub message: String,
    /// Optional structured detail.
    pub data: Option<Value>,
}

/// One message from the server, sorted by role.
#[derive(Clone, Debug, PartialEq)]
pub enum Incoming {
    /// Answer to a request this client sent.
    Response { id: Value, result: Result<Value, RpcError> },
    /// A request the server expects us to answer.
    Request { id: Value, method: String, params: Value },
    /// Fire-and-forget event.
    Notification { method: String, params: Value },
}

/// Sort a parsed line into response, server request, or notification.
pub fn classify(value: Value) -> Option<Incoming> {
    let obj = value.as_object()?;
    let id = obj.get("id").filter(|v| !v.is_null()).cloned();
    let method = obj.get("method").and_then(Value::as_str).map(str::to_owned);
    let params = obj.get("params").cloned().unwrap_or_else(|| json!({}));
    match (id, method) {
        (Some(id), Some(method)) => Some(Incoming::Request { id, method, params }),
        (None, Some(method)) => Some(Incoming::Notification { method, params }),
        (Some(id), None) => {
            let result = match obj.get("error") {
                Some(err) if !err.is_null() => Err(RpcError {
                    code: err.get("code").and_then(Value::as_i64).unwrap_or(-1),
                    message: err.get("message").and_then(Value::as_str).unwrap_or("unknown error").to_owned(),
                    data: err.get("data").cloned(),
                }),
                _ => Ok(obj.get("result").cloned().unwrap_or(Value::Null)),
            };
            Some(Incoming::Response { id, result })
        }
        (None, None) => None,
    }
}

/// Our answer to a server-initiated request.
#[derive(Clone, Debug, PartialEq)]
pub enum Reply {
    /// Success payload.
    Result { id: Value, result: Value },
    /// JSON-RPC error.
    Error { id: Value, code: i64, message: String },
}

impl Reply {
    /// The wire form of this reply.
    pub fn to_value(&self) -> Value {
        match self {
            Reply::Result { id, result } => json!({ "id": id, "result": result }),
            Reply::Error { id, code, message } => json!({ "id": id, "error": { "code": code, "message": message } }),
        }
    }
}

type Pending = HashMap<u64, oneshot::Sender<Result<Value, RpcError>>>;

/// Request/response matching and outgoing messages for one connection.
pub struct RpcClient {
    out: Arc<dyn Outbound>,
    next_id: AtomicU64,
    pending: Mutex<Pending>,
    timeout: Duration,
}

impl RpcClient {
    /// Wrap an outbound sink. `timeout` bounds every `request`.
    pub fn new(out: Arc<dyn Outbound>, timeout: Duration) -> Self {
        Self { out, next_id: AtomicU64::new(1), pending: Mutex::new(HashMap::new()), timeout }
    }

    fn pending(&self) -> MutexGuard<'_, Pending> {
        self.pending.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Send a request and wait for its response.
    pub async fn request(&self, method: &str, params: Value) -> Result<Value> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending().insert(id, tx);
        let message = json!({ "id": id, "method": method, "params": params });
        if let Err(err) = self.out.send(&message).await {
            self.pending().remove(&id);
            return Err(err);
        }
        match tokio::time::timeout(self.timeout, rx).await {
            Ok(Ok(Ok(value))) => Ok(value),
            Ok(Ok(Err(err))) => Err(anyhow!(err).context(format!("codex {method}"))),
            Ok(Err(_)) => Err(anyhow!("codex {method}: connection closed")),
            Err(_) => {
                self.pending().remove(&id);
                Err(anyhow!("codex {method}: timed out after {:?}", self.timeout))
            }
        }
    }

    /// Send a notification (no response expected).
    pub async fn notify(&self, method: &str, params: Value) -> Result<()> {
        self.out.send(&json!({ "method": method, "params": params })).await
    }

    /// Answer a server-initiated request.
    pub async fn reply(&self, reply: &Reply) -> Result<()> {
        self.out.send(&reply.to_value()).await
    }

    /// Route a response to the waiting request. Returns false when nothing waits for `id`.
    pub fn handle_response(&self, id: &Value, result: Result<Value, RpcError>) -> bool {
        let Some(id) = id.as_u64().or_else(|| id.as_str().and_then(|s| s.parse().ok())) else {
            return false;
        };
        match self.pending().remove(&id) {
            Some(tx) => tx.send(result).is_ok(),
            None => false,
        }
    }

    /// Fail every outstanding request; used when the child exits.
    pub fn fail_all(&self) {
        self.pending().clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct Recorder(Mutex<Vec<Value>>);

    #[async_trait]
    impl Outbound for Recorder {
        async fn send(&self, value: &Value) -> Result<()> {
            self.0.lock().unwrap().push(value.clone());
            Ok(())
        }
    }

    fn client() -> (Arc<Recorder>, Arc<RpcClient>) {
        let recorder = Arc::new(Recorder::default());
        let client = Arc::new(RpcClient::new(recorder.clone(), Duration::from_secs(5)));
        (recorder, client)
    }

    #[test]
    fn classify_sorts_messages_by_role() {
        assert_eq!(
            classify(json!({"id": 3, "result": {"ok": true}})),
            Some(Incoming::Response { id: json!(3), result: Ok(json!({"ok": true})) })
        );
        assert_eq!(
            classify(json!({"id": 4, "error": {"code": -32602, "message": "invalid params"}})),
            Some(Incoming::Response {
                id: json!(4),
                result: Err(RpcError { code: -32602, message: "invalid params".into(), data: None }),
            })
        );
        assert_eq!(
            classify(json!({"id": 9, "method": "item/commandExecution/requestApproval", "params": {"command": "ls"}})),
            Some(Incoming::Request {
                id: json!(9),
                method: "item/commandExecution/requestApproval".into(),
                params: json!({"command": "ls"}),
            })
        );
        assert_eq!(
            classify(json!({"method": "turn/started", "params": {"threadId": "t"}})),
            Some(Incoming::Notification { method: "turn/started".into(), params: json!({"threadId": "t"}) })
        );
        assert_eq!(classify(json!({"unrelated": 1})), None);
        assert_eq!(classify(json!("not an object")), None);
    }

    #[tokio::test]
    async fn request_resolves_with_matching_response() {
        let (recorder, client) = client();
        let waiter = tokio::spawn({
            let client = client.clone();
            async move { client.request("thread/start", json!({"cwd": "/tmp"})).await }
        });
        tokio::task::yield_now().await;
        let sent = recorder.0.lock().unwrap().clone();
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0]["method"], "thread/start");
        assert_eq!(sent[0]["params"]["cwd"], "/tmp");
        let id = sent[0]["id"].clone();
        assert!(sent[0].get("jsonrpc").is_none(), "app-server envelope has no jsonrpc field");

        assert!(!client.handle_response(&json!(999), Ok(json!(null))), "unknown id is reported");
        assert!(client.handle_response(&id, Ok(json!({"thread": {"id": "abc"}}))));
        let result = waiter.await.unwrap().unwrap();
        assert_eq!(result["thread"]["id"], "abc");
        assert!(!client.handle_response(&id, Ok(json!(null))), "a response is consumed once");
    }

    #[tokio::test]
    async fn error_response_becomes_err() {
        let (recorder, client) = client();
        let waiter = tokio::spawn({
            let client = client.clone();
            async move { client.request("model/list", json!({})).await }
        });
        tokio::task::yield_now().await;
        let id = recorder.0.lock().unwrap()[0]["id"].clone();
        client.handle_response(&id, Err(RpcError { code: -32601, message: "no such method".into(), data: None }));
        let err = waiter.await.unwrap().unwrap_err();
        assert!(err.to_string().contains("model/list"), "{err}");
        assert!(format!("{err:#}").contains("no such method"), "{err:#}");
    }

    #[tokio::test]
    async fn fail_all_closes_waiting_requests() {
        let (_recorder, client) = client();
        let waiter = tokio::spawn({
            let client = client.clone();
            async move { client.request("turn/start", json!({})).await }
        });
        tokio::task::yield_now().await;
        client.fail_all();
        let err = waiter.await.unwrap().unwrap_err();
        assert!(err.to_string().contains("connection closed"), "{err}");
    }

    #[tokio::test]
    async fn ids_increase_and_replies_carry_the_server_id() {
        let (recorder, client) = client();
        let a = tokio::spawn({
            let client = client.clone();
            async move { client.request("a", json!({})).await }
        });
        let b = tokio::spawn({
            let client = client.clone();
            async move { client.request("b", json!({})).await }
        });
        tokio::task::yield_now().await;
        tokio::task::yield_now().await;
        client.reply(&Reply::Result { id: json!("srv-7"), result: json!({"decision": "accept"}) }).await.unwrap();
        client.reply(&Reply::Error { id: json!(8), code: -32601, message: "nope".into() }).await.unwrap();
        client.notify("initialized", json!({})).await.unwrap();
        let sent = recorder.0.lock().unwrap().clone();
        let ids: Vec<u64> = sent.iter().filter(|m| m.get("method").is_some() && m.get("id").is_some()).map(|m| m["id"].as_u64().unwrap()).collect();
        assert_eq!(ids.len(), 2);
        assert_ne!(ids[0], ids[1]);
        assert_eq!(sent[2], json!({"id": "srv-7", "result": {"decision": "accept"}}));
        assert_eq!(sent[3], json!({"id": 8, "error": {"code": -32601, "message": "nope"}}));
        assert_eq!(sent[4], json!({"method": "initialized", "params": {}}));
        for id in ids {
            client.handle_response(&json!(id), Ok(json!(null)));
        }
        a.await.unwrap().unwrap();
        b.await.unwrap().unwrap();
    }
}
