//! The rooms state machine: who is in a room, what survives them, and what
//! the app must do next. Port of `src/main/room-manager.ts` plus the routing,
//! catch-up and handover decisions that lived in `src/main/backend/manager.ts`.
//!
//! Pure. Persistence, engines and the clock belong to the app: state comes in
//! through [`RoomManager::from_parts`] and [`RoomContext`], and every side
//! effect goes out as a [`RoomIntent`].

use super::brief::{HANDOVER_PROMPT, brief_for_role, coordinator_allowed_tools};
use super::job_notes::brief_of;
use super::recipient::split_override;
use super::room::{
    JobNotes, JobNotesPatch, ParticipantState, ROOM_ASSISTANT_ID, RoomParticipant, RoomRole,
    RoomState, RoomTeam, assistant_id, is_assistant, is_everyone, is_thread_agent,
    participant_is_stale,
};
use super::routing::{catch_up_for, catch_up_prompt, delivery_for};
use crate::engine::{EngineId, PermissionMode, Prompt, SessionOptions};
use crate::ids::{ParticipantId, ThreadId};
use crate::message::Message;
use crate::thread::{Participant, RoomShape};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;
use time::OffsetDateTime;

/// What the app must do after a room transition.
///
/// Execute in order. A `SendToParticipant` is done when that participant's
/// run settles, not when the engine accepts the prompt; that is what makes a
/// broadcast reach one participant at a time instead of all at once.
#[derive(Clone, Debug)]
pub enum RoomIntent {
    /// Start a fresh engine session for a participant that joined or was
    /// replaced. Never resumes: an old context is dropped, not resent.
    StartSession {
        /// The engine to start it on.
        engine: EngineId,
        /// Everything the engine needs. `bus` is left for the app to fill.
        options: SessionOptions,
    },
    /// Close a participant's session.
    EndSession {
        /// The room.
        thread_id: ThreadId,
        /// Whose session.
        participant: ParticipantId,
        /// The engine-native id, if the session had reported one.
        native_session_id: Option<String>,
    },
    /// Deliver one prompt to a participant's session.
    SendToParticipant {
        /// The room.
        thread_id: ThreadId,
        /// Who answers.
        participant: ParticipantId,
        /// Standing context true for this message only: job notes and what
        /// the participant missed. Hand it over outside the conversation.
        context: Option<String>,
        /// What the user (or the shape) asked.
        prompt: Prompt,
    },
    /// A collapsed system line for the room: "Builder joined", or why
    /// nothing happened.
    Notify {
        /// The room.
        thread_id: ThreadId,
        /// The line.
        text: String,
    },
}

/// What the wider app knows that a routing decision needs.
#[derive(Clone, Copy, Debug)]
pub struct RoomContext<'a> {
    /// Where the room's work happens. Every participant shares it.
    pub cwd: &'a Path,
    /// The room's transcript in stored order, without the message being routed.
    pub messages: &'a [Message],
    /// How the user is named in catch-up text.
    pub user_label: &'a str,
    /// Now.
    pub now: OffsetDateTime,
}

/// Told to the user when a broadcast finds nobody to answer.
pub const NOBODY_HERE: &str =
    "There is nobody in this room yet. Address a role, or start the work first.";

/// Roles BOSS proposes when a user has connected engines but never opened
/// setup. Defaults, not a vocabulary: the user renames them freely. The
/// reviewer differs from the builder when there is a choice, because a second
/// opinion from the same model is not a second opinion.
pub fn suggested_roles(available: &[EngineId]) -> Vec<RoomRole> {
    let Some(&first) = available.first() else {
        return Vec::new();
    };
    let strongest = if available.contains(&EngineId::Claude) {
        EngineId::Claude
    } else {
        first
    };
    let builder = if available.contains(&EngineId::Codex) {
        EngineId::Codex
    } else {
        strongest
    };
    let reviewer = available
        .iter()
        .copied()
        .find(|engine| *engine != builder)
        .unwrap_or(builder);
    vec![
        // First, because it is who the user talks to. It coordinates and never
        // edits code, so it reads only.
        RoomRole::new(
            ROOM_ASSISTANT_ID,
            "BOSS",
            strongest,
            Some(PermissionMode::Plan),
        ),
        RoomRole::new(
            "researcher",
            "Researcher",
            strongest,
            Some(PermissionMode::Plan),
        ),
        RoomRole::new("planner", "Planner", strongest, Some(PermissionMode::Plan)),
        RoomRole::new("builder", "Builder", builder, Some(PermissionMode::Bypass)),
        RoomRole::new("reviewer", "Reviewer", reviewer, Some(PermissionMode::Plan)),
        RoomRole::new(
            "releaser",
            "Releaser",
            builder,
            Some(PermissionMode::Default),
        ),
    ]
}

/// Which roles a shape uses, in the order they join. Roles the user deleted
/// from the team are skipped: deleting a role removes that step.
pub fn roles_for_shape(shape: RoomShape, team: &RoomTeam) -> Vec<ParticipantId> {
    let order: &[&str] = match shape {
        RoomShape::Direct => &["builder"],
        RoomShape::Reviewed => &["builder", "reviewer"],
        RoomShape::Full => &["researcher", "planner", "builder", "reviewer"],
    };
    order
        .iter()
        .filter(|id| team.has_role(id))
        .map(|id| ParticipantId::from(*id))
        .collect()
}

/// Every room's state and the team, with the transitions between them.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct RoomManager {
    #[serde(default)]
    team: Option<RoomTeam>,
    #[serde(default)]
    rooms: BTreeMap<ThreadId, RoomState>,
}

impl RoomManager {
    /// No team, no rooms.
    pub fn new() -> Self {
        Self::default()
    }

    /// Rebuild from stored state. A team saved before BOSS had a row gets one.
    pub fn from_parts(team: Option<RoomTeam>, rooms: BTreeMap<ThreadId, RoomState>) -> Self {
        Self {
            team: team.map(RoomTeam::with_assistant),
            rooms,
        }
    }

    /// The team and every room, for storing.
    pub fn into_parts(self) -> (Option<RoomTeam>, BTreeMap<ThreadId, RoomState>) {
        (self.team, self.rooms)
    }

    /// The user's team, once configured.
    pub fn team(&self) -> Option<&RoomTeam> {
        self.team.as_ref()
    }

    /// Every room that has state.
    pub fn rooms(&self) -> &BTreeMap<ThreadId, RoomState> {
        &self.rooms
    }

    /// Replace the team.
    pub fn configure_team(&mut self, team: RoomTeam) -> &RoomTeam {
        &*self.team.insert(team)
    }

    /// A room's state, or an empty room for a thread with none.
    pub fn room(&self, thread: &ThreadId) -> RoomState {
        self.rooms.get(thread).cloned().unwrap_or_default()
    }

    /// A room's state, if the thread has any.
    pub fn room_ref(&self, thread: &ThreadId) -> Option<&RoomState> {
        self.rooms.get(thread)
    }

