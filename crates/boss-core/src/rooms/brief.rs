//! What a participant is told, once, when it joins a room; and what BOSS is
//! told in its own conversation. Port of `src/shared/room-brief.ts`.
//!
//! Kept as text an agent reads rather than behaviour the code enforces,
//! because the user configures intent and authority, not prose.

use super::cards::CARD_INSTRUCTIONS;
use super::room::ROOM_ASSISTANT_ID;

/// The part every participant hears, whatever its role.
fn shared() -> String {
    [
        "You are one named participant in a room: a single conversation several agents share with the user.",
        "",
        "How a room works:",
        "- You speak only when the user addresses you. You never reply to another agent.",
        "- You may be shown messages meant for someone else, marked as context. Read them. Do not act on them.",
        "- Nothing you say reaches another agent directly. Job notes are the only thing that survives you.",
        "",
        "Before you finish, record your job notes: what was agreed, what you decided and why, and what actually changed. An agent brought in after you reads those notes and nothing else, so anything you leave out is lost.",
        "",
        CARD_INSTRUCTIONS,
    ]
    .join("\n")
}

/// Who BOSS is, wherever it is. Shared by the standing conversation and by
/// BOSS inside a room, because they are the same assistant in two places.
fn boss_identity(label: &str) -> Vec<String> {
    vec![
        format!("The app you run inside is also called {label}, and its tools are named after it. That is the same name, not a different thing: you are {label}. If the user asks whether you are {label}, the answer is yes."),
        String::new(),
        "Where you work:".to_owned(),
        format!("- {label} runs coding agents for this user. Each job gets its own room: one conversation several named agents share, with the user, and with you."),
        "- A room has a researcher, a planner, a builder, a reviewer — whichever the job needs. They join when the work reaches them, and each runs in its own session against its own copy of the code.".to_owned(),
        "- They do not talk to each other. What one agent leaves for the next is its job notes. Nothing else crosses.".to_owned(),
        "- Rooms keep running when the user closes the app or walks away. Several run at once.".to_owned(),
        String::new(),
        "You have a coding agent's tools, and you are not one. Reading a file to answer a question is fine. Changing code, running a build, or fixing a bug is not: that work belongs in a room. Asked what you can do, describe running the work — not editing files.".to_owned(),
    ]
}

/// How BOSS offers to start work, wherever it is asked for.
const BOSS_OFFER: &[&str] = &[
    "When the user asks for something that changes code, do not start. Ask first, with a card:",
    "",
    "```boss-card",
    "kind: gate",
    "title: Start a room for this?",
    "Add a search box to the settings page",
    "do: Start it",
    "do: Just tell me",
    "```",
    "",
    "If they choose to start it, ask which shape the room takes — one agent, build then review, or the full run. Never pick for them. Then open the room with that shape, and link to it so they can watch.",
    "If they choose \"Just tell me\", answer in the conversation and change nothing.",
    "Do not ask twice about the same job. Once the user has answered, that answer holds until the job is done.",
];

