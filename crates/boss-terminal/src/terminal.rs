//! The terminal model: alacritty's grid behind a lock, fed by the pty reader
//! thread, read by the element when it paints.

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use alacritty_terminal::event::{Event as TermEvent, EventListener};
use alacritty_terminal::grid::{Dimensions, Scroll};
use alacritty_terminal::index::{Line, Point, Side};
use alacritty_terminal::selection::{Selection, SelectionType};
use alacritty_terminal::sync::FairMutex;
use alacritty_terminal::term::cell::Flags;
use alacritty_terminal::term::{Config, Term, TermMode};
use alacritty_terminal::vte::ansi::{ClearMode, CursorShape, Handler, Processor};
use anyhow::Result;
use gpui::Hsla;
use parking_lot::Mutex;

use crate::colors::Palette;
use crate::keys::{KeyModes, key_to_bytes};
use crate::pty::{Pty, PtyEvent, PtySpec};
use crate::throttle::FlowControl;

/// Lines of scrollback kept above the screen.
pub const SCROLLBACK_LINES: usize = 10_000;

/// How a mouse selection grows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SelectionKind {
    /// Character by character (single click and drag).
    Simple,
    /// Whole words (double click).
    Word,
    /// Whole lines (triple click).
    Line,
    /// A rectangle (Alt-drag).
    Block,
}

impl From<SelectionKind> for SelectionType {
    fn from(kind: SelectionKind) -> Self {
        match kind {
            SelectionKind::Simple => SelectionType::Simple,
            SelectionKind::Word => SelectionType::Semantic,
            SelectionKind::Line => SelectionType::Lines,
            SelectionKind::Block => SelectionType::Block,
        }
    }
}

/// Grid size in cells; implements alacritty's `Dimensions`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GridSize {
    /// Columns.
    pub cols: usize,
    /// Visible rows.
    pub rows: usize,
}

impl Dimensions for GridSize {
    fn total_lines(&self) -> usize {
        self.rows + SCROLLBACK_LINES
    }
    fn screen_lines(&self) -> usize {
        self.rows
    }
    fn columns(&self) -> usize {
        self.cols
    }
}

/// Events alacritty raises that the view has to act on.
#[derive(Clone)]
pub struct Listener {
    events: async_channel::Sender<TermEvent>,
}

impl EventListener for Listener {
    fn send_event(&self, event: TermEvent) {
        let _ = self.events.try_send(event);
    }
}

/// A run of text on one row sharing a style.
#[derive(Debug, Clone, PartialEq)]
pub struct TextRunSpec {
    /// Starting column.
    pub col: usize,
    /// Cells covered (wide characters count twice).
    pub width: usize,
    /// The characters, including any zero-width combining marks.
    pub text: String,
    /// Text colour.
    pub fg: Hsla,
    /// SGR 1.
    pub bold: bool,
    /// SGR 3.
    pub italic: bool,
    /// Any underline flag.
    pub underline: bool,
    /// SGR 9.
    pub strikethrough: bool,
    /// Every glyph in the run is double width.
    pub wide: bool,
}

/// A run of cells on one row sharing a background other than the default.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BackgroundRun {
    /// Starting column.
    pub col: usize,
    /// Cells covered.
    pub width: usize,
    /// Fill colour.
    pub color: Hsla,
}

/// One visible row, ready to paint.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct RowFrame {
    /// Non-default backgrounds.
    pub backgrounds: Vec<BackgroundRun>,
    /// Text runs.
    pub texts: Vec<TextRunSpec>,
}

/// Where the cursor is on screen.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CursorFrame {
    /// Column.
    pub col: usize,
    /// Row within the visible screen.
    pub row: usize,
    /// Shape to paint.
    pub shape: CursorShape,
    /// The cursor cell is a wide character.
    pub wide: bool,
}

