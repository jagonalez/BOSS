//! `TerminalView`: the entity that owns a terminal, its focus, and the
//! task that turns pty and alacritty events into repaints and `TerminalEvent`s.

use std::ops::Range;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

use alacritty_terminal::event::Event as AlacEvent;
use alacritty_terminal::term::TermMode;
use anyhow::Result;
use gpui::{
    App, Bounds, ClipboardItem, Context, EntityInputHandler, EventEmitter, FocusHandle, Focusable,
    IntoElement, KeyDownEvent, Pixels, Render, ScrollDelta, UTF16Selection, Window, div,
    prelude::*,
};

use crate::element::{TerminalElement, TerminalStyle, scroll_lines_for};
use crate::pty::PtyEvent;
use crate::terminal::{GridSize, Terminal, TerminalChannels};
use crate::throttle::Coalescer;

/// What a terminal reports to whoever embeds it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TerminalEvent {
    /// The shell exited with this code.
    Exit(u32),
    /// The program changed the window title.
    TitleChanged(String),
    /// BEL.
    Bell,
}

/// A focusable terminal pane.
pub struct TerminalView {
    terminal: Arc<Terminal>,
    focus_handle: FocusHandle,
    style: Option<TerminalStyle>,
    alive: bool,
    exit_code: Option<u32>,
    dragging: bool,
    scroll_accumulator: f32,
    option_as_meta: bool,
    _tasks: Vec<gpui::Task<()>>,
}

impl TerminalView {
    /// Spawn the user's shell (or `command`) in `cwd` and start listening.
    pub fn new(cwd: Option<PathBuf>, command: Option<Vec<String>>, cx: &mut Context<Self>) -> Result<Self> {
        let (terminal, channels) = Terminal::spawn(cwd, command, GridSize { cols: 80, rows: 24 })?;
        let focus_handle = cx.focus_handle();
        let tasks = vec![
            Self::spawn_pty_task(channels.pty.clone(), cx),
            Self::spawn_term_task(&channels, cx),
        ];
        Ok(Self {
            terminal,
            focus_handle,
            style: None,
            alive: true,
            exit_code: None,
            dragging: false,
            scroll_accumulator: 0.0,
            option_as_meta: false,
            _tasks: tasks,
        })
    }

    /// The window title the shell set, or the program name.
    pub fn title(&self) -> String {
        self.terminal.title()
    }

    /// The shell is still running.
    pub fn is_alive(&self) -> bool {
        self.alive && self.terminal.is_alive()
    }

    /// Exit code once the shell has exited.
    pub fn exit_code(&self) -> Option<u32> {
        self.exit_code
    }

    /// The underlying model, for embedding code that wants to write or read.
    pub fn terminal(&self) -> &Arc<Terminal> {
        &self.terminal
    }

    /// Send Alt+letter as `ESC letter` instead of composing a character.
    pub fn set_option_as_meta(&mut self, on: bool) {
        self.option_as_meta = on;
    }

    /// Override the font the theme would pick.
    pub fn set_style(&mut self, style: TerminalStyle, cx: &mut Context<Self>) {
        self.style = Some(style);
        cx.notify();
    }

    /// Paste the clipboard into the shell.
    pub fn paste(&mut self, cx: &mut Context<Self>) {
        if let Some(text) = cx.read_from_clipboard().and_then(|item| item.text()) {
            self.terminal.paste(&text);
            cx.notify();
        }
    }

    /// Copy the selection, if any. Returns whether something was copied.
    pub fn copy(&mut self, cx: &mut Context<Self>) -> bool {
        match self.terminal.selection_text() {
            Some(text) => {
                cx.write_to_clipboard(ClipboardItem::new_string(text));
                self.terminal.clear_selection();
                cx.notify();
                true
            }
            None => false,
        }
    }

    /// Clear screen and scrollback.
    pub fn clear(&mut self, cx: &mut Context<Self>) {
        self.terminal.clear();
        cx.notify();
    }

