//! Replay buffer backing event resume. Port of `src/shared/event-buffer.ts`.
//!
//! A phone that locks, loses signal, or sleeps must be able to ask "what did
//! I miss?" and either receive it or be told plainly that it fell too far
//! behind. Silently delivering a partial stream is the failure this exists to
//! prevent: a thread that looks complete but is missing messages is worse
//! than one that visibly reloads.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::VecDeque;

/// One retained event with the sequence number it was sent under.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct BufferedEvent {
    pub event: Value,
    pub seq: u64,
}

/// What a resuming phone gets back.
#[derive(Clone, Debug, PartialEq)]
pub struct ResumeResult {
    pub events: Vec<BufferedEvent>,
    /// The requested point had already been evicted; the caller must refetch.
    pub gap: bool,
    /// Latest sequence the buffer has seen, so a gapped phone can resync to it.
    pub seq: u64,
}

/// Fixed-capacity ring of numbered events.
#[derive(Debug)]
pub struct EventBuffer {
    entries: VecDeque<BufferedEvent>,
    seq: u64,
    capacity: usize,
}

impl EventBuffer {
    /// A buffer that keeps the newest `capacity` events.
    pub fn new(capacity: usize) -> Self {
        Self { entries: VecDeque::with_capacity(capacity.min(4096)), seq: 0, capacity }
    }

    /// Number and retain an event. Returns the sequence assigned to it.
    pub fn push(&mut self, event: Value) -> u64 {
        self.seq += 1;
        self.entries.push_back(BufferedEvent { event, seq: self.seq });
        while self.entries.len() > self.capacity {
            self.entries.pop_front();
        }
        self.seq
    }

    /// The latest sequence handed out.
    pub fn latest(&self) -> u64 {
        self.seq
    }

    /// How many events are held right now.
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// Whether nothing is held.
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Everything after `since`.
    ///
    /// `since` of 0 means a phone that has never applied an event: it gets no
    /// replay and no gap, because it will load current state anyway.
    ///
    /// A gap is reported when the next event the phone needs — `since + 1` —
    /// is older than the oldest entry still held, or when `since` is ahead of
    /// us (a desktop restart reset the counter).
    pub fn since(&self, since: u64) -> ResumeResult {
        if since == 0 {
            return ResumeResult { events: vec![], gap: false, seq: self.seq };
        }
        if since > self.seq {
            return ResumeResult { events: vec![], gap: true, seq: self.seq };
        }
        if let Some(oldest) = self.entries.front().map(|e| e.seq)
            && since + 1 < oldest
        {
            return ResumeResult { events: vec![], gap: true, seq: self.seq };
        }
        ResumeResult {
            events: self.entries.iter().filter(|e| e.seq > since).cloned().collect(),
            gap: false,
            seq: self.seq,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn event(n: usize) -> Value {
        json!({ "type": "message.updated", "n": n })
    }

    fn seqs(result: &ResumeResult) -> Vec<u64> {
        result.events.iter().map(|e| e.seq).collect()
    }

    #[test]
    fn events_are_numbered_from_one_and_handed_back_in_order() {
        let mut buffer = EventBuffer::new(10);
        assert_eq!(buffer.push(event(1)), 1);
        assert_eq!(buffer.push(event(2)), 2);
        assert_eq!(buffer.latest(), 2);
        assert_eq!(seqs(&buffer.since(0)), Vec::<u64>::new());
        assert_eq!(seqs(&buffer.since(1)), vec![2]);
    }

    #[test]
    fn a_phone_that_missed_a_burst_gets_exactly_what_it_missed() {
        let mut buffer = EventBuffer::new(100);
        for i in 0..20 {
            buffer.push(event(i));
        }
        let result = buffer.since(12);
        assert!(!result.gap);
        assert_eq!(seqs(&result), vec![13, 14, 15, 16, 17, 18, 19, 20]);
    }

    #[test]
    fn a_caught_up_phone_gets_nothing_and_no_gap() {
        let mut buffer = EventBuffer::new(10);
        buffer.push(event(1));
        buffer.push(event(2));
        let result = buffer.since(2);
        assert!(result.events.is_empty());
        assert!(!result.gap);
    }

    #[test]
    fn a_brand_new_phone_is_not_told_there_is_a_gap() {
        let mut buffer = EventBuffer::new(4);
        for i in 0..50 {
            buffer.push(event(i));
        }
        let result = buffer.since(0);
        assert!(!result.gap);
        assert!(result.events.is_empty());
        assert_eq!(result.seq, 50);
    }

    #[test]
    fn falling_behind_the_buffer_reports_a_gap_rather_than_a_partial_stream() {
        let mut buffer = EventBuffer::new(5);
        for i in 0..20 {
            buffer.push(event(i));
        }
        // Holds 16..20. A phone at 3 needs 4, which is long gone.
        let result = buffer.since(3);
        assert!(result.gap, "a hole must be reported, never silently skipped");
        assert!(result.events.is_empty());
        assert_eq!(result.seq, 20, "the phone still learns where to resync to");
    }

    #[test]
    fn the_exact_boundary_of_the_buffer_is_not_a_gap() {
        let mut buffer = EventBuffer::new(5);
        for i in 0..20 {
            buffer.push(event(i));
        }
        let boundary = buffer.since(15);
        assert!(!boundary.gap);
        assert_eq!(seqs(&boundary), vec![16, 17, 18, 19, 20]);
        assert!(buffer.since(14).gap);
    }

    #[test]
    fn the_buffer_never_grows_past_its_capacity() {
        let mut buffer = EventBuffer::new(50);
        for i in 0..5000 {
            buffer.push(event(i));
        }
        assert_eq!(buffer.len(), 50);
        assert_eq!(buffer.latest(), 5000);
    }

    #[test]
    fn a_desktop_restart_is_treated_as_a_gap_not_an_endless_wait() {
        let mut buffer = EventBuffer::new(10);
        buffer.push(event(1));
        buffer.push(event(2));
        buffer.push(event(3));
        let result = buffer.since(400);
        assert!(result.gap, "otherwise the phone waits for events that will never arrive");
        assert_eq!(result.seq, 3);
    }

    #[test]
    fn buffered_events_serialize_the_way_the_phone_reads_them() {
        let entry = BufferedEvent { event: json!({ "type": "session.idle" }), seq: 7 };
        assert_eq!(serde_json::to_value(&entry).unwrap(), json!({ "event": { "type": "session.idle" }, "seq": 7 }));
    }
}
