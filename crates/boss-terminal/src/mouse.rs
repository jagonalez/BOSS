//! Mouse reporting: turning a click, drag or wheel tick into the bytes a
//! full-screen program expects.
//!
//! Programs opt in with the private modes alacritty tracks in [`TermMode`]:
//! `MOUSE_REPORT_CLICK` (1000) reports press and release, `MOUSE_DRAG` (1002)
//! adds motion while a button is held, `MOUSE_MOTION` (1003) reports every
//! move. The encoding is either SGR (1006, `ESC [ < b ; x ; y M/m`) or the
//! original X10 form (`ESC [ M` plus three bytes offset by 32), which cannot
//! address past column 223.

use alacritty_terminal::term::TermMode;

/// Which physical button an event came from, in report order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MouseButtonCode {
    /// Left / primary.
    Left,
    /// Middle / wheel click.
    Middle,
    /// Right / secondary.
    Right,
    /// Wheel up (button 64).
    WheelUp,
    /// Wheel down (button 65).
    WheelDown,
}

impl MouseButtonCode {
    fn base(self) -> u8 {
        match self {
            MouseButtonCode::Left => 0,
            MouseButtonCode::Middle => 1,
            MouseButtonCode::Right => 2,
            MouseButtonCode::WheelUp => 64,
            MouseButtonCode::WheelDown => 65,
        }
    }

    /// Wheel ticks report as a press with no matching release.
    pub fn is_wheel(self) -> bool {
        matches!(self, MouseButtonCode::WheelUp | MouseButtonCode::WheelDown)
    }
}

/// What happened to the button.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MouseEventKind {
    /// Button went down.
    Press,
    /// Button came up.
    Release,
    /// The pointer moved (with a button held, for drag reporting).
    Motion,
}

/// Keyboard modifiers, which ride along in the button byte.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct MouseModifiers {
    /// Shift (bit 4).
    pub shift: bool,
    /// Alt / Option, reported as Meta (bit 8).
    pub alt: bool,
    /// Control (bit 16).
    pub control: bool,
}

/// One mouse event to report, in zero-based grid coordinates.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MouseReport {
    /// Which button.
    pub button: MouseButtonCode,
    /// Press, release or motion.
    pub kind: MouseEventKind,
    /// Zero-based column.
    pub col: usize,
    /// Zero-based row within the visible screen.
    pub row: usize,
    /// Held modifiers.
    pub modifiers: MouseModifiers,
}

/// Whether `mode` asks for this event at all.
///
/// Shift is the standard override: holding it means the user wants BOSS's
/// own selection, so nothing is forwarded.
pub fn wants_report(mode: TermMode, report: &MouseReport) -> bool {
    if report.modifiers.shift {
        return false;
    }
    match report.kind {
        MouseEventKind::Press | MouseEventKind::Release => mode.intersects(TermMode::MOUSE_MODE),
        MouseEventKind::Motion => mode.intersects(TermMode::MOUSE_DRAG | TermMode::MOUSE_MOTION),
    }
}

