//! The GPUI element that paints a [`Terminal`].
//!
//! Layout fills its container. Prepaint measures the monospace cell, derives
//! cols/rows from the bounds, resizes the terminal and pty when that changed,
//! and snapshots the visible rows. Paint draws backgrounds, selection, text
//! runs and the cursor, and registers mouse listeners.

use std::sync::Arc;

use alacritty_terminal::index::{Column, Line, Point, Side};
use alacritty_terminal::vte::ansi::CursorShape;
use gpui::{
    App, Bounds, ClipboardItem, ContentMask, CursorStyle, DispatchPhase, Element, ElementId,
    ElementInputHandler, Entity, FocusHandle, Font, GlobalElementId, Hitbox, HitboxBehavior, Hsla,
    InspectorElementId, IntoElement, LayoutId, Modifiers, MouseButton, MouseDownEvent,
    MouseMoveEvent, MouseUpEvent, Pixels, Point as GpuiPoint, ScrollDelta, ScrollWheelEvent,
    SharedString, StrikethroughStyle, Style, TextAlign, TextRun, UnderlineStyle, Window, fill,
    outline, point, px, relative, size,
};
use gpui_component::ActiveTheme;

use crate::colors::Palette;
use crate::mouse::{MouseButtonCode, MouseEventKind, MouseModifiers, MouseReport};
use crate::terminal::{Frame, GridSize, SelectionKind, Terminal};
use crate::view::TerminalView;

/// Map a GPUI button onto the code a program is told about. Buttons past
/// the third are not reported.
pub fn report_button(button: MouseButton) -> Option<MouseButtonCode> {
    match button {
        MouseButton::Left => Some(MouseButtonCode::Left),
        MouseButton::Middle => Some(MouseButtonCode::Middle),
        MouseButton::Right => Some(MouseButtonCode::Right),
        _ => None,
    }
}

/// GPUI modifiers as the mouse protocol's three bits.
pub fn report_modifiers(m: &Modifiers) -> MouseModifiers {
    MouseModifiers { shift: m.shift, alt: m.alt, control: m.control }
}

/// Font and cell metrics the terminal paints with.
#[derive(Debug, Clone, PartialEq)]
pub struct TerminalStyle {
    /// Monospace font.
    pub font: Font,
    /// Font size in pixels.
    pub font_size: Pixels,
    /// Row height in pixels (whole pixels).
    pub line_height: Pixels,
}

impl TerminalStyle {
    /// Take the monospace font from the app theme; rows are 1.35 em, rounded.
    pub fn from_theme(cx: &App) -> Self {
        let theme = cx.theme();
        let font_size = theme.mono_font_size;
        Self {
            font: gpui::font(theme.mono_font_family.clone()),
            font_size,
            line_height: px((f32::from(font_size) * 1.35).round()),
        }
    }
}

/// Columns and rows that fit in `area` given one cell's size. Never below
/// 2x1 so a collapsed pane does not zero the grid.
pub fn grid_dimensions(area: gpui::Size<Pixels>, cell_width: Pixels, line_height: Pixels) -> GridSize {
    let cols = if cell_width > px(0.) { (f32::from(area.width) / f32::from(cell_width)).floor() as usize } else { 0 };
    let rows = if line_height > px(0.) { (f32::from(area.height) / f32::from(line_height)).floor() as usize } else { 0 };
    GridSize { cols: cols.max(2), rows: rows.max(1) }
}

/// Pointer position relative to the grid origin, to a visible cell and side.
pub fn cell_at(
    pos: GpuiPoint<Pixels>,
    cell_width: Pixels,
    line_height: Pixels,
    grid: GridSize,
) -> (Point, Side) {
    let x = f32::from(pos.x).max(0.0);
    let y = f32::from(pos.y).max(0.0);
    let cw = f32::from(cell_width).max(1.0);
    let lh = f32::from(line_height).max(1.0);
    let mut col = (x / cw).floor() as usize;
    let mut side = if x % cw > cw / 2.0 { Side::Right } else { Side::Left };
    let last_col = grid.cols.saturating_sub(1);
    if col > last_col {
        col = last_col;
        side = Side::Right;
    }
    let row = ((y / lh).floor() as usize).min(grid.rows.saturating_sub(1));
    (Point::new(Line(row as i32), Column(col)), side)
}

/// Paints one terminal; create a fresh one every render.
pub struct TerminalElement {
    view: Entity<TerminalView>,
    terminal: Arc<Terminal>,
    focus: FocusHandle,
    style: TerminalStyle,
}

