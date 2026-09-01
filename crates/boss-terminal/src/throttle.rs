//! Pacing shell output on its way to the screen.
//!
//! A shell can write far faster than a window can draw. Two independent
//! pieces keep the UI responsive, both modelled on VS Code's terminal and the
//! Electron app's `terminal-throttle.ts`:
//!
//! - [`Coalescer`] bounds how often the view is told to repaint: bursts of
//!   many small reads collapse into one notification per interval.
//! - [`FlowControl`] stops the reader thread once the parsed-but-unpainted
//!   backlog passes a high watermark and resumes it below a low one. Pausing
//!   the read makes the shell block on a full pipe, which is the only thing
//!   that slows a runaway process down.
//!
//! Neither touches a pty, a thread, or a window, which is what makes them
//! testable directly.

use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

/// Minimum spacing between repaint notifications while output is heavy.
pub const FLUSH_INTERVAL: Duration = Duration::from_millis(8);
/// Backlog (bytes parsed, not yet painted) that pauses the reader.
pub const HIGH_WATERMARK: usize = 100_000;
/// Backlog below which a paused reader resumes.
pub const LOW_WATERMARK: usize = 5_000;

/// Decides whether a repaint may go out now or has to wait for the interval.
#[derive(Debug, Clone)]
pub struct Coalescer {
    interval: Duration,
    last_emit: Option<Instant>,
    pending: bool,
}

impl Default for Coalescer {
    fn default() -> Self {
        Self::new(FLUSH_INTERVAL)
    }
}

impl Coalescer {
    /// A coalescer that emits at most once per `interval`.
    pub fn new(interval: Duration) -> Self {
        Self { interval, last_emit: None, pending: false }
    }

    /// Record that new output arrived at `now`. Returns true when a repaint
    /// should be emitted immediately; otherwise the batch is held and
    /// [`Self::deadline`] says when to flush it.
    pub fn offer(&mut self, now: Instant) -> bool {
        self.pending = true;
        match self.last_emit {
            Some(last) if now.duration_since(last) < self.interval => false,
            _ => {
                self.mark_emitted(now);
                true
            }
        }
    }

    /// When the held batch must go out, if one is held.
    pub fn deadline(&self) -> Option<Instant> {
        if !self.pending {
            return None;
        }
        Some(self.last_emit.map_or_else(Instant::now, |t| t + self.interval))
    }

    /// Flush a held batch at `now`. Returns true if there was one to flush.
    pub fn flush(&mut self, now: Instant) -> bool {
        if !self.pending {
            return false;
        }
        self.mark_emitted(now);
        true
    }

    /// Whether output is waiting for the interval to elapse.
    pub fn is_pending(&self) -> bool {
        self.pending
    }

    fn mark_emitted(&mut self, now: Instant) {
        self.last_emit = Some(now);
        self.pending = false;
    }
}

#[derive(Debug, Default)]
struct FlowState {
    unacknowledged: usize,
    paused: bool,
}

/// Watermark-based back pressure shared between the reader thread and the UI.
///
/// The reader calls [`FlowControl::record`] after every parse and blocks in
/// [`FlowControl::wait_while_paused`]; the UI calls
/// [`FlowControl::acknowledge`] after painting.
#[derive(Debug, Default)]
pub struct FlowControl {
    state: Mutex<FlowState>,
    resumed: Condvar,
}

impl FlowControl {
    /// A fresh, unpaused flow control.
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Account for `bytes` of parsed output. Returns true if this crossed the
    /// high watermark and paused the reader.
    pub fn record(&self, bytes: usize) -> bool {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.unacknowledged += bytes;
        if !state.paused && state.unacknowledged > HIGH_WATERMARK {
            state.paused = true;
            return true;
        }
        false
    }

    /// Report that `bytes` of output have been painted. Returns true if this
    /// resumed a paused reader. Resuming below the low watermark rather than
    /// at zero keeps the shell reading continuously instead of stuttering.
    pub fn acknowledge(&self, bytes: usize) -> bool {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.unacknowledged = state.unacknowledged.saturating_sub(bytes);
        if state.paused && state.unacknowledged < LOW_WATERMARK {
            state.paused = false;
            self.resumed.notify_all();
            return true;
        }
        false
    }

