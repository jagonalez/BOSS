//! boss-terminal: an embedded terminal for GPUI.
//!
//! Layers, bottom up:
//! - [`Pty`]: spawns the shell with `portable-pty`, owns the reader thread.
//! - [`Terminal`]: the `alacritty_terminal` grid, cursor, scrollback and
//!   selection, plus paste and key mapping. Shared behind an `Arc`.
//! - [`TerminalElement`]: a custom GPUI element that paints visible rows.
//! - [`TerminalView`]: the `Render` entity that wires focus, keys and
//!   mouse to the model and reports `TerminalEvent`s.

pub mod blink;
pub mod colors;
pub mod element;
pub mod keys;
pub mod links;
pub mod mouse;
pub mod pty;
pub mod terminal;
pub mod throttle;
pub mod view;

pub use blink::BlinkState;
pub use colors::Palette;
pub use element::{TerminalElement, TerminalStyle, grid_dimensions};
pub use keys::key_to_bytes;
pub use links::{LinkSpan, find_links};
pub use mouse::{MouseButtonCode, MouseEventKind, MouseModifiers, MouseReport};
pub use pty::{Pty, PtyEvent, PtySpec};
pub use terminal::{Frame, SelectionKind, Terminal};
pub use throttle::{FlowControl, Coalescer};
pub use view::{TerminalEvent, TerminalView};
