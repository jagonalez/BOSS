//! boss-runtime: everything BOSS does without a window.
//!
//! - `model`    — `ThreadModel`, the fold from `EngineEvent` into messages.
//! - `sessions` — runs engine sessions on tokio and forwards their events.
//! - `runtime`  — stores, engines, thread bus, and the session manager in one
//!                object the UI talks to.
//! - `bus_handler` — the `BusHandler` that serves agents' thread tools.
//! - `rooms`    — `RoomCoordinator`, which runs `RoomManager` intents.
//! - `web_access` — the phone PWA over loopback, published with tailscale.
//! - `relay`    — mobile access through the relay (the desktop side).
//! - `worktree` — git worktrees for threads that want their own checkout.
//!
//! No GPUI types live here, so this crate compiles and tests headless.

pub mod bus_handler;
pub mod model;
pub mod rooms;
pub mod relay;
pub mod runtime;
pub mod sessions;
pub mod web_access;
pub mod worktree;

pub use runtime::Runtime;
