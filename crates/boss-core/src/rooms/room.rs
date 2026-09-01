//! Room vocabulary: reserved recipients, shapes, roles, teams, seats and job
//! notes. Port of `src/shared/room.ts`. Plain data; the transitions live in
//! [`super::manager`].

use crate::engine::{EngineId, PermissionMode};
use crate::ids::{ParticipantId, RoomId, ThreadId};
use crate::thread::{Participant, Room, RoomShape};
use serde::{Deserialize, Serialize};
use time::{Duration, OffsetDateTime};

/// Reserved recipient: BOSS, the coordinator that joins every room.
pub const ROOM_ASSISTANT_ID: &str = "boss";
/// Reserved recipient: the agent a plain thread runs on before it has roles.
pub const ROOM_THREAD_AGENT: &str = "agent";
/// Reserved author: the user.
pub const ROOM_USER_ID: &str = "you";
/// Reserved recipient: every participant, each replying once.
pub const ROOM_EVERYONE: &str = "everyone";
/// Every shape, in the order the user is offered them.
pub const ROOM_SHAPES: [RoomShape; 3] = [RoomShape::Direct, RoomShape::Reviewed, RoomShape::Full];
/// A participant idle beyond this is replaced rather than resumed: past an
/// hour no provider discount is left, and an old session would speak
/// confidently about code that has since moved.
pub const PARTICIPANT_STALE_AFTER: Duration = Duration::HOUR;

/// Wire name of a shape: `direct`, `reviewed`, or `full`.
pub fn room_shape_name(shape: RoomShape) -> &'static str {
    match shape {
        RoomShape::Direct => "direct",
        RoomShape::Reviewed => "reviewed",
        RoomShape::Full => "full",
    }
}

/// Read a shape from its wire name; anything else is not a shape.
pub fn parse_room_shape(value: &str) -> Option<RoomShape> {
    ROOM_SHAPES
        .into_iter()
        .find(|shape| room_shape_name(*shape) == value)
}

/// Read an engine from its wire name (`claude`, `codex`, `opencode`, `pi`).
pub fn parse_engine(value: &str) -> Option<EngineId> {
    EngineId::ALL
        .into_iter()
        .find(|engine| engine.as_str() == value)
}

/// Is this BOSS's reserved id?
pub fn is_assistant(id: &ParticipantId) -> bool {
    id.as_str() == ROOM_ASSISTANT_ID
}

/// Is this the broadcast recipient?
pub fn is_everyone(id: &ParticipantId) -> bool {
    id.as_str() == ROOM_EVERYONE
}

/// Is this the thread's own agent, addressed before a thread has roles?
pub fn is_thread_agent(id: &ParticipantId) -> bool {
    id.as_str() == ROOM_THREAD_AGENT
}

/// BOSS's reserved id as a `ParticipantId`.
pub fn assistant_id() -> ParticipantId {
    ParticipantId::from(ROOM_ASSISTANT_ID)
}

/// The broadcast recipient as a `ParticipantId`.
pub fn everyone_id() -> ParticipantId {
    ParticipantId::from(ROOM_EVERYONE)
}

/// The thread's own agent as a `ParticipantId`.
pub fn thread_agent_id() -> ParticipantId {
    ParticipantId::from(ROOM_THREAD_AGENT)
}

/// A role the user configured once, in setup. Names are theirs: "builder"
/// and "reviewer" are only defaults, and nothing may assume them.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RoomRole {
    /// Doubles as the participant id when this role joins a room.
    pub id: ParticipantId,
    /// What the user calls it. Shown on every message it sends.
    pub label: String,
    /// The engine this role runs on.
    pub engine: EngineId,
    /// Engine model, if the user chose one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Permission stance. Setup asks when to stop and ask in plain words;
    /// this is the machine-facing result and is never named in the UI.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<PermissionMode>,
    /// Extra standing instruction for this role, from setup.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instruction: Option<String>,
}

