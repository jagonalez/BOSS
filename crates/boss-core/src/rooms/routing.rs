//! Who a message reaches, what a participant is told it missed, and how a
//! room splits into a main stream and branches. Port of
//! `src/shared/room-routing.ts`.

use super::room::{
    ParticipantState, RoomParticipant, RoomState, assistant_id, is_assistant, is_everyone,
};
use crate::ids::{MessageId, ParticipantId};
use crate::message::{Message, Part, Role};
use std::collections::HashMap;
use time::OffsetDateTime;

/// Who a message should reach, worked out once so no two surfaces disagree.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RoomDelivery {
    /// Role ids that must answer: one for a normal message, several for a
    /// broadcast, none when the addressee has left.
    pub role_ids: Vec<ParticipantId>,
    /// Addressed to everyone. Each answers once and never answers another.
    pub broadcast: bool,
}

/// Who a recipient resolves to in this room.
pub fn delivery_for(room: &RoomState, recipient: &ParticipantId) -> RoomDelivery {
    if is_everyone(recipient) {
        return RoomDelivery {
            role_ids: room
                .addressable()
                .into_iter()
                .map(|entry| entry.id().clone())
                .collect(),
            broadcast: true,
        };
    }
    if is_assistant(recipient) {
        return RoomDelivery {
            role_ids: vec![assistant_id()],
            broadcast: false,
        };
    }
    let role_ids = match room.find_participant(recipient) {
        Some(participant) if participant.state != ParticipantState::Done => {
            vec![participant.id().clone()]
        }
        _ => Vec::new(),
    };
    RoomDelivery {
        role_ids,
        broadcast: false,
    }
}

/// What a participant is told when it is addressed. Participants read only
/// when addressed, and catch up on what they missed at that moment.
#[derive(Clone, Debug, PartialEq)]
pub struct CatchUp<'a> {
    /// Messages since this participant last spoke or was addressed.
    pub missed: Vec<&'a Message>,
    /// The participant has never seen any of the room.
    pub first: bool,
}

/// Everything from the first message newer than the participant's last
/// activity onwards.
///
/// Stored order is not time order, so the cut is the first new message, not
/// the last old one: a participant may see a message twice, but never misses
/// one. The stored time is clamped to `now` so a clock that ran fast cannot
/// hide everything sent since.
pub fn catch_up_for<'a>(
    messages: &'a [Message],
    participant: Option<&RoomParticipant>,
    now: OffsetDateTime,
) -> CatchUp<'a> {
    let Some(last_active) = participant.and_then(|entry| entry.last_active_at) else {
        return CatchUp {
            missed: messages.iter().collect(),
            first: true,
        };
    };
    let since = last_active.min(now);
    let cut = messages
        .iter()
        .position(|message| message.created_at > since)
        .unwrap_or(messages.len());
    CatchUp {
        missed: messages[cut..].iter().collect(),
        first: false,
    }
}

/// Render caught-up messages for a participant that was not addressed in
/// them. It may read them and must not act on them: the user thinks out loud
/// with BOSS before deciding what to tell the builder.
pub fn catch_up_prompt(missed: &[&Message], addressed: &ParticipantId, user_label: &str) -> String {
    if missed.is_empty() {
        return String::new();
    }
    let mut lines = vec![
        "[ROOM CATCH-UP — CONTEXT ONLY]".to_owned(),
        "These messages happened while you were not addressed. Read them. Do not act on them."
            .to_owned(),
        "Only the message addressed to you asks for anything.".to_owned(),
        String::new(),
    ];
    for message in missed {
        let text = message_text(message);
        if !text.is_empty() {
            lines.push(format!(
                "{}: {text}",
                speaker_label(message, addressed, user_label)
            ));
        }
    }
    lines.join("\n")
}

fn speaker_label(message: &Message, addressed: &ParticipantId, user_label: &str) -> String {
    if message.role == Role::User {
        if let Some(to) = &message.recipient
            && to != addressed
            && !is_everyone(to)
        {
            return format!("{user_label} (to {to})");
        }
        return user_label.to_owned();
    }
    message
        .author
        .as_ref()
        .map_or_else(|| "agent".to_owned(), ToString::to_string)
}

fn message_text(message: &Message) -> String {
    let texts: Vec<&str> = message
        .parts
        .iter()
        .filter_map(|part| match part {
            Part::Text(text) if !text.text.is_empty() => Some(text.text.as_str()),
            _ => None,
        })
        .collect();
    texts.join("\n").trim().to_owned()
}

/// Whether a message belongs in the main stream (`None`) or under a branch.
pub fn in_branch(message: &Message, branch_of: Option<&MessageId>) -> bool {
    message.branch_of.as_ref() == branch_of
}