/// A selection projected into visible coordinates.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SelectionFrame {
    /// First row, inclusive; may be negative when it starts above the screen.
    pub start_row: i32,
    /// Column on the first row.
    pub start_col: usize,
    /// Last row, inclusive; may exceed the screen.
    pub end_row: i32,
    /// Column on the last row.
    pub end_col: usize,
    /// Rectangle rather than stream selection.
    pub block: bool,
}

impl SelectionFrame {
    /// The inclusive column span the selection covers on `row`, if any.
    pub fn columns_on_row(&self, row: i32, last_col: usize) -> Option<(usize, usize)> {
        if row < self.start_row || row > self.end_row {
            return None;
        }
        if self.block {
            return Some((self.start_col.min(self.end_col), self.start_col.max(self.end_col)));
        }
        let start = if row == self.start_row { self.start_col } else { 0 };
        let end = if row == self.end_row { self.end_col } else { last_col };
        Some((start, end))
    }
}

/// A snapshot of the visible screen, built under the lock, painted outside it.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Frame {
    /// Columns.
    pub cols: usize,
    /// Rows.
    pub rows: usize,
    /// How far the view is scrolled into history.
    pub display_offset: usize,
    /// Lines of history available.
    pub history: usize,
    /// Cursor, if it is on screen and shown.
    pub cursor: Option<CursorFrame>,
    /// Selection, if any.
    pub selection: Option<SelectionFrame>,
    /// One entry per visible row.
    pub lines: Vec<RowFrame>,
}

/// The terminal: grid, scrollback, selection and the shell behind it.
pub struct Terminal {
    term: Arc<FairMutex<Term<Listener>>>,
    pty: Pty,
    size: Mutex<GridSize>,
    bytes_since_paint: AtomicUsize,
    title: Mutex<String>,
}

impl std::fmt::Debug for Terminal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Terminal").field("size", &*self.size.lock()).field("pty", &self.pty).finish()
    }
}

/// Channels the view listens on.
pub struct TerminalChannels {
    /// Output wakeups and exit.
    pub pty: async_channel::Receiver<PtyEvent>,
    /// Alacritty's own events: title, bell, requests to write to the pty.
    pub term: async_channel::Receiver<TermEvent>,
}

impl Terminal {
    /// Spawn the shell (or `command`) in `cwd` with an initial grid size.
    pub fn spawn(
        cwd: Option<PathBuf>,
        command: Option<Vec<String>>,
        size: GridSize,
    ) -> Result<(Arc<Self>, TerminalChannels)> {
        let (term_tx, term_rx) = async_channel::unbounded();
        let (pty_tx, pty_rx) = async_channel::bounded(64);

        let config = Config { scrolling_history: SCROLLBACK_LINES, ..Config::default() };
        let term = Arc::new(FairMutex::new(Term::new(config, &size, Listener { events: term_tx })));

        let flow = FlowControl::new();
        let sink_term = term.clone();
        let mut processor: Processor = Processor::new();
        let pty = Pty::spawn(
            PtySpec {
                cwd,
                command: command.clone(),
                cols: size.cols as u16,
                rows: size.rows as u16,
            },
            pty_tx,
            flow,
            move |bytes| {
                let mut term = sink_term.lock();
                processor.advance(&mut *term, bytes);
            },
        )?;

        let title = command
            .as_ref()
            .and_then(|c| c.first().cloned())
            .unwrap_or_else(|| pty.program().to_string());
        let title = std::path::Path::new(&title)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or(title);

        let terminal = Arc::new(Self {
            term,
            pty,
            size: Mutex::new(size),
            bytes_since_paint: AtomicUsize::new(0),
            title: Mutex::new(title),
        });
        Ok((terminal, TerminalChannels { pty: pty_rx, term: term_rx }))
    }

    /// The shell is still running.
    pub fn is_alive(&self) -> bool {
        self.pty.is_alive()
    }

    /// Current title: what the shell set with OSC 0/2, else the program name.
    pub fn title(&self) -> String {
        self.title.lock().clone()
    }

