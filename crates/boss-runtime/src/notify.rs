//! One place every BOSS event passes through on its way to a person.
//!
//! Port of `src/main/notification-router.ts` and the presence half of
//! `src/shared/notification.ts`. Senders describe what happened; this decides
//! whether the user hears about it now, later, or not at all.
//!
//! Presence is durable: it lives in `Settings.notifications.presence`, so
//! "do not disturb" survives a restart rather than quietly turning itself off.

use boss_core::store::{NotifyLevel, Presence, SettingsStore};
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};

/// How many held events survive a long quiet spell. Enough for a working day
/// of real interruptions; past that the oldest are the least useful.
const HELD_CAP: usize = 100;

/// Every BOSS event worth telling someone about, in one vocabulary.
///
/// Named after what happened rather than where it came from, so a consumer can
/// decide what to do without knowing whether an automation, a thread, or a
/// workflow produced it. Serialized with the TS spellings.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum NotifyEventType {
    /// A task finished as asked.
    #[serde(rename = "task.completed")]
    TaskCompleted,
    /// A task ended badly.
    #[serde(rename = "task.failed")]
    TaskFailed,
    /// A task is waiting on a person.
    #[serde(rename = "task.needs_attention")]
    TaskNeedsAttention,
    /// An automation run finished.
    #[serde(rename = "automation.completed")]
    AutomationCompleted,
    /// An automation run failed.
    #[serde(rename = "automation.failed")]
    AutomationFailed,
    /// A review came back.
    #[serde(rename = "review.completed")]
    ReviewCompleted,
    /// A workflow finished.
    #[serde(rename = "workflow.completed")]
    WorkflowCompleted,
    /// A workflow is waiting on a person.
    #[serde(rename = "workflow.needs_attention")]
    WorkflowNeedsAttention,
}

impl NotifyEventType {
    /// Blocks progress, or is a failure. These are what `attention` and
    /// `away` let through.
    pub fn needs_attention(self) -> bool {
        matches!(
            self,
            Self::TaskFailed
                | Self::TaskNeedsAttention
                | Self::AutomationFailed
                | Self::ReviewCompleted
                | Self::WorkflowNeedsAttention
        )
    }
}

/// Something that happened, already written for a human.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotifyEvent {
    /// What kind of thing happened.
    #[serde(rename = "type")]
    pub kind: NotifyEventType,
    /// One line.
    pub title: String,
    /// The detail under the line.
    pub body: String,
    /// Thread it came from, if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    /// Project it came from, if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_path: Option<String>,
    /// Unix milliseconds.
    pub created_at: i64,
}

/// Whether an event should reach a channel set to this level.
pub fn should_notify(level: NotifyLevel, kind: NotifyEventType) -> bool {
    match level {
        NotifyLevel::Off => false,
        NotifyLevel::All => true,
        NotifyLevel::Attention => kind.needs_attention(),
    }
}

/// Whether an event reaches a person at all, given where they are.
///
/// Separate from [`should_notify`], which answers what a *channel* wants. Both
/// have to agree: presence is the user's bar, the level is the channel's.
pub fn presence_allows(presence: Presence, kind: NotifyEventType) -> bool {
    match presence {
        Presence::Quiet => false,
        Presence::Away => kind.needs_attention(),
        Presence::Desk => true,
    }
}

/// Shows a desktop notification. The app fills this in; headless tests and
/// the runtime alone do not need one.
pub trait DesktopNotifier: Send + Sync {
    /// Show one notification. Best effort: a failure must not fail the work
    /// that reported the event.
    fn show(&self, event: &NotifyEvent);
    /// Is a BOSS window in front right now? A notification for something the
    /// user is already looking at is noise.
    fn is_foreground(&self) -> bool {
        false
    }
}

/// Routes events to the desktop, holding back what presence bars.
pub struct Notifier {
    settings: Arc<SettingsStore>,
    /// What arrived while the bar was up, so coming back does not mean finding
    /// out by accident that something needed an answer two hours ago.
    held: Mutex<Vec<NotifyEvent>>,
    desktop: Mutex<Option<Arc<dyn DesktopNotifier>>>,
}

impl Notifier {
    /// Route through `settings`, which owns the durable presence.
    pub fn new(settings: Arc<SettingsStore>) -> Self {
        Self { settings, held: Mutex::new(Vec::new()), desktop: Mutex::new(None) }
    }

    /// The app sets this once it can show a notification.
    pub fn set_desktop(&self, desktop: Arc<dyn DesktopNotifier>) {
        *self.desktop.lock().unwrap() = Some(desktop);
    }

    /// Where the user is right now.
    pub fn presence(&self) -> Presence {
        self.settings.get().notifications.presence
    }

