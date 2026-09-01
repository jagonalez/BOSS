//! Request/response correlation over pi's JSONL RPC (`pi --mode rpc`).
//!
//! Commands go to stdin with an `id`; the matching `{type: "response", id}`
//! resolves the caller. Everything else on stdout is an event and is forwarded
//! on a channel for `translate::PiTranslator`.

use crate::jsonl::JsonlChild;
use anyhow::{Context, Result};
use async_channel::{Receiver, Sender};
use serde_json::Value;
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

/// One line from pi, sorted into a command response or a streamed event.
#[derive(Clone, Debug, PartialEq)]
pub enum Frame {
    /// `{type: "response", ...}`.
    Response {
        /// The `id` we sent, if any.
        id: Option<String>,
        /// Which command this answers.
        command: String,
        /// `success` flag.
        success: bool,
        /// `data` on success.
        data: Option<Value>,
        /// `error` text on failure.
        error: Option<String>,
    },
    /// Anything else (agent events, extension UI requests).
    Event(Value),
}

/// Sort a parsed stdout line into a response or an event.
pub fn classify(value: Value) -> Frame {
    if value.get("type").and_then(Value::as_str) != Some("response") {
        return Frame::Event(value);
    }
    Frame::Response {
        id: value.get("id").and_then(Value::as_str).map(str::to_string),
        command: value.get("command").and_then(Value::as_str).unwrap_or("").to_string(),
        success: value.get("success").and_then(Value::as_bool).unwrap_or(false),
        data: value.get("data").cloned(),
        error: value.get("error").and_then(Value::as_str).map(str::to_string),
    }
}

type Pending = Arc<Mutex<HashMap<String, oneshot::Sender<std::result::Result<Value, String>>>>>;

/// A running `pi --mode rpc` child with request correlation.
pub struct PiRpc {
    child: Arc<JsonlChild>,
    pending: Pending,
    next_id: AtomicU64,
    reader: Mutex<Option<JoinHandle<()>>>,
}

impl PiRpc {
    /// Spawn `program args...` in `cwd`. Events (non-response lines) are sent to
    /// `events`; the channel is closed when the child's stdout ends.
    pub fn spawn(program: &Path, args: &[String], cwd: &Path, env: &[(String, String)], events: Sender<Value>) -> Result<Self> {
        let child = Arc::new(JsonlChild::spawn(program, args, cwd, env)?);
        let pending: Pending = Default::default();
        let reader = tokio::spawn(read_loop(child.lines(), pending.clone(), events));
        Ok(Self { child, pending, next_id: AtomicU64::new(1), reader: Mutex::new(Some(reader)) })
    }

    /// Send a command and wait for its response `data` (or `Null`).
    pub async fn request(&self, mut command: Value, timeout: Duration) -> Result<Value> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst).to_string();
        let kind = command.get("type").and_then(Value::as_str).unwrap_or("command").to_string();
        command
            .as_object_mut()
            .context("pi command must be a JSON object")?
            .insert("id".into(), Value::String(id.clone()));
        let (tx, rx) = oneshot::channel();
        self.pending.lock().map_err(|_| anyhow::anyhow!("pi pending map poisoned"))?.insert(id.clone(), tx);
        if let Err(err) = self.child.send(&command).await {
            self.take_pending(&id);
            return Err(err.context(format!("pi {kind}: write failed")));
        }
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(Ok(data))) => Ok(data),
            Ok(Ok(Err(message))) => anyhow::bail!("{message}"),
            Ok(Err(_)) => anyhow::bail!("Pi RPC process exited."),
            Err(_) => {
                self.take_pending(&id);
                anyhow::bail!("Pi {kind} request timed out.")
            }
        }
    }

    /// Write a message that has no response (`extension_ui_response`).
    pub async fn notify(&self, value: &Value) -> Result<()> {
        self.child.send(value).await
    }

    /// Lines pi printed on stderr.
    pub fn stderr(&self) -> Receiver<String> {
        self.child.stderr.clone()
    }

    /// Kill the child and fail every pending request.
    pub async fn kill(&self) {
        if let Ok(mut guard) = self.reader.lock()
            && let Some(task) = guard.take()
        {
            task.abort();
        }
        let _ = self.child.kill().await;
        reject_all(&self.pending, "Pi RPC process stopped.");
    }

    fn take_pending(&self, id: &str) {
        if let Ok(mut map) = self.pending.lock() {
            map.remove(id);
        }
    }
}

