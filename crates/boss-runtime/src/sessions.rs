//! Runs agent sessions on the tokio runtime and hands their events to the
//! UI thread. One `SessionManager` per app.
//!
//! Flow: `Session::events()` (tokio side) → `SessionEvent` → one
//! `async_channel` the UI drains. The UI applies events to the matching
//! `ThreadModel` through the coalescer (see `transcript::coalesce`), so
//! this module does no batching itself.

use anyhow::{Context, Result, anyhow};
use async_channel::{Receiver, Sender};
use boss_core::*;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;

/// Key for one running session: a participant in a thread.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct SessionKey {
    pub thread_id: ThreadId,
    pub participant_id: ParticipantId,
}

/// An engine event tagged with where it came from.
#[derive(Clone, Debug)]
pub struct SessionEvent {
    pub key: SessionKey,
    pub event: EngineEvent,
}

/// Owns engines and live sessions.
pub struct SessionManager {
    engines: HashMap<EngineId, Arc<dyn Engine>>,
    sessions: Mutex<HashMap<SessionKey, Arc<dyn Session>>>,
    tx: Sender<SessionEvent>,
    rx: Receiver<SessionEvent>,
    handle: tokio::runtime::Handle,
}

impl SessionManager {
    pub fn new(engines: Vec<Arc<dyn Engine>>, handle: tokio::runtime::Handle) -> Arc<Self> {
        let (tx, rx) = async_channel::unbounded();
        Arc::new(Self {
            engines: engines.into_iter().map(|e| (e.id(), e)).collect(),
            sessions: Mutex::new(HashMap::new()),
            tx,
            rx,
            handle,
        })
    }

    /// The UI drains this. Clone it once per consumer.
    pub fn events(&self) -> Receiver<SessionEvent> {
        self.rx.clone()
    }

    pub fn engine(&self, id: EngineId) -> Option<Arc<dyn Engine>> {
        self.engines.get(&id).cloned()
    }

    pub fn engines(&self) -> impl Iterator<Item = &Arc<dyn Engine>> {
        self.engines.values()
    }

    /// Start (or resume) a session and begin pumping its events.
    pub async fn start(self: &Arc<Self>, engine: EngineId, opts: SessionOptions) -> Result<()> {
        let key = SessionKey { thread_id: opts.thread_id.clone(), participant_id: opts.participant_id.clone() };
        let engine = self.engine(engine).ok_or_else(|| anyhow!("engine {engine:?} not registered"))?;
        let session: Arc<dyn Session> = Arc::from(engine.start_session(opts).await.context("start session")?);
        let events = session.events();
        self.sessions.lock().await.insert(key.clone(), session);

        let tx = self.tx.clone();
        let this = Arc::clone(self);
        self.handle.spawn(async move {
            while let Ok(event) = events.recv().await {
                let closed = matches!(event, EngineEvent::Closed);
                if tx.send(SessionEvent { key: key.clone(), event }).await.is_err() {
                    break;
                }
                if closed {
                    break;
                }
            }
            this.sessions.lock().await.remove(&key);
        });
        Ok(())
    }

    pub async fn get(&self, key: &SessionKey) -> Option<Arc<dyn Session>> {
        self.sessions.lock().await.get(key).cloned()
    }

    pub async fn send(&self, key: &SessionKey, prompt: Prompt) -> Result<()> {
        self.get(key).await.ok_or_else(|| anyhow!("no session for {key:?}"))?.send(prompt).await
    }

    pub async fn interrupt(&self, key: &SessionKey) -> Result<()> {
        self.get(key).await.ok_or_else(|| anyhow!("no session for {key:?}"))?.interrupt().await
    }

    pub async fn respond_permission(&self, key: &SessionKey, request: RequestId, decision: PermissionDecision) -> Result<()> {
        self.get(key).await.ok_or_else(|| anyhow!("no session for {key:?}"))?.respond_permission(request, decision).await
    }

    pub async fn close(&self, key: &SessionKey) -> Result<()> {
        if let Some(s) = self.sessions.lock().await.remove(key) {
            s.close().await?;
        }
        Ok(())
    }

    /// Close every session (app quit).
    pub async fn close_all(&self) {
        let all: Vec<_> = self.sessions.lock().await.drain().collect();
        for (_, s) in all {
            let _ = s.close().await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;

    struct FakeSession {
        tx: Sender<EngineEvent>,
        rx: Receiver<EngineEvent>,
    }

    #[async_trait]
    impl Session for FakeSession {
        fn engine(&self) -> EngineId {
            EngineId::Pi
        }
        fn native_session_id(&self) -> Option<String> {
            Some("s1".into())
        }
        fn events(&self) -> Receiver<EngineEvent> {
            self.rx.clone()
        }
        async fn send(&self, prompt: Prompt) -> Result<()> {
            let mid = MessageId::new();
            self.tx.send(EngineEvent::TextDelta { message_id: mid.clone(), part_id: PartId::new(), delta: prompt.text }).await?;
            self.tx.send(EngineEvent::MessageCompleted { message_id: mid, usage: None, model: None }).await?;
            Ok(())
        }
        async fn interrupt(&self) -> Result<()> {
            Ok(())
        }
        async fn respond_permission(&self, _: RequestId, _: PermissionDecision) -> Result<()> {
            Ok(())
        }
        async fn set_model(&self, _: String) -> Result<()> {
            Ok(())
        }
        async fn set_permission_mode(&self, _: PermissionMode) -> Result<()> {
            Ok(())
        }
        async fn close(&self) -> Result<()> {
            self.tx.send(EngineEvent::Closed).await?;
            Ok(())
        }
    }

    struct FakeEngine;

    #[async_trait]
    impl Engine for FakeEngine {
        fn id(&self) -> EngineId {
            EngineId::Pi
        }
        fn executable(&self) -> Option<std::path::PathBuf> {
            None
        }
        async fn probe(&self) -> Result<EngineProbe> {
            Ok(EngineProbe { installed: true, ..Default::default() })
        }
        async fn list_models(&self) -> Result<Vec<ModelInfo>> {
            Ok(vec![])
        }
        async fn start_session(&self, _: SessionOptions) -> Result<Box<dyn Session>> {
            let (tx, rx) = async_channel::unbounded();
            Ok(Box::new(FakeSession { tx, rx }))
        }
    }

    fn opts() -> SessionOptions {
        SessionOptions {
            thread_id: ThreadId::new(),
            participant_id: ParticipantId::new(),
            cwd: ".".into(),
            model: None,
            permission_mode: PermissionMode::Default,
            resume: None,
            append_system_prompt: None,
            system_prompt: None,
            allowed_tools: None,
            bus: None,
        }
    }

    #[tokio::test]
    async fn events_are_tagged_and_sessions_are_removed_on_close() {
        let mgr = SessionManager::new(vec![Arc::new(FakeEngine)], tokio::runtime::Handle::current());
        let o = opts();
        let key = SessionKey { thread_id: o.thread_id.clone(), participant_id: o.participant_id.clone() };
        mgr.start(EngineId::Pi, o).await.unwrap();
        mgr.send(&key, Prompt { text: "hi".into(), attachments: vec![] }).await.unwrap();
        let rx = mgr.events();
        let first = rx.recv().await.unwrap();
        assert_eq!(first.key, key);
        assert!(matches!(first.event, EngineEvent::TextDelta { .. }));
        let _ = rx.recv().await.unwrap();
        mgr.close(&key).await.unwrap();
        let closed = rx.recv().await.unwrap();
        assert!(matches!(closed.event, EngineEvent::Closed));
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        assert!(mgr.get(&key).await.is_none());
    }
}
