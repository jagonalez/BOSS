//! Which colour names an agent in the transcript, and what a speaker is
//! called. Port of `src/renderer/src/lib/author-tone.ts`.

use super::room::RoomRole;
use serde::{Deserialize, Serialize};

/// One of four tones. Four, not more: past that the colours stop being
/// distinguishable, and the point is to tell two speakers apart at a glance.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthorTone {
    /// Held by BOSS alone.
    One,
    /// Drawn by name.
    Two,
    /// Drawn by name.
    Three,
    /// Drawn by name.
    Four,
}

/// The tone for an author. The name itself picks it, so the same agent looks
/// the same everywhere without anything being stored. BOSS keeps the first
/// tone; everyone else draws from the rest.
pub fn author_tone(author: &str) -> AuthorTone {
    if author.eq_ignore_ascii_case("boss") {
        return AuthorTone::One;
    }
    let sum = author
        .chars()
        .fold(0u32, |sum, c| (sum + u32::from(c)) % 997);
    match sum % 3 {
        0 => AuthorTone::Two,
        1 => AuthorTone::Three,
        _ => AuthorTone::Four,
    }
}

/// What a speaker is called, in the words the user gave it. Falls back to the
/// id, because a role the user has since deleted still spoke; BOSS keeps its
/// capitals with no team to read.
pub fn author_name(author: &str, roles: &[RoomRole]) -> String {
    if let Some(role) = roles.iter().find(|role| role.id.as_str() == author) {
        return role.label.clone();
    }
    if author.eq_ignore_ascii_case("boss") {
        "BOSS".to_owned()
    } else {
        author.to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::EngineId;

    #[test]
    fn the_same_name_always_draws_the_same_colour() {
        assert_eq!(author_tone("builder"), author_tone("builder"));
        assert_eq!(author_tone("Reviewer"), author_tone("Reviewer"));
    }

    #[test]
    fn boss_keeps_a_colour_of_its_own() {
        assert_eq!(author_tone("boss"), AuthorTone::One);
        assert_eq!(author_tone("BOSS"), AuthorTone::One);
    }

    #[test]
    fn another_agent_never_takes_the_colour_boss_holds() {
        for name in [
            "builder",
            "reviewer",
            "planner",
            "researcher",
            "releaser",
            "Codey",
        ] {
            assert_ne!(
                author_tone(name),
                AuthorTone::One,
                "{name} must not look like BOSS"
            );
        }
    }

    #[test]
    fn a_role_the_user_renamed_still_gets_a_colour() {
        assert!(
            [AuthorTone::Two, AuthorTone::Three, AuthorTone::Four]
                .contains(&author_tone("Codey McCodeface"))
        );
    }

    #[test]
    fn a_speaker_is_named_in_the_words_the_user_gave_it() {
        let roles = [RoomRole::new(
            "reviewer",
            "Second pair of eyes",
            EngineId::Claude,
            None,
        )];
        assert_eq!(author_name("reviewer", &roles), "Second pair of eyes");
    }

    #[test]
    fn boss_keeps_its_capitals_even_with_no_team_to_read() {
        assert_eq!(author_name("boss", &[]), "BOSS");
    }

    #[test]
    fn a_role_the_user_deleted_is_still_named_by_its_id() {
        let roles = [RoomRole::new("builder", "Builder", EngineId::Codex, None)];
        assert_eq!(author_name("releaser", &roles), "releaser");
    }
}
