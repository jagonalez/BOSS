//! Room views: the screens a room needs that a plain chat does not.
//!
//! - `team_setup` — `TeamSetup`: the shape cards and the team, shown in a
//!   room tab before the shape is chosen.
//! - `team_bar`   — `TeamBar`: the strip of participant chips above the
//!   transcript once a room is running.
//! - `replies`    — `RepliesPanel`: the branch replies under one turn.
//!
//! Views never own room data. `TeamSetup` and `TeamBar` are handed plain
//! `boss_core::rooms` values and emit events; the lead wires them to the
//! `RoomManager`.

pub mod pane;
pub mod replies;
pub mod team_bar;
pub mod team_setup;

pub use pane::{RoomPane, RoomPaneEvent};
pub use replies::{RepliesEvent, RepliesPanel};
pub use team_bar::{TeamBar, TeamBarEvent};
pub use team_setup::{TeamSetup, TeamSetupEvent};

use boss_core::rooms::{ParticipantState, RoomParticipant, participant_is_stale};
use boss_core::{EngineId, RoomShape};
use gpui::{App, Hsla};
use gpui_component::ActiveTheme as _;
use time::OffsetDateTime;

/// Every shape, in the order the user is offered them.
pub const SHAPES: [RoomShape; 3] = boss_core::rooms::ROOM_SHAPES;

/// The user-facing name of a room shape. One definition, so the setup cards
/// and the sidebar's "New room" menu can never disagree.
pub fn shape_label(shape: RoomShape) -> &'static str {
    match shape {
        RoomShape::Direct => "Just do it",
        RoomShape::Reviewed => "Build and review",
        RoomShape::Full => "The full run",
    }
}

/// What a shape does, in one line under its name.
pub fn shape_detail(shape: RoomShape) -> &'static str {
    match shape {
        RoomShape::Direct => "one agent, no review",
        RoomShape::Reviewed => "a fresh agent checks the work",
        RoomShape::Full => "research, plan, build, review",
    }
}

/// Short name of an engine, for a badge beside a participant.
pub fn engine_badge(engine: EngineId) -> &'static str {
    match engine {
        EngineId::Claude => "claude",
        EngineId::Codex => "codex",
        EngineId::Opencode => "opencode",
        EngineId::Pi => "pi",
    }
}

/// How a seat reads on the team bar: one word, never a state name from the
/// wire. A dropped session is "idle", not an error.
pub fn state_word(state: ParticipantState) -> &'static str {
    match state {
        ParticipantState::Active => "here",
        ParticipantState::Working => "working",
        ParticipantState::Stale => "idle",
        ParticipantState::Done => "finished",
    }
}

/// The seat's state as the bar shows it: `Stale` once its session has aged
/// out, whatever the stored value says. Staleness is a fact about the clock,
/// and a bar that waited for a write would show a live agent that is gone.
pub fn effective_state(participant: &RoomParticipant, now: OffsetDateTime) -> ParticipantState {
    if participant.state != ParticipantState::Working && participant_is_stale(participant, now) {
        return ParticipantState::Stale;
    }
    participant.state
}

/// Colour of the dot beside a participant.
pub fn state_color(state: ParticipantState, cx: &App) -> Hsla {
    let theme = cx.theme();
    match state {
        ParticipantState::Active => theme.primary,
        ParticipantState::Working => theme.success,
        ParticipantState::Stale => theme.warning,
        ParticipantState::Done => theme.muted_foreground,
    }
}

/// Test seats and timestamps, shared by every view in this module.
#[cfg(test)]
pub(crate) mod demo {
    use boss_core::rooms::{ParticipantState, RoomParticipant, RoomRole, RoomTeam, assistant_id};
    use boss_core::{EngineId, Participant, ParticipantId, PermissionMode, RoomShape};
    use time::OffsetDateTime;

