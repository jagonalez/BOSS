//! Turn grouping: fold consecutive messages into the visual turns the list
//! renders. Pure Rust so the rules can be unit-tested without a window.
//!
//! Rules (ported from `src/renderer/src/lib/transcript.ts`):
//! - A user message starts a new turn.
//! - Assistant messages join the running turn while the author stays the
//!   same; a different author starts a new turn without a user message, so
//!   a builder and a reviewer never speak with one voice.
//! - System messages stand alone: they are machinery, not speech.
//! - Branch replies (`branch_of` set) are not placed inline; the turn that
//!   holds the parent gets a reply count instead (see `docs/rooms.md`).

use boss_core::{Message, MessageId, Role};
use std::collections::HashMap;

/// One visual turn in the transcript. Indices point into the model's
/// `messages` vector, so the turn never copies message data.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Turn {
    /// Stable key: id of the first message in the turn.
    pub key: MessageId,
    /// The user message that opened the turn, if any.
    pub user: Option<usize>,
    /// Assistant (or one system) messages in the turn, in order.
    pub assistants: Vec<usize>,
    /// Sum of the member messages' revisions; changes when any of them does.
    pub revision: u64,
    /// Number of branch replies whose parent lives in this turn.
    pub replies: usize,
}

impl Turn {
    /// Every message index in the turn, user first.
    pub fn members(&self) -> impl Iterator<Item = usize> + '_ {
        self.user.into_iter().chain(self.assistants.iter().copied())
    }
}

/// Group `messages` into turns. O(n); cheap enough to run on every
/// coalesced commit for thousands of messages.
pub fn group_turns(messages: &[Message]) -> Vec<Turn> {
    let mut turns: Vec<Turn> = Vec::new();
    let mut owner: HashMap<&MessageId, usize> = HashMap::with_capacity(messages.len());
    let mut current: Option<Turn> = None;

    fn finish(current: &mut Option<Turn>, turns: &mut Vec<Turn>) {
        if let Some(turn) = current.take() {
            turns.push(turn);
        }
    }

    for (ix, msg) in messages.iter().enumerate() {
        if msg.branch_of.is_some() {
            continue;
        }
        match msg.role {
            Role::User => {
                finish(&mut current, &mut turns);
                current = Some(Turn { key: msg.id.clone(), user: Some(ix), assistants: Vec::new(), revision: msg.revision, replies: 0 });
            }
            Role::System => {
                finish(&mut current, &mut turns);
                turns.push(Turn { key: msg.id.clone(), user: None, assistants: vec![ix], revision: msg.revision, replies: 0 });
            }
            Role::Assistant => {
                let same_author = current.as_ref().is_some_and(|t| {
                    t.assistants.first().is_none_or(|&first| messages[first].author == msg.author)
                });
                if !same_author {
                    finish(&mut current, &mut turns);
                }
                let turn = current.get_or_insert_with(|| Turn { key: msg.id.clone(), user: None, assistants: Vec::new(), revision: 0, replies: 0 });
                turn.assistants.push(ix);
                turn.revision = turn.revision.wrapping_add(msg.revision);
            }
        }
        // System turns are already pushed; the running turn lands at `turns.len()`.
        let turn_ix = if msg.role == Role::System { turns.len() - 1 } else { turns.len() };
        owner.insert(&msg.id, turn_ix);
    }
    finish(&mut current, &mut turns);

    for msg in messages {
        if let Some(parent) = &msg.branch_of
            && let Some(&turn_ix) = owner.get(parent)
        {
            turns[turn_ix].replies += 1;
        }
    }
    turns
}

#[cfg(test)]
mod tests {
    use super::*;
    use boss_core::*;

    fn msg(role: Role, author: Option<&str>) -> Message {
        let mut m = Message::new(ThreadId::from_raw("t"), role);
        m.author = author.map(ParticipantId::from_raw);
        m.status = MessageStatus::Complete;
        m
    }

    #[test]
    fn user_then_assistants_form_one_turn() {
        let msgs = vec![msg(Role::User, None), msg(Role::Assistant, None), msg(Role::Assistant, None)];
        let turns = group_turns(&msgs);
        assert_eq!(turns.len(), 1);
        assert_eq!(turns[0].user, Some(0));
        assert_eq!(turns[0].assistants, vec![1, 2]);
        assert_eq!(turns[0].key, msgs[0].id);
    }