impl RoomRole {
    /// A role with no model and no instruction.
    pub fn new(id: &str, label: &str, engine: EngineId, mode: Option<PermissionMode>) -> Self {
        Self {
            id: ParticipantId::from(id),
            label: label.to_owned(),
            engine,
            model: None,
            mode,
            instruction: None,
        }
    }
}

/// What the user's team looks like. Configured once.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RoomTeam {
    /// The roles, BOSS first when it has a row.
    pub roles: Vec<RoomRole>,
    /// Whether BOSS asks which shape to use, or reuses `default_shape`.
    pub ask_shape: bool,
    /// Default when `ask_shape` is false. The user still chose it.
    pub default_shape: RoomShape,
}

impl RoomTeam {
    /// The role with this id, if the team has one.
    pub fn role(&self, id: &ParticipantId) -> Option<&RoomRole> {
        self.roles.iter().find(|role| &role.id == id)
    }

    /// Does the team have a role with this id?
    pub fn has_role(&self, id: &str) -> bool {
        self.roles.iter().any(|role| role.id.as_str() == id)
    }

    /// BOSS's own role. A real row when the team has one; otherwise borrowed
    /// from whichever role reads rather than writes, for teams saved before
    /// BOSS had a row.
    pub fn assistant_role(&self) -> Option<RoomRole> {
        if let Some(own) = self.roles.iter().find(|role| is_assistant(&role.id)) {
            return Some(own.clone());
        }
        let reader = self
            .roles
            .iter()
            .find(|role| role.mode == Some(PermissionMode::Plan))
            .or_else(|| self.roles.first())?;
        Some(RoomRole::new(
            ROOM_ASSISTANT_ID,
            "BOSS",
            reader.engine,
            Some(PermissionMode::Plan),
        ))
    }

    /// Add BOSS as a row to a team saved before it had one.
    pub fn with_assistant(mut self) -> Self {
        if self.roles.iter().any(|role| is_assistant(&role.id)) {
            return self;
        }
        if let Some(boss) = self.assistant_role() {
            self.roles.insert(0, boss);
        }
        self
    }
}

/// Where a participant is in its life inside one room.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ParticipantState {
    /// In the room and reachable.
    Active,
    /// Running right now.
    Working,
    /// Idle long enough that its session was dropped. Addressing it starts
    /// a fresh one that reads the job notes.
    Stale,
    /// Finished its part and left. Its notes remain.
    Done,
}

/// One named agent inside one room: the contract [`Participant`] plus the
/// room-side state of its seat.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RoomParticipant {
    /// Identity, engine, and native session of this seat.
    #[serde(flatten)]
    pub participant: Participant,
    /// Reachable, running, replaced, or gone.
    pub state: ParticipantState,
    /// When it last sent or received a message. Drives staleness and
    /// catch-up. Unset until it first speaks or is spoken to: joining is
    /// not the same as having read the room.
    #[serde(
        default,
        with = "time::serde::rfc3339::option",
        skip_serializing_if = "Option::is_none"
    )]
    pub last_active_at: Option<OffsetDateTime>,
    /// When it joined. Participants join when the work reaches them.
    #[serde(with = "time::serde::rfc3339")]
    pub joined_at: OffsetDateTime,
}

impl RoomParticipant {
    /// The role id this seat answers to.
    pub fn id(&self) -> &ParticipantId {
        &self.participant.id
    }

    /// What the user calls this participant.
    pub fn label(&self) -> &str {
        &self.participant.name
    }

    /// The engine this seat runs on for this job.
    pub fn engine(&self) -> EngineId {
        self.participant.engine
    }
}

/// Idle beyond the threshold, and not already gone. Falls back to the join
/// time: one that arrived and was never spoken to still holds a session.
pub fn participant_is_stale(participant: &RoomParticipant, now: OffsetDateTime) -> bool {
    if participant.state == ParticipantState::Done {
        return false;
    }
    let since = participant.last_active_at.unwrap_or(participant.joined_at);
    now - since > PARTICIPANT_STALE_AFTER
}