/// A room's messages grouped into the main stream and its branches. A flat
/// map rather than a tree, so a virtualised list keeps stable keys.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Branches<'a> {
    /// Messages with no parent, in stored order.
    pub main: Vec<&'a Message>,
    /// Replies under each parent, in stored order.
    pub branches: HashMap<MessageId, Vec<&'a Message>>,
}

/// Group a room's messages into the main stream and its branches.
pub fn split_branches(messages: &[Message]) -> Branches<'_> {
    let mut split = Branches::default();
    for message in messages {
        match &message.branch_of {
            None => split.main.push(message),
            Some(parent) => split
                .branches
                .entry(parent.clone())
                .or_default()
                .push(message),
        }
    }
    split
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::engine::EngineId;
    use crate::ids::{PartId, ThreadId};
    use crate::message::{MessageStatus, TextPart};
    use crate::rooms::room::tests::{at, participant, room};

    /// A complete text message in room-1, timed at `seconds`.
    pub(crate) fn message(id: &str, role: Role, text: &str, seconds: i64) -> Message {
        Message {
            id: MessageId::from(id),
            thread_id: ThreadId::from("room-1"),
            role,
            author: None,
            recipient: None,
            branch_of: None,
            created_at: at(seconds),
            status: MessageStatus::Complete,
            parts: vec![Part::Text(TextPart {
                id: PartId::from(format!("{id}-p")),
                text: text.to_owned(),
            })],
            revision: 0,
            usage: None,
            model: None,
        }
    }

    fn from(mut message: Message, author: &str) -> Message {
        message.author = Some(ParticipantId::from(author));
        message
    }

    fn to(mut message: Message, recipient: &str) -> Message {
        message.recipient = Some(ParticipantId::from(recipient));
        message
    }

    fn under(mut message: Message, parent: &str) -> Message {
        message.branch_of = Some(MessageId::from(parent));
        message
    }

    fn builder(id: &str, state: ParticipantState) -> RoomParticipant {
        participant(id, "Builder", EngineId::Codex, state)
    }

    fn active_since(seconds: i64) -> RoomParticipant {
        let mut seat = builder("builder", ParticipantState::Active);
        seat.last_active_at = Some(at(seconds));
        seat
    }

    fn ids<'a>(messages: &[&'a Message]) -> Vec<&'a str> {
        messages.iter().map(|message| message.id.as_str()).collect()
    }

    #[test]
    fn a_message_addressed_to_one_participant_reaches_only_that_one() {
        let state = room(vec![
            builder("builder", ParticipantState::Active),
            builder("reviewer", ParticipantState::Active),
        ]);
        let delivery = delivery_for(&state, &ParticipantId::from("builder"));
        assert_eq!(
            delivery,
            RoomDelivery {
                role_ids: vec![ParticipantId::from("builder")],
                broadcast: false
            }
        );
    }

    #[test]
    fn boss_is_reachable_from_a_room_with_no_participants_at_all() {
        let delivery = delivery_for(&room(vec![]), &assistant_id());
        assert_eq!(
            delivery,
            RoomDelivery {
                role_ids: vec![assistant_id()],
                broadcast: false
            }
        );
    }

    #[test]
    fn a_broadcast_reaches_every_participant_that_has_not_left() {
        let state = room(vec![
            builder("builder", ParticipantState::Active),
            builder("reviewer", ParticipantState::Active),
            builder("planner", ParticipantState::Done),
        ]);
        let delivery = delivery_for(&state, &super::super::room::everyone_id());
        assert_eq!(
            delivery.role_ids,
            vec![
                ParticipantId::from("builder"),
                ParticipantId::from("reviewer")
            ]
        );
        assert!(delivery.broadcast);
    }

    #[test]
    fn addressing_a_participant_that_has_left_reaches_nobody_rather_than_guessing() {
        let state = room(vec![builder("builder", ParticipantState::Done)]);
        assert!(
            delivery_for(&state, &ParticipantId::from("builder"))
                .role_ids
                .is_empty()
        );
    }

    #[test]
    fn a_stale_participant_is_still_addressed_because_addressing_it_starts_a_fresh_one() {
        let state = room(vec![builder("planner", ParticipantState::Stale)]);
        assert_eq!(
            delivery_for(&state, &ParticipantId::from("planner")).role_ids,
            vec![ParticipantId::from("planner")]
        );
    }

    #[test]
    fn a_participant_that_never_spoke_catches_up_on_the_whole_room() {
        let messages = vec![message("m1", Role::User, "hello", 10)];
        let result = catch_up_for(&messages, None, at(100));
        assert!(result.first);
        assert_eq!(result.missed.len(), 1);
        // One that joined but never spoke is the same case.
        let joined = catch_up_for(
            &messages,
            Some(&builder("builder", ParticipantState::Active)),
            at(100),
        );
        assert!(joined.first);
    }

    #[test]
    fn a_participant_catches_up_only_on_what_it_missed_not_the_whole_room_again() {
        let messages = vec![
            message("m1", Role::User, "first", 10),
            from(message("m2", Role::Assistant, "reply", 20), "builder"),
            to(message("m3", Role::User, "to boss", 30), "boss"),
            to(message("m4", Role::User, "to you", 40), "builder"),
        ];
        let result = catch_up_for(&messages, Some(&active_since(20)), at(100));
        assert_eq!(ids(&result.missed), vec!["m3", "m4"]);
        assert!(!result.first);
    }

    #[test]
    fn a_clock_that_ran_fast_does_not_hide_messages_sent_since() {
        let messages = vec![
            message("m1", Role::User, "before", 50),
            message("m2", Role::User, "after", 150),
        ];
        let result = catch_up_for(&messages, Some(&active_since(999_999)), at(100));
        assert_eq!(
            ids(&result.missed),
            vec!["m2"],
            "the clamp trusts the earlier of the two clocks"
        );
    }

    #[test]
    fn a_caught_up_participant_is_told_to_read_but_not_act() {
        let messages = [to(message("m1", Role::User, "this is wrong", 10), "boss")];
        let prompt = catch_up_prompt(&[&messages[0]], &ParticipantId::from("builder"), "Jeremy");
        assert!(prompt.contains("Do not act on them"));
        assert!(
            prompt.contains("Jeremy (to boss)"),
            "the builder can see who was actually being addressed"
        );
    }

    #[test]
    fn catch_up_names_the_agent_that_spoke_so_two_agents_never_merge_into_one_voice() {
        let messages = [from(message("m1", Role::Assistant, "done", 10), "reviewer")];
        let prompt = catch_up_prompt(&[&messages[0]], &ParticipantId::from("builder"), "Jeremy");
        assert!(prompt.contains("reviewer: done"));
    }

    #[test]
    fn a_message_to_the_addressed_participant_or_to_everyone_is_plainly_from_the_user() {
        let messages = [
            to(message("m1", Role::User, "for you", 10), "builder"),
            to(message("m2", Role::User, "for all", 20), "everyone"),
        ];
        let prompt = catch_up_prompt(
            &[&messages[0], &messages[1]],
            &ParticipantId::from("builder"),
            "Jeremy",
        );
        assert!(prompt.contains("Jeremy: for you"));
        assert!(prompt.contains("Jeremy: for all"));
    }

    #[test]
    fn an_empty_catch_up_produces_nothing_rather_than_a_bare_heading() {
        assert_eq!(
            catch_up_prompt(&[], &ParticipantId::from("builder"), "Jeremy"),
            ""
        );
    }

    #[test]
    fn branch_replies_are_kept_out_of_the_main_stream() {
        let messages = vec![
            from(
                message("m1", Role::Assistant, "review found two things", 10),
                "reviewer",
            ),
            under(message("m2", Role::User, "why storage?", 20), "m1"),
            under(
                from(message("m3", Role::Assistant, "i assumed", 30), "builder"),
                "m1",
            ),
            message("m4", Role::User, "next point", 40),
        ];
        let split = split_branches(&messages);
        assert_eq!(ids(&split.main), vec!["m1", "m4"]);
        assert_eq!(
            ids(split
                .branches
                .get(&MessageId::from("m1"))
                .expect("a branch")),
            vec!["m2", "m3"]
        );
        assert!(in_branch(&messages[1], Some(&MessageId::from("m1"))));
        assert!(in_branch(&messages[3], None));
    }

    #[test]
    fn a_room_with_no_branches_leaves_the_stream_untouched() {
        let messages = vec![message("m1", Role::User, "hi", 10)];
        let split = split_branches(&messages);
        assert_eq!(split.main.len(), 1);
        assert!(split.branches.is_empty());
    }

    #[test]
    fn a_participant_that_has_seen_everything_catches_up_on_nothing() {
        let messages = vec![message("m1", Role::User, "old", 10)];
        assert!(
            catch_up_for(&messages, Some(&active_since(50)), at(100))
                .missed
                .is_empty()
        );
    }

    #[test]
    fn a_new_message_stored_before_an_old_one_is_not_dropped() {
        // Stored order is not time order. Taking the last old-looking message
        // as the cut dropped anything newer that sat before it.
        let messages = vec![
            message("m1", Role::User, "old", 10),
            message("m2", Role::User, "new", 500),
            message("m3", Role::User, "also old", 20),
        ];
        let result = catch_up_for(&messages, Some(&active_since(30)), at(1000));
        assert!(
            ids(&result.missed).contains(&"m2"),
            "seeing a message twice costs repetition; missing one costs the answer"
        );
    }
}
