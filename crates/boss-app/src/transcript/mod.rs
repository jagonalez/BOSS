//! Transcript list and composer.
//!
//! - `view`      — `TranscriptView`: the bottom-aligned `list()` of turns.
//! - `composer`  — `Composer`: input, recipient chip, attachments, permission bar.
//! - `pane`      — `ThreadPane`: the two stacked; what the shell mounts.
//! - `turns`     — grouping messages into visual turns (pure).
//! - `cache`     — per-message render cache keyed by revision (pure).
//! - `coalesce`  — rate-limits engine events into ≤ 8 model commits/second.
//! - `recipient` — `@name` parsing for the chip (pure).

pub mod cache;
pub mod coalesce;
pub mod composer;
pub mod pane;
pub mod recipient;
pub mod turns;
pub mod view;

pub use composer::{Composer, ComposerEvent};
pub use pane::ThreadPane;
pub use view::{RenderStats, TranscriptEvent, TranscriptView};

use gpui::{App, Div, ParentElement as _, SharedString, Styled as _, div};
use gpui_component::ActiveTheme as _;

/// A monospace block for tool input/output and permission payloads.
pub(crate) fn mono_block(text: SharedString, cx: &App) -> Div {
    let theme = cx.theme();
    div()
        .w_full()
        .rounded_sm()
        .bg(theme.background)
        .border_1()
        .border_color(theme.border)
        .px_2()
        .py_1()
        .font_family(theme.mono_font_family.clone())
        .text_size(theme.mono_font_size)
        .overflow_hidden()
        .child(text)
}