    #[test]
    fn author_change_breaks_the_turn() {
        let msgs = vec![
            msg(Role::User, None),
            msg(Role::Assistant, Some("builder")),
            msg(Role::Assistant, Some("builder")),
            msg(Role::Assistant, Some("reviewer")),
            msg(Role::User, None),
        ];
        let turns = group_turns(&msgs);
        assert_eq!(turns.len(), 3);
        assert_eq!(turns[0].assistants, vec![1, 2]);
        assert_eq!(turns[1].user, None);
        assert_eq!(turns[1].assistants, vec![3]);
        assert_eq!(turns[1].key, msgs[3].id);
        assert_eq!(turns[2].user, Some(4));
        assert!(turns[2].assistants.is_empty());
    }

    #[test]
    fn system_messages_stand_alone() {
        let msgs = vec![msg(Role::Assistant, None), msg(Role::System, None), msg(Role::Assistant, None)];
        let turns = group_turns(&msgs);
        assert_eq!(turns.len(), 3);
        assert_eq!(turns[1].assistants, vec![1]);
    }

    #[test]
    fn branch_replies_are_counted_not_placed() {
        let mut msgs = vec![msg(Role::User, None), msg(Role::Assistant, None)];
        let parent = msgs[1].id.clone();
        let mut reply = msg(Role::User, None);
        reply.branch_of = Some(parent.clone());
        let mut reply2 = msg(Role::Assistant, None);
        reply2.branch_of = Some(parent);
        msgs.push(reply);
        msgs.push(reply2);
        msgs.push(msg(Role::User, None));
        let turns = group_turns(&msgs);
        assert_eq!(turns.len(), 2);
        assert_eq!(turns[0].replies, 2);
        assert_eq!(turns[0].members().collect::<Vec<_>>(), vec![0, 1]);
        assert_eq!(turns[1].user, Some(4));
    }

    #[test]
    fn revision_tracks_member_changes() {
        let mut msgs = vec![msg(Role::User, None), msg(Role::Assistant, None)];
        let before = group_turns(&msgs)[0].revision;
        msgs[1].touch();
        let after = group_turns(&msgs)[0].revision;
        assert_ne!(before, after);
    }
}

#[cfg(test)]
mod scale_tests {
    use super::*;
    use crate::transcript::cache::RenderCache;
    use boss_core::*;
    use std::time::Instant;

    /// The per-commit work at the target scale: regroup 5,000 messages and
    /// serve them from the cache. Both must stay far below one frame (16 ms).
    #[test]
    fn five_thousand_messages_regroup_and_cache_within_a_frame() {
        let thread = ThreadId::from_raw("t");
        let messages: Vec<Message> = (0..5_000)
            .map(|i| {
                let mut m = Message::new(thread.clone(), if i % 6 == 0 { Role::User } else { Role::Assistant });
                m.author = (i % 6 != 0).then(|| ParticipantId::from_raw(if (i / 6) % 2 == 0 { "a" } else { "b" }));
                m.parts.push(Part::Text(TextPart { id: PartId::new(), text: format!("message {i} with some **markdown**") }));
                m
            })
            .collect();

        let started = Instant::now();
        let turns = group_turns(&messages);
        let group_time = started.elapsed();

        let mut cache = RenderCache::new();
        let started = Instant::now();
        for m in &messages {
            cache.get(m);
        }
        let cold = started.elapsed();
        let started = Instant::now();
        for m in &messages {
            cache.get(m);
        }
        let warm = started.elapsed();

        eprintln!("5,000 messages: group {group_time:?}, cache cold {cold:?}, cache warm {warm:?}");
        // One user message plus five same-author replies make one turn.
        assert_eq!(turns.len(), messages.len().div_ceil(6));
        assert_eq!(cache.misses(), 5_000);
        assert_eq!(cache.hits(), 5_000);
        assert!(group_time.as_millis() < 16, "grouping took {group_time:?}");
        assert!(warm.as_millis() < 16, "warm cache pass took {warm:?}");
    }
}