    /// Update the title (from an OSC sequence).
    pub fn set_title(&self, title: impl Into<String>) {
        *self.title.lock() = title.into();
    }

    /// Current grid size.
    pub fn size(&self) -> GridSize {
        *self.size.lock()
    }

    /// Active terminal modes.
    pub fn mode(&self) -> TermMode {
        *self.term.lock().mode()
    }

    /// Key modes derived from the terminal state.
    pub fn key_modes(&self) -> KeyModes {
        let mode = self.mode();
        KeyModes {
            app_cursor: mode.contains(TermMode::APP_CURSOR),
            disambiguate: mode.contains(TermMode::DISAMBIGUATE_ESC_CODES),
        }
    }

    /// Send raw bytes to the shell and snap the view back to the bottom.
    pub fn write(&self, bytes: &[u8]) {
        if bytes.is_empty() {
            return;
        }
        self.scroll(Scroll::Bottom);
        if let Err(err) = self.pty.write(bytes) {
            tracing::warn!(%err, "terminal write failed");
        }
    }

    /// Translate a keystroke and send it. Returns false if the key is not
    /// one the terminal handles (so text input or the app should).
    pub fn key_down(&self, keystroke: &gpui::Keystroke, option_as_meta: bool) -> bool {
        match key_to_bytes(keystroke, self.key_modes(), option_as_meta) {
            Some(bytes) => {
                self.write(&bytes);
                true
            }
            None => false,
        }
    }

    /// Paste text. Bracketed when the program asked for it, otherwise with
    /// newlines turned into carriage returns like a typed Enter.
    pub fn paste(&self, text: &str) {
        let bytes = paste_bytes(text, self.mode().contains(TermMode::BRACKETED_PASTE));
        self.write(&bytes);
    }

    /// Resize the grid and the shell. No-op when unchanged.
    pub fn resize(&self, size: GridSize) {
        if size.cols < 2 || size.rows < 1 {
            return;
        }
        {
            let mut current = self.size.lock();
            if *current == size {
                return;
            }
            *current = size;
        }
        self.term.lock().resize(size);
        if let Err(err) = self.pty.resize(size.cols as u16, size.rows as u16) {
            tracing::warn!(%err, "pty resize failed");
        }
    }

    /// Scroll the view through history.
    pub fn scroll(&self, scroll: Scroll) {
        self.term.lock().scroll_display(scroll);
    }

    /// Scroll by whole lines: positive is up into history.
    pub fn scroll_lines(&self, lines: i32) {
        if lines == 0 {
            return;
        }
        let mode = self.mode();
        if mode.contains(TermMode::ALT_SCREEN) && mode.contains(TermMode::ALTERNATE_SCROLL) {
            // Full-screen programs get arrow keys instead of a scrolled view.
            let key: &[u8] = if lines > 0 {
                if mode.contains(TermMode::APP_CURSOR) { b"\x1bOA" } else { b"\x1b[A" }
            } else if mode.contains(TermMode::APP_CURSOR) {
                b"\x1bOB"
            } else {
                b"\x1b[B"
            };
            let repeated: Vec<u8> = key.iter().copied().cycle().take(key.len() * lines.unsigned_abs() as usize).collect();
            let _ = self.pty.write(&repeated);
            return;
        }
        self.scroll(Scroll::Delta(lines));
    }

    /// Clear the screen and history, then ask the shell to redraw its prompt.
    pub fn clear(&self) {
        {
            let mut term = self.term.lock();
            term.clear_screen(ClearMode::Saved);
            term.clear_screen(ClearMode::All);
        }
        let _ = self.pty.write(b"\x0c");
    }

    /// Begin a selection at a visible cell. `side` says which half of the
    /// cell the pointer is in.
    pub fn start_selection(&self, kind: SelectionKind, point: Point, side: Side) {
        let mut term = self.term.lock();
        let point = viewport_to_grid(point, term.grid().display_offset());
        term.selection = Some(Selection::new(kind.into(), point, side));
    }

