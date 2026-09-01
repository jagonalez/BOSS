use crate::engine::EngineId;
use crate::ids::*;
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;

/// Three kinds of thread, per `docs/rooms-shape.md`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ThreadKind {
    /// One agent, no team, no BOSS.
    Chat { engine: EngineId },
    /// Several named agents plus BOSS plus the user.
    Room { room_id: RoomId },
    /// The standing assistant thread.
    Assistant,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Thread {
    pub id: ThreadId,
    pub project_id: ProjectId,
    pub title: String,
    pub kind: ThreadKind,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339")]
    pub updated_at: OffsetDateTime,
    /// Working directory for the agents in this thread (a worktree or the
    /// project root).
    pub cwd: std::path::PathBuf,
    #[serde(default)]
    pub archived: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Project {
    pub id: ProjectId,
    pub name: String,
    pub root: std::path::PathBuf,
    #[serde(with = "time::serde::rfc3339")]
    pub added_at: OffsetDateTime,
}

/// A named seat in a room: "researcher", "builder", and so on. Names are
/// chosen by the user. BOSS itself is a participant with `is_boss`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Participant {
    pub id: ParticipantId,
    pub name: String,
    pub engine: EngineId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default)]
    pub is_boss: bool,
    /// Engine-native session id, if a session exists.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_session_id: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RoomShape {
    /// "Just do it": one agent, no review.
    Direct,
    /// "Build and review": a fresh agent checks afterwards.
    Reviewed,
    /// "The full run": research, plan, build, review.
    Full,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Room {
    pub id: RoomId,
    pub thread_id: ThreadId,
    pub shape: RoomShape,
    pub participants: Vec<Participant>,
}
