//! Cursor blink timing.
//!
//! Three rules, all of them about not distracting the reader:
//! - an unfocused terminal never blinks (it draws a hollow cursor instead),
//! - typing restarts the cycle so the cursor is solid while you type,
//! - the program can turn blinking off entirely (DECSCUSR steady shapes,
//!   which alacritty reports through `Term::cursor_style().blinking`).

use std::time::{Duration, Instant};

/// Half-period of the blink: the cursor is on for this long, then off.
pub const BLINK_INTERVAL: Duration = Duration::from_millis(500);

/// How long after a keystroke the cursor stays solid before blinking resumes.
pub const TYPING_GRACE: Duration = Duration::from_millis(600);

/// Blink phase for one terminal.
#[derive(Debug, Clone, Copy)]
pub struct BlinkState {
    /// Start of the current cycle; also reset by typing.
    epoch: Instant,
    /// Last keystroke, if any.
    last_input: Option<Instant>,
}

impl BlinkState {
    /// A cursor that is on right now.
    pub fn new(now: Instant) -> Self {
        Self { epoch: now, last_input: None }
    }

    /// Note a keystroke: the cursor goes solid and the cycle restarts.
    pub fn typed(&mut self, now: Instant) {
        self.epoch = now;
        self.last_input = Some(now);
    }

    /// Restart the cycle without counting it as typing (focus changes).
    pub fn reset(&mut self, now: Instant) {
        self.epoch = now;
        self.last_input = None;
    }

    /// Should the cursor be painted?
    ///
    /// `enabled` is the program's blink mode; `focused` is the window's. A
    /// cursor that does not blink is always visible, and this returns true
    /// for it, so callers can use the answer directly.
    pub fn visible(&self, now: Instant, enabled: bool, focused: bool) -> bool {
        if !enabled || !focused {
            return true;
        }
        if self.last_input.is_some_and(|t| now.duration_since(t) < TYPING_GRACE) {
            return true;
        }
        let elapsed = now.duration_since(self.epoch);
        (elapsed.as_millis() / BLINK_INTERVAL.as_millis()).is_multiple_of(2)
    }

    /// When the painted state next changes, so the view can schedule one
    /// repaint instead of running a timer. `None` when nothing will change.
    pub fn next_change(&self, now: Instant, enabled: bool, focused: bool) -> Option<Duration> {
        if !enabled || !focused {
            return None;
        }
        if let Some(t) = self.last_input {
            let since = now.duration_since(t);
            if since < TYPING_GRACE {
                return Some(TYPING_GRACE - since);
            }
        }
        let elapsed = now.duration_since(self.epoch).as_millis();
        let interval = BLINK_INTERVAL.as_millis();
        Some(Duration::from_millis((interval - elapsed % interval) as u64))
    }
}

impl Default for BlinkState {
    fn default() -> Self {
        Self::new(Instant::now())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_blinking_cursor_alternates_every_interval() {
        let start = Instant::now();
        let blink = BlinkState::new(start);
        assert!(blink.visible(start, true, true));
        assert!(blink.visible(start + Duration::from_millis(499), true, true));
        assert!(!blink.visible(start + Duration::from_millis(500), true, true));
        assert!(!blink.visible(start + Duration::from_millis(999), true, true));
        assert!(blink.visible(start + Duration::from_millis(1000), true, true));
    }

    #[test]
    fn unfocused_and_non_blinking_cursors_stay_solid() {
        let start = Instant::now();
        let blink = BlinkState::new(start);
        let off_phase = start + Duration::from_millis(600);
        assert!(blink.visible(off_phase, true, false), "unfocused does not blink");
        assert!(blink.visible(off_phase, false, true), "the program turned blinking off");
        assert_eq!(blink.next_change(off_phase, true, false), None);
        assert_eq!(blink.next_change(off_phase, false, true), None);
    }

    #[test]
    fn typing_holds_the_cursor_solid_then_resumes() {
        let start = Instant::now();
        let mut blink = BlinkState::new(start);
        // Mid-cycle the cursor would be off; a keystroke makes it solid.
        let typed_at = start + Duration::from_millis(600);
        assert!(!blink.visible(typed_at, true, true));
        blink.typed(typed_at);
        assert!(blink.visible(typed_at, true, true));
        assert!(blink.visible(typed_at + Duration::from_millis(599), true, true));
        // Past the grace the cycle runs again, timed from the keystroke.
        assert!(!blink.visible(typed_at + Duration::from_millis(700), true, true));
        assert!(blink.visible(typed_at + Duration::from_millis(1000), true, true));
    }

    #[test]
    fn next_change_schedules_the_repaint() {
        let start = Instant::now();
        let mut blink = BlinkState::new(start);
        assert_eq!(blink.next_change(start, true, true), Some(BLINK_INTERVAL));
        assert_eq!(
            blink.next_change(start + Duration::from_millis(200), true, true),
            Some(Duration::from_millis(300))
        );
        blink.typed(start);
        assert_eq!(blink.next_change(start, true, true), Some(TYPING_GRACE));
    }

    #[test]
    fn reset_restarts_the_cycle_without_a_grace_period() {
        let start = Instant::now();
        let mut blink = BlinkState::new(start);
        blink.typed(start);
        blink.reset(start + Duration::from_millis(100));
        // No grace: straight back onto the blink cycle.
        assert!(blink.visible(start + Duration::from_millis(100), true, true));
        assert!(!blink.visible(start + Duration::from_millis(700), true, true));
    }
}