    /// Seconds since the epoch, as a timestamp.
    pub(crate) fn at(seconds: i64) -> OffsetDateTime {
        OffsetDateTime::from_unix_timestamp(seconds).expect("valid timestamp")
    }

    /// One seat, joined at the epoch and never spoken to.
    pub(crate) fn seat(
        id: &str,
        label: &str,
        engine: EngineId,
        state: ParticipantState,
    ) -> RoomParticipant {
        RoomParticipant {
            participant: Participant {
                id: ParticipantId::from(id),
                name: label.to_owned(),
                engine,
                model: None,
                is_boss: ParticipantId::from(id) == assistant_id(),
                native_session_id: None,
            },
            state,
            last_active_at: None,
            joined_at: at(0),
        }
    }

    /// BOSS, a builder and a reviewer: enough for every shape but the full run.
    pub(crate) fn team() -> RoomTeam {
        RoomTeam {
            roles: vec![
                RoomRole::new("boss", "BOSS", EngineId::Claude, Some(PermissionMode::Plan)),
                RoomRole::new(
                    "researcher",
                    "Researcher",
                    EngineId::Claude,
                    Some(PermissionMode::Plan),
                ),
                RoomRole::new(
                    "planner",
                    "Planner",
                    EngineId::Claude,
                    Some(PermissionMode::Plan),
                ),
                RoomRole::new(
                    "builder",
                    "Builder",
                    EngineId::Codex,
                    Some(PermissionMode::Bypass),
                ),
                RoomRole::new(
                    "reviewer",
                    "Reviewer",
                    EngineId::Claude,
                    Some(PermissionMode::Plan),
                ),
            ],
            ask_shape: true,
            default_shape: RoomShape::Reviewed,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::demo::{at, seat};
    use super::*;
    use boss_core::rooms::PARTICIPANT_STALE_AFTER;

    #[test]
    fn every_shape_has_a_name_and_a_line_saying_what_it_does() {
        for shape in boss_core::rooms::ROOM_SHAPES {
            assert!(!shape_label(shape).is_empty());
            assert!(!shape_detail(shape).is_empty());
        }
        assert_eq!(shape_label(RoomShape::Direct), "Just do it");
        assert_eq!(shape_label(RoomShape::Reviewed), "Build and review");
        assert_eq!(shape_label(RoomShape::Full), "The full run");
    }

    #[test]
    fn every_engine_has_a_badge() {
        for engine in EngineId::ALL {
            assert_eq!(engine_badge(engine), engine.as_str());
        }
    }

    #[test]
    fn a_dropped_session_reads_as_idle_not_as_an_error() {
        assert_eq!(state_word(ParticipantState::Stale), "idle");
        assert_eq!(state_word(ParticipantState::Working), "working");
        assert_eq!(state_word(ParticipantState::Done), "finished");
    }

    #[test]
    fn a_seat_reads_stale_once_the_clock_says_so_without_waiting_for_a_write() {
        let seat = seat(
            "builder",
            "Builder",
            EngineId::Codex,
            ParticipantState::Active,
        );
        let fresh = at(PARTICIPANT_STALE_AFTER.whole_seconds());
        assert_eq!(effective_state(&seat, fresh), ParticipantState::Active);
        let aged = at(PARTICIPANT_STALE_AFTER.whole_seconds() + 1);
        assert_eq!(effective_state(&seat, aged), ParticipantState::Stale);
    }

    #[test]
    fn a_working_seat_is_never_shown_as_idle_and_a_finished_one_stays_finished() {
        let aged = at(PARTICIPANT_STALE_AFTER.whole_seconds() + 1);
        let working = seat(
            "builder",
            "Builder",
            EngineId::Codex,
            ParticipantState::Working,
        );
        assert_eq!(effective_state(&working, aged), ParticipantState::Working);
        let done = seat("planner", "Planner", EngineId::Claude, ParticipantState::Done);
        assert_eq!(effective_state(&done, aged), ParticipantState::Done);
    }
}
