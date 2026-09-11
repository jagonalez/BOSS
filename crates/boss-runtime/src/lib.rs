//! boss-runtime: everything BOSS does without a window.
//!
//! - `model`    — `ThreadModel`, the fold from `EngineEvent` into messages.
//! - `sessions` — runs engine sessions on tokio and forwards their events.
//! - `runtime`  — stores, engines, thread bus, and the session manager in one
//!                object the UI talks to.
//! - `bus_handler` — the `BusHandler` that serves agents' thread tools.
//! - `computer_use` — drives native apps through the embedded cua-driver.
//! - `notify`   — presence and the one path every event takes to a person.
//! - `import`   — one-time import of the Electron app's data.
//! - `rooms`    — `RoomCoordinator`, which runs `RoomManager` intents.
//! - `web_access` — the phone PWA over loopback, published with tailscale.
//! - `relay`    — mobile access through the relay (the desktop side).
//! - `worktree` — git worktrees for threads that want their own checkout.
//! - `automations` — workflows, automations, cron, and the durable event bus.
//!
//! No GPUI types live here, so this crate compiles and tests headless.

pub mod automations;
pub mod bus_handler;
pub mod computer_use;
pub mod import;
pub mod model;
pub mod notify;
pub mod rooms;
pub mod relay;
pub mod runtime;
pub mod sessions;
pub mod web_access;
pub mod worktree;

pub use import::ImportReport;
pub use runtime::Runtime;
