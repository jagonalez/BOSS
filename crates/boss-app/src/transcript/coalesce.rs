//! Coalesce engine events so the model commits at most N times per second.
//!
//! `EventCoalescer` is plain Rust: it buffers `(author, EngineEvent)` pairs,
//! merges adjacent deltas for the same part, and says when the next flush
//! may happen. `drive` is the GPUI side: it pulls events from a channel,
//! feeds the coalescer, and applies each flush to a `ThreadModel` in one
//! `update` followed by one `notify`, so the transcript re-renders once per
//! batch rather than once per token.

use crate::model::ThreadModel;
use async_channel::Receiver;
use boss_core::{EngineEvent, ParticipantId};
use futures::FutureExt as _;
use gpui::{App, AsyncApp, Entity, Task};
use std::time::{Duration, Instant};

/// Commits per second the transcript accepts (see `docs/native-port.md`).
pub const MAX_COMMITS_PER_SECOND: u32 = 8;

/// One buffered event with the participant it came from.
pub type Batched = (Option<ParticipantId>, EngineEvent);

/// Buffers engine events and releases them in rate-limited batches.
#[derive(Debug)]
pub struct EventCoalescer {
    min_interval: Duration,
    buffered: Vec<Batched>,
    last_flush: Option<Instant>,
}

impl EventCoalescer {
    /// Coalescer allowing at most `max_per_second` flushes per second.
    pub fn new(max_per_second: u32) -> Self {
        let per_second = max_per_second.max(1);
        Self::with_interval(Duration::from_secs(1) / per_second)
    }

    /// Coalescer with an explicit minimum gap between flushes.
    pub fn with_interval(min_interval: Duration) -> Self {
        Self { min_interval, buffered: Vec::new(), last_flush: None }
    }

    /// Buffer one event. Adjacent text/reasoning/input deltas for the same
    /// part are merged so the model applies one delta per part per batch.
    pub fn push(&mut self, author: Option<ParticipantId>, event: EngineEvent) {
        if let Some((last_author, last)) = self.buffered.last_mut()
            && *last_author == author
            && merge_delta(last, &event)
        {
            return;
        }
        self.buffered.push((author, event));
    }

    /// Buffered events not yet flushed.
    pub fn len(&self) -> usize {
        self.buffered.len()
    }

    /// True when nothing is waiting.
    pub fn is_empty(&self) -> bool {
        self.buffered.is_empty()
    }

    /// When the buffered events may be flushed; `None` when the buffer is empty.
    pub fn next_flush_at(&self, now: Instant) -> Option<Instant> {
        if self.buffered.is_empty() {
            return None;
        }
        Some(match self.last_flush {
            Some(last) => (last + self.min_interval).max(now),
            None => now,
        })
    }

    /// True when a flush is due at `now`.
    pub fn is_ready(&self, now: Instant) -> bool {
        self.next_flush_at(now).is_some_and(|at| at <= now)
    }

    /// Take the batch if one is due; otherwise leave the buffer alone.
    pub fn try_flush(&mut self, now: Instant) -> Option<Vec<Batched>> {
        self.is_ready(now).then(|| self.flush(now))
    }

    /// Take everything buffered regardless of timing (for shutdown).
    pub fn flush(&mut self, now: Instant) -> Vec<Batched> {
        self.last_flush = Some(now);
        std::mem::take(&mut self.buffered)
    }
}

/// Append `next`'s delta onto `last` when both are the same kind of delta for
/// the same message and part. Returns false when they cannot merge.
fn merge_delta(last: &mut EngineEvent, next: &EngineEvent) -> bool {
    match (last, next) {
        (
            EngineEvent::TextDelta { message_id: m1, part_id: p1, delta: d1 },
            EngineEvent::TextDelta { message_id: m2, part_id: p2, delta: d2 },
        )
        | (
            EngineEvent::ReasoningDelta { message_id: m1, part_id: p1, delta: d1 },
            EngineEvent::ReasoningDelta { message_id: m2, part_id: p2, delta: d2 },
        )
        | (
            EngineEvent::ToolCallInputDelta { message_id: m1, part_id: p1, delta: d1 },
            EngineEvent::ToolCallInputDelta { message_id: m2, part_id: p2, delta: d2 },
        ) if m1 == m2 && p1 == p2 => {
            d1.push_str(d2);
            true
        }
        _ => false,
    }
}