/// What prepaint computed for paint.
pub struct Layout {
    hitbox: Hitbox,
    frame: Frame,
    palette: Palette,
    cell_width: Pixels,
    line_height: Pixels,
    focused: bool,
    /// Blink phase: false means the cursor is in its "off" half.
    cursor_visible: bool,
    /// The program is reading the mouse, so the pointer is an arrow and
    /// drags do not select.
    mouse_reporting: bool,
}

impl TerminalElement {
    /// A new element for `view`'s terminal.
    pub fn new(view: Entity<TerminalView>, terminal: Arc<Terminal>, focus: FocusHandle, style: TerminalStyle) -> Self {
        Self { view, terminal, focus, style }
    }

    fn measure_cell(&self, window: &Window) -> Pixels {
        let text_system = window.text_system();
        let font_id = text_system.resolve_font(&self.style.font);
        text_system
            .em_advance(font_id, self.style.font_size)
            .ok()
            .filter(|w| *w > px(0.))
            .unwrap_or_else(|| px((f32::from(self.style.font_size) * 0.6).round()))
    }

    fn register_mouse(&self, layout: &Layout, bounds: Bounds<Pixels>, window: &mut Window) {
        let origin = bounds.origin;
        let cell_width = layout.cell_width;
        let line_height = layout.line_height;
        let grid = GridSize { cols: layout.frame.cols.max(1), rows: layout.frame.rows.max(1) };
        let hitbox = layout.hitbox.clone();

        {
            let terminal = self.terminal.clone();
            let focus = self.focus.clone();
            let view = self.view.clone();
            let hitbox = hitbox.clone();
            window.on_mouse_event(move |event: &MouseDownEvent, phase, window, cx| {
                if phase != DispatchPhase::Bubble || !hitbox.is_hovered(window) {
                    return;
                }
                if !focus.is_focused(window) {
                    focus.focus(window, cx);
                }
                let (cell, side) = cell_at(event.position - origin, cell_width, line_height, grid);

                // Cmd+click opens a URL instead of selecting it. Checked
                // first so a link in a full-screen program still works.
                if event.button == MouseButton::Left
                    && event.modifiers.platform
                    && let Some(url) = terminal.link_at(cell)
                {
                    view.update(cx, |view, cx| view.open_link(&url, cx));
                    cx.stop_propagation();
                    return;
                }

                // The program asked for the mouse: hand the press over.
                if let Some(button) = report_button(event.button) {
                    let report = MouseReport {
                        button,
                        kind: MouseEventKind::Press,
                        col: cell.column.0,
                        row: cell.line.0.max(0) as usize,
                        modifiers: report_modifiers(&event.modifiers),
                    };
                    if terminal.report_mouse(&report) {
                        view.update(cx, |view, cx| {
                            view.set_reported_button(Some(button));
                            cx.notify();
                        });
                        cx.stop_propagation();
                        return;
                    }
                }

                if event.button != MouseButton::Left {
                    return;
                }
                let kind = match event.click_count {
                    0 => return,
                    1 if event.modifiers.alt => SelectionKind::Block,
                    1 => SelectionKind::Simple,
                    2 => SelectionKind::Word,
                    _ => SelectionKind::Line,
                };
                if event.click_count == 1 && event.modifiers.shift && terminal.has_selection() {
                    terminal.update_selection(cell, side);
                } else {
                    terminal.start_selection(kind, cell, side);
                }
                view.update(cx, |view, cx| {
                    view.set_dragging(true);
                    cx.notify();
                });
                cx.stop_propagation();
            });
        }

        {
            let terminal = self.terminal.clone();
            let view = self.view.clone();
            window.on_mouse_event(move |event: &MouseMoveEvent, phase, _window, cx| {
                if phase != DispatchPhase::Bubble {
                    return;
                }
                let (cell, side) = cell_at(event.position - origin, cell_width, line_height, grid);
                let col = cell.column.0;
                let row = cell.line.0.max(0) as usize;

                // A drag the program owns: report the motion, do not select.
                if let Some(button) = view.read(cx).reported_button() {
                    let report = MouseReport {
                        button,
                        kind: MouseEventKind::Motion,
                        col,
                        row,
                        modifiers: report_modifiers(&event.modifiers),
                    };
                    terminal.report_mouse(&report);
                    cx.stop_propagation();
                    return;
                }
                // Mode 1003 wants every move, button or not.
                if !event.dragging() {
                    let report = MouseReport {
                        button: MouseButtonCode::Left,
                        kind: MouseEventKind::Motion,
                        col,
                        row,
                        modifiers: report_modifiers(&event.modifiers),
                    };
                    terminal.report_mouse(&report);
                    return;
                }
                if !view.read(cx).is_dragging() {
                    return;
                }
                terminal.update_selection(cell, side);
                view.update(cx, |_, cx| cx.notify());
            });
        }

        {
            let terminal = self.terminal.clone();
            let view = self.view.clone();
            window.on_mouse_event(move |event: &MouseUpEvent, phase, _window, cx| {
                if phase != DispatchPhase::Bubble {
                    return;
                }
                // Release the button the program is tracking.
                if let Some(button) = view.read(cx).reported_button()
                    && report_button(event.button) == Some(button)
                {
                    let (cell, _) = cell_at(event.position - origin, cell_width, line_height, grid);
                    let report = MouseReport {
                        button,
                        kind: MouseEventKind::Release,
                        col: cell.column.0,
                        row: cell.line.0.max(0) as usize,
                        modifiers: report_modifiers(&event.modifiers),
                    };
                    terminal.report_mouse(&report);
                    view.update(cx, |view, cx| {
                        view.set_reported_button(None);
                        cx.notify();
                    });
                    cx.stop_propagation();
                    return;
                }
                if event.button != MouseButton::Left {
                    return;
                }
                if !view.read(cx).is_dragging() {
                    return;
                }
                view.update(cx, |view, cx| {
                    view.set_dragging(false);
                    // Copy on select, as the Electron app did: text moves
                    // between terminal and threads constantly.
                    if let Some(text) = terminal.selection_text() {
                        cx.write_to_clipboard(ClipboardItem::new_string(text));
                    }
                    cx.notify();
                });
            });
        }

        {
            let terminal = self.terminal.clone();
            let view = self.view.clone();
            window.on_mouse_event(move |event: &ScrollWheelEvent, phase, window, cx| {
                if phase != DispatchPhase::Bubble || !hitbox.is_hovered(window) {
                    return;
                }
                let lines = view.update(cx, |view, _| view.accumulate_scroll(event.delta, line_height));
                if lines == 0 {
                    cx.stop_propagation();
                    return;
                }
                // A program reading the mouse gets wheel buttons 64/65, one
                // per line, instead of the view scrolling.
                if terminal.mouse_reporting() && !event.modifiers.shift {
                    let (cell, _) = cell_at(event.position - origin, cell_width, line_height, grid);
                    let button = if lines > 0 { MouseButtonCode::WheelUp } else { MouseButtonCode::WheelDown };
                    let report = MouseReport {
                        button,
                        kind: MouseEventKind::Press,
                        col: cell.column.0,
                        row: cell.line.0.max(0) as usize,
                        modifiers: report_modifiers(&event.modifiers),
                    };
                    for _ in 0..lines.unsigned_abs() {
                        terminal.report_mouse(&report);
                    }
                    cx.stop_propagation();
                    return;
                }
                terminal.scroll_lines(lines);
                view.update(cx, |_, cx| cx.notify());
                cx.stop_propagation();
            });
        }
    }

