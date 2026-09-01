//! boss-core: the shared contract for BOSS.
//!
//! Every other crate depends on this one and only on this one for domain
//! types. Keep it free of UI and free of process/IO details. Engines,
//! the thread bus, and the app all speak the types defined here.
//!
//! Runtime rule: engines and the bus run on a tokio runtime that the app
//! owns. They hand results to the UI over `async_channel` receivers, which
//! GPUI's foreground executor can await directly.

pub mod bus;
pub mod engine;
pub mod event;
pub mod ids;
pub mod message;
pub mod paths;
pub mod rooms;
pub mod store;
pub mod thread;

pub use bus::*;
pub use engine::*;
pub use event::*;
pub use ids::*;
pub use message::*;
pub use thread::*;