/// A choice made along the way, with who made it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct JobDecision {
    /// The decision in plain words.
    pub text: String,
    /// When it was made.
    #[serde(with = "time::serde::rfc3339")]
    pub at: OffsetDateTime,
    /// Which participant made or recorded it.
    pub by: ParticipantId,
}

/// What survives a participant's session. Scoped to one job; never memory
/// across jobs and never user preferences.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct JobNotes {
    /// What the user and the participants agreed to do.
    #[serde(default)]
    pub agreed: Vec<String>,
    /// Choices made along the way.
    #[serde(default)]
    pub decided: Vec<JobDecision>,
    /// What actually changed, in plain words.
    #[serde(default)]
    pub changed: Vec<String>,
    /// When the notes last changed. Unset when nothing was ever recorded.
    #[serde(
        default,
        with = "time::serde::rfc3339::option",
        skip_serializing_if = "Option::is_none"
    )]
    pub updated_at: Option<OffsetDateTime>,
}

impl JobNotes {
    /// Nothing recorded under any heading.
    pub fn is_empty(&self) -> bool {
        self.agreed.is_empty() && self.decided.is_empty() && self.changed.is_empty()
    }
}

/// A partial update to job notes: only the fields set are replaced.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct JobNotesPatch {
    /// Replace what was agreed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agreed: Option<Vec<String>>,
    /// Replace what was decided.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decided: Option<Vec<JobDecision>>,
    /// Replace what changed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub changed: Option<Vec<String>>,
}

/// The room's own state, stored beside the thread.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RoomState {
    /// Who has joined, in join order.
    #[serde(default)]
    pub participants: Vec<RoomParticipant>,
    /// What survives the participants.
    #[serde(default)]
    pub notes: JobNotes,
    /// How the job runs. Unset for a thread that is still an ordinary chat,
    /// or a room whose user has not chosen yet.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shape: Option<RoomShape>,
    /// Who the composer is addressed to. Stays where the user left it.
    pub recipient: ParticipantId,
}

impl Default for RoomState {
    fn default() -> Self {
        Self::addressed_to(thread_agent_id())
    }
}

impl RoomState {
    /// An empty room whose composer aims at `recipient`.
    pub fn addressed_to(recipient: ParticipantId) -> Self {
        Self {
            participants: Vec::new(),
            notes: JobNotes::default(),
            shape: None,
            recipient,
        }
    }

    /// The seat with this role id, whatever its state.
    pub fn find_participant(&self, id: &ParticipantId) -> Option<&RoomParticipant> {
        self.participants
            .iter()
            .find(|participant| participant.id() == id)
    }

    /// The seat with this role id, for mutation.
    pub fn find_participant_mut(&mut self, id: &ParticipantId) -> Option<&mut RoomParticipant> {
        self.participants
            .iter_mut()
            .find(|participant| participant.id() == id)
    }

    /// Who can be addressed right now: everyone who has not left.
    pub fn addressable(&self) -> Vec<&RoomParticipant> {
        self.participants
            .iter()
            .filter(|participant| participant.state != ParticipantState::Done)
            .collect()
    }

    /// Resolve a typed `@name` against the room, case-insensitively. Matches
    /// the label the user chose, then the role id. `None` rather than a
    /// guess: addressing the wrong agent is worse than asking again.
    pub fn resolve_mention(&self, name: &str) -> Option<ParticipantId> {
        let wanted = name.trim().trim_start_matches('@').to_lowercase();
        if wanted.is_empty() {
            return None;
        }
        if wanted == ROOM_EVERYONE {
            return Some(everyone_id());
        }
        if wanted == ROOM_ASSISTANT_ID {
            return Some(assistant_id());
        }
        self.participants
            .iter()
            .find(|participant| {
                participant.label().to_lowercase() == wanted
                    || participant.id().as_str().to_lowercase() == wanted
            })
            .map(|participant| participant.id().clone())
    }

    /// The contract's plain-data view of this room, once it has a shape.
    pub fn to_room(&self, id: RoomId, thread_id: ThreadId) -> Option<Room> {
        Some(Room {
            id,
            thread_id,
            shape: self.shape?,
            participants: self
                .participants
                .iter()
                .map(|participant| participant.participant.clone())
                .collect(),
        })
    }