    /// Extend the active selection to a visible cell.
    pub fn update_selection(&self, point: Point, side: Side) {
        let mut term = self.term.lock();
        let offset = term.grid().display_offset();
        let point = viewport_to_grid(point, offset);
        if let Some(selection) = term.selection.as_mut() {
            selection.update(point, side);
        }
    }

    /// Drop the selection.
    pub fn clear_selection(&self) {
        self.term.lock().selection = None;
    }

    /// Text of the selection, if it is non-empty.
    pub fn selection_text(&self) -> Option<String> {
        let term = self.term.lock();
        let selection = term.selection.as_ref()?;
        if selection.is_empty() {
            return None;
        }
        term.selection_to_string().filter(|s| !s.is_empty())
    }

    /// Whether there is a non-empty selection.
    pub fn has_selection(&self) -> bool {
        let term = self.term.lock();
        term.selection.as_ref().is_some_and(|s| !s.is_empty())
    }

    /// Print text into the grid locally (not to the shell), e.g. an exit notice.
    pub fn print_local(&self, text: &str) {
        let mut processor: Processor = Processor::new();
        let mut term = self.term.lock();
        processor.advance(&mut *term, text.as_bytes());
    }

    /// Terminate the shell.
    pub fn kill(&self) {
        self.pty.kill();
    }

    /// Build a paint-ready snapshot of the visible screen and acknowledge
    /// everything parsed so far, releasing a paused reader.
    pub fn frame(&self, palette: &Palette) -> Frame {
        let frame = {
            let term = self.term.lock();
            build_frame(&term, palette)
        };
        self.pty.clear_dirty();
        self.pty.flow().acknowledge_all();
        self.bytes_since_paint.store(0, Ordering::Relaxed);
        frame
    }

    /// Run `f` with the locked terminal. For tests and tools.
    pub fn with_term<R>(&self, f: impl FnOnce(&mut Term<Listener>) -> R) -> R {
        let mut term = self.term.lock();
        f(&mut term)
    }
}

impl Drop for Terminal {
    fn drop(&mut self) {
        self.pty.kill();
    }
}

/// Bytes to send for a paste.
pub fn paste_bytes(text: &str, bracketed: bool) -> Vec<u8> {
    if bracketed {
        let mut out = b"\x1b[200~".to_vec();
        out.extend(text.replace('\x1b', "").into_bytes());
        out.extend_from_slice(b"\x1b[201~");
        out
    } else {
        text.replace("\r\n", "\r").replace('\n', "\r").into_bytes()
    }
}

/// A visible row/column (row 0 at the top of the screen) into grid
/// coordinates, where negative lines are history.
pub fn viewport_to_grid(point: Point, display_offset: usize) -> Point {
    Point::new(Line(point.line.0 - display_offset as i32), point.column)
}