    fn paint_frame(&self, layout: &mut Layout, bounds: Bounds<Pixels>, window: &mut Window, cx: &mut App) {
        let layout_cursor_visible = layout.cursor_visible;
        let Layout { frame, palette, cell_width, line_height, focused, .. } = &*layout;
        let cell_width = *cell_width;
        let line_height = *line_height;
        let origin = bounds.origin;
        let cell_bounds = |col: usize, row: usize, width: usize| -> Bounds<Pixels> {
            Bounds::new(
                point(origin.x + cell_width * col as f32, origin.y + line_height * row as f32),
                size(cell_width * width as f32, line_height),
            )
        };

        window.paint_quad(fill(bounds, palette.background));

        for (row, line) in frame.lines.iter().enumerate() {
            for bg in &line.backgrounds {
                window.paint_quad(fill(cell_bounds(bg.col, row, bg.width), bg.color));
            }
        }

        if let Some(selection) = &frame.selection {
            let last_col = frame.cols.saturating_sub(1);
            for row in 0..frame.rows {
                if let Some((start, end)) = selection.columns_on_row(row as i32, last_col) {
                    let end = end.min(last_col);
                    if end >= start {
                        let mut color = palette.selection;
                        color.a = color.a.clamp(0.35, 0.6);
                        window.paint_quad(fill(cell_bounds(start, row, end - start + 1), color));
                    }
                }
            }
        }

        let cursor_cell = frame.cursor.filter(|_| frame.display_offset == 0);
        // In the "off" half of the blink the cursor is simply not drawn;
        // the glyph under it renders normally.
        let cursor_cell = cursor_cell.filter(|_| layout_cursor_visible);
        if let (Some(cursor), true) = (cursor_cell, *focused) {
            let width = if cursor.wide { 2 } else { 1 };
            let cursor_bounds = cell_bounds(cursor.col, cursor.row, width);
            match cursor.shape {
                CursorShape::Block | CursorShape::HollowBlock => {
                    window.paint_quad(fill(cursor_bounds, palette.cursor));
                }
                CursorShape::Underline => {
                    let mut b = cursor_bounds;
                    b.origin.y += line_height - px(2.);
                    b.size.height = px(2.);
                    window.paint_quad(fill(b, palette.cursor));
                }
                CursorShape::Beam => {
                    let mut b = cursor_bounds;
                    b.size.width = px(2.);
                    window.paint_quad(fill(b, palette.cursor));
                }
                CursorShape::Hidden => {}
            }
        } else if let Some(cursor) = cursor_cell {
            let width = if cursor.wide { 2 } else { 1 };
            window.paint_quad(outline(cell_bounds(cursor.col, cursor.row, width), palette.cursor, Default::default()));
        }

        let block_cursor = cursor_cell.filter(|c| *focused && matches!(c.shape, CursorShape::Block));
        for (row, line) in frame.lines.iter().enumerate() {
            for run in &line.texts {
                let mut font = self.style.font.clone();
                if run.bold {
                    font = font.bold();
                }
                if run.italic {
                    font = font.italic();
                }
                let mut color = run.fg;
                let over_cursor = block_cursor.is_some_and(|c| c.row == row && c.col >= run.col && c.col < run.col + run.width);
                if over_cursor {
                    // Simple and readable: the glyph under a block cursor
                    // takes the background colour. Only exact when the run
                    // is one cell wide; otherwise it tints the whole run.
                    if run.width == 1 {
                        color = palette.background;
                    }
                }
                let text_run = TextRun {
                    len: run.text.len(),
                    font,
                    color,
                    background_color: None,
                    underline: run.underline.then(|| UnderlineStyle {
                        thickness: px(1.),
                        color: Some(color),
                        wavy: false,
                    }),
                    strikethrough: run.strikethrough.then(|| StrikethroughStyle {
                        thickness: px(1.),
                        color: Some(color),
                    }),
                };
                let glyph_width = if run.wide { cell_width * 2. } else { cell_width };
                let shaped = window.text_system().shape_line(
                    SharedString::from(run.text.clone()),
                    self.style.font_size,
                    std::slice::from_ref(&text_run),
                    Some(glyph_width),
                );
                let pos = point(origin.x + cell_width * run.col as f32, origin.y + line_height * row as f32);
                if let Err(err) = shaped.paint(pos, line_height, TextAlign::Left, None, window, cx) {
                    tracing::debug!(%err, "terminal text paint failed");
                }
            }
        }

        // Scrolled into history: a thin marker at the right edge shows where
        // the viewport sits.
        if frame.history > 0 && frame.display_offset > 0 {
            let total = (frame.history + frame.rows) as f32;
            let track_h = f32::from(bounds.size.height);
            let thumb_h = (track_h * frame.rows as f32 / total).max(12.0);
            let from_top = (frame.history - frame.display_offset) as f32 / total * track_h;
            let thumb = Bounds::new(
                point(bounds.origin.x + bounds.size.width - px(4.), bounds.origin.y + px(from_top)),
                size(px(3.), px(thumb_h)),
            );
            let mut color: Hsla = palette.foreground;
            color.a = 0.35;
            window.paint_quad(fill(thumb, color));
        }
    }
}