    /// Say where the user is, and get back what was held while they were away
    /// so the caller can tell them what waited.
    ///
    /// Held events come back whenever the bar comes down, not only on the way
    /// out of silence: going from away to the desk should also hand back the
    /// routine things that were withheld.
    pub fn set_presence(&self, presence: Presence) -> Vec<NotifyEvent> {
        let was_barred = self.presence() != Presence::Desk;
        // Persisted before anything is handed back, so a crash between the two
        // leaves the bar where the user put it.
        let _ = self.settings.update(|s| s.notifications.presence = presence);
        if presence == Presence::Quiet || !was_barred {
            return Vec::new();
        }
        let mut held = self.held.lock().unwrap();
        let (waiting, keep) =
            held.drain(..).partition::<Vec<_>, _>(|event| presence_allows(presence, event.kind));
        *held = keep;
        waiting
    }

    /// What is being held back right now.
    pub fn held(&self) -> Vec<NotifyEvent> {
        self.held.lock().unwrap().clone()
    }

    /// Deliver an event to every channel that wants it, or hold it.
    pub fn publish(&self, event: NotifyEvent) {
        let settings = self.settings.get().notifications;
        if !presence_allows(settings.presence, event.kind) {
            // Held rather than dropped. Work keeps running while the user is
            // away; what needed them is what they came back for.
            let mut held = self.held.lock().unwrap();
            held.push(event);
            let over = held.len().saturating_sub(HELD_CAP);
            if over > 0 {
                held.drain(..over);
            }
            return;
        }
        if !settings.desktop || !should_notify(settings.level, event.kind) {
            return;
        }
        let desktop = self.desktop.lock().unwrap().clone();
        if let Some(desktop) = desktop
            && !desktop.is_foreground()
        {
            desktop.show(&event);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(kind: NotifyEventType, title: &str) -> NotifyEvent {
        NotifyEvent {
            kind,
            title: title.into(),
            body: "body".into(),
            thread_id: None,
            project_path: None,
            created_at: 1,
        }
    }

    #[derive(Default)]
    struct Shown {
        titles: Mutex<Vec<String>>,
        foreground: Mutex<bool>,
    }

    impl DesktopNotifier for Shown {
        fn show(&self, event: &NotifyEvent) {
            self.titles.lock().unwrap().push(event.title.clone());
        }
        fn is_foreground(&self) -> bool {
            *self.foreground.lock().unwrap()
        }
    }

    fn notifier() -> (tempfile::TempDir, Notifier, Arc<Shown>) {
        let dir = tempfile::tempdir().unwrap();
        let settings = Arc::new(SettingsStore::open(Some(dir.path())).unwrap());
        let notifier = Notifier::new(settings);
        let shown = Arc::new(Shown::default());
        notifier.set_desktop(shown.clone());
        (dir, notifier, shown)
    }

    #[test]
    fn the_attention_set_matches_the_ts_one() {
        for kind in [
            NotifyEventType::TaskFailed,
            NotifyEventType::TaskNeedsAttention,
            NotifyEventType::AutomationFailed,
            NotifyEventType::ReviewCompleted,
            NotifyEventType::WorkflowNeedsAttention,
        ] {
            assert!(kind.needs_attention(), "{kind:?}");
        }
        for kind in [
            NotifyEventType::TaskCompleted,
            NotifyEventType::AutomationCompleted,
            NotifyEventType::WorkflowCompleted,
        ] {
            assert!(!kind.needs_attention(), "{kind:?}");
        }
    }

    #[test]
    fn presence_is_the_users_bar_and_the_level_is_the_channels() {
        assert!(presence_allows(Presence::Desk, NotifyEventType::TaskCompleted));
        assert!(!presence_allows(Presence::Away, NotifyEventType::TaskCompleted));
        assert!(presence_allows(Presence::Away, NotifyEventType::TaskFailed));
        // No exceptions, not even a failure.
        assert!(!presence_allows(Presence::Quiet, NotifyEventType::TaskFailed));

        assert!(!should_notify(NotifyLevel::Off, NotifyEventType::TaskFailed));
        assert!(should_notify(NotifyLevel::All, NotifyEventType::TaskCompleted));
        assert!(!should_notify(NotifyLevel::Attention, NotifyEventType::TaskCompleted));
    }

    #[test]
    fn presence_is_durable_across_a_restart() {
        let dir = tempfile::tempdir().unwrap();
        let settings = Arc::new(SettingsStore::open(Some(dir.path())).unwrap());
        Notifier::new(settings).set_presence(Presence::Quiet);

        let reopened = Arc::new(SettingsStore::open(Some(dir.path())).unwrap());
        assert_eq!(Notifier::new(reopened).presence(), Presence::Quiet);
    }

    #[test]
    fn quiet_holds_everything_and_coming_back_hands_it_over_once() {
        let (_dir, notifier, shown) = notifier();
        notifier.set_presence(Presence::Quiet);
        notifier.publish(event(NotifyEventType::TaskFailed, "The build broke"));
        notifier.publish(event(NotifyEventType::TaskCompleted, "Docs generated"));
        assert!(shown.titles.lock().unwrap().is_empty(), "nothing gets through quiet");
        assert_eq!(notifier.held().len(), 2);

        // Quiet to quiet hands nothing back.
        assert!(notifier.set_presence(Presence::Quiet).is_empty());

        let waiting = notifier.set_presence(Presence::Desk);
        assert_eq!(waiting.len(), 2);
        assert_eq!(waiting[0].title, "The build broke");
        assert!(notifier.held().is_empty(), "handed over once, not twice");
    }

    #[test]
    fn coming_from_away_to_the_desk_hands_back_the_routine_things_too() {
        let (_dir, notifier, _) = notifier();
        notifier.set_presence(Presence::Away);
        // Attention events still reach a person who is away, so only the
        // routine one is held.
        notifier.publish(event(NotifyEventType::TaskCompleted, "Docs generated"));
        notifier.publish(event(NotifyEventType::TaskFailed, "The build broke"));
        assert_eq!(notifier.held().len(), 1);

        let waiting = notifier.set_presence(Presence::Desk);
        assert_eq!(waiting.len(), 1);
        assert_eq!(waiting[0].title, "Docs generated");
    }

    #[test]
    fn away_hands_back_only_what_it_now_allows() {
        let (_dir, notifier, _) = notifier();
        notifier.set_presence(Presence::Quiet);
        notifier.publish(event(NotifyEventType::TaskCompleted, "Docs generated"));
        notifier.publish(event(NotifyEventType::TaskFailed, "The build broke"));

        let waiting = notifier.set_presence(Presence::Away);
        assert_eq!(waiting.len(), 1);
        assert_eq!(waiting[0].title, "The build broke");
        // The routine one waits for the desk.
        assert_eq!(notifier.held().len(), 1);
    }

    #[test]
    fn starting_at_the_desk_hands_nothing_back() {
        let (_dir, notifier, shown) = notifier();
        notifier.publish(event(NotifyEventType::TaskFailed, "The build broke"));
        assert!(notifier.set_presence(Presence::Away).is_empty(), "the bar was never up");
        assert_eq!(shown.titles.lock().unwrap().as_slice(), ["The build broke"]);
    }

    #[test]
    fn a_desktop_notification_is_skipped_while_boss_is_in_front() {
        let (_dir, notifier, shown) = notifier();
        *shown.foreground.lock().unwrap() = true;
        notifier.publish(event(NotifyEventType::TaskFailed, "The build broke"));
        assert!(shown.titles.lock().unwrap().is_empty());
        // Not held either: presence let it through, the window ate it.
        assert!(notifier.held().is_empty());
    }

    #[test]
    fn the_channel_level_still_applies_at_the_desk() {
        let (dir, notifier, shown) = notifier();
        // Default level is `attention`, so a routine completion is dropped.
        notifier.publish(event(NotifyEventType::TaskCompleted, "Docs generated"));
        assert!(shown.titles.lock().unwrap().is_empty());

        let settings = SettingsStore::open(Some(dir.path())).unwrap();
        settings.update(|s| s.notifications.level = NotifyLevel::All).unwrap();
        let louder = Notifier::new(Arc::new(settings));
        louder.set_desktop(shown.clone());
        louder.publish(event(NotifyEventType::TaskCompleted, "Docs generated"));
        assert_eq!(shown.titles.lock().unwrap().len(), 1);
    }

    #[test]
    fn desktop_notifications_off_means_nothing_is_shown() {
        let (dir, _notifier, shown) = notifier();
        let settings = SettingsStore::open(Some(dir.path())).unwrap();
        settings.update(|s| s.notifications.desktop = false).unwrap();
        let quiet = Notifier::new(Arc::new(settings));
        quiet.set_desktop(shown.clone());
        quiet.publish(event(NotifyEventType::TaskFailed, "The build broke"));
        assert!(shown.titles.lock().unwrap().is_empty());
    }

    #[test]
    fn the_held_list_is_capped_at_a_working_days_worth() {
        let (_dir, notifier, _) = notifier();
        notifier.set_presence(Presence::Quiet);
        for i in 0..HELD_CAP + 20 {
            notifier.publish(event(NotifyEventType::TaskFailed, &format!("break {i}")));
        }
        let held = notifier.held();
        assert_eq!(held.len(), HELD_CAP);
        // The oldest are dropped, not the newest.
        assert_eq!(held[0].title, "break 20");
        assert_eq!(held[HELD_CAP - 1].title, format!("break {}", HELD_CAP + 19));
    }

    #[test]
    fn the_wire_names_match_the_ts_vocabulary() {
        let json = serde_json::to_value(event(NotifyEventType::TaskNeedsAttention, "Decide")).unwrap();
        assert_eq!(json["type"], "task.needs_attention");
        assert_eq!(json["title"], "Decide");
        assert_eq!(json["createdAt"], 1);
        assert!(json.get("threadId").is_none(), "absent, not null");
    }
}
