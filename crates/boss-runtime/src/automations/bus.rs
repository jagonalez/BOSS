//! The one place events and durable subscriptions meet.
//!
//! Port of `src/main/event-bus.ts`. Sources (cron, GitHub webhooks, user
//! actions) publish normalized [`BossEvent`]s; the workflow engine registers
//! durable subscriptions that either trigger new runs or resume parked ones.
//! Subscriptions survive restarts: they are the "when X happens, wake me"
//! half of durable execution.
//!
//! Persisted to `workflow-subscriptions.json` in the Electron format.

use super::cron::{cron_error, next_cron_time_in};
use super::types::*;
use anyhow::{Result, bail};
use boss_core::store::JsonFile;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::path::Path;
use std::sync::{Arc, Mutex};
use time::UtcOffset;

/// Timers are checked this often, matching the TS `TICK_MS`.
pub const TICK: std::time::Duration = std::time::Duration::from_secs(30);

/// The `workflow-subscriptions.json` envelope.
#[derive(Debug, Default, Serialize, Deserialize)]
struct BusDoc {
    version: u32,
    #[serde(default)]
    subscriptions: Vec<WorkflowSubscription>,
}

/// What a subscription firing means. `event` is `None` for timer expiries
/// (sleep deadlines and `waitFor` timeouts).
pub type Fired = (SubscriptionTarget, Option<BossEvent>);

/// A clock the bus reads. Tests supply a fake one so a scheduler test never
/// waits on wall time.
pub trait Clock: Send + Sync {
    /// Epoch milliseconds.
    fn now_ms(&self) -> i64;
    /// The zone cron expressions are evaluated in.
    fn offset(&self) -> UtcOffset {
        super::cron::local_offset()
    }
}

/// The machine's clock in the machine's zone.
#[derive(Debug, Default)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now_ms(&self) -> i64 {
        now_ms()
    }
}

/// A clock a test drives by hand, fixed to UTC so cron assertions do not
/// depend on where the machine is.
#[derive(Debug)]
pub struct FakeClock(Mutex<i64>);

impl FakeClock {
    pub fn new(at: i64) -> Arc<Self> {
        Arc::new(Self(Mutex::new(at)))
    }
    /// Move time forward by `ms`.
    pub fn advance(&self, ms: i64) {
        *self.0.lock().unwrap() += ms;
    }
    /// Jump to an absolute time.
    pub fn set(&self, at: i64) {
        *self.0.lock().unwrap() = at;
    }
}

impl Clock for FakeClock {
    fn now_ms(&self) -> i64 {
        *self.0.lock().unwrap()
    }
    fn offset(&self) -> UtcOffset {
        UtcOffset::UTC
    }
}

/// Durable subscriptions, persisted on every change.
pub struct EventBus {
    file: JsonFile,
    subscriptions: Mutex<Vec<WorkflowSubscription>>,
    clock: Arc<dyn Clock>,
}

impl EventBus {
    /// Open `workflow-subscriptions.json` under `dir`.
    pub fn open(dir: &Path, clock: Arc<dyn Clock>) -> Result<Self> {
        let file = JsonFile::in_dir(Some(dir), "workflow-subscriptions.json");
        let doc = file.load::<BusDoc>()?.unwrap_or_default();
        let subscriptions = if doc.version == 1 { doc.subscriptions } else { Vec::new() };
        Ok(Self { file, subscriptions: Mutex::new(subscriptions), clock })
    }

    fn save(&self) -> Result<()> {
        let subscriptions = self.subscriptions.lock().unwrap().clone();
        self.file.save(&BusDoc { version: 1, subscriptions })?;
        Ok(())
    }

    pub fn list(&self) -> Vec<WorkflowSubscription> {
        self.subscriptions.lock().unwrap().clone()
    }

    /// Register a subscription. A cron subscription's first `nextAt` is
    /// computed here, so the caller may pass any placeholder.
    pub fn subscribe(
        &self,
        target: SubscriptionTarget,
        pattern: Option<EventPattern>,
        cron: Option<String>,
        expires_at: Option<i64>,
    ) -> Result<WorkflowSubscription> {
        let now = self.clock.now_ms();
        let cron = match cron {
            None => None,
            Some(expression) => {
                if let Some(problem) = cron_error(&expression) {
                    bail!(problem);
                }
                // `Number.MAX_SAFE_INTEGER` is what the TS parks an
                // unschedulable expression at; keep the same sentinel so the
                // two apps read each other's files identically.
                let next_at =
                    next_cron_time_in(&expression, now, self.clock.offset()).unwrap_or(MAX_SAFE_INTEGER);
                Some(CronSubscription { expression, next_at })
            }
        };
        let subscription = WorkflowSubscription {
            id: uuid::Uuid::new_v4().to_string(),
            target,
            pattern,
            cron,
            expires_at,
            created_at: now,
        };
        self.subscriptions.lock().unwrap().push(subscription.clone());
        self.save()?;
        Ok(subscription)
    }