impl Element for TerminalElement {
    type RequestLayoutState = ();
    type PrepaintState = Layout;

    fn id(&self) -> Option<ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static std::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, ()) {
        let mut style = Style::default();
        style.size.width = relative(1.).into();
        style.size.height = relative(1.).into();
        (window.request_layout(style, None, cx), ())
    }

    fn prepaint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _request_layout: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) -> Layout {
        let cell_width = self.measure_cell(window);
        let line_height = self.style.line_height;
        let grid = grid_dimensions(bounds.size, cell_width, line_height);
        self.terminal.resize(grid);

        let palette = Palette::from_theme(cx.theme());
        let frame = self.terminal.frame(&palette);
        let hitbox = window.insert_hitbox(bounds, HitboxBehavior::Normal);
        window.set_focus_handle(&self.focus, cx);
        let focused = self.focus.is_focused(window);
        let cursor_visible = self.view.update(cx, |view, cx| {
            let visible = view.sync_focus(focused);
            view.schedule_blink(focused, cx);
            visible
        });
        Layout {
            hitbox,
            frame,
            palette,
            cell_width,
            line_height,
            focused,
            cursor_visible,
            mouse_reporting: self.terminal.mouse_reporting(),
        }
    }

    fn paint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _request_layout: &mut (),
        layout: &mut Layout,
        window: &mut Window,
        cx: &mut App,
    ) {
        window.with_content_mask(Some(ContentMask { bounds }), |window| {
            // A program reading the mouse gets the arrow, so it is obvious
            // that a drag will not select.
            let style = if layout.mouse_reporting { CursorStyle::Arrow } else { CursorStyle::IBeam };
            window.set_cursor_style(style, &layout.hitbox);
            window.handle_input(&self.focus, ElementInputHandler::new(bounds, self.view.clone()), cx);
            self.register_mouse(layout, bounds, window);
            self.paint_frame(layout, bounds, window, cx);
        });
    }
}