    /// Terminate the shell.
    pub fn kill(&mut self) {
        self.terminal.kill();
    }

    pub(crate) fn is_dragging(&self) -> bool {
        self.dragging
    }

    pub(crate) fn set_dragging(&mut self, dragging: bool) {
        self.dragging = dragging;
    }

    pub(crate) fn accumulate_scroll(&mut self, delta: ScrollDelta, line_height: Pixels) -> i32 {
        scroll_lines_for(delta, line_height, &mut self.scroll_accumulator)
    }

    fn spawn_pty_task(rx: async_channel::Receiver<PtyEvent>, cx: &mut Context<Self>) -> gpui::Task<()> {
        cx.spawn(async move |this, cx| {
            let mut coalescer = Coalescer::default();
            while let Ok(event) = rx.recv().await {
                match event {
                    PtyEvent::Wakeup => {
                        // At most one repaint per interval while output is heavy.
                        if !coalescer.offer(Instant::now())
                            && let Some(deadline) = coalescer.deadline()
                        {
                            let wait = deadline.saturating_duration_since(Instant::now());
                            cx.background_executor().timer(wait).await;
                            coalescer.flush(Instant::now());
                        }
                        if this.update(cx, |_, cx| cx.notify()).is_err() {
                            break;
                        }
                    }
                    PtyEvent::Exit(code) => {
                        let _ = this.update(cx, |view, cx| view.on_exit(code, cx));
                        break;
                    }
                }
            }
        })
    }

    fn spawn_term_task(channels: &TerminalChannels, cx: &mut Context<Self>) -> gpui::Task<()> {
        let rx = channels.term.clone();
        cx.spawn(async move |this, cx| {
            while let Ok(event) = rx.recv().await {
                if this.update(cx, |view, cx| view.on_term_event(event, cx)).is_err() {
                    break;
                }
            }
        })
    }

    fn on_exit(&mut self, code: u32, cx: &mut Context<Self>) {
        self.alive = false;
        self.exit_code = Some(code);
        self.terminal.print_local(&format!("\r\n\x1b[90m[process exited: {code}]\x1b[0m\r\n"));
        cx.emit(TerminalEvent::Exit(code));
        cx.notify();
    }

    fn on_term_event(&mut self, event: AlacEvent, cx: &mut Context<Self>) {
        match event {
            AlacEvent::Title(title) => {
                self.terminal.set_title(title.clone());
                cx.emit(TerminalEvent::TitleChanged(title));
                cx.notify();
            }
            AlacEvent::ResetTitle => {
                let title = self.terminal.title();
                cx.emit(TerminalEvent::TitleChanged(title));
            }
            AlacEvent::PtyWrite(text) => self.terminal.write(text.as_bytes()),
            AlacEvent::ClipboardStore(_, text) => cx.write_to_clipboard(ClipboardItem::new_string(text)),
            AlacEvent::ClipboardLoad(_, format) => {
                let text = cx.read_from_clipboard().and_then(|item| item.text()).unwrap_or_default();
                self.terminal.write(format(&text).as_bytes());
            }
            AlacEvent::Bell => cx.emit(TerminalEvent::Bell),
            AlacEvent::Exit => {
                self.terminal.kill();
            }
            AlacEvent::Wakeup
            | AlacEvent::MouseCursorDirty
            | AlacEvent::CursorBlinkingChange
            | AlacEvent::ColorRequest(..)
            | AlacEvent::TextAreaSizeRequest(_)
            | AlacEvent::ChildExit(_) => {}
        }
    }

