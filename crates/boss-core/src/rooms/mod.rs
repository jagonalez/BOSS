//! Rooms: a thread several named agents share with BOSS and the user.
//!
//! Pure domain logic, no IO and no UI. `room` holds the vocabulary,
//! `routing`, `recipient`, `brief`, `cards`, `job_notes`, `team_roles` and
//! `author_tone` are the pure helpers, and `manager` is the state machine
//! that turns user messages and finished runs into [`RoomIntent`]s for the
//! app to execute.

pub mod author_tone;
pub mod brief;
pub mod cards;
pub mod job_notes;
pub mod manager;
pub mod recipient;
pub mod room;
pub mod routing;
pub mod team_roles;

pub use author_tone::{AuthorTone, author_name, author_tone};
pub use brief::{
    COORDINATOR_TOOLS, HANDOVER_PROMPT, THREAD_BUS_SERVER, assistant_brief, brief_for_role,
    coordinator_allowed_tools,
};
pub use cards::{
    CARD_INSTRUCTIONS, CardKind, CardLink, CardSegment, LineMark, RoomCard, line_mark, parse_card,
    split_cards,
};
pub use job_notes::brief_of;
pub use manager::{
    NOBODY_HERE, RoomContext, RoomIntent, RoomManager, roles_for_shape, suggested_roles,
};
pub use recipient::{
    RecipientKind, RecipientOption, Retarget, asking, override_for, recipient_kind,
    recipient_label, recipient_options, recipient_problem, retarget, split_override,
};
pub use room::{
    JobDecision, JobNotes, JobNotesPatch, PARTICIPANT_STALE_AFTER, ParticipantState,
    ROOM_ASSISTANT_ID, ROOM_EVERYONE, ROOM_SHAPES, ROOM_THREAD_AGENT, ROOM_USER_ID,
    RoomParticipant, RoomRole, RoomState, RoomTeam, assistant_id, everyone_id, is_assistant,
    is_everyone, is_thread_agent, parse_engine, parse_room_shape, participant_is_stale,
    room_shape_name, strip_leading_mention, thread_agent_id,
};
pub use routing::{
    Branches, CatchUp, RoomDelivery, catch_up_for, catch_up_prompt, delivery_for, in_branch,
    split_branches,
};
pub use team_roles::{REACH_CHOICES, addable_roles, missing_roles, reach_of};
