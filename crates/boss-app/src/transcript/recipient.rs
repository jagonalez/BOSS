//! Recipient chip rules for the composer.
//!
//! Minimal port of `src/renderer/src/lib/recipient.ts` (`retarget`) and
//! `src/shared/room.ts` (`resolveMention`) against `ThreadModel.participants`.
//! `boss_core::rooms::recipient` has the fuller version keyed on `RoomState`;
//! it is not exported from `boss_core` yet, so this stays local until it is.

use boss_core::{Participant, ParticipantId};

/// Reserved mention that addresses the coordinator (`is_boss`).
pub const BOSS_MENTION: &str = "boss";

/// Result of a leading `@name` in composed text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Mention {
    /// Who the text now addresses.
    pub recipient: ParticipantId,
    /// The text with the mention removed; the chip carries it instead.
    pub rest: String,
}

/// Parse a leading `@name[,:] ` and resolve it against `participants`.
///
/// With `require_trailing_space` the name must be followed by whitespace,
/// which is the rule while the user is still typing (so `@bui` is not
/// grabbed before `@builder` is finished). On send, end-of-text also counts.
/// An unknown name is left alone: the user may be writing about a person or
/// a file, and retargeting to something they did not mean is worse than
/// doing nothing.
pub fn retarget(text: &str, participants: &[Participant], require_trailing_space: bool) -> Option<Mention> {
    let body = text.trim_start().strip_prefix('@')?;
    let name_len = body.chars().take_while(|c| c.is_alphanumeric() || *c == '_' || *c == '-').map(char::len_utf8).sum::<usize>();
    if name_len == 0 {
        return None;
    }
    let (name, mut after) = body.split_at(name_len);
    if let Some(stripped) = after.strip_prefix([',', ':']) {
        after = stripped;
    }
    let delimited = after.starts_with(char::is_whitespace);
    if !delimited && (require_trailing_space || !after.is_empty()) {
        return None;
    }
    let recipient = resolve_mention(name, participants)?;
    Some(Mention { recipient, rest: after.trim_start().to_owned() })
}

/// Resolve a bare name (with or without `@`) to a participant, case-insensitively,
/// by display name or id. `boss` resolves to the participant flagged `is_boss`.
pub fn resolve_mention(name: &str, participants: &[Participant]) -> Option<ParticipantId> {
    let wanted = name.trim().trim_start_matches('@').to_lowercase();
    if wanted.is_empty() {
        return None;
    }
    if wanted == BOSS_MENTION
        && let Some(boss) = participants.iter().find(|p| p.is_boss)
    {
        return Some(boss.id.clone());
    }
    participants
        .iter()
        .find(|p| p.name.to_lowercase() == wanted || p.id.as_str().to_lowercase() == wanted)
        .map(|p| p.id.clone())
}

/// Display name for a participant id, if it is in the thread.
pub fn participant_name<'a>(participants: &'a [Participant], id: &ParticipantId) -> Option<&'a str> {
    participants.iter().find(|p| &p.id == id).map(|p| p.name.as_str())
}

/// The recipient a fresh composer starts with: BOSS when present, else the
/// first participant, else nobody (a plain chat has no chip).
pub fn default_recipient(participants: &[Participant]) -> Option<ParticipantId> {
    participants
        .iter()
        .find(|p| p.is_boss)
        .or_else(|| participants.first())
        .map(|p| p.id.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use boss_core::EngineId;

    fn participant(id: &str, name: &str, is_boss: bool) -> Participant {
        Participant { id: ParticipantId::from_raw(id), name: name.into(), engine: EngineId::Claude, model: None, is_boss, native_session_id: None }
    }

    fn team() -> Vec<Participant> {
        vec![participant("who_1", "Builder", false), participant("who_2", "Reviewer", false), participant("who_boss", "BOSS", true)]
    }

    #[test]
    fn leading_mention_retargets_and_is_stripped() {
        let m = retarget("@builder fix the tests", &team(), false).unwrap();
        assert_eq!(m.recipient.as_str(), "who_1");
        assert_eq!(m.rest, "fix the tests");
    }

    #[test]
    fn punctuation_and_whitespace_variants() {
        assert_eq!(retarget("  @Reviewer: look", &team(), false).unwrap().rest, "look");
        assert_eq!(retarget("@reviewer, look", &team(), false).unwrap().rest, "look");
        assert_eq!(retarget("@who_2\nlook", &team(), false).unwrap().recipient.as_str(), "who_2");
    }

    #[test]
    fn mention_alone_only_counts_on_send() {
        assert!(retarget("@builder", &team(), true).is_none(), "still typing");
        let m = retarget("@builder", &team(), false).unwrap();
        assert_eq!(m.recipient.as_str(), "who_1");
        assert_eq!(m.rest, "");
    }

    #[test]
    fn unknown_or_mid_sentence_names_are_left_alone() {
        assert!(retarget("@nobody hi", &team(), false).is_none());
        assert!(retarget("ask @builder about it", &team(), false).is_none());
        assert!(retarget("@builder2 hi", &team(), false).is_none(), "longer name is a different name");
        assert!(retarget("email me@builder.dev", &team(), false).is_none());
    }

    #[test]
    fn boss_resolves_to_the_coordinator() {
        assert_eq!(resolve_mention("@boss", &team()).unwrap().as_str(), "who_boss");
        assert_eq!(default_recipient(&team()).unwrap().as_str(), "who_boss");
        let no_boss = &team()[..2];
        assert_eq!(default_recipient(no_boss).unwrap().as_str(), "who_1");
        assert!(default_recipient(&[]).is_none());
    }
}