    /// Room state for a contract `Room` whose seats have no history yet.
    /// The composer aims at BOSS, because a room opens with the user and BOSS.
    pub fn from_room(room: &Room, now: OffsetDateTime) -> Self {
        Self {
            participants: room
                .participants
                .iter()
                .cloned()
                .map(|participant| RoomParticipant {
                    participant,
                    state: ParticipantState::Active,
                    last_active_at: None,
                    joined_at: now,
                })
                .collect(),
            notes: JobNotes::default(),
            shape: Some(room.shape),
            recipient: assistant_id(),
        }
    }
}

/// A leading `@name` in composed text: the name and how many bytes it spans.
///
/// With `require_space`, the mention must be followed by whitespace, all of
/// which is consumed. Without it, a single trailing whitespace character or
/// the end of the text ends the mention. An optional `,` or `:` may follow
/// the name in both cases.
pub(super) fn mention_prefix(text: &str, require_space: bool) -> Option<(&str, usize)> {
    let mut rest = text.trim_start_matches(char::is_whitespace);
    let mut consumed = text.len() - rest.len();
    rest = rest.strip_prefix('@')?;
    consumed += 1;
    let name_len = rest
        .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == '-'))
        .unwrap_or(rest.len());
    if name_len == 0 {
        return None;
    }
    let name = &rest[..name_len];
    rest = &rest[name_len..];
    consumed += name_len;
    if let Some(after) = rest.strip_prefix([',', ':']) {
        rest = after;
        consumed += 1;
    }
    if require_space {
        let trimmed = rest.trim_start_matches(char::is_whitespace);
        if trimmed.len() == rest.len() {
            return None;
        }
        consumed += rest.len() - trimmed.len();
    } else if let Some(first) = rest.chars().next() {
        if !first.is_whitespace() {
            return None;
        }
        consumed += first.len_utf8();
    }
    Some((name, consumed))
}

