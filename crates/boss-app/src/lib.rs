//! boss-app: the GPUI application.
//!
//! - `app`        — wires the runtime to the views (`BossApp` implements
//!                  `ShellActions`, pumps engine events, owns tab views).
//! - `model`      — thread state the views read (`ThreadModel`), and the
//!                  fold from `EngineEvent` into `Message`s.
//! - `transcript` — the message list and composer.
//! - `shell`      — window, title bar, sidebar, tabs, settings.
//!
//! Views never own message data. They hold an `Entity<ThreadModel>` and
//! read from it during render.

pub mod app;
pub mod model;
pub mod shell;
pub mod transcript;