async fn read_loop(lines: Receiver<Value>, pending: Pending, events: Sender<Value>) {
    while let Ok(line) = lines.recv().await {
        match classify(line) {
            Frame::Response { id, command, success, data, error } => {
                let Some(id) = id else {
                    tracing::debug!(%command, "pi: response without id");
                    continue;
                };
                let waiter = pending.lock().ok().and_then(|mut map| map.remove(&id));
                if let Some(waiter) = waiter {
                    let result = if success {
                        Ok(data.unwrap_or(Value::Null))
                    } else {
                        Err(error.unwrap_or_else(|| format!("Pi {command} failed.")))
                    };
                    let _ = waiter.send(result);
                }
            }
            Frame::Event(value) => {
                if events.send(value).await.is_err() {
                    break;
                }
            }
        }
    }
    events.close();
    reject_all(&pending, "Pi RPC process exited.");
}

fn reject_all(pending: &Pending, message: &str) {
    if let Ok(mut map) = pending.lock() {
        for (_, waiter) in map.drain() {
            let _ = waiter.send(Err(message.to_string()));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn responses_and_events_are_told_apart() {
        assert_eq!(
            classify(json!({ "id": "3", "type": "response", "command": "get_state", "success": true, "data": { "sessionId": "s" } })),
            Frame::Response { id: Some("3".into()), command: "get_state".into(), success: true, data: Some(json!({ "sessionId": "s" })), error: None }
        );
        assert_eq!(
            classify(json!({ "type": "response", "command": "set_model", "success": false, "error": "Model not found: x" })),
            Frame::Response { id: None, command: "set_model".into(), success: false, data: None, error: Some("Model not found: x".into()) }
        );
        assert_eq!(classify(json!({ "type": "agent_start" })), Frame::Event(json!({ "type": "agent_start" })));
    }

    #[tokio::test]
    async fn read_loop_resolves_pending_and_forwards_events() {
        let (line_tx, line_rx) = async_channel::unbounded::<Value>();
        let (event_tx, event_rx) = async_channel::unbounded::<Value>();
        let pending: Pending = Default::default();
        let (ok_tx, ok_rx) = oneshot::channel();
        let (err_tx, err_rx) = oneshot::channel();
        let (orphan_tx, orphan_rx) = oneshot::channel();
        pending.lock().unwrap().insert("1".into(), ok_tx);
        pending.lock().unwrap().insert("2".into(), err_tx);
        pending.lock().unwrap().insert("9".into(), orphan_tx);
        let task = tokio::spawn(read_loop(line_rx, pending.clone(), event_tx));

        line_tx.send(json!({ "type": "agent_start" })).await.unwrap();
        line_tx.send(json!({ "id": "1", "type": "response", "command": "prompt", "success": true })).await.unwrap();
        line_tx.send(json!({ "id": "2", "type": "response", "command": "abort", "success": false, "error": "nope" })).await.unwrap();
        line_tx.close();
        task.await.unwrap();

        assert_eq!(event_rx.recv().await.unwrap(), json!({ "type": "agent_start" }));
        assert!(event_rx.recv().await.is_err(), "event channel closes with stdout");
        assert_eq!(ok_rx.await.unwrap(), Ok(Value::Null));
        assert_eq!(err_rx.await.unwrap(), Err("nope".to_string()));
        assert_eq!(orphan_rx.await.unwrap(), Err("Pi RPC process exited.".to_string()));
    }
}