    fn room_mut(&mut self, thread: &ThreadId) -> &mut RoomState {
        self.rooms.entry(thread.clone()).or_default()
    }

    /// Remember who the composer is addressed to. It stays where the user
    /// left it; an unaddressed message is never allowed.
    pub fn set_recipient(&mut self, thread: &ThreadId, recipient: ParticipantId) -> &RoomState {
        let room = self.room_mut(thread);
        room.recipient = recipient;
        room
    }

    /// Choose how a job runs. Recording only: nobody starts until the first
    /// message, so the choice can still be changed.
    pub fn choose_shape(&mut self, thread: &ThreadId, shape: RoomShape) -> &RoomState {
        let room = self.room_mut(thread);
        room.shape = Some(shape);
        room
    }

    /// Who answers this room's first message, if nobody has yet. `None` when
    /// the room has no shape, there is no team, or someone is already in it.
    /// A room only has a shape because the user gave it one; falling back to
    /// the team default here would turn every ordinary chat into a job.
    pub fn opening_role(&self, thread: &ThreadId) -> Option<ParticipantId> {
        let room = self.rooms.get(thread)?;
        let shape = room.shape?;
        let team = self.team.as_ref()?;
        if !room.participants.is_empty() {
            return None;
        }
        roles_for_shape(shape, team).into_iter().next()
    }

    /// The shape a new job takes when the user asked not to be asked each
    /// time. `None` when they want the choice, which is the default.
    pub fn standing_shape(&self) -> Option<RoomShape> {
        let team = self.team.as_ref()?;
        (!team.ask_shape).then_some(team.default_shape)
    }

    /// Who follows the role that just finished, under this room's shape.
    /// Nothing when the shape is done, the room has no shape, or the next
    /// role is already here.
    pub fn next_after(&self, thread: &ThreadId, role: &ParticipantId) -> Option<ParticipantId> {
        let room = self.rooms.get(thread)?;
        let order = roles_for_shape(room.shape?, self.team.as_ref()?);
        let index = order.iter().position(|id| id == role)?;
        let next = order.get(index + 1)?;
        match room.find_participant(next) {
            Some(already) if already.state != ParticipantState::Done => None,
            _ => Some(next.clone()),
        }
    }

    fn role_for(&self, id: &ParticipantId) -> Option<RoomRole> {
        let team = self.team.as_ref()?;
        // BOSS is a participant in every room, not a role the user configures.
        if is_assistant(id) {
            team.assistant_role()
        } else {
            team.role(id).cloned()
        }
    }

    /// Bring a participant into the room, starting its session.
    ///
    /// Joining twice is a no-op, so a repeated mention cannot spawn a second
    /// session. A stale or finished seat is replaced by a fresh one. `engine`
    /// runs this one job on a different engine than the role usually uses;
    /// that always means a fresh session, because the point is a different
    /// agent. The reach stays the role's own.
    pub fn join(
        &mut self,
        thread: &ThreadId,
        role_id: &ParticipantId,
        engine: Option<EngineId>,
        cwd: &Path,
        now: OffsetDateTime,
    ) -> Option<(RoomParticipant, Vec<RoomIntent>)> {
        let mut role = self.role_for(role_id)?;
        let room = self.room_mut(thread);
        let mut intents = Vec::new();
        if let Some(existing) = room.find_participant_mut(role_id) {
            let same_engine = engine.is_none_or(|wanted| wanted == existing.engine());
            let live = !matches!(
                existing.state,
                ParticipantState::Stale | ParticipantState::Done
            );
            if live && same_engine {
                return Some((existing.clone(), intents));
            }
            // Replacing a live agent stops it. A half-finished run has nothing
            // worth keeping, and its context is never resent.
            if live {
                intents.push(RoomIntent::EndSession {
                    thread_id: thread.clone(),
                    participant: role_id.clone(),
                    native_session_id: existing.participant.native_session_id.take(),
                });
            }
        }
        if let Some(engine) = engine {
            role.engine = engine;
        }
        let participant = RoomParticipant {
            participant: Participant {
                id: role_id.clone(),
                name: role.label.clone(),
                engine: role.engine,
                model: role.model.clone(),
                is_boss: is_assistant(role_id),
                native_session_id: None,
            },
            state: ParticipantState::Active,
            // Deliberately unset. Joining is not the same as having read the
            // room; stamped here, a fresh reviewer looked caught up and its
            // brief never reached it.
            last_active_at: None,
            joined_at: now,
        };
        room.participants.retain(|entry| entry.id() != role_id);
        room.participants.push(participant.clone());
        intents.push(RoomIntent::StartSession {
            engine: role.engine,
            options: session_options(thread, &role, cwd),
        });
        intents.push(RoomIntent::Notify {
            thread_id: thread.clone(),
            text: format!("{} joined", role.label),
        });
        Some((participant, intents))
    }

    /// Bring in the role that opens this room, and aim the composer at it.
    /// Only the first role joins: a reviewer arrives when the builder
    /// finishes, and starting all of them would burn sessions on agents with
    /// nothing yet to read.
    pub fn open_with(
        &mut self,
        thread: &ThreadId,
        role: &ParticipantId,
        cwd: &Path,
        now: OffsetDateTime,
    ) -> Vec<RoomIntent> {
        let Some((_, intents)) = self.join(thread, role, None, cwd, now) else {
            return Vec::new();
        };
        self.set_recipient(thread, role.clone());
        intents
    }

    /// Note that a participant just spoke or was spoken to, so it does not
    /// go stale while in use; optionally move it to a new state.
    pub fn touch(
        &mut self,
        thread: &ThreadId,
        role: &ParticipantId,
        state: Option<ParticipantState>,
        now: OffsetDateTime,
    ) {
        let Some(participant) = self
            .rooms
            .get_mut(thread)
            .and_then(|room| room.find_participant_mut(role))
        else {
            return;
        };
        participant.last_active_at = Some(now);
        if let Some(state) = state {
            participant.state = state;
        }
    }

    /// Record the engine-native session id a participant's session reported.
    pub fn session_ready(
        &mut self,
        thread: &ThreadId,
        role: &ParticipantId,
        native_session_id: String,
    ) {
        if let Some(participant) = self
            .rooms
            .get_mut(thread)
            .and_then(|room| room.find_participant_mut(role))
        {
            participant.participant.native_session_id = Some(native_session_id);
        }
    }

    /// Drop the sessions of participants idle too long. A stale participant
    /// is replaced rather than resumed; its notes are what carry forward.
    pub fn retire_stale(&mut self, thread: &ThreadId, now: OffsetDateTime) -> Vec<RoomIntent> {
        let Some(room) = self.rooms.get_mut(thread) else {
            return Vec::new();
        };
        let mut intents = Vec::new();
        for participant in &mut room.participants {
            if participant.state == ParticipantState::Stale
                || !participant_is_stale(participant, now)
            {
                continue;
            }
            intents.push(RoomIntent::EndSession {
                thread_id: thread.clone(),
                participant: participant.id().clone(),
                native_session_id: participant.participant.native_session_id.take(),
            });
            participant.state = ParticipantState::Stale;
        }
        intents
    }