    /// Drop resume subscriptions for steps at or after `min_seq`, used when a
    /// script edit invalidates the tail of a journal: their patterns belong
    /// to steps that no longer exist and must not settle the re-run ones. The
    /// run's deadline timer (a negative seq) survives.
    pub fn unsubscribe_resumes_from(&self, run_id: &str, min_seq: i64) -> Result<()> {
        self.retain(|item| !matches!(&item.target,
            SubscriptionTarget::Resume { run_id: r, seq } if r == run_id && *seq >= min_seq))
    }

    /// Drop every subscription pointing at a run, e.g. when it is stopped.
    pub fn unsubscribe_run(&self, run_id: &str) -> Result<()> {
        self.retain(|item| !matches!(&item.target, SubscriptionTarget::Resume { run_id: r, .. } if r == run_id))
    }

    /// Drop every trigger subscription for a workflow, e.g. when it is
    /// disabled, edited, or deleted.
    pub fn unsubscribe_workflow(&self, workflow_id: &str) -> Result<()> {
        self.retain(
            |item| !matches!(&item.target, SubscriptionTarget::Trigger { workflow_id: w } if w == workflow_id),
        )
    }

    fn retain(&self, keep: impl Fn(&WorkflowSubscription) -> bool) -> Result<()> {
        let changed = {
            let mut subscriptions = self.subscriptions.lock().unwrap();
            let before = subscriptions.len();
            subscriptions.retain(keep);
            subscriptions.len() != before
        };
        if changed {
            self.save()?;
        }
        Ok(())
    }

    /// Match `event` against every subscription and return what fired.
    ///
    /// Resume subscriptions are one-shot and removed *before* the caller acts
    /// on them, so a crash mid-handling can never double-deliver; trigger
    /// subscriptions persist.
    pub fn publish(&self, event: &BossEvent) -> Result<Vec<Fired>> {
        let matched: Vec<WorkflowSubscription> = {
            let subscriptions = self.subscriptions.lock().unwrap();
            subscriptions
                .iter()
                .filter(|item| item.pattern.as_ref().is_some_and(|p| matches_pattern(p, event)))
                .cloned()
                .collect()
        };
        if matched.is_empty() {
            return Ok(Vec::new());
        }
        let one_shot: Vec<&str> = matched
            .iter()
            .filter(|item| matches!(item.target, SubscriptionTarget::Resume { .. }))
            .map(|item| item.id.as_str())
            .collect();
        if !one_shot.is_empty() {
            self.subscriptions.lock().unwrap().retain(|item| !one_shot.contains(&item.id.as_str()));
            self.save()?;
        }
        Ok(matched.into_iter().map(|item| (item.target, Some(event.clone()))).collect())
    }

    /// Fire due cron triggers and expired timers, and return what fired.
    ///
    /// A cron subscription is rescheduled rather than removed; an expired
    /// timer is removed and fires with no event.
    pub fn tick(&self) -> Result<Vec<Fired>> {
        let now = self.clock.now_ms();
        let offset = self.clock.offset();
        let mut fired: Vec<Fired> = Vec::new();
        let mut changed = false;
        {
            let mut subscriptions = self.subscriptions.lock().unwrap();
            for subscription in subscriptions.iter_mut() {
                let Some(cron) = &mut subscription.cron else { continue };
                if cron.next_at > now {
                    continue;
                }
                let event = BossEvent {
                    id: uuid::Uuid::new_v4().to_string(),
                    kind: "cron.fired".into(),
                    at: now,
                    project_path: None,
                    data: json!({ "expression": cron.expression })
                        .as_object()
                        .cloned()
                        .unwrap_or_default(),
                };
                fired.push((subscription.target.clone(), Some(event)));
                cron.next_at = next_cron_time_in(&cron.expression, now, offset).unwrap_or(MAX_SAFE_INTEGER);
                changed = true;
            }
            // A cron subscription is never "expired": its expiresAt, if any,
            // belongs to the run, not the timer. The TS excludes them here
            // for the same reason.
            let expired: Vec<WorkflowSubscription> = subscriptions
                .iter()
                .filter(|item| item.cron.is_none() && item.expires_at.is_some_and(|at| at <= now))
                .cloned()
                .collect();
            if !expired.is_empty() {
                let drop: Vec<&str> = expired.iter().map(|item| item.id.as_str()).collect();
                subscriptions.retain(|item| !drop.contains(&item.id.as_str()));
                fired.extend(expired.into_iter().map(|item| (item.target, None)));
                changed = true;
            }
        }
        if changed {
            self.save()?;
        }
        Ok(fired)
    }
}