    /// Everything parsed so far has been painted.
    pub fn acknowledge_all(&self) -> bool {
        let bytes = self.state.lock().unwrap_or_else(|e| e.into_inner()).unacknowledged;
        self.acknowledge(bytes)
    }

    /// Whether the reader is currently held.
    pub fn is_paused(&self) -> bool {
        self.state.lock().unwrap_or_else(|e| e.into_inner()).paused
    }

    /// Bytes parsed but not yet acknowledged.
    pub fn unacknowledged(&self) -> usize {
        self.state.lock().unwrap_or_else(|e| e.into_inner()).unacknowledged
    }

    /// Block the calling (reader) thread until the UI catches up. Wakes at
    /// least every `poll` so a dying terminal can still unwind the thread.
    pub fn wait_while_paused(&self, poll: Duration) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        while state.paused {
            let (next, _) = self
                .resumed
                .wait_timeout(state, poll)
                .unwrap_or_else(|e| e.into_inner());
            state = next;
        }
    }

    /// Release a paused reader unconditionally, e.g. on shutdown.
    pub fn release(&self) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.paused = false;
        state.unacknowledged = 0;
        self.resumed.notify_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn coalescer_emits_first_then_holds_within_interval() {
        let t0 = Instant::now();
        let mut c = Coalescer::new(Duration::from_millis(8));
        assert!(c.offer(t0), "first chunk goes out immediately");
        assert!(!c.offer(t0 + Duration::from_millis(1)), "second is held");
        assert!(!c.offer(t0 + Duration::from_millis(7)));
        assert!(c.is_pending());
        assert_eq!(c.deadline(), Some(t0 + Duration::from_millis(8)));
        // The deadline is not pushed back by later chunks, so continuous
        // output still gets drawn.
        assert!(c.offer(t0 + Duration::from_millis(8)));
        assert!(!c.is_pending());
        assert_eq!(c.deadline(), None);
    }

    #[test]
    fn coalescer_flush_clears_pending() {
        let t0 = Instant::now();
        let mut c = Coalescer::default();
        assert!(!c.flush(t0), "nothing held");
        c.offer(t0);
        c.offer(t0 + Duration::from_millis(2));
        assert!(c.flush(t0 + Duration::from_millis(8)));
        assert!(!c.is_pending());
        // After a flush the interval restarts from the flush time.
        assert!(!c.offer(t0 + Duration::from_millis(9)));
        assert!(c.offer(t0 + Duration::from_millis(16)));
    }

    #[test]
    fn flow_control_pauses_above_high_and_resumes_below_low() {
        let flow = FlowControl::new();
        assert!(!flow.record(HIGH_WATERMARK));
        assert!(!flow.is_paused());
        assert!(flow.record(1), "crossing the high watermark pauses");
        assert!(flow.is_paused());
        assert!(!flow.record(10), "already paused: no second pause signal");

        // Acknowledging down to just above the low watermark keeps us paused.
        let backlog = flow.unacknowledged();
        assert!(!flow.acknowledge(backlog - LOW_WATERMARK));
        assert!(flow.is_paused());
        // One more byte below the low watermark resumes.
        assert!(flow.acknowledge(1));
        assert!(!flow.is_paused());
        assert_eq!(flow.unacknowledged(), LOW_WATERMARK - 1);
    }

    #[test]
    fn flow_control_acknowledge_never_goes_negative() {
        let flow = FlowControl::new();
        flow.record(10);
        flow.acknowledge(1_000);
        assert_eq!(flow.unacknowledged(), 0);
        assert!(!flow.acknowledge(5));
    }

    #[test]
    fn flow_control_acknowledge_all_resumes() {
        let flow = FlowControl::new();
        assert!(flow.record(HIGH_WATERMARK + 1));
        assert!(flow.acknowledge_all());
        assert_eq!(flow.unacknowledged(), 0);
        assert!(!flow.is_paused());
    }

    #[test]
    fn flow_control_wait_returns_once_released() {
        let flow = FlowControl::new();
        flow.record(HIGH_WATERMARK + 1);
        let waiter = {
            let flow = flow.clone();
            std::thread::spawn(move || {
                flow.wait_while_paused(Duration::from_millis(5));
                true
            })
        };
        std::thread::sleep(Duration::from_millis(10));
        flow.release();
        assert!(waiter.join().unwrap());
    }
}