    /// Take a participant out of the room for good: close its session, drop
    /// its seat, and say so. `None` when there is no such seat.
    ///
    /// BOSS cannot be removed. It is the seat the user always has to fall
    /// back on, and a room with nobody in it could not answer anything.
    /// A composer pointing at the seat that just left is aimed back at BOSS
    /// rather than left addressing a ghost.
    pub fn remove_participant(
        &mut self,
        thread: &ThreadId,
        role: &ParticipantId,
    ) -> Option<Vec<RoomIntent>> {
        if is_assistant(role) {
            return None;
        }
        let room = self.rooms.get_mut(thread)?;
        let ix = room.participants.iter().position(|seat| seat.id() == role)?;
        let mut seat = room.participants.remove(ix);
        let mut intents = vec![RoomIntent::EndSession {
            thread_id: thread.clone(),
            participant: role.clone(),
            native_session_id: seat.participant.native_session_id.take(),
        }];
        if &room.recipient == role {
            room.recipient = assistant_id();
        }
        intents.push(RoomIntent::Notify {
            thread_id: thread.clone(),
            text: format!("{} left", seat.label()),
        });
        Some(intents)
    }

    /// Record what survives a participant's session. Only the fields in the
    /// patch change, so a builder cannot wipe what the planner agreed.
    pub fn record_notes(
        &mut self,
        thread: &ThreadId,
        patch: JobNotesPatch,
        now: OffsetDateTime,
    ) -> JobNotes {
        let notes = &mut self.room_mut(thread).notes;
        if let Some(agreed) = patch.agreed {
            notes.agreed = agreed;
        }
        if let Some(decided) = patch.decided {
            notes.decided = decided;
        }
        if let Some(changed) = patch.changed {
            notes.changed = changed;
        }
        notes.updated_at = Some(now);
        notes.clone()
    }

    /// Forget a room once its thread is gone.
    pub fn forget(&mut self, thread: &ThreadId) {
        self.rooms.remove(thread);
    }

    /// Route one user message. `None` means this is not a room message and
    /// the thread's own agent answers it: a plain chat, a thread whose shape
    /// has nobody to open it, or a role the team does not have.
    pub fn route_message(
        &mut self,
        thread: &ThreadId,
        recipient: &ParticipantId,
        prompt: Prompt,
        ctx: RoomContext<'_>,
    ) -> Option<Vec<RoomIntent>> {
        let (role, engine) = split_override(recipient);
        if is_everyone(&role) {
            // Each participant answers once and never answers another. One
            // that cannot start is an answer missing, not a reason to withhold
            // the question from the rest.
            let mut intents = self.retire_stale(thread, ctx.now);
            let delivery = delivery_for(&self.room(thread), &role);
            if delivery.role_ids.is_empty() {
                intents.push(RoomIntent::Notify {
                    thread_id: thread.clone(),
                    text: NOBODY_HERE.to_owned(),
                });
                return Some(intents);
            }
            for id in delivery.role_ids {
                intents.extend(
                    self.deliver(thread, &id, None, prompt.clone(), ctx)
                        .unwrap_or_default(),
                );
            }
            return Some(intents);
        }
        if is_thread_agent(&role) {
            // The first message into a shaped room is what brings its opening
            // role in. Picking the shape started nobody.
            let opening = self.opening_role(thread)?;
            let mut intents = self.open_with(thread, &opening, ctx.cwd, ctx.now);
            intents.extend(self.deliver(thread, &opening, None, prompt, ctx)?);
            return Some(intents);
        }
        self.role_for(&role)?;
        // Stale seats are dropped before deciding where this goes: this is the
        // moment the cost of an old session would be paid.
        let mut intents = self.retire_stale(thread, ctx.now);
        intents.extend(self.deliver(thread, &role, engine, prompt, ctx)?);
        Some(intents)
    }

    /// A participant's run settled. It is reachable again, and under a shape
    /// the next role joins and is handed the work. Do not call this for runs
    /// inside a broadcast: a question to everyone must not advance the work.
    pub fn finish(
        &mut self,
        thread: &ThreadId,
        role: &ParticipantId,
        ctx: RoomContext<'_>,
    ) -> Vec<RoomIntent> {
        self.touch(thread, role, Some(ParticipantState::Active), ctx.now);
        let Some(next) = self.next_after(thread, role) else {
            return Vec::new();
        };
        let mut intents = self.open_with(thread, &next, ctx.cwd, ctx.now);
        // Sent as if the user had asked, because in choosing the shape they
        // did. The arriving agent gets its notes and catch-up on the same path
        // as any other first message.
        let handover = Prompt {
            text: HANDOVER_PROMPT.to_owned(),
            attachments: Vec::new(),
        };
        intents.extend(
            self.deliver(thread, &next, None, handover, ctx)
                .unwrap_or_default(),
        );
        intents
    }

    /// Join if needed, work out what the participant missed, mark it working,
    /// and produce the send.
    fn deliver(
        &mut self,
        thread: &ThreadId,
        role: &ParticipantId,
        engine: Option<EngineId>,
        prompt: Prompt,
        ctx: RoomContext<'_>,
    ) -> Option<Vec<RoomIntent>> {
        let (_, mut intents) = self.join(thread, role, engine, ctx.cwd, ctx.now)?;
        let room = self.rooms.get(thread)?;
        let participant = room.find_participant(role)?;
        // Computed before the touch below, so the catch-up is measured from
        // the participant's previous activity.
        let missed = catch_up_for(ctx.messages, Some(participant), ctx.now);
        let mut context = Vec::new();
        let notes = brief_of(&room.notes);
        if !notes.is_empty() {
            context.push(format!("[JOB NOTES]\n{notes}"));
        }
        let catch_up = catch_up_prompt(&missed.missed, role, ctx.user_label);
        if !catch_up.is_empty() {
            context.push(catch_up);
        }
        self.touch(thread, role, Some(ParticipantState::Working), ctx.now);
        intents.push(RoomIntent::SendToParticipant {
            thread_id: thread.clone(),
            participant: role.clone(),
            context: (!context.is_empty()).then(|| context.join("\n\n")),
            prompt,
        });
        Some(intents)
    }
}