/// JavaScript's `Number.MAX_SAFE_INTEGER`, the "never" the TS parks an
/// unschedulable cron subscription at.
pub const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn bus(dir: &Path, at: i64) -> (EventBus, Arc<FakeClock>) {
        let clock = FakeClock::new(at);
        let bus = EventBus::open(dir, clock.clone()).unwrap();
        (bus, clock)
    }

    fn event(kind: &str, data: serde_json::Value) -> BossEvent {
        BossEvent {
            id: "e1".into(),
            kind: kind.into(),
            at: 0,
            project_path: None,
            data: data.as_object().cloned().unwrap_or_default(),
        }
    }

    fn pattern(kind: &str) -> EventPattern {
        EventPattern { kind: kind.into(), ..Default::default() }
    }

    #[test]
    fn a_missing_file_is_an_empty_bus() {
        let dir = tempfile::tempdir().unwrap();
        let (bus, _) = bus(dir.path(), 0);
        assert!(bus.list().is_empty());
        assert!(bus.tick().unwrap().is_empty());
    }

    #[test]
    fn subscriptions_survive_a_reopen_in_the_electron_shape() {
        let dir = tempfile::tempdir().unwrap();
        let (bus, clock) = bus(dir.path(), 1_000);
        bus.subscribe(
            SubscriptionTarget::Resume { run_id: "r1".into(), seq: 2 },
            Some(pattern("github.push")),
            None,
            Some(9_999),
        )
        .unwrap();
        let doc: Value = serde_json::from_str(
            &std::fs::read_to_string(dir.path().join("workflow-subscriptions.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(doc["version"], 1);
        assert_eq!(doc["subscriptions"][0]["target"]["kind"], "resume");
        assert_eq!(doc["subscriptions"][0]["target"]["runId"], "r1");
        assert_eq!(doc["subscriptions"][0]["expiresAt"], 9_999);
        assert_eq!(doc["subscriptions"][0]["createdAt"], 1_000);

        let reopened = EventBus::open(dir.path(), clock).unwrap();
        assert_eq!(reopened.list().len(), 1);
    }

    #[test]
    fn publish_delivers_only_to_matching_patterns() {
        let dir = tempfile::tempdir().unwrap();
        let (bus, _) = bus(dir.path(), 0);
        bus.subscribe(SubscriptionTarget::Trigger { workflow_id: "w1".into() }, Some(pattern("github.push")), None, None)
            .unwrap();
        bus.subscribe(
            SubscriptionTarget::Trigger { workflow_id: "w2".into() },
            Some(pattern("github.pull_request")),
            None,
            None,
        )
        .unwrap();
        let fired = bus.publish(&event("github.push", serde_json::json!({}))).unwrap();
        assert_eq!(fired.len(), 1);
        assert_eq!(fired[0].0, SubscriptionTarget::Trigger { workflow_id: "w1".into() });
        assert!(fired[0].1.is_some());
        // Nothing matched: no fire, and nothing removed.
        assert!(bus.publish(&event("cron.fired", serde_json::json!({}))).unwrap().is_empty());
        assert_eq!(bus.list().len(), 2);
    }

    #[test]
    fn resume_subscriptions_are_one_shot_and_triggers_are_not() {
        let dir = tempfile::tempdir().unwrap();
        let (bus, _) = bus(dir.path(), 0);
        bus.subscribe(SubscriptionTarget::Resume { run_id: "r1".into(), seq: 1 }, Some(pattern("x")), None, None)
            .unwrap();
        bus.subscribe(SubscriptionTarget::Trigger { workflow_id: "w1".into() }, Some(pattern("x")), None, None)
            .unwrap();
        assert_eq!(bus.publish(&event("x", serde_json::json!({}))).unwrap().len(), 2);
        // The resume is gone; the trigger remains and fires again.
        assert_eq!(bus.list().len(), 1);
        assert_eq!(bus.publish(&event("x", serde_json::json!({}))).unwrap().len(), 1);
    }

    #[test]
    fn a_cron_subscription_fires_and_reschedules() {
        let dir = tempfile::tempdir().unwrap();
        // 2026-01-01 08:59:00 UTC.
        let start = 1_767_257_940_000;
        let (bus, clock) = bus(dir.path(), start);
        bus.subscribe(
            SubscriptionTarget::Trigger { workflow_id: "w1".into() },
            None,
            Some("0 9 * * *".into()),
            None,
        )
        .unwrap();
        // Not yet nine o'clock.
        assert!(bus.tick().unwrap().is_empty());
        clock.advance(60_000);
        let fired = bus.tick().unwrap();
        assert_eq!(fired.len(), 1);
        let (target, ev) = &fired[0];
        assert_eq!(*target, SubscriptionTarget::Trigger { workflow_id: "w1".into() });
        let ev = ev.as_ref().unwrap();
        assert_eq!(ev.kind, "cron.fired");
        assert_eq!(ev.data["expression"], "0 9 * * *");
        // Rescheduled a day out, and it does not fire twice.
        assert!(bus.tick().unwrap().is_empty());
        let next = bus.list()[0].cron.as_ref().unwrap().next_at;
        assert_eq!(next, clock.now_ms() + 24 * 60 * 60 * 1_000);
    }

    #[test]
    fn an_unschedulable_cron_parks_at_the_javascript_sentinel() {
        let dir = tempfile::tempdir().unwrap();
        let (bus, _) = bus(dir.path(), 0);
        // February 30th never comes.
        bus.subscribe(SubscriptionTarget::Trigger { workflow_id: "w1".into() }, None, Some("0 0 30 2 *".into()), None)
            .unwrap();
        assert_eq!(bus.list()[0].cron.as_ref().unwrap().next_at, MAX_SAFE_INTEGER);
        assert!(bus.tick().unwrap().is_empty());
    }

    #[test]
    fn an_invalid_cron_expression_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let (bus, _) = bus(dir.path(), 0);
        let error = bus
            .subscribe(SubscriptionTarget::Trigger { workflow_id: "w1".into() }, None, Some("nope".into()), None)
            .unwrap_err();
        assert!(error.to_string().contains("5 fields"), "{error}");
        assert!(bus.list().is_empty());
    }

    #[test]
    fn an_expired_timer_fires_once_with_no_event() {
        let dir = tempfile::tempdir().unwrap();
        let (bus, clock) = bus(dir.path(), 1_000);
        bus.subscribe(SubscriptionTarget::Resume { run_id: "r1".into(), seq: 4 }, None, None, Some(2_000)).unwrap();
        assert!(bus.tick().unwrap().is_empty());
        clock.set(2_000);
        let fired = bus.tick().unwrap();
        assert_eq!(fired.len(), 1);
        assert_eq!(fired[0].0, SubscriptionTarget::Resume { run_id: "r1".into(), seq: 4 });
        assert!(fired[0].1.is_none(), "a timer fires with no event");
        // Removed, so it never fires again.
        assert!(bus.list().is_empty());
        assert!(bus.tick().unwrap().is_empty());
    }

    #[test]
    fn a_cron_subscription_with_a_deadline_is_not_treated_as_a_timer() {
        let dir = tempfile::tempdir().unwrap();
        let (bus, clock) = bus(dir.path(), 0);
        bus.subscribe(
            SubscriptionTarget::Trigger { workflow_id: "w1".into() },
            None,
            Some("* * * * *".into()),
            Some(1),
        )
        .unwrap();
        clock.advance(120_000);
        let fired = bus.tick().unwrap();
        assert_eq!(fired.len(), 1);
        assert!(fired[0].1.is_some(), "it fired as cron, not as an expiry");
        assert_eq!(bus.list().len(), 1, "and it is still registered");
    }

    #[test]
    fn unsubscribe_resumes_from_spares_earlier_steps_and_the_deadline() {
        let dir = tempfile::tempdir().unwrap();
        let (bus, _) = bus(dir.path(), 0);
        for seq in [-1i64, 0, 1, 2, 3] {
            bus.subscribe(SubscriptionTarget::Resume { run_id: "r1".into(), seq }, Some(pattern("x")), None, None)
                .unwrap();
        }
        bus.subscribe(SubscriptionTarget::Resume { run_id: "other".into(), seq: 2 }, Some(pattern("x")), None, None)
            .unwrap();
        bus.unsubscribe_resumes_from("r1", 2).unwrap();
        let left: Vec<i64> = bus
            .list()
            .iter()
            .filter_map(|item| match &item.target {
                SubscriptionTarget::Resume { run_id, seq } if run_id == "r1" => Some(*seq),
                _ => None,
            })
            .collect();
        assert_eq!(left, vec![-1, 0, 1], "the deadline (-1) and earlier steps survive");
        assert_eq!(bus.list().len(), 4, "another run is untouched");
    }

    #[test]
    fn unsubscribe_run_and_workflow_clear_their_own_targets() {
        let dir = tempfile::tempdir().unwrap();
        let (bus, _) = bus(dir.path(), 0);
        bus.subscribe(SubscriptionTarget::Resume { run_id: "r1".into(), seq: 0 }, Some(pattern("x")), None, None)
            .unwrap();
        bus.subscribe(SubscriptionTarget::Trigger { workflow_id: "w1".into() }, Some(pattern("x")), None, None)
            .unwrap();
        bus.unsubscribe_run("r1").unwrap();
        assert_eq!(bus.list().len(), 1);
        bus.unsubscribe_workflow("w1").unwrap();
        assert!(bus.list().is_empty());
    }
}
