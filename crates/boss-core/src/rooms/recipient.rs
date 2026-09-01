//! The recipient chip: who a thread can be addressed to, and what typing
//! `@name` does. Port of `src/renderer/src/lib/recipient.ts`.

use super::room::{
    ParticipantState, RoomState, assistant_id, everyone_id, is_assistant, is_everyone,
    is_thread_agent, mention_prefix, parse_engine, thread_agent_id,
};
use crate::engine::EngineId;
use crate::ids::ParticipantId;
use serde::{Deserialize, Serialize};

/// Colours the chip. BOSS and a broadcast read differently from a worker.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RecipientKind {
    /// BOSS.
    Assistant,
    /// A named role, or the thread's own agent.
    Participant,
    /// Everyone, one reply each.
    Everyone,
}

/// One option in the recipient chip's menu.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecipientOption {
    /// The recipient value the composer holds when this is chosen.
    pub id: ParticipantId,
    /// What the chip shows.
    pub label: String,
    /// What it is doing, shown beside the name. Empty when nothing is worth saying.
    pub detail: String,
    /// How the chip is coloured.
    pub kind: RecipientKind,
}

fn state_detail(state: ParticipantState) -> &'static str {
    match state {
        ParticipantState::Active => "",
        ParticipantState::Working => "working",
        ParticipantState::Stale => "idle",
        ParticipantState::Done => "finished",
    }
}

/// Who this thread can be addressed to, in menu order.
///
/// Participants first, because they are what the user is working with. BOSS
/// and a broadcast come last and are always present. The thread's own agent
/// is offered first, and only while the thread has no roles yet.
pub fn recipient_options(room: &RoomState, thread_agent: Option<&str>) -> Vec<RecipientOption> {
    let participants: Vec<RecipientOption> = room
        .participants
        .iter()
        .filter(|entry| entry.state != ParticipantState::Done)
        .map(|entry| RecipientOption {
            id: entry.id().clone(),
            label: entry.label().to_owned(),
            detail: state_detail(entry.state).to_owned(),
            kind: RecipientKind::Participant,
        })
        .collect();
    let mut options = Vec::with_capacity(participants.len() + 3);
    if participants.is_empty()
        && let Some(agent) = thread_agent
    {
        options.push(RecipientOption {
            id: thread_agent_id(),
            label: agent.to_owned(),
            detail: String::new(),
            kind: RecipientKind::Participant,
        });
    }
    options.extend(participants);
    options.push(RecipientOption {
        id: assistant_id(),
        label: "BOSS".to_owned(),
        detail: "assistant".to_owned(),
        kind: RecipientKind::Assistant,
    });
    options.push(RecipientOption {
        id: everyone_id(),
        label: "Everyone".to_owned(),
        detail: "one reply each".to_owned(),
        kind: RecipientKind::Everyone,
    });
    options
}

/// Send this one message to a different engine without changing the team.
/// Returned as `role@engine` so it survives as one value through the
/// composer and the send.
pub fn override_for(recipient: &ParticipantId, engine: EngineId) -> ParticipantId {
    ParticipantId::from(format!("{}@{}", recipient, engine.as_str()))
}

/// The role a recipient names, and the one-off engine if it carries one.
/// A suffix that is not an engine name is left as part of the role.
pub fn split_override(recipient: &ParticipantId) -> (ParticipantId, Option<EngineId>) {
    let raw = recipient.as_str();
    if let Some(at) = raw.rfind('@').filter(|at| *at > 0)
        && let Some(engine) = parse_engine(&raw[at + 1..])
    {
        return (ParticipantId::from(&raw[..at]), Some(engine));
    }
    (recipient.clone(), None)
}

/// What the chip shows for a recipient. The engine is named only when it is
/// not the one the role normally uses, so an ordinary message stays one word.
pub fn recipient_label(room: &RoomState, id: &ParticipantId, thread_agent: Option<&str>) -> String {
    let (role_id, engine) = split_override(id);
    let label = recipient_options(room, thread_agent)
        .into_iter()
        .find(|option| option.id == role_id)
        .map(|option| option.label)
        .or_else(|| thread_agent.map(str::to_owned))
        .unwrap_or_else(|| "BOSS".to_owned());
    match engine {
        Some(engine) => format!("{label} · {}", engine.as_str()),
        None => label,
    }
}