/// How a participant's session starts. BOSS is the coordinator: its brief
/// replaces the engine's own prompt and it holds only bus tools. Every other
/// role keeps the engine's coding instructions and has its brief appended.
fn session_options(thread: &ThreadId, role: &RoomRole, cwd: &Path) -> SessionOptions {
    let brief = brief_for_role(role.id.as_str(), &role.label, role.instruction.as_deref());
    let (append_system_prompt, system_prompt, allowed_tools) = if is_assistant(&role.id) {
        (None, Some(brief), Some(coordinator_allowed_tools()))
    } else {
        (Some(brief), None, None)
    };
    SessionOptions {
        thread_id: thread.clone(),
        participant_id: role.id.clone(),
        cwd: cwd.to_path_buf(),
        model: role.model.clone(),
        permission_mode: role.mode.unwrap_or(PermissionMode::Default),
        resume: None,
        append_system_prompt,
        system_prompt,
        allowed_tools,
        bus: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::message::Role;
    use crate::rooms::room::tests::at;
    use crate::rooms::room::{
        JobDecision, PARTICIPANT_STALE_AFTER, assistant_id, everyone_id, thread_agent_id,
    };
    use crate::rooms::routing::tests::message;

    const STALE: i64 = PARTICIPANT_STALE_AFTER.whole_seconds();

    fn team() -> RoomTeam {
        RoomTeam {
            roles: vec![
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

    fn with_team() -> RoomManager {
        let mut manager = RoomManager::new();
        manager.configure_team(team());
        manager
    }

    fn thread(name: &str) -> ThreadId {
        ThreadId::from(name)
    }

    fn id(name: &str) -> ParticipantId {
        ParticipantId::from(name)
    }

    fn cwd() -> &'static Path {
        Path::new("/hyper")
    }

    fn ctx(messages: &[Message], now: i64) -> RoomContext<'_> {
        RoomContext {
            cwd: cwd(),
            messages,
            user_label: "Jeremy",
            now: at(now),
        }
    }

    fn prompt(text: &str) -> Prompt {
        Prompt {
            text: text.to_owned(),
            attachments: Vec::new(),
        }
    }

    fn joined(
        manager: &mut RoomManager,
        room: &str,
        role: &str,
        now: i64,
    ) -> (RoomParticipant, Vec<RoomIntent>) {
        manager
            .join(&thread(room), &id(role), None, cwd(), at(now))
            .expect("joins")
    }

    fn starts(intents: &[RoomIntent]) -> Vec<(EngineId, &SessionOptions)> {
        intents
            .iter()
            .filter_map(|intent| match intent {
                RoomIntent::StartSession { engine, options } => Some((*engine, options)),
                _ => None,
            })
            .collect()
    }

    fn sends(intents: &[RoomIntent]) -> Vec<(&str, Option<&str>, &str)> {
        intents
            .iter()
            .filter_map(|intent| match intent {
                RoomIntent::SendToParticipant {
                    participant,
                    context,
                    prompt,
                    ..
                } => Some((
                    participant.as_str(),
                    context.as_deref(),
                    prompt.text.as_str(),
                )),
                _ => None,
            })
            .collect()
    }

    fn ended(intents: &[RoomIntent]) -> Vec<(&str, Option<&str>)> {
        intents
            .iter()
            .filter_map(|intent| match intent {
                RoomIntent::EndSession {
                    participant,
                    native_session_id,
                    ..
                } => Some((participant.as_str(), native_session_id.as_deref())),
                _ => None,
            })
            .collect()
    }

    fn notices(intents: &[RoomIntent]) -> Vec<&str> {
        intents
            .iter()
            .filter_map(|intent| match intent {
                RoomIntent::Notify { text, .. } => Some(text.as_str()),
                _ => None,
            })
            .collect()
    }

    fn engines(manager: &RoomManager, room: &str) -> Vec<(String, EngineId)> {
        manager
            .room(&thread(room))
            .participants
            .iter()
            .map(|p| (p.id().to_string(), p.engine()))
            .collect()
    }

    #[test]
    fn a_room_with_no_team_cannot_admit_a_participant() {
        let mut manager = RoomManager::new();
        assert!(
            manager
                .join(&thread("room-1"), &id("builder"), None, cwd(), at(1))
                .is_none()
        );
        assert!(
            manager
                .join(&thread("room-1"), &assistant_id(), None, cwd(), at(1))
                .is_none(),
            "BOSS neither"
        );
        assert!(manager.room(&thread("room-1")).participants.is_empty());
    }

    #[test]
    fn a_participant_joins_with_its_own_session_on_its_own_engine() {
        let mut manager = with_team();
        let (participant, intents) = joined(&mut manager, "room-1", "builder", 1);
        assert_eq!(participant.id(), &id("builder"));
        assert_eq!(
            participant.engine(),
            EngineId::Codex,
            "the builder runs on the engine the user chose for it"
        );
        let started = starts(&intents);
        assert_eq!(started.len(), 1, "exactly one session per participant");
        assert_eq!(started[0].0, EngineId::Codex);
        assert_eq!(started[0].1.participant_id, id("builder"));
        assert_eq!(started[0].1.cwd, cwd());
        assert_eq!(notices(&intents), vec!["Builder joined"]);
    }

    #[test]
    fn the_reach_the_user_chose_is_applied_to_the_session_not_merely_stored() {
        let mut manager = with_team();
        let (_, builder) = joined(&mut manager, "room-1", "builder", 1);
        let (_, reviewer) = joined(&mut manager, "room-1", "reviewer", 1);
        assert_eq!(
            starts(&builder)[0].1.permission_mode,
            PermissionMode::Bypass
        );
        assert_eq!(starts(&reviewer)[0].1.permission_mode, PermissionMode::Plan);
    }

    #[test]
    fn a_one_off_engine_override_keeps_the_roles_reach() {
        // The override names a different agent for one job. It says nothing
        // about what that agent may touch.
        let mut manager = with_team();
        let (participant, intents) = manager
            .join(
                &thread("room-1"),
                &id("reviewer"),
                Some(EngineId::Codex),
                cwd(),
                at(1),
            )
            .expect("joins");
        assert_eq!(participant.engine(), EngineId::Codex);
        assert_eq!(starts(&intents)[0].0, EngineId::Codex);
        assert_eq!(starts(&intents)[0].1.permission_mode, PermissionMode::Plan);
    }

    #[test]
    fn a_reviewer_can_run_on_a_different_engine_from_the_builder_in_one_room() {
        let mut manager = with_team();
        joined(&mut manager, "room-1", "builder", 1);
        joined(&mut manager, "room-1", "reviewer", 1);
        assert_eq!(
            engines(&manager, "room-1"),
            vec![
                ("builder".to_owned(), EngineId::Codex),
                ("reviewer".to_owned(), EngineId::Claude)
            ],
            "a second opinion from the same model is not a second opinion"
        );
    }

    #[test]
    fn joining_twice_reuses_the_session_so_a_repeated_mention_cannot_spawn_a_second_one() {
        let mut manager = with_team();
        let (first, _) = joined(&mut manager, "room-1", "builder", 1);
        let (second, intents) = joined(&mut manager, "room-1", "builder", 2);
        assert_eq!(second, first);
        assert!(intents.is_empty());
    }

    #[test]
    fn the_recipient_stays_where_the_user_left_it() {
        let mut manager = RoomManager::new();
        manager.set_recipient(&thread("room-1"), id("builder"));
        assert_eq!(manager.room(&thread("room-1")).recipient, id("builder"));
    }

    #[test]
    fn an_idle_participant_is_retired_and_its_session_is_dropped_rather_than_resumed() {
        let mut manager = with_team();
        joined(&mut manager, "room-1", "planner", 1_000);
        manager.session_ready(&thread("room-1"), &id("planner"), "sess-planner".into());
        let intents = manager.retire_stale(&thread("room-1"), at(1_000 + STALE + 1));
        assert_eq!(
            ended(&intents),
            vec![("planner", Some("sess-planner"))],
            "the old context is never resent"
        );
        let planner = manager
            .room(&thread("room-1"))
            .find_participant(&id("planner"))
            .cloned()
            .expect("still listed");
        assert_eq!(planner.state, ParticipantState::Stale);
        assert_eq!(
            planner.participant.native_session_id, None,
            "addressing it later starts a fresh one"
        );
    }

    #[test]
    fn a_participant_in_use_does_not_go_stale() {
        let mut manager = with_team();
        joined(&mut manager, "room-1", "builder", 1_000);
        manager.touch(
            &thread("room-1"),
            &id("builder"),
            None,
            at(1_000 + STALE - 1),
        );
        assert!(
            manager
                .retire_stale(&thread("room-1"), at(1_000 + 2 * STALE - 2))
                .is_empty(),
            "speaking keeps it alive"
        );
    }

    #[test]
    fn retiring_twice_does_not_end_the_same_session_twice() {
        let mut manager = with_team();
        joined(&mut manager, "room-1", "planner", 1_000);
        let later = at(1_000 + STALE + 1);
        assert_eq!(manager.retire_stale(&thread("room-1"), later).len(), 1);
        assert!(manager.retire_stale(&thread("room-1"), later).is_empty());
    }

    #[test]
    fn job_notes_record_when_they_last_changed() {
        let mut manager = RoomManager::new();
        let patch = JobNotesPatch {
            agreed: Some(vec!["save the query and the sort order".into()]),
            decided: Some(vec![JobDecision {
                text: "the index stays in the existing layer".into(),
                at: at(5),
                by: id("builder"),
            }]),
            changed: None,
        };
        manager.record_notes(&thread("room-1"), patch, at(9));
        let notes = manager.room(&thread("room-1")).notes;
        assert_eq!(notes.agreed, vec!["save the query and the sort order"]);
        assert_eq!(notes.updated_at, Some(at(9)));
    }

    #[test]
    fn recording_one_field_of_the_notes_leaves_the_others_alone() {
        // An agent records what it knows when it knows it. Replacing the whole
        // set each time would let a builder wipe what the planner agreed.
        let mut manager = RoomManager::new();
        let room = thread("room-1");
        manager.record_notes(
            &room,
            JobNotesPatch {
                agreed: Some(vec!["no cap on saved searches".into()]),
                ..Default::default()
            },
            at(1),
        );
        manager.record_notes(
            &room,
            JobNotesPatch {
                changed: Some(vec!["11 files, 3 new tests".into()]),
                ..Default::default()
            },
            at(2),
        );
        let notes = manager.room(&room).notes;
        assert_eq!(
            notes.agreed,
            vec!["no cap on saved searches"],
            "an earlier agreement is not lost"
        );
        assert_eq!(notes.changed, vec!["11 files, 3 new tests"]);
        assert!(brief_of(&notes).contains("AGREED"));
        assert!(
            brief_of(&manager.room(&thread("never-used")).notes).is_empty(),
            "nothing to say is said as nothing"
        );
    }

    #[test]
    fn forgetting_a_room_clears_its_state_when_the_thread_is_gone() {
        let mut manager = with_team();
        joined(&mut manager, "room-1", "builder", 1);
        manager.forget(&thread("room-1"));
        assert!(manager.room(&thread("room-1")).participants.is_empty());
        assert!(manager.rooms().is_empty());
    }

    #[test]
    fn a_suggested_reviewer_differs_from_the_suggested_builder_when_there_is_a_choice() {
        let roles = suggested_roles(&[EngineId::Claude, EngineId::Codex]);
        let engine = |name: &str| {
            roles
                .iter()
                .find(|role| role.id.as_str() == name)
                .map(|role| role.engine)
        };
        assert_eq!(engine("builder"), Some(EngineId::Codex));
        assert_ne!(
            engine("reviewer"),
            engine("builder"),
            "the reviewer must be a second opinion"
        );
    }

    #[test]
    fn one_connected_agent_still_yields_a_usable_team() {
        let roles = suggested_roles(&[EngineId::Claude]);
        assert_eq!(roles.len(), 6, "BOSS plus the five working roles");
        assert!(roles.iter().all(|role| role.engine == EngineId::Claude));
    }

    #[test]
    fn no_connected_agents_yields_no_roles() {
        assert!(suggested_roles(&[]).is_empty());
    }

    #[test]
    fn boss_is_a_row_in_the_team_so_its_agent_is_visible_and_changeable() {
        let roles = suggested_roles(&[EngineId::Claude, EngineId::Codex]);
        assert_eq!(
            roles[0].id,
            assistant_id(),
            "first, because it is who the user talks to"
        );
        assert_eq!(roles[0].label, "BOSS");
        assert_eq!(
            roles[0].mode,
            Some(PermissionMode::Plan),
            "it coordinates and never edits code"
        );
    }

    #[test]
    fn shapes_name_their_roles_in_join_order() {
        let team = team();
        assert_eq!(
            roles_for_shape(RoomShape::Direct, &team),
            vec![id("builder")]
        );
        assert_eq!(
            roles_for_shape(RoomShape::Reviewed, &team),
            vec![id("builder"), id("reviewer")]
        );
        assert_eq!(
            roles_for_shape(RoomShape::Full, &team),
            vec![
                id("researcher"),
                id("planner"),
                id("builder"),
                id("reviewer")
            ]
        );
    }

    #[test]
    fn a_shape_skips_roles_the_user_deleted_from_their_team() {
        let mut lean = team();
        lean.roles.retain(|role| role.id.as_str() != "reviewer");
        assert_eq!(
            roles_for_shape(RoomShape::Reviewed, &lean),
            vec![id("builder")],
            "deleting a role removes that step"
        );
    }

    #[test]
    fn boss_joins_any_room_without_being_a_configured_role() {
        let mut manager = with_team();
        let (boss, _) = joined(&mut manager, "room-1", "boss", 1);
        assert_eq!(boss.label(), "BOSS");
        assert!(boss.participant.is_boss);
        assert_eq!(
            boss.engine(),
            EngineId::Claude,
            "it takes the agent behind a reading role"
        );
    }

    #[test]
    fn boss_in_two_rooms_gets_a_session_each_so_neither_can_cross_the_other() {
        let mut manager = with_team();
        let (_, first) = joined(&mut manager, "room-1", "boss", 1);
        let (_, second) = joined(&mut manager, "room-2", "boss", 1);
        assert_eq!(starts(&first)[0].1.thread_id, thread("room-1"));
        assert_eq!(starts(&second)[0].1.thread_id, thread("room-2"));
    }

    #[test]
    fn a_joining_participant_has_read_nothing_so_its_brief_still_reaches_it() {
        let mut manager = with_team();
        let (reviewer, _) = joined(&mut manager, "room-1", "reviewer", 1);
        assert_eq!(
            reviewer.last_active_at, None,
            "joining is not the same as having read the room"
        );
    }

    #[test]
    fn speaking_marks_a_participant_as_caught_up() {
        let mut manager = with_team();
        joined(&mut manager, "room-1", "builder", 1);
        manager.touch(&thread("room-1"), &id("builder"), None, at(7));
        assert_eq!(
            manager.room(&thread("room-1")).participants[0].last_active_at,
            Some(at(7))
        );
    }

    #[test]
    fn a_job_can_be_handed_to_a_different_agent_without_changing_the_team() {
        let mut manager = with_team();
        let (usual, _) = joined(&mut manager, "room-1", "reviewer", 1);
        assert_eq!(usual.engine(), EngineId::Claude);
        let (handed, _) = manager
            .join(
                &thread("room-2"),
                &id("reviewer"),
                Some(EngineId::Codex),
                cwd(),
                at(1),
            )
            .expect("joins");
        assert_eq!(handed.engine(), EngineId::Codex);
        let team = manager.team().expect("a team");
        assert_eq!(
            team.role(&id("reviewer")).map(|role| role.engine),
            Some(EngineId::Claude),
            "the role keeps its own agent"
        );
    }

    #[test]
    fn a_team_saved_before_boss_had_a_row_gets_one_on_load() {
        let (saved, rooms) = with_team().into_parts();
        let reopened = RoomManager::from_parts(saved, rooms);
        let boss = reopened
            .team()
            .and_then(|team| team.role(&assistant_id()).cloned())
            .expect("BOSS has a row");
        assert_eq!(boss.label, "BOSS");
        assert_eq!(
            boss.engine,
            EngineId::Claude,
            "it inherits from whichever role read rather than wrote"
        );
        assert_eq!(reopened.team().map(|team| team.roles.len()), Some(5));
    }

    #[test]
    fn boss_runs_on_the_agent_the_team_says_not_on_a_borrowed_one() {
        let mut manager = RoomManager::new();
        let mut roles = vec![RoomRole::new(
            "boss",
            "BOSS",
            EngineId::Codex,
            Some(PermissionMode::Plan),
        )];
        roles.extend(team().roles);
        manager.configure_team(RoomTeam { roles, ..team() });
        let (boss, _) = joined(&mut manager, "room-1", "boss", 1);
        assert_eq!(boss.engine(), EngineId::Codex);
    }

    #[test]
    fn choosing_a_shape_starts_nobody_so_the_choice_can_still_be_changed() {
        let mut manager = with_team();
        let room = manager
            .choose_shape(&thread("room-1"), RoomShape::Reviewed)
            .clone();
        assert_eq!(room.shape, Some(RoomShape::Reviewed));
        assert!(
            room.participants.is_empty(),
            "nobody starts until the user sends something"
        );
        let room = manager
            .choose_shape(&thread("room-1"), RoomShape::Full)
            .clone();
        assert_eq!(room.shape, Some(RoomShape::Full));
        assert!(room.participants.is_empty());
    }

    #[test]
    fn the_first_message_brings_in_the_role_that_opens_the_shape() {
        let mut manager = with_team();
        manager.choose_shape(&thread("room-1"), RoomShape::Reviewed);
        let opening = manager.opening_role(&thread("room-1")).expect("an opener");
        assert_eq!(opening, id("builder"));
        let intents = manager.open_with(&thread("room-1"), &opening, cwd(), at(1));
        assert_eq!(starts(&intents).len(), 1);
        let room = manager.room(&thread("room-1"));
        assert_eq!(room.participants.len(), 1);
        assert_eq!(
            room.recipient,
            id("builder"),
            "the composer aims at whoever just arrived"
        );
    }

    #[test]
    fn only_the_first_agent_starts_because_the_rest_have_nothing_to_read_yet() {
        let mut manager = with_team();
        manager.choose_shape(&thread("room-1"), RoomShape::Full);
        let opening = manager.opening_role(&thread("room-1")).expect("an opener");
        assert_eq!(opening, id("researcher"));
        manager.open_with(&thread("room-1"), &opening, cwd(), at(1));
        assert_eq!(manager.room(&thread("room-1")).participants.len(), 1);
    }

    #[test]
    fn a_room_that_already_has_someone_opens_nobody_else() {
        let mut manager = with_team();
        manager.choose_shape(&thread("room-1"), RoomShape::Reviewed);
        manager.open_with(&thread("room-1"), &id("builder"), cwd(), at(1));
        assert_eq!(manager.opening_role(&thread("room-1")), None);
    }

    #[test]
    fn a_room_with_no_shape_opens_nobody_so_an_ordinary_chat_stays_one() {
        let manager = with_team();
        assert_eq!(manager.opening_role(&thread("room-1")), None);
    }

    #[test]
    fn a_reviewer_follows_the_builder_and_nothing_follows_the_reviewer() {
        let mut manager = with_team();
        manager.choose_shape(&thread("room-1"), RoomShape::Reviewed);
        assert_eq!(
            manager.next_after(&thread("room-1"), &id("builder")),
            Some(id("reviewer"))
        );
        assert_eq!(manager.next_after(&thread("room-1"), &id("reviewer")), None);
    }

    #[test]
    fn an_agent_already_in_the_room_does_not_arrive_twice() {
        let mut manager = with_team();
        manager.choose_shape(&thread("room-1"), RoomShape::Reviewed);
        joined(&mut manager, "room-1", "reviewer", 1);
        assert_eq!(manager.next_after(&thread("room-1"), &id("builder")), None);
    }

    #[test]
    fn a_thread_with_no_shape_hands_over_to_nobody() {
        let mut manager = with_team();
        joined(&mut manager, "room-1", "builder", 1);
        assert_eq!(manager.next_after(&thread("room-1"), &id("builder")), None);
        assert!(
            manager
                .finish(&thread("room-1"), &id("builder"), ctx(&[], 2))
                .is_empty()
        );
    }

    #[test]
    fn an_ordinary_chat_never_opens_a_role_whatever_the_team_default_is() {
        // The default belongs to a job, not to a chat.
        let mut manager = RoomManager::new();
        manager.configure_team(RoomTeam {
            ask_shape: false,
            default_shape: RoomShape::Reviewed,
            ..team()
        });
        assert_eq!(manager.opening_role(&thread("room-1")), None);
        assert!(
            manager
                .route_message(
                    &thread("room-1"),
                    &thread_agent_id(),
                    prompt("hi"),
                    ctx(&[], 1)
                )
                .is_none()
        );
        assert!(
            manager.rooms().is_empty(),
            "no agent is started by a plain message"
        );
    }

    #[test]
    fn the_standing_shape_is_offered_to_whoever_starts_a_job_not_applied_by_surprise() {
        let mut manager = RoomManager::new();
        manager.configure_team(RoomTeam {
            ask_shape: false,
            default_shape: RoomShape::Reviewed,
            ..team()
        });
        assert_eq!(manager.standing_shape(), Some(RoomShape::Reviewed));
        manager.configure_team(RoomTeam {
            ask_shape: true,
            ..team()
        });
        assert_eq!(
            manager.standing_shape(),
            None,
            "a user who wants to be asked has no standing shape"
        );
        assert_eq!(RoomManager::new().standing_shape(), None);
    }

    #[test]
    fn a_shape_whose_roles_the_user_deleted_opens_nobody() {
        let mut manager = RoomManager::new();
        let mut lean = team();
        lean.roles.retain(|role| role.id.as_str() != "builder");
        manager.configure_team(lean);
        manager.choose_shape(&thread("room-1"), RoomShape::Direct);
        assert_eq!(manager.opening_role(&thread("room-1")), None);
        assert!(
            manager
                .route_message(
                    &thread("room-1"),
                    &thread_agent_id(),
                    prompt("hi"),
                    ctx(&[], 1)
                )
                .is_none()
        );
    }

    #[test]
    fn the_first_message_into_a_shaped_room_starts_its_opener_and_delivers_to_it() {
        let mut manager = with_team();
        manager.choose_shape(&thread("room-1"), RoomShape::Reviewed);
        let intents = manager
            .route_message(
                &thread("room-1"),
                &thread_agent_id(),
                prompt("add search"),
                ctx(&[], 1),
            )
            .expect("routed");
        assert_eq!(starts(&intents).len(), 1);
        assert_eq!(starts(&intents)[0].1.participant_id, id("builder"));
        assert_eq!(notices(&intents), vec!["Builder joined"]);
        assert_eq!(
            sends(&intents),
            vec![("builder", None, "add search")],
            "an empty room has nothing to catch up on"
        );
        let room = manager.room(&thread("room-1"));
        assert_eq!(room.recipient, id("builder"));
        let builder = room.find_participant(&id("builder")).expect("joined");
        assert_eq!(
            builder.state,
            ParticipantState::Working,
            "the room is what looks busy"
        );
        assert_eq!(builder.last_active_at, Some(at(1)));
    }

    #[test]
    fn a_message_to_the_thread_agent_in_a_plain_chat_is_not_a_room_message() {
        let mut manager = with_team();
        assert!(
            manager
                .route_message(
                    &thread("room-1"),
                    &thread_agent_id(),
                    prompt("hi"),
                    ctx(&[], 1)
                )
                .is_none()
        );
        let mut no_team = RoomManager::new();
        assert!(
            no_team
                .route_message(
                    &thread("room-1"),
                    &assistant_id(),
                    prompt("hi"),
                    ctx(&[], 1)
                )
                .is_none(),
            "BOSS cannot join before a team"
        );
    }

    #[test]
    fn boss_in_a_room_is_the_coordinator_with_its_own_prompt_and_only_bus_tools() {
        let mut manager = with_team();
        let intents = manager
            .route_message(
                &thread("room-1"),
                &assistant_id(),
                prompt("status?"),
                ctx(&[], 1),
            )
            .expect("routed");
        let (engine, options) = starts(&intents)[0];
        assert_eq!(engine, EngineId::Claude);
        assert_eq!(options.permission_mode, PermissionMode::Plan);
        assert!(
            options
                .system_prompt
                .as_deref()
                .is_some_and(|text| text.starts_with("[BOSS]")),
            "replaces the engine's own prompt"
        );
        assert_eq!(options.append_system_prompt, None);
        let tools = options.allowed_tools.as_ref().expect("a strict tool list");
        assert!(
            tools
                .iter()
                .all(|tool| tool.starts_with("mcp__boss_thread_bus__")),
            "BOSS never writes code"
        );
        assert_eq!(sends(&intents), vec![("boss", None, "status?")]);
    }

    #[test]
    fn a_role_is_briefed_by_appending_to_the_engines_own_prompt() {
        let mut manager = with_team();
        let (_, intents) = joined(&mut manager, "room-1", "builder", 1);
        let options = starts(&intents)[0].1;
        assert!(
            options
                .append_system_prompt
                .as_deref()
                .is_some_and(|text| text.contains("You are the builder"))
        );
        assert_eq!(
            options.system_prompt, None,
            "a builder keeps its coding instructions"
        );
        assert_eq!(options.allowed_tools, None);
        assert_eq!(options.resume, None);
    }

    #[test]
    fn a_users_instruction_for_a_role_reaches_its_session() {
        let mut manager = RoomManager::new();
        let mut custom = team();
        custom.roles[2].instruction = Some("Always run the linter.".into());
        manager.configure_team(custom);
        let (_, intents) = joined(&mut manager, "room-1", "builder", 1);
        assert!(
            starts(&intents)[0]
                .1
                .append_system_prompt
                .as_deref()
                .is_some_and(|t| t.ends_with("Always run the linter."))
        );
    }

    #[test]
    fn finishing_hands_over_to_the_next_role_with_the_notes_and_nothing_about_the_task() {
        let mut manager = with_team();
        let room = thread("room-1");
        manager.choose_shape(&room, RoomShape::Reviewed);
        manager
            .route_message(&room, &thread_agent_id(), prompt("add search"), ctx(&[], 1))
            .expect("routed");
        manager.record_notes(
            &room,
            JobNotesPatch {
                agreed: Some(vec!["no cap on saved searches".into()]),
                ..Default::default()
            },
            at(2),
        );
        let transcript = vec![message("m1", Role::User, "add search", 1)];
        let intents = manager.finish(&room, &id("builder"), ctx(&transcript, 3));
        assert_eq!(starts(&intents)[0].1.participant_id, id("reviewer"));
        assert_eq!(starts(&intents)[0].0, EngineId::Claude);
        let sent = sends(&intents);
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0].0, "reviewer");
        assert_eq!(sent[0].2, HANDOVER_PROMPT);
        let context = sent[0].1.expect("the reviewer is handed the notes");
        assert!(context.contains("[JOB NOTES]\nAGREED\n· no cap on saved searches"));
        assert!(
            context.contains("ROOM CATCH-UP"),
            "and what the room said while it was not here"
        );
        let state = manager.room(&room);
        assert_eq!(state.recipient, id("reviewer"));
        assert_eq!(
            state.find_participant(&id("builder")).map(|p| p.state),
            Some(ParticipantState::Active),
            "back to reachable"
        );
        assert_eq!(
            state.find_participant(&id("reviewer")).map(|p| p.state),
            Some(ParticipantState::Working)
        );
    }

    #[test]
    fn finishing_the_last_role_in_a_shape_hands_over_to_nobody() {
        let mut manager = with_team();
        let room = thread("room-1");
        manager.choose_shape(&room, RoomShape::Reviewed);
        manager.route_message(&room, &thread_agent_id(), prompt("go"), ctx(&[], 1));
        manager.finish(&room, &id("builder"), ctx(&[], 2));
        assert!(
            manager
                .finish(&room, &id("reviewer"), ctx(&[], 3))
                .is_empty()
        );
        let mut direct = with_team();
        direct.choose_shape(&room, RoomShape::Direct);
        direct.route_message(&room, &thread_agent_id(), prompt("go"), ctx(&[], 1));
        assert!(
            direct.finish(&room, &id("builder"), ctx(&[], 2)).is_empty(),
            "a one-line fix needs no ceremony"
        );
    }

    #[test]
    fn a_full_run_hands_along_research_plan_build_review() {
        let mut manager = with_team();
        let room = thread("room-1");
        manager.choose_shape(&room, RoomShape::Full);
        manager.route_message(&room, &thread_agent_id(), prompt("go"), ctx(&[], 1));
        let mut order = vec!["researcher".to_owned()];
        for finished in ["researcher", "planner", "builder"] {
            let intents = manager.finish(&room, &id(finished), ctx(&[], 2));
            order.push(starts(&intents)[0].1.participant_id.to_string());
        }
        assert_eq!(order, vec!["researcher", "planner", "builder", "reviewer"]);
        assert_eq!(manager.room(&room).participants.len(), 4);
    }

    #[test]
    fn a_stale_participant_is_replaced_by_a_fresh_one_that_does_not_resume() {
        let mut manager = with_team();
        let room = thread("room-1");
        joined(&mut manager, "room-1", "builder", 1_000);
        manager.session_ready(&room, &id("builder"), "old".into());
        let intents = manager
            .route_message(
                &room,
                &id("builder"),
                prompt("still there?"),
                ctx(&[], 1_000 + STALE + 1),
            )
            .expect("routed");
        assert_eq!(
            ended(&intents),
            vec![("builder", Some("old"))],
            "the old context is dropped first"
        );
        let (engine, options) = starts(&intents)[0];
        assert_eq!(engine, EngineId::Codex);
        assert_eq!(options.resume, None, "replaced, not resumed");
        assert_eq!(sends(&intents).len(), 1);
        let builder = manager
            .room(&room)
            .find_participant(&id("builder"))
            .cloned()
            .expect("present");
        assert_eq!(builder.state, ParticipantState::Working);
        assert_eq!(builder.participant.native_session_id, None);
    }

    #[test]
    fn a_one_off_override_starts_a_fresh_session_on_that_engine_and_stops_the_old_one() {
        let mut manager = with_team();
        let room = thread("room-1");
        joined(&mut manager, "room-1", "reviewer", 1);
        let intents = manager
            .route_message(
                &room,
                &id("reviewer@codex"),
                prompt("look again"),
                ctx(&[], 2),
            )
            .expect("routed");
        assert_eq!(ended(&intents).len(), 1, "replacing an agent stops it");
        let (engine, options) = starts(&intents)[0];
        assert_eq!(engine, EngineId::Codex);
        assert_eq!(
            options.permission_mode,
            PermissionMode::Plan,
            "the reach stays the role's own"
        );
        assert_eq!(sends(&intents), vec![("reviewer", None, "look again")]);
        // Addressed again without the override, the seat it now holds is reused.
        let again = manager
            .route_message(&room, &id("reviewer"), prompt("and again"), ctx(&[], 3))
            .expect("routed");
        assert!(starts(&again).is_empty());
    }

    #[test]
    fn an_addressed_participant_is_told_what_it_missed_but_not_to_act_on_it() {
        let mut manager = with_team();
        let room = thread("room-1");
        joined(&mut manager, "room-1", "builder", 1);
        manager.touch(&room, &id("builder"), None, at(20));
        let mut to_boss = message("m2", Role::User, "this is wrong", 30);
        to_boss.recipient = Some(assistant_id());
        let transcript = vec![message("m1", Role::User, "old", 10), to_boss];
        let intents = manager
            .route_message(
                &room,
                &id("builder"),
                prompt("fix it"),
                ctx(&transcript, 40),
            )
            .expect("routed");
        let context = sends(&intents)[0].1.expect("context");
        assert!(context.contains("Do not act on them"));
        assert!(context.contains("Jeremy (to boss): this is wrong"));
        assert!(
            !context.contains("old"),
            "what it already saw is not repeated"
        );
        assert!(!context.contains("[JOB NOTES]"), "no notes, no heading");
    }

    #[test]
    fn a_broadcast_reaches_each_participant_in_turn_and_starts_nobody_new() {
        let mut manager = with_team();
        let room = thread("room-1");
        joined(&mut manager, "room-1", "builder", 1);
        joined(&mut manager, "room-1", "reviewer", 1);
        let intents = manager
            .route_message(&room, &everyone_id(), prompt("status?"), ctx(&[], 2))
            .expect("routed");
        assert!(starts(&intents).is_empty());
        let who: Vec<&str> = sends(&intents).iter().map(|send| send.0).collect();
        assert_eq!(who, vec!["builder", "reviewer"]);
        assert!(
            manager
                .room(&room)
                .participants
                .iter()
                .all(|p| p.state == ParticipantState::Working)
        );
    }

    #[test]
    fn a_broadcast_into_an_empty_room_says_so() {
        let mut manager = with_team();
        let intents = manager
            .route_message(
                &thread("room-1"),
                &everyone_id(),
                prompt("anyone?"),
                ctx(&[], 1),
            )
            .expect("routed");
        assert_eq!(notices(&intents), vec![NOBODY_HERE]);
        assert!(sends(&intents).is_empty());
    }

    #[test]
    fn a_role_the_team_does_not_have_is_not_a_room_message_and_changes_nothing() {
        let mut manager = with_team();
        let room = thread("room-1");
        joined(&mut manager, "room-1", "planner", 1_000);
        let before = manager.room(&room);
        assert!(
            manager
                .route_message(
                    &room,
                    &id("releaser"),
                    prompt("ship"),
                    ctx(&[], 1_000 + STALE + 1)
                )
                .is_none()
        );
        assert_eq!(
            manager.room(&room),
            before,
            "nothing is retired on a message that went nowhere"
        );
    }

    #[test]
    fn a_manager_round_trips_through_json() {
        let mut manager = with_team();
        let room = thread("room-1");
        manager.choose_shape(&room, RoomShape::Reviewed);
        manager.route_message(&room, &thread_agent_id(), prompt("go"), ctx(&[], 1));
        manager.session_ready(&room, &id("builder"), "sess".into());
        manager.record_notes(
            &room,
            JobNotesPatch {
                changed: Some(vec!["one file".into()]),
                ..Default::default()
            },
            at(2),
        );
        let json = serde_json::to_string(&manager).expect("serialises");
        let back: RoomManager = serde_json::from_str(&json).expect("deserialises");
        assert_eq!(back, manager);
    }
}
