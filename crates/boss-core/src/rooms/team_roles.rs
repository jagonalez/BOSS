//! Role presets for the team setup screen. Port of
//! `src/renderer/src/lib/team-roles.ts`.

use super::room::RoomRole;
use crate::engine::{EngineId, PermissionMode};

/// What a role may touch, said in plain words. Never the name of a
/// permission mode: the user answers "when should it stop and ask", not
/// "which policy applies". No stated reach reads only, the safe answer.
pub fn reach_of(role: &RoomRole) -> &'static str {
    match role.mode {
        Some(PermissionMode::Bypass) => "its own copy of the code",
        Some(PermissionMode::Default) | Some(PermissionMode::AcceptEdits) => "asks before shipping",
        Some(PermissionMode::Plan) | None => "reads only",
    }
}

/// What a role may touch, as the user chooses it. Three answers, no modes.
pub const REACH_CHOICES: [(PermissionMode, &str); 3] = [
    (PermissionMode::Plan, "reads only"),
    (PermissionMode::Bypass, "its own copy of the code"),
    (PermissionMode::Default, "asks before shipping"),
];

/// Roles the user can add back once they have deleted one. Only the
/// defaults BOSS knows how to place in a run; BOSS itself cannot be removed,
/// so it never needs adding back.
pub fn addable_roles() -> Vec<RoomRole> {
    vec![
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
        RoomRole::new(
            "releaser",
            "Releaser",
            EngineId::Codex,
            Some(PermissionMode::Default),
        ),
    ]
}

/// Default roles the team lacks, each on an engine the user has connected.
/// A default that names an unconnected engine falls back to the first one
/// available rather than offering a role that cannot run.
pub fn missing_roles(roles: &[RoomRole], available: &[EngineId]) -> Vec<RoomRole> {
    let Some(fallback) = available.first().copied() else {
        return Vec::new();
    };
    addable_roles()
        .into_iter()
        .filter(|candidate| !roles.iter().any(|role| role.id == candidate.id))
        .map(|mut candidate| {
            if !available.contains(&candidate.engine) {
                candidate.engine = fallback;
            }
            candidate
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn role(id: &str, mode: Option<PermissionMode>) -> RoomRole {
        RoomRole::new(id, "Builder", EngineId::Codex, mode)
    }

    #[test]
    fn what_a_role_may_touch_is_said_in_plain_words_never_as_a_policy_name() {
        assert_eq!(
            reach_of(&role("builder", Some(PermissionMode::Bypass))),
            "its own copy of the code"
        );
        assert_eq!(
            reach_of(&role("builder", Some(PermissionMode::Default))),
            "asks before shipping"
        );
        assert_eq!(
            reach_of(&role("builder", Some(PermissionMode::Plan))),
            "reads only"
        );
    }

    #[test]
    fn a_role_with_no_stated_reach_reads_only_which_is_the_safe_answer() {
        assert_eq!(reach_of(&role("builder", None)), "reads only");
    }

    #[test]
    fn every_reach_choice_reads_back_as_the_words_it_was_chosen_with() {
        for (mode, words) in REACH_CHOICES {
            assert_eq!(reach_of(&role("builder", Some(mode))), words);
        }
    }

    #[test]
    fn only_roles_the_user_has_deleted_are_offered_back() {
        let kept = [role("builder", None), role("reviewer", None)];
        let offered: Vec<String> = missing_roles(&kept, &[EngineId::Claude, EngineId::Codex])
            .iter()
            .map(|entry| entry.id.to_string())
            .collect();
        assert_eq!(offered, vec!["researcher", "planner", "releaser"]);
    }

    #[test]
    fn a_full_team_offers_nothing_to_add() {
        let full: Vec<RoomRole> = ["researcher", "planner", "builder", "reviewer", "releaser"]
            .iter()
            .map(|id| role(id, None))
            .collect();
        assert!(missing_roles(&full, &[EngineId::Claude]).is_empty());
    }

    #[test]
    fn an_offered_role_never_names_an_agent_the_user_has_not_connected() {
        let offered = missing_roles(&[], &[EngineId::Opencode]);
        assert!(!offered.is_empty());
        assert!(
            offered
                .iter()
                .all(|entry| entry.engine == EngineId::Opencode),
            "every offered role runs on something that exists"
        );
    }

    #[test]
    fn no_connected_agents_means_nothing_to_add() {
        assert!(missing_roles(&[], &[]).is_empty());
    }
}