/// How the chip is coloured for a recipient. Unknown ids read as BOSS.
pub fn recipient_kind(
    room: &RoomState,
    id: &ParticipantId,
    thread_agent: Option<&str>,
) -> RecipientKind {
    let (role_id, _) = split_override(id);
    recipient_options(room, thread_agent)
        .into_iter()
        .find(|option| option.id == role_id)
        .map(|option| option.kind)
        .unwrap_or(if is_thread_agent(&role_id) {
            RecipientKind::Participant
        } else {
            RecipientKind::Assistant
        })
}

/// What typing in the composer should do to the chip.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Retarget {
    /// The new recipient, when a leading `@name` matched someone.
    pub recipient: Option<ParticipantId>,
    /// The text with the matched mention removed.
    pub text: String,
}

/// A leading `@name` retargets the message and is then removed from the
/// text, because the chip already carries it. An unrecognised name is left
/// alone: a wrong retarget is worse than none.
pub fn retarget(room: &RoomState, text: &str) -> Retarget {
    let Some((name, consumed)) = mention_prefix(text, false) else {
        return Retarget {
            recipient: None,
            text: text.to_owned(),
        };
    };
    match room.resolve_mention(name) {
        Some(recipient) => Retarget {
            recipient: Some(recipient),
            text: text[consumed..].to_owned(),
        },
        None => Retarget {
            recipient: None,
            text: text.to_owned(),
        },
    }
}

/// Why a message may not be sent, if it may not. A room never allows an
/// unaddressed message, so the only block is addressing someone who left.
pub fn recipient_problem(room: &RoomState, recipient: &ParticipantId) -> Option<String> {
    if is_assistant(recipient) || is_everyone(recipient) {
        return None;
    }
    let participant = room.find_participant(recipient)?;
    (participant.state == ParticipantState::Done)
        .then(|| format!("{} has finished. Pick someone else.", participant.label()))
}