/// The bytes to send for `report` under `mode`, or `None` when the program
/// did not ask for it or the position cannot be encoded.
pub fn encode(mode: TermMode, report: &MouseReport) -> Option<Vec<u8>> {
    if !wants_report(mode, report) {
        return None;
    }
    // A release is reported for the wheel by nobody; drop it rather than
    // sending a spurious button-up.
    if report.button.is_wheel() && report.kind != MouseEventKind::Press {
        return None;
    }

    let mut code = report.button.base();
    if report.kind == MouseEventKind::Motion {
        code += 32;
    }
    if report.modifiers.shift {
        code += 4;
    }
    if report.modifiers.alt {
        code += 8;
    }
    if report.modifiers.control {
        code += 16;
    }

    // Terminals count from 1.
    let x = report.col + 1;
    let y = report.row + 1;

    if mode.contains(TermMode::SGR_MOUSE) {
        let final_byte = if report.kind == MouseEventKind::Release { 'm' } else { 'M' };
        return Some(format!("\x1b[<{code};{x};{y}{final_byte}").into_bytes());
    }

    // X10/normal: a release is button 3 and the position is a byte offset
    // by 32, so anything past column 223 is unreportable.
    let code = if report.kind == MouseEventKind::Release { (code & !0b11) + 3 } else { code };
    if x > 223 || y > 223 {
        return None;
    }
    Some(vec![0x1b, b'[', b'M', 32 + code, 32 + x as u8, 32 + y as u8])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn report(button: MouseButtonCode, kind: MouseEventKind, col: usize, row: usize) -> MouseReport {
        MouseReport { button, kind, col, row, modifiers: MouseModifiers::default() }
    }

    #[test]
    fn nothing_is_reported_without_a_mouse_mode() {
        let mode = TermMode::empty();
        assert_eq!(encode(mode, &report(MouseButtonCode::Left, MouseEventKind::Press, 0, 0)), None);
    }

    #[test]
    fn sgr_press_release_and_motion() {
        let mode = TermMode::MOUSE_REPORT_CLICK | TermMode::MOUSE_DRAG | TermMode::SGR_MOUSE;
        assert_eq!(
            encode(mode, &report(MouseButtonCode::Left, MouseEventKind::Press, 9, 4)).unwrap(),
            b"\x1b[<0;10;5M".to_vec()
        );
        assert_eq!(
            encode(mode, &report(MouseButtonCode::Left, MouseEventKind::Release, 9, 4)).unwrap(),
            b"\x1b[<0;10;5m".to_vec()
        );
        // Motion adds 32 to the button code and keeps the 'M' terminator.
        assert_eq!(
            encode(mode, &report(MouseButtonCode::Left, MouseEventKind::Motion, 9, 4)).unwrap(),
            b"\x1b[<32;10;5M".to_vec()
        );
        assert_eq!(
            encode(mode, &report(MouseButtonCode::Right, MouseEventKind::Press, 0, 0)).unwrap(),
            b"\x1b[<2;1;1M".to_vec()
        );
    }

    #[test]
    fn sgr_carries_modifiers() {
        let mode = TermMode::MOUSE_REPORT_CLICK | TermMode::SGR_MOUSE;
        let mut r = report(MouseButtonCode::Left, MouseEventKind::Press, 0, 0);
        r.modifiers.control = true;
        assert_eq!(encode(mode, &r).unwrap(), b"\x1b[<16;1;1M".to_vec());
        r.modifiers.alt = true;
        assert_eq!(encode(mode, &r).unwrap(), b"\x1b[<24;1;1M".to_vec());
    }

    #[test]
    fn wheel_reports_a_press_only() {
        let mode = TermMode::MOUSE_REPORT_CLICK | TermMode::SGR_MOUSE;
        assert_eq!(
            encode(mode, &report(MouseButtonCode::WheelUp, MouseEventKind::Press, 2, 3)).unwrap(),
            b"\x1b[<64;3;4M".to_vec()
        );
        assert_eq!(
            encode(mode, &report(MouseButtonCode::WheelDown, MouseEventKind::Press, 2, 3)).unwrap(),
            b"\x1b[<65;3;4M".to_vec()
        );
        assert_eq!(encode(mode, &report(MouseButtonCode::WheelUp, MouseEventKind::Release, 2, 3)), None);
    }

    #[test]
    fn normal_encoding_offsets_by_32_and_uses_button_3_for_release() {
        let mode = TermMode::MOUSE_REPORT_CLICK;
        assert_eq!(
            encode(mode, &report(MouseButtonCode::Left, MouseEventKind::Press, 0, 0)).unwrap(),
            vec![0x1b, b'[', b'M', 32, 33, 33]
        );
        assert_eq!(
            encode(mode, &report(MouseButtonCode::Right, MouseEventKind::Release, 1, 2)).unwrap(),
            vec![0x1b, b'[', b'M', 35, 34, 35]
        );
        // Past column 223 the byte form cannot address the cell.
        assert_eq!(encode(mode, &report(MouseButtonCode::Left, MouseEventKind::Press, 300, 0)), None);
    }

    #[test]
    fn motion_needs_a_motion_mode_and_shift_always_wins() {
        let click_only = TermMode::MOUSE_REPORT_CLICK | TermMode::SGR_MOUSE;
        assert_eq!(encode(click_only, &report(MouseButtonCode::Left, MouseEventKind::Motion, 1, 1)), None);
        let drag = click_only | TermMode::MOUSE_DRAG;
        assert!(encode(drag, &report(MouseButtonCode::Left, MouseEventKind::Motion, 1, 1)).is_some());

        let mut shifted = report(MouseButtonCode::Left, MouseEventKind::Press, 1, 1);
        shifted.modifiers.shift = true;
        assert_eq!(encode(drag, &shifted), None, "shift keeps the selection local");
    }
}
