//! boss-engines: adapters that drive coding agents and emit `EngineEvent`s.
//!
//! Each adapter lives in its own module and owns its own process or HTTP
//! client. Shared helpers live in `jsonl`. Nothing here knows about the UI.

pub mod claude;
pub mod codex;
pub mod jsonl;
pub mod opencode;
pub mod pi;

pub use boss_core::{Engine, EngineEvent, EngineId, Session, SessionOptions};