/// Pump `rx` into `model` through a coalescer. Each flush is one
/// `model.update` and one `notify`. Ends when the channel closes.
pub fn drive(model: Entity<ThreadModel>, rx: Receiver<Batched>, max_per_second: u32, cx: &App) -> Task<()> {
    cx.spawn(async move |cx: &mut AsyncApp| {
        let mut coalescer = EventCoalescer::new(max_per_second);
        loop {
            if coalescer.is_empty() {
                match rx.recv().await {
                    Ok((author, event)) => coalescer.push(author, event),
                    Err(_) => break,
                }
                continue;
            }
            let now = Instant::now();
            let deadline = coalescer.next_flush_at(now).expect("buffer is non-empty");
            if deadline <= now {
                apply(&model, coalescer.flush(now), cx);
                continue;
            }
            let mut timer = std::pin::pin!(cx.background_executor().timer(deadline - now).fuse());
            let mut recv = std::pin::pin!(rx.recv().fuse());
            futures::select_biased! {
                received = recv => match received {
                    Ok((author, event)) => coalescer.push(author, event),
                    Err(_) => {
                        apply(&model, coalescer.flush(Instant::now()), cx);
                        break;
                    }
                },
                _ = timer => apply(&model, coalescer.flush(Instant::now()), cx),
            }
        }
    })
}

fn apply(model: &Entity<ThreadModel>, batch: Vec<Batched>, cx: &mut AsyncApp) {
    if batch.is_empty() {
        return;
    }
    model.update(cx, |model, cx| {
        for (author, event) in batch {
            model.apply(author.as_ref(), event);
        }
        cx.notify();
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use boss_core::{MessageId, PartId};

    fn delta(part: &str, text: &str) -> EngineEvent {
        EngineEvent::TextDelta { message_id: MessageId::from_raw("m"), part_id: PartId::from_raw(part), delta: text.into() }
    }

    #[test]
    fn first_flush_is_immediate_then_rate_limited() {
        let t0 = Instant::now();
        let mut c = EventCoalescer::new(8);
        assert!(!c.is_ready(t0), "empty buffer is never ready");
        c.push(None, delta("p", "a"));
        assert!(c.is_ready(t0));
        assert_eq!(c.try_flush(t0).unwrap().len(), 1);

        c.push(None, delta("p", "b"));
        assert!(!c.is_ready(t0 + Duration::from_millis(100)));
        assert_eq!(c.next_flush_at(t0 + Duration::from_millis(100)), Some(t0 + Duration::from_millis(125)));
        assert!(c.is_ready(t0 + Duration::from_millis(125)));
    }

    #[test]
    fn forty_tokens_per_second_yield_eight_flushes() {
        let t0 = Instant::now();
        let mut c = EventCoalescer::new(8);
        let mut flushes = 0;
        let mut delivered = String::new();
        for i in 0..40 {
            let now = t0 + Duration::from_millis(25 * i);
            c.push(None, delta("p", &format!("{i},")));
            if let Some(batch) = c.try_flush(now) {
                flushes += 1;
                for (_, ev) in batch {
                    if let EngineEvent::TextDelta { delta, .. } = ev {
                        delivered.push_str(&delta);
                    }
                }
            }
        }
        assert_eq!(flushes, 8);
        assert!(!c.is_empty(), "tail of the second is still buffered");
        for (_, ev) in c.flush(t0 + Duration::from_secs(1)) {
            if let EngineEvent::TextDelta { delta, .. } = ev {
                delivered.push_str(&delta);
            }
        }
        let expected = (0..40).map(|i| format!("{i},")).collect::<String>();
        assert_eq!(delivered, expected, "every token arrives once, in order");
    }

    #[test]
    fn adjacent_deltas_merge_but_order_is_kept() {
        let mut c = EventCoalescer::new(8);
        c.push(None, delta("p1", "a"));
        c.push(None, delta("p1", "b"));
        c.push(None, delta("p2", "x"));
        c.push(None, EngineEvent::Status { busy: true });
        c.push(None, delta("p1", "c"));
        let batch = c.flush(Instant::now());
        assert_eq!(batch.len(), 4);
        assert!(matches!(&batch[0].1, EngineEvent::TextDelta { delta, part_id, .. } if delta == "ab" && part_id.as_str() == "p1"));
        assert!(matches!(&batch[1].1, EngineEvent::TextDelta { delta, .. } if delta == "x"));
        assert!(matches!(&batch[2].1, EngineEvent::Status { busy: true }));
        assert!(matches!(&batch[3].1, EngineEvent::TextDelta { delta, .. } if delta == "c"));
    }

    #[test]
    fn deltas_from_different_authors_do_not_merge() {
        let mut c = EventCoalescer::new(8);
        c.push(Some(ParticipantId::from_raw("a")), delta("p", "1"));
        c.push(Some(ParticipantId::from_raw("b")), delta("p", "2"));
        assert_eq!(c.len(), 2);
    }
}