    fn on_key_down(&mut self, event: &KeyDownEvent, _window: &mut Window, cx: &mut Context<Self>) {
        let ks = &event.keystroke;
        let m = &ks.modifiers;

        // Command combinations that are the terminal's, not the app's.
        if m.platform && !m.alt {
            let handled = match ks.key.as_str() {
                "c" if !m.shift => {
                    if !self.copy(cx) {
                        // No selection: Cmd+C still interrupts, as in the old app.
                        self.terminal.write(b"\x03");
                    }
                    true
                }
                "v" if !m.shift => {
                    self.paste(cx);
                    true
                }
                "k" if !m.shift => {
                    self.clear(cx);
                    true
                }
                "left" | "right" => {
                    let app_cursor = self.terminal.mode().contains(TermMode::APP_CURSOR);
                    let bytes: &[u8] = match (ks.key.as_str(), app_cursor) {
                        ("left", true) => b"\x1bOH",
                        ("left", false) => b"\x1b[H",
                        (_, true) => b"\x1bOF",
                        (_, false) => b"\x1b[F",
                    };
                    self.terminal.write(bytes);
                    true
                }
                _ => false,
            };
            if handled {
                cx.stop_propagation();
                cx.notify();
            }
            return;
        }

        // Option+arrow moves by word; readline understands ESC b / ESC f.
        if m.alt && !m.control && !m.platform && matches!(ks.key.as_str(), "left" | "right") {
            self.terminal.write(if ks.key == "left" { b"\x1bb" } else { b"\x1bf" });
            cx.stop_propagation();
            cx.notify();
            return;
        }

        if self.terminal.key_down(ks, self.option_as_meta) {
            self.terminal.clear_selection();
            cx.stop_propagation();
            cx.notify();
        }
        // Anything else with a character goes through the text input
        // handler (`replace_text_in_range`), which handles IME and dead keys.
    }
}

impl EventEmitter<TerminalEvent> for TerminalView {}

impl Focusable for TerminalView {
    fn focus_handle(&self, _cx: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

impl Render for TerminalView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let style = self.style.clone().unwrap_or_else(|| TerminalStyle::from_theme(cx));
        let element = TerminalElement::new(cx.entity(), self.terminal.clone(), self.focus_handle.clone(), style);
        div()
            .id("boss-terminal")
            .size_full()
            .overflow_hidden()
            .track_focus(&self.focus_handle)
            .on_key_down(cx.listener(|this, event, window, cx| this.on_key_down(event, window, cx)))
            .child(element)
    }
}

impl EntityInputHandler for TerminalView {
    fn text_for_range(
        &mut self,
        _range: Range<usize>,
        _adjusted: &mut Option<Range<usize>>,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<String> {
        None
    }

    fn selected_text_range(
        &mut self,
        _ignore_disabled: bool,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<UTF16Selection> {
        Some(UTF16Selection { range: 0..0, reversed: false })
    }

    fn marked_text_range(&self, _window: &mut Window, _cx: &mut Context<Self>) -> Option<Range<usize>> {
        None
    }

    fn unmark_text(&mut self, _window: &mut Window, _cx: &mut Context<Self>) {}

    fn replace_text_in_range(
        &mut self,
        _range: Option<Range<usize>>,
        text: &str,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.terminal.write(text.as_bytes());
        self.terminal.clear_selection();
        cx.notify();
    }

    fn replace_and_mark_text_in_range(
        &mut self,
        _range: Option<Range<usize>>,
        _new_text: &str,
        _new_selected_range: Option<Range<usize>>,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) {
        // IME composition preview is not drawn; the committed text arrives
        // through `replace_text_in_range`.
    }

    fn bounds_for_range(
        &mut self,
        _range: Range<usize>,
        element_bounds: Bounds<Pixels>,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<Bounds<Pixels>> {
        Some(element_bounds)
    }

    fn character_index_for_point(
        &mut self,
        _point: gpui::Point<Pixels>,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<usize> {
        None
    }
}

impl Drop for TerminalView {
    fn drop(&mut self) {
        // The reader and waiter threads exit on EOF once the child is gone.
        self.terminal.kill();
    }
}