/// Strip a leading mention from composed text. The chip already carries the
/// recipient, so "@builder do the thing" reaches the builder as "do the
/// thing". A mention mid-sentence is prose the agent should see.
pub fn strip_leading_mention(text: &str) -> &str {
    match mention_prefix(text, true) {
        Some((_, consumed)) => &text[consumed..],
        None => text,
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// A seat for tests: active, joined at the epoch, no session.
    pub(crate) fn participant(
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
                is_boss: id == ROOM_ASSISTANT_ID,
                native_session_id: None,
            },
            state,
            last_active_at: None,
            joined_at: at(0),
        }
    }

    /// Seconds since the epoch, as a timestamp.
    pub(crate) fn at(seconds: i64) -> OffsetDateTime {
        OffsetDateTime::from_unix_timestamp(seconds).expect("valid timestamp")
    }

    pub(crate) fn room(participants: Vec<RoomParticipant>) -> RoomState {
        RoomState {
            participants,
            ..RoomState::default()
        }
    }

    fn builder() -> RoomParticipant {
        participant(
            "builder",
            "Builder",
            EngineId::Codex,
            ParticipantState::Active,
        )
    }

    #[test]
    fn shapes_round_trip_through_their_wire_names() {
        for shape in ROOM_SHAPES {
            assert_eq!(parse_room_shape(room_shape_name(shape)), Some(shape));
        }
        assert_eq!(parse_room_shape("sideways"), None);
    }

    #[test]
    fn engines_parse_from_their_wire_names() {
        assert_eq!(parse_engine("codex"), Some(EngineId::Codex));
        assert_eq!(parse_engine("lab"), None, "Lab is gone");
    }

    #[test]
    fn a_participant_that_has_left_is_never_stale() {
        let left = participant(
            "planner",
            "Planner",
            EngineId::Claude,
            ParticipantState::Done,
        );
        assert!(!participant_is_stale(&left, at(1_000_000)));
    }

    #[test]
    fn staleness_falls_back_to_the_join_time_when_it_never_spoke() {
        // One that arrived and was never spoken to still holds a session.
        let seat = builder();
        assert!(!participant_is_stale(
            &seat,
            at(PARTICIPANT_STALE_AFTER.whole_seconds())
        ));
        assert!(participant_is_stale(
            &seat,
            at(PARTICIPANT_STALE_AFTER.whole_seconds() + 1)
        ));
    }

    #[test]
    fn speaking_pushes_staleness_out() {
        let mut seat = builder();
        seat.last_active_at = Some(at(5_000));
        assert!(!participant_is_stale(
            &seat,
            at(5_000 + PARTICIPANT_STALE_AFTER.whole_seconds())
        ));
    }

    #[test]
    fn a_mention_resolves_by_label_or_id_regardless_of_case() {
        let state = room(vec![participant(
            "r1",
            "Codey",
            EngineId::Codex,
            ParticipantState::Active,
        )]);
        assert_eq!(
            state.resolve_mention("codey"),
            Some(ParticipantId::from("r1"))
        );
        assert_eq!(
            state.resolve_mention("@R1"),
            Some(ParticipantId::from("r1"))
        );
        assert_eq!(state.resolve_mention("Everyone"), Some(everyone_id()));
        assert_eq!(state.resolve_mention("BOSS"), Some(assistant_id()));
        assert_eq!(
            state.resolve_mention("ghost"),
            None,
            "a wrong agent is worse than asking again"
        );
        assert_eq!(state.resolve_mention("@"), None);
    }

    #[test]
    fn a_leading_mention_is_stripped_and_a_mid_sentence_one_is_kept() {
        assert_eq!(
            strip_leading_mention("@builder do the thing"),
            "do the thing"
        );
        assert_eq!(strip_leading_mention("  @builder:   do it"), "do it");
        assert_eq!(
            strip_leading_mention("tell @builder it is ready"),
            "tell @builder it is ready"
        );
        assert_eq!(
            strip_leading_mention("@builder"),
            "@builder",
            "nothing follows, nothing to strip"
        );
    }

    #[test]
    fn a_room_projects_to_the_contract_only_once_it_has_a_shape() {
        let mut state = room(vec![builder()]);
        assert!(
            state
                .to_room(RoomId::from("room_1"), ThreadId::from("thr_1"))
                .is_none()
        );
        state.shape = Some(RoomShape::Reviewed);
        let projected = state
            .to_room(RoomId::from("room_1"), ThreadId::from("thr_1"))
            .expect("has a shape");
        assert_eq!(projected.participants.len(), 1);
        assert_eq!(projected.participants[0].id, ParticipantId::from("builder"));
        let back = RoomState::from_room(&projected, at(9));
        assert_eq!(back.shape, Some(RoomShape::Reviewed));
        assert_eq!(
            back.recipient,
            assistant_id(),
            "a room opens with the user and BOSS"
        );
    }

    #[test]
    fn a_team_saved_before_boss_had_a_row_gets_one() {
        let team = RoomTeam {
            roles: vec![
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
        };
        let with = team.clone().with_assistant();
        assert_eq!(with.roles[0].id, assistant_id());
        assert_eq!(
            with.roles[0].engine,
            EngineId::Claude,
            "it inherits from whichever role read rather than wrote"
        );
        assert_eq!(
            with.clone().with_assistant(),
            with,
            "adding twice adds nothing"
        );
        assert_eq!(
            RoomTeam {
                roles: vec![],
                ..team
            }
            .with_assistant()
            .roles
            .len(),
            0,
            "nothing to inherit from"
        );
    }

    #[test]
    fn a_seat_serialises_flat_with_its_participant() {
        let json = serde_json::to_value(builder()).expect("serialises");
        assert_eq!(json["id"], "builder");
        assert_eq!(json["engine"], "codex");
        assert_eq!(json["state"], "active");
        let back: RoomParticipant = serde_json::from_value(json).expect("deserialises");
        assert_eq!(back, builder());
    }
}