/// The recipient the composer's placeholder names ("Ask …"): the chip's
/// answer, never the engine's name.
pub fn asking(room: &RoomState, thread_agent: &str) -> String {
    let (role_id, _) = split_override(&room.recipient);
    recipient_label(room, &role_id, Some(thread_agent))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rooms::room::tests::{participant, room};

    fn builder(
        id: &str,
        label: &str,
        state: ParticipantState,
    ) -> super::super::room::RoomParticipant {
        participant(id, label, EngineId::Codex, state)
    }

    fn ids(options: &[RecipientOption]) -> Vec<&str> {
        options.iter().map(|option| option.id.as_str()).collect()
    }

    #[test]
    fn a_room_with_nobody_in_it_can_still_address_boss_and_everyone() {
        assert_eq!(
            ids(&recipient_options(&room(vec![]), None)),
            vec!["boss", "everyone"]
        );
    }

    #[test]
    fn participants_come_before_boss_because_they_are_what_the_user_is_working_with() {
        let options = recipient_options(
            &room(vec![builder(
                "builder",
                "Builder",
                ParticipantState::Active,
            )]),
            None,
        );
        assert_eq!(ids(&options), vec!["builder", "boss", "everyone"]);
    }

    #[test]
    fn a_finished_participant_drops_out_of_the_menu() {
        let state = room(vec![
            builder("builder", "Builder", ParticipantState::Done),
            builder("reviewer", "Reviewer", ParticipantState::Active),
        ]);
        assert_eq!(
            ids(&recipient_options(&state, None)),
            vec!["reviewer", "boss", "everyone"]
        );
    }

    #[test]
    fn the_menu_says_what_each_participant_is_doing() {
        let state = room(vec![
            builder("builder", "Builder", ParticipantState::Working),
            builder("planner", "Planner", ParticipantState::Stale),
        ]);
        let options = recipient_options(&state, None);
        assert_eq!(options[0].detail, "working");
        assert_eq!(
            options[1].detail, "idle",
            "a dropped session reads as idle, not as an error"
        );
    }

    #[test]
    fn the_chip_shows_the_name_the_user_chose() {
        let state = room(vec![builder("r1", "Codey", ParticipantState::Active)]);
        assert_eq!(
            recipient_label(&state, &ParticipantId::from("r1"), None),
            "Codey"
        );
        assert_eq!(recipient_label(&state, &assistant_id(), None), "BOSS");
    }

    #[test]
    fn an_unknown_recipient_falls_back_to_boss_rather_than_showing_nothing() {
        let ghost = ParticipantId::from("ghost");
        assert_eq!(recipient_label(&room(vec![]), &ghost, None), "BOSS");
        assert_eq!(
            recipient_kind(&room(vec![]), &ghost, None),
            RecipientKind::Assistant
        );
    }

    #[test]
    fn boss_and_a_broadcast_look_different_from_a_worker() {
        let state = room(vec![builder(
            "builder",
            "Builder",
            ParticipantState::Active,
        )]);
        assert_eq!(
            recipient_kind(&state, &ParticipantId::from("builder"), None),
            RecipientKind::Participant
        );
        assert_eq!(
            recipient_kind(&state, &assistant_id(), None),
            RecipientKind::Assistant
        );
        assert_eq!(
            recipient_kind(&state, &everyone_id(), None),
            RecipientKind::Everyone
        );
    }

    #[test]
    fn typing_a_name_retargets_the_chip_and_drops_the_name_from_the_message() {
        let state = room(vec![builder(
            "builder",
            "Builder",
            ParticipantState::Active,
        )]);
        let expected = Retarget {
            recipient: Some(ParticipantId::from("builder")),
            text: "fix the header".into(),
        };
        assert_eq!(retarget(&state, "@builder fix the header"), expected);
        let expected = Retarget {
            recipient: Some(ParticipantId::from("builder")),
            text: "fix it".into(),
        };
        assert_eq!(retarget(&state, "@Builder, fix it"), expected);
    }

    #[test]
    fn typing_boss_retargets_from_inside_any_room() {
        let expected = Retarget {
            recipient: Some(assistant_id()),
            text: "what happened".into(),
        };
        assert_eq!(retarget(&room(vec![]), "@boss what happened"), expected);
    }

    #[test]
    fn an_unrecognised_name_is_left_alone_because_a_wrong_retarget_is_worse_than_none() {
        let state = room(vec![builder(
            "builder",
            "Builder",
            ParticipantState::Active,
        )]);
        assert_eq!(
            retarget(&state, "@ghost do something"),
            Retarget {
                recipient: None,
                text: "@ghost do something".into()
            }
        );
    }

    #[test]
    fn a_name_inside_a_sentence_does_not_retarget_anything() {
        let state = room(vec![builder(
            "builder",
            "Builder",
            ParticipantState::Active,
        )]);
        let text = "tell @builder it is ready";
        assert_eq!(
            retarget(&state, text),
            Retarget {
                recipient: None,
                text: text.into()
            }
        );
    }

    #[test]
    fn a_bare_name_with_nothing_after_it_still_retargets() {
        let state = room(vec![builder(
            "builder",
            "Builder",
            ParticipantState::Active,
        )]);
        assert_eq!(
            retarget(&state, "@builder"),
            Retarget {
                recipient: Some(ParticipantId::from("builder")),
                text: String::new()
            }
        );
    }

    #[test]
    fn addressing_someone_who_has_finished_is_refused_with_a_reason() {
        let state = room(vec![builder("builder", "Builder", ParticipantState::Done)]);
        let problem = recipient_problem(&state, &ParticipantId::from("builder")).expect("a reason");
        assert!(problem.contains("has finished"));
    }

    #[test]
    fn a_working_participant_boss_and_a_broadcast_are_all_sendable() {
        let state = room(vec![builder(
            "builder",
            "Builder",
            ParticipantState::Working,
        )]);
        assert_eq!(
            recipient_problem(&state, &ParticipantId::from("builder")),
            None
        );
        assert_eq!(recipient_problem(&state, &assistant_id()), None);
        assert_eq!(recipient_problem(&state, &everyone_id()), None);
    }

    #[test]
    fn addressing_a_stale_participant_is_allowed_because_it_starts_a_fresh_one() {
        let state = room(vec![builder("planner", "Planner", ParticipantState::Stale)]);
        assert_eq!(
            recipient_problem(&state, &ParticipantId::from("planner")),
            None
        );
    }

    #[test]
    fn a_message_can_name_a_different_agent_without_changing_the_team() {
        let reviewer = ParticipantId::from("reviewer");
        assert_eq!(
            override_for(&reviewer, EngineId::Codex).as_str(),
            "reviewer@codex"
        );
        assert_eq!(
            split_override(&ParticipantId::from("reviewer@codex")),
            (reviewer, Some(EngineId::Codex))
        );
    }

    #[test]
    fn an_ordinary_recipient_has_no_agent_attached() {
        assert_eq!(
            split_override(&ParticipantId::from("reviewer")),
            (ParticipantId::from("reviewer"), None)
        );
        assert_eq!(
            split_override(&ParticipantId::from("boss")),
            (assistant_id(), None)
        );
        assert_eq!(
            split_override(&ParticipantId::from("reviewer@nowhere")),
            (ParticipantId::from("reviewer@nowhere"), None),
            "a suffix that names no engine is not an override"
        );
    }

    #[test]
    fn the_chip_names_the_agent_only_when_it_is_not_the_usual_one() {
        let state = room(vec![builder(
            "reviewer",
            "Reviewer",
            ParticipantState::Active,
        )]);
        assert_eq!(
            recipient_label(&state, &ParticipantId::from("reviewer"), None),
            "Reviewer"
        );
        assert_eq!(
            recipient_label(&state, &ParticipantId::from("reviewer@codex"), None),
            "Reviewer · codex"
        );
    }

    #[test]
    fn a_one_off_agent_does_not_change_what_kind_of_recipient_it_is() {
        let state = room(vec![builder(
            "reviewer",
            "Reviewer",
            ParticipantState::Active,
        )]);
        assert_eq!(
            recipient_kind(&state, &ParticipantId::from("reviewer@codex"), None),
            RecipientKind::Participant
        );
    }

    #[test]
    fn a_thread_with_no_roles_offers_its_own_agent_by_name() {
        let options = recipient_options(&room(vec![]), Some("Claude"));
        assert_eq!(options[0].label, "Claude");
        assert_eq!(
            options[0].kind,
            RecipientKind::Participant,
            "it is who the user is talking to, not the assistant"
        );
    }

    #[test]
    fn once_a_thread_has_roles_its_own_agent_is_no_longer_offered() {
        let options = recipient_options(
            &room(vec![builder(
                "builder",
                "Builder",
                ParticipantState::Active,
            )]),
            Some("Claude"),
        );
        let labels: Vec<&str> = options.iter().map(|option| option.label.as_str()).collect();
        assert_eq!(labels, vec!["Builder", "BOSS", "Everyone"]);
    }

    #[test]
    fn the_chip_names_the_thread_agent_rather_than_falling_back_to_boss() {
        let state = room(vec![]);
        assert_eq!(
            recipient_label(&state, &thread_agent_id(), Some("Codex")),
            "Codex"
        );
        assert_eq!(
            recipient_kind(&state, &thread_agent_id(), Some("Codex")),
            RecipientKind::Participant
        );
    }

    #[test]
    fn a_plain_chat_invites_the_user_to_ask_its_own_agent() {
        assert_eq!(asking(&room(vec![]), "Claude"), "Claude");
        assert_eq!(asking(&room(vec![]), "Codex"), "Codex");
    }

    #[test]
    fn a_chat_aimed_at_boss_invites_the_user_to_ask_boss() {
        let state = RoomState {
            recipient: assistant_id(),
            ..room(vec![])
        };
        assert_eq!(asking(&state, "Claude"), "BOSS");
    }

    #[test]
    fn a_room_aimed_at_a_role_invites_the_user_to_ask_that_role_by_name() {
        let state = RoomState {
            recipient: ParticipantId::from("reviewer"),
            ..room(vec![builder(
                "reviewer",
                "Reviewer",
                ParticipantState::Active,
            )])
        };
        assert_eq!(asking(&state, "Claude"), "Reviewer");
    }

    #[test]
    fn a_broadcast_invites_the_user_to_ask_everyone() {
        let state = RoomState {
            recipient: everyone_id(),
            ..room(vec![])
        };
        assert_eq!(asking(&state, "Claude"), "Everyone");
    }

    #[test]
    fn a_one_off_agent_is_not_repeated_in_the_placeholder() {
        // The chip beside it already names the agent.
        let state = RoomState {
            recipient: override_for(&ParticipantId::from("reviewer"), EngineId::Codex),
            ..room(vec![builder(
                "reviewer",
                "Reviewer",
                ParticipantState::Active,
            )])
        };
        assert_eq!(asking(&state, "Claude"), "Reviewer");
    }
}