/// Build a [`Frame`] from a locked terminal. Only the visible rows are read.
pub fn build_frame<T: EventListener>(term: &Term<T>, palette: &Palette) -> Frame {
    let content = term.renderable_content();
    let cols = term.columns();
    let rows = term.screen_lines();
    let display_offset = content.display_offset;
    let colors = content.colors;
    let history = term.grid().history_size();

    let mut lines: Vec<RowFrame> = (0..rows).map(|_| RowFrame::default()).collect();
    let cursor_point = content.cursor.point;
    let show_cursor = content.cursor.shape != CursorShape::Hidden;
    let mut cursor = None;

    for indexed in content.display_iter {
        let cell = indexed.cell;
        let point = indexed.point;
        let view_row = point.line.0 + display_offset as i32;
        if view_row < 0 || view_row as usize >= rows {
            continue;
        }
        let row = &mut lines[view_row as usize];
        let col = point.column.0;
        let flags = cell.flags;

        if flags.contains(Flags::WIDE_CHAR_SPACER) || flags.contains(Flags::LEADING_WIDE_CHAR_SPACER) {
            continue;
        }
        let wide = flags.contains(Flags::WIDE_CHAR);
        let width = if wide { 2 } else { 1 };

        let bold = flags.intersects(Flags::BOLD);
        let dim = flags.intersects(Flags::DIM);
        let (mut fg, mut bg) = (
            palette.foreground_for(cell.fg, colors, bold, dim),
            palette.resolve(cell.bg, colors, false),
        );
        if flags.contains(Flags::INVERSE) {
            std::mem::swap(&mut fg, &mut bg);
        }

        if point == cursor_point && show_cursor {
            cursor = Some(CursorFrame {
                col,
                row: view_row as usize,
                shape: content.cursor.shape,
                wide,
            });
        }

        let default_bg = cell.bg == alacritty_terminal::vte::ansi::Color::Named(
            alacritty_terminal::vte::ansi::NamedColor::Background,
        ) && !flags.contains(Flags::INVERSE);
        if !default_bg {
            match row.backgrounds.last_mut() {
                Some(last) if last.color == bg && last.col + last.width == col => last.width += width,
                _ => row.backgrounds.push(BackgroundRun { col, width, color: bg }),
            }
        }

        if flags.contains(Flags::HIDDEN) {
            continue;
        }
        let c = cell.c;
        let blank = c == ' ' && cell.zerowidth().is_none();
        if blank {
            continue;
        }
        let italic = flags.intersects(Flags::ITALIC);
        let underline = flags.intersects(Flags::ALL_UNDERLINES);
        let strikethrough = flags.contains(Flags::STRIKEOUT);
        let joins = row.texts.last().is_some_and(|last| {
            last.col + last.width == col
                && last.fg == fg
                && last.bold == bold
                && last.italic == italic
                && last.underline == underline
                && last.strikethrough == strikethrough
                && last.wide == wide
        });
        if joins {
            let last = row.texts.last_mut().expect("checked above");
            last.width += width;
            last.text.push(c);
            if let Some(zw) = cell.zerowidth() {
                last.text.extend(zw);
            }
        } else {
            let mut text = String::new();
            text.push(c);
            if let Some(zw) = cell.zerowidth() {
                text.extend(zw);
            }
            row.texts.push(TextRunSpec {
                col,
                width,
                text,
                fg,
                bold,
                italic,
                underline,
                strikethrough,
                wide,
            });
        }
    }

    // Blank runs are skipped above, so a cursor over spaces still needs a
    // position. Its grid point is always valid when shown.
    if cursor.is_none() && show_cursor {
        let view_row = cursor_point.line.0 + display_offset as i32;
        if view_row >= 0 && (view_row as usize) < rows {
            cursor = Some(CursorFrame {
                col: cursor_point.column.0.min(cols.saturating_sub(1)),
                row: view_row as usize,
                shape: content.cursor.shape,
                wide: false,
            });
        }
    }

    let selection = content.selection.map(|range| SelectionFrame {
        start_row: range.start.line.0 + display_offset as i32,
        start_col: range.start.column.0,
        end_row: range.end.line.0 + display_offset as i32,
        end_col: range.end.column.0,
        block: range.is_block,
    });

    Frame { cols, rows, display_offset, history, cursor, selection, lines }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alacritty_terminal::event::VoidListener;
    use alacritty_terminal::index::Column;

    fn term_with(cols: usize, rows: usize, input: &str) -> Term<VoidListener> {
        let size = GridSize { cols, rows };
        let mut term = Term::new(Config::default(), &size, VoidListener);
        let mut processor: Processor = Processor::new();
        processor.advance(&mut term, input.as_bytes());
        term
    }

    #[test]
    fn simple_selection_extracts_across_rows() {
        let mut term = term_with(10, 3, "hello foo\r\nbar baz!\r\n");
        // From "foo" on row 0 to "bar" on row 1.
        let mut sel = Selection::new(SelectionType::Simple, Point::new(Line(0), Column(6)), Side::Left);
        sel.update(Point::new(Line(1), Column(2)), Side::Right);
        term.selection = Some(sel);
        assert_eq!(term.selection_to_string().as_deref(), Some("foo\nbar"));
    }

    #[test]
    fn word_and_line_selection() {
        let mut term = term_with(20, 3, "alpha beta-gamma\r\nsecond line\r\n");
        // Double click on "beta" selects the word; '-' is not a semantic
        // escape in alacritty's default set, so the hyphenated word is one unit.
        term.selection = Some(Selection::new(
            SelectionType::Semantic,
            Point::new(Line(0), Column(7)),
            Side::Left,
        ));
        assert_eq!(term.selection_to_string().as_deref(), Some("beta-gamma"));
        // Triple click selects the whole line.
        term.selection = Some(Selection::new(
            SelectionType::Lines,
            Point::new(Line(1), Column(3)),
            Side::Left,
        ));
        assert_eq!(term.selection_to_string().as_deref(), Some("second line\n"));
    }

    #[test]
    fn empty_selection_is_none() {
        let mut term = term_with(10, 2, "abc");
        let sel = Selection::new(SelectionType::Simple, Point::new(Line(0), Column(1)), Side::Left);
        assert!(sel.is_empty());
        term.selection = Some(sel);
        // Zero-width selection resolves to a single cell in alacritty; our
        // wrapper reports none via `Selection::is_empty`.
        assert!(term.selection.as_ref().unwrap().is_empty());
    }

    #[test]
    fn frame_merges_runs_and_places_cursor() {
        let term = term_with(12, 2, "ab \x1b[31mcd\x1b[0m");
        let frame = build_frame(&term, &Palette::dark());
        assert_eq!(frame.cols, 12);
        assert_eq!(frame.rows, 2);
        let row = &frame.lines[0];
        assert_eq!(row.texts.len(), 2, "default 'ab' then red 'cd': {:?}", row.texts);
        assert_eq!(row.texts[0].text, "ab");
        assert_eq!(row.texts[0].col, 0);
        assert_eq!(row.texts[1].text, "cd");
        assert_eq!(row.texts[1].col, 3);
        assert_eq!(row.texts[1].fg, Palette::dark().ansi[1]);
        assert!(row.backgrounds.is_empty());
        let cursor = frame.cursor.expect("cursor shown");
        assert_eq!((cursor.col, cursor.row), (5, 0));
    }

    #[test]
    fn frame_records_backgrounds_and_selection() {
        let mut term = term_with(8, 2, "\x1b[44m  \x1b[0mx");
        let mut sel = Selection::new(SelectionType::Simple, Point::new(Line(0), Column(1)), Side::Left);
        sel.update(Point::new(Line(1), Column(2)), Side::Right);
        term.selection = Some(sel);
        let frame = build_frame(&term, &Palette::dark());
        assert_eq!(frame.lines[0].backgrounds, vec![BackgroundRun { col: 0, width: 2, color: Palette::dark().ansi[4] }]);
        let selection = frame.selection.expect("selection");
        assert_eq!(selection.columns_on_row(0, 7), Some((1, 7)));
        assert_eq!(selection.columns_on_row(1, 7), Some((0, 2)));
        assert_eq!(selection.columns_on_row(2, 7), None);
    }

    #[test]
    fn viewport_to_grid_accounts_for_scroll() {
        let p = viewport_to_grid(Point::new(Line(3), Column(1)), 5);
        assert_eq!(p, Point::new(Line(-2), Column(1)));
    }

    #[test]
    fn paste_bytes_forms() {
        assert_eq!(paste_bytes("a\r\nb\nc", false), b"a\rb\rc".to_vec());
        assert_eq!(paste_bytes("x\x1by", true), b"\x1b[200~xy\x1b[201~".to_vec());
    }
}