/// What each default role is for. Only the roles BOSS proposes have a line;
/// an unknown id gets the shared part and its own name.
fn by_role(id: &str) -> Option<&'static str> {
    Some(match id {
        "researcher" => {
            "You are the researcher. Find out how the code actually works before anyone changes it.\n\
             Read the code and report what is there. Do not change anything.\n\
             Say plainly what you could not find out, rather than filling the gap with a guess."
        }
        "planner" => {
            "You are the planner. Turn what the user asked for into a short, ordered plan.\n\
             Name what you will not do as clearly as what you will. A plan the user cannot check is not a plan.\n\
             Record the plan in your job notes as what was agreed. The builder reads that, not this conversation."
        }
        "builder" => {
            "You are the builder. Make the change.\n\
             A fresh agent that never saw this conversation will review your work against the plan. It reads the plan, the diff, and your job notes.\n\
             Where you went off the plan, say so and say why. The user trusts an agent that names its own departures far more than one that reports total success."
        }
        "reviewer" => {
            "You are the reviewer. You did not write this code and you are not here to approve it.\n\
             You are given the plan, the diff, and the job notes. You are deliberately not given the builder's conversation, so its account of itself cannot mislead you.\n\
             Compare what changed against what was agreed. Report every place they differ, whether or not the difference looks reasonable. The user decides which departures matter; you only find them."
        }
        "releaser" => {
            "You are the releaser. Ship what was agreed, and nothing else.\n\
             Stop and ask before anything the user cannot undo."
        }
        // Short, and the name first: the one sentence that matters must win
        // against the hundreds of tool descriptions loaded around it.
        ROOM_ASSISTANT_ID => {
            "You are BOSS. If the user asks whether you are BOSS, the answer is yes.\n\
             The app you run inside is also called BOSS, and its tools are named after it. That is one name for one thing, not two.\n\
             You coordinate this room. You never write code: a change belongs in a room, where it is planned and reviewed.\n\
             Quote the other agents word for word. Never write your own summary of work you did not see — the user reads the room, not your account of it.\n\
             When the user tells you to pass something on, pass it on as they said it. You speak with their authority.\n\
             When the user asks for something that changes code, ask which shape the room takes — one agent, build then review, or the full run. Never pick for them."
        }
        _ => return None,
    })
}

/// What starts the next participant when the one before it finishes. It says
/// nothing about the task: the arriving agent already has its brief, the job
/// notes, and the diff, and a second shorter version could disagree.
pub const HANDOVER_PROMPT: &str = "The agent before you has finished. Your turn.";

/// The full standing instruction for one participant. The user's own
/// instruction goes last, because it outranks anything shipped as a default.
pub fn brief_for_role(id: &str, label: &str, instruction: Option<&str>) -> String {
    let mut parts = vec![
        format!("[{}]", label.to_uppercase()),
        format!("You are \"{label}\" in this room."),
    ];
    if let Some(own) = by_role(id) {
        parts.push(String::new());
        parts.push(own.to_owned());
    }
    parts.push(String::new());
    parts.push(shared());
    if let Some(own) = instruction.map(str::trim).filter(|text| !text.is_empty()) {
        parts.push(String::new());
        parts.push(own.to_owned());
    }
    parts.join("\n")
}

/// What BOSS is, in its own standing conversation. Separate from a room
/// role's brief because that conversation is not a room. Replaces the
/// engine's own system prompt rather than appending to it.
pub fn assistant_brief(label: &str) -> String {
    let mut lines = vec![
        format!("[{}]", label.to_uppercase()),
        format!(
            "You are {label}, this user's standing assistant. One persistent conversation, reachable from anywhere, including their phone."
        ),
        format!("If the user asks whether you are {label}, the answer is yes."),
        String::new(),
    ];
    lines.extend(boss_identity(label));
    lines.extend(
        [
            "",
            "What you do:",
            "- Keep track of what jobs exist, what state each is in, and which thread each lives in.",
            "- Start a room per job. Never write code yourself, even for a one-line fix: the user may add another job half an hour later, and separate rooms keep the two from tangling.",
            "- Carry the user's instructions to other threads. You speak with their authority.",
            "- Tell them when something needs a decision.",
            "",
            "How you answer:",
            "- Quote other agents word for word, and link to their thread. Never write your own summary of work you did not see — the user checks the room, not your account of it.",
            "- Look things up with the thread tools rather than answering from memory.",
            "- Be brief. Say what happened, not what you are about to do.",
            "",
        ]
        .into_iter()
        .map(str::to_owned),
    );
    lines.extend(BOSS_OFFER.iter().map(|line| (*line).to_owned()));
    lines.push(String::new());
    lines.push(CARD_INSTRUCTIONS.to_owned());
    lines.join("\n")
}

/// The MCP server name the thread bus registers under in every engine.
pub const THREAD_BUS_SERVER: &str = "boss_thread_bus";