impl IntoElement for TerminalElement {
    type Element = Self;

    fn into_element(self) -> Self {
        self
    }
}

/// Lines to scroll for a wheel delta, carrying fractional pixels between
/// events so a trackpad scrolls smoothly.
pub fn scroll_lines_for(delta: ScrollDelta, line_height: Pixels, accumulator: &mut f32) -> i32 {
    let dy = match delta {
        ScrollDelta::Lines(lines) => lines.y * 3.0,
        ScrollDelta::Pixels(pixels) => f32::from(pixels.y) / f32::from(line_height).max(1.0),
    };
    *accumulator += dy;
    let lines = accumulator.trunc();
    *accumulator -= lines;
    lines as i32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounds_to_cols_and_rows() {
        let grid = grid_dimensions(size(px(800.), px(600.)), px(8.), px(18.));
        assert_eq!(grid, GridSize { cols: 100, rows: 33 });
        // Partial cells are dropped, not rounded up.
        let grid = grid_dimensions(size(px(807.9), px(611.), ), px(8.), px(18.));
        assert_eq!(grid, GridSize { cols: 100, rows: 33 });
        // Never collapses to zero.
        let grid = grid_dimensions(size(px(3.), px(3.)), px(8.), px(18.));
        assert_eq!(grid, GridSize { cols: 2, rows: 1 });
        let grid = grid_dimensions(size(px(100.), px(100.)), px(0.), px(0.));
        assert_eq!(grid, GridSize { cols: 2, rows: 1 });
    }

    #[test]
    fn pointer_to_cell_and_side() {
        let grid = GridSize { cols: 10, rows: 4 };
        let (p, side) = cell_at(point(px(1.), px(1.)), px(8.), px(18.), grid);
        assert_eq!((p.line.0, p.column.0, side), (0, 0, Side::Left));
        let (p, side) = cell_at(point(px(15.), px(40.)), px(8.), px(18.), grid);
        assert_eq!((p.line.0, p.column.0, side), (2, 1, Side::Right));
        // Beyond the right edge clamps to the last column, right side.
        let (p, side) = cell_at(point(px(500.), px(500.)), px(8.), px(18.), grid);
        assert_eq!((p.line.0, p.column.0, side), (3, 9, Side::Right));
        // Negative coordinates clamp to the origin.
        let (p, _) = cell_at(point(px(-5.), px(-5.)), px(8.), px(18.), grid);
        assert_eq!((p.line.0, p.column.0), (0, 0));
    }

    #[test]
    fn wheel_delta_accumulates_fractions() {
        let mut acc = 0.0;
        assert_eq!(scroll_lines_for(ScrollDelta::Pixels(point(px(0.), px(9.))), px(18.), &mut acc), 0);
        assert_eq!(scroll_lines_for(ScrollDelta::Pixels(point(px(0.), px(9.))), px(18.), &mut acc), 1);
        assert_eq!(scroll_lines_for(ScrollDelta::Lines(point(0., -1.)), px(18.), &mut acc), -3);
    }
}