/// Bus tools BOSS may call as coordinator, by bare name. Everything it needs
/// to look things up, pass messages on, and start rooms; nothing that edits
/// code. BOSS never writes code.
pub const COORDINATOR_TOOLS: &[&str] = &[
    "boss_threads_list",
    "boss_threads_read",
    "boss_threads_send",
    "boss_threads_reply",
    "boss_threads_spawn_worktree",
    "boss_rooms_open",
    "boss_threads_use_worktree",
    "boss_threads_leave_worktree",
    "boss_git_create_change_request",
    "boss_presence_set",
    "boss_notes_record",
    "boss_reports_create",
    "boss_reports_update",
    "boss_workflow_list",
    "boss_workflow_create",
    "boss_workflow_update",
    "boss_workflow_run",
    "boss_workflow_runs",
    "boss_browser_tabs",
    "boss_browser_navigate",
    "boss_browser_snapshot",
    "boss_browser_screenshot",
    "boss_browser_click",
    "boss_browser_type",
    "boss_computer",
];

/// The coordinator's allowed-tools list as engines name MCP tools:
/// `mcp__<server>__<tool>`. Used with a strict tool config so BOSS holds
/// only these.
pub fn coordinator_allowed_tools() -> Vec<String> {
    COORDINATOR_TOOLS
        .iter()
        .map(|tool| format!("mcp__{THREAD_BUS_SERVER}__{tool}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn role_brief(id: &str, label: &str) -> String {
        brief_for_role(id, label, None)
    }

    #[test]
    fn every_participant_is_told_its_own_name_so_a_message_can_say_who_it_is_from() {
        assert!(role_brief("builder", "Builder").contains("Builder"));
    }

    #[test]
    fn the_reviewer_is_told_it_did_not_write_the_code_and_is_not_here_to_approve_it() {
        let brief = role_brief("reviewer", "Reviewer");
        assert!(brief.contains("did not write this code"));
        assert!(brief.contains("not here to approve"));
    }

    #[test]
    fn the_reviewer_is_told_why_it_does_not_get_the_builders_conversation() {
        assert!(role_brief("reviewer", "Reviewer").contains("account of itself"));
    }

    #[test]
    fn the_builder_is_told_a_fresh_agent_will_check_it_against_the_plan() {
        let brief = role_brief("builder", "Builder");
        assert!(brief.contains("review your work against the plan"));
        assert!(brief.contains("why"));
    }

    #[test]
    fn every_participant_is_told_job_notes_are_the_only_thing_that_survives_it() {
        for id in [
            "researcher",
            "planner",
            "builder",
            "reviewer",
            "releaser",
            "boss",
        ] {
            assert!(
                role_brief(id, id).to_lowercase().contains("job notes"),
                "{id} is told about notes"
            );
        }
    }

    #[test]
    fn every_participant_is_told_it_speaks_only_when_addressed() {
        let brief = role_brief("planner", "Planner");
        assert!(brief.contains("only when the user addresses you"));
        assert!(brief.contains("never reply to another agent"));
    }

    #[test]
    fn a_role_the_user_invented_still_gets_the_shared_part() {
        let brief = role_brief("designer", "Designer");
        assert!(brief.contains("Designer"));
        assert!(brief.to_lowercase().contains("job notes"));
    }

    #[test]
    fn boss_in_a_room_is_told_to_quote_rather_than_summarise() {
        let brief = role_brief("boss", "BOSS");
        assert!(brief.contains("word for word"));
        assert!(brief.to_lowercase().contains("never write code"));
    }

    #[test]
    fn the_users_own_instruction_comes_last_so_it_outranks_the_default() {
        let brief = brief_for_role("builder", "Builder", Some("Always run the linter."));
        assert!(brief.ends_with("Always run the linter."));
    }

    #[test]
    fn an_empty_instruction_adds_nothing() {
        let brief = brief_for_role("builder", "Builder", Some("   "));
        assert!(!brief.contains("\n\n\n"));
        assert_eq!(brief, brief_for_role("builder", "Builder", None));
    }

    #[test]
    fn the_handover_says_nothing_about_the_task() {
        let lower = HANDOVER_PROMPT.to_lowercase();
        for word in ["review", "build", "plan", "research"] {
            assert!(!lower.contains(word), "handover must not say {word}");
        }
    }

    #[test]
    fn every_participant_is_told_how_to_write_a_card() {
        for id in ["researcher", "planner", "builder", "reviewer", "boss"] {
            assert!(
                role_brief(id, id).contains("```boss-card"),
                "{id} can write a card"
            );
        }
    }

    #[test]
    fn the_standing_assistant_is_not_told_about_a_room_it_is_not_in() {
        let brief = assistant_brief("BOSS");
        assert!(!brief.contains("only when the user addresses you"));
        assert!(!brief.contains("never reply to another agent"));
    }

    #[test]
    fn the_standing_assistant_is_told_what_it_is_for() {
        let brief = assistant_brief("BOSS");
        assert!(brief.to_lowercase().contains("never write code yourself"));
        assert!(brief.contains("word for word"));
        assert!(brief.contains("```boss-card"), "and how to write a card");
    }

    #[test]
    fn the_assistant_is_named_in_the_words_the_user_gave_it() {
        assert!(assistant_brief("Chief").contains("You are Chief, this user's standing assistant"));
    }

    #[test]
    fn the_assistant_is_told_the_app_carries_its_own_name() {
        for brief in [assistant_brief("BOSS"), role_brief("boss", "BOSS")] {
            assert!(brief.contains("also called BOSS"));
            assert!(brief.contains("the answer is yes"));
        }
    }

    #[test]
    fn the_assistant_is_named_the_same_way_throughout_when_renamed() {
        let brief = assistant_brief("Chief");
        assert!(brief.contains("also called Chief"));
        assert!(!brief.contains("BOSS"));
    }

    #[test]
    fn the_assistant_is_told_what_the_app_around_it_does() {
        let lower = assistant_brief("BOSS").to_lowercase();
        assert!(lower.contains("room"), "knows work happens in rooms");
        assert!(
            lower.contains("job notes"),
            "knows what carries between agents"
        );
        assert!(
            lower.contains("closes the app"),
            "knows work outlives the window"
        );
    }

    #[test]
    fn the_assistant_is_told_it_is_not_the_coding_agent() {
        let lower = assistant_brief("BOSS").to_lowercase();
        assert!(lower.contains("you are not one"));
        assert!(lower.contains("belongs in a room"));
    }

    #[test]
    fn the_assistant_offers_a_room_before_anything_changes_code() {
        let brief = assistant_brief("BOSS");
        assert!(brief.contains("Start a room for this?"));
        assert!(brief.contains("do: Start it"));
        assert!(brief.contains("do: Just tell me"));
    }

    #[test]
    fn the_assistant_does_not_ask_twice_about_one_job() {
        assert!(
            assistant_brief("BOSS")
                .to_lowercase()
                .contains("not ask twice")
        );
    }

    #[test]
    fn boss_claims_its_name_in_both_places_and_claims_it_first() {
        for (where_, brief) in [
            ("the standing chat", assistant_brief("BOSS")),
            ("a room", role_brief("boss", "BOSS")),
        ] {
            assert!(
                brief.contains("the answer is yes"),
                "{where_} claims the name"
            );
            let head: Vec<&str> = brief.lines().take(4).collect();
            assert!(
                head.join("\n").contains("the answer is yes"),
                "{where_} claims it in the first lines"
            );
        }
    }

    #[test]
    fn the_room_brief_stays_short() {
        // Doubling it to explain rooms, notes, and cards is what buried the name.
        let brief = role_brief("boss", "BOSS");
        assert!(
            brief.chars().count() < 2500,
            "room brief is {} characters",
            brief.chars().count()
        );
    }

    #[test]
    fn the_coordinator_holds_bus_tools_and_nothing_that_edits_code() {
        let tools = coordinator_allowed_tools();
        assert!(
            tools
                .iter()
                .all(|tool| tool.starts_with("mcp__boss_thread_bus__boss_"))
        );
        assert!(tools.contains(&"mcp__boss_thread_bus__boss_threads_read".to_owned()));
        for forbidden in ["Edit", "Write", "Bash"] {
            assert!(
                !tools.iter().any(|tool| tool == forbidden),
                "BOSS never writes code"
            );
        }
    }
}
