//! Thread state for the views, and the fold from engine events into
//! messages. Pure Rust; no GPUI types here so it can be unit-tested.

use boss_core::*;
use std::collections::HashMap;

/// One open thread as the UI sees it.
#[derive(Debug, Clone)]
pub struct ThreadModel {
    pub thread: Thread,
    pub participants: Vec<Participant>,
    pub messages: Vec<Message>,
    /// Permission and question requests waiting for the user.
    pub pending: Vec<PendingRequest>,
    pub todos: Vec<Todo>,
    pub busy: bool,
    /// Bumps on any change. Views compare it to skip work.
    pub revision: u64,
    index: HashMap<MessageId, usize>,
    /// Participants that are answering inside a branch, and the turn each
    /// branch hangs off. What an agent says while it is in here belongs to
    /// the replies panel, not to the main transcript — the engine has no
    /// idea a branch exists, so the model has to remember.
    open_branches: HashMap<ParticipantId, MessageId>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum PendingRequest {
    Permission { request: RequestId, participant: Option<ParticipantId>, tool: String, input: serde_json::Value, title: Option<String>, message_id: Option<MessageId> },
    Question { request: RequestId, participant: Option<ParticipantId>, prompt: String, options: Vec<String> },
}

impl PendingRequest {
    pub fn request_id(&self) -> &RequestId {
        match self {
            PendingRequest::Permission { request, .. } | PendingRequest::Question { request, .. } => request,
        }
    }
}

impl ThreadModel {
    pub fn new(thread: Thread, participants: Vec<Participant>, messages: Vec<Message>) -> Self {
        let mut m = Self {
            thread,
            participants,
            messages: Vec::new(),
            pending: Vec::new(),
            todos: Vec::new(),
            busy: false,
            revision: 0,
            index: HashMap::new(),
            open_branches: HashMap::new(),
        };
        for msg in messages {
            m.push(msg);
        }
        m
    }

    fn push(&mut self, msg: Message) {
        self.index.insert(msg.id.clone(), self.messages.len());
        self.messages.push(msg);
        self.revision += 1;
    }

    pub fn message(&self, id: &MessageId) -> Option<&Message> {
        self.index.get(id).map(|i| &self.messages[*i])
    }

    fn message_mut(&mut self, id: &MessageId) -> Option<&mut Message> {
        let i = *self.index.get(id)?;
        self.revision += 1;
        Some(&mut self.messages[i])
    }

    /// Add the user's own message before the engine answers.
    pub fn push_user_message(&mut self, text: String, recipient: Option<ParticipantId>, attachments: Vec<AttachmentPart>) -> MessageId {
        let mut msg = Message::new(self.thread.id.clone(), Role::User);
        msg.status = MessageStatus::Complete;
        msg.recipient = recipient;
        msg.parts.push(Part::Text(TextPart { id: PartId::new(), text }));
        msg.parts.extend(attachments.into_iter().map(Part::Attachment));
        let id = msg.id.clone();
        self.push(msg);
        id
    }

    /// Append a ready-made message (for example one built by the rooms
    /// coordinator) and return its id.
    pub fn push_message(&mut self, msg: Message) -> MessageId {
        let id = msg.id.clone();
        self.push(msg);
        id
    }

    /// Answer `participant`'s next turn inside the branch under `parent`,
    /// until it goes idle. Set when the user sends a branch reply.
    pub fn open_branch(&mut self, participant: ParticipantId, parent: MessageId) {
        self.open_branches.insert(participant, parent);
        self.revision += 1;
    }

    /// The branch a participant is currently answering in, if any.
    pub fn branch_of(&self, participant: &ParticipantId) -> Option<&MessageId> {
        self.open_branches.get(participant)
    }

    pub fn resolve_request(&mut self, request: &RequestId) {
        let before = self.pending.len();
        self.pending.retain(|p| p.request_id() != request);
        if self.pending.len() != before {
            self.revision += 1;
        }
    }

    /// Fold one engine event from `author` into the messages.
    pub fn apply(&mut self, author: Option<&ParticipantId>, event: EngineEvent) {
        match event {
            EngineEvent::SessionReady { native_session_id } => {
                if let Some(a) = author {
                    if let Some(p) = self.participants.iter_mut().find(|p| &p.id == a) {
                        p.native_session_id = Some(native_session_id);
                        self.revision += 1;
                    }
                }
            }
            EngineEvent::MessageStarted { message_id, role } => {
                if self.index.contains_key(&message_id) {
                    return;
                }
                let mut msg = Message::new(self.thread.id.clone(), role);
                msg.id = message_id;
                msg.author = author.cloned();
                msg.branch_of = author.and_then(|a| self.open_branches.get(a)).cloned();
                self.push(msg);
            }
            EngineEvent::TextDelta { message_id, part_id, delta } => {
                self.ensure_message(&message_id, author);
                let msg = self.message_mut(&message_id).expect("ensured");
                match msg.part_mut(&part_id) {
                    Some(Part::Text(t)) => t.text.push_str(&delta),
                    Some(_) => {}
                    None => msg.parts.push(Part::Text(TextPart { id: part_id, text: delta })),
                }
                msg.touch();
            }
            EngineEvent::ReasoningDelta { message_id, part_id, delta } => {
                self.ensure_message(&message_id, author);
                let msg = self.message_mut(&message_id).expect("ensured");
                match msg.part_mut(&part_id) {
                    Some(Part::Reasoning(t)) => t.text.push_str(&delta),
                    Some(_) => {}
                    None => msg.parts.push(Part::Reasoning(ReasoningPart { id: part_id, text: delta })),
                }
                msg.touch();
            }
            EngineEvent::ToolCallStarted { message_id, part_id, call_id, name, input, title } => {
                self.ensure_message(&message_id, author);
                let msg = self.message_mut(&message_id).expect("ensured");
                if msg.part_mut(&part_id).is_none() {
                    msg.parts.push(Part::ToolCall(ToolCallPart {
                        id: part_id,
                        call_id,
                        name,
                        input,
                        state: ToolState::Pending,
                        title,
                        output: None,
                        error: None,
                    }));
                }
                msg.touch();
            }
            EngineEvent::ToolCallInputDelta { message_id, part_id, delta } => {
                if let Some(msg) = self.message_mut(&message_id) {
                    if let Some(Part::ToolCall(tc)) = msg.part_mut(&part_id) {
                        // Accumulate raw JSON text; the final input arrives with the full message.
                        let mut raw = tc.input.as_str().map(str::to_owned).unwrap_or_default();
                        raw.push_str(&delta);
                        tc.input = serde_json::Value::String(raw);
                    }
                    msg.touch();
                }
            }
            EngineEvent::ToolCallRunning { message_id, part_id } => {
                if let Some(msg) = self.message_mut(&message_id) {
                    if let Some(Part::ToolCall(tc)) = msg.part_mut(&part_id) {
                        tc.state = ToolState::Running;
                    }
                    msg.touch();
                }
            }
            EngineEvent::ToolCallFinished { message_id, part_id, output, error } => {
                if let Some(msg) = self.message_mut(&message_id) {
                    if let Some(Part::ToolCall(tc)) = msg.part_mut(&part_id) {
                        tc.state = if error.is_some() { ToolState::Error } else { ToolState::Done };
                        tc.output = output;
                        tc.error = error;
                    }
                    msg.touch();
                }
            }
            EngineEvent::MessageCompleted { message_id, usage, model } => {
                if let Some(msg) = self.message_mut(&message_id) {
                    msg.status = MessageStatus::Complete;
                    if usage.is_some() {
                        msg.usage = usage;
                    }
                    if model.is_some() {
                        msg.model = model;
                    }
                    msg.touch();
                }
            }
            EngineEvent::PermissionRequested { request, tool, input, title, message_id } => {
                self.pending.push(PendingRequest::Permission { request, participant: author.cloned(), tool, input, title, message_id });
                self.revision += 1;
            }
            EngineEvent::QuestionAsked { request, prompt, options } => {
                self.pending.push(PendingRequest::Question { request, participant: author.cloned(), prompt, options });
                self.revision += 1;
            }
            EngineEvent::RequestWithdrawn { request } => {
                self.resolve_request(&request);
            }
            EngineEvent::Todos { items } => {
                self.todos = items;
                self.revision += 1;
            }
            EngineEvent::Status { busy } => {
                // The branch closes when its answerer settles: the next thing
                // it says is a new turn in the room, not more of this reply.
                if !busy && let Some(a) = author && self.open_branches.remove(a).is_some() {
                    self.revision += 1;
                }
                if self.busy != busy {
                    self.busy = busy;
                    self.revision += 1;
                }
            }
            EngineEvent::Error { message, fatal: _ } => {
                let mut msg = Message::new(self.thread.id.clone(), Role::System);
                msg.status = MessageStatus::Error;
                msg.author = author.cloned();
                msg.parts.push(Part::Text(TextPart { id: PartId::new(), text: message }));
                self.push(msg);
            }
            EngineEvent::Closed => {
                self.busy = false;
                for msg in &mut self.messages {
                    if msg.status == MessageStatus::Streaming {
                        msg.status = MessageStatus::Interrupted;
                        msg.touch();
                    }
                }
                self.revision += 1;
            }
        }
    }

    fn ensure_message(&mut self, id: &MessageId, author: Option<&ParticipantId>) {
        if !self.index.contains_key(id) {
            let mut msg = Message::new(self.thread.id.clone(), Role::Assistant);
            msg.id = id.clone();
            msg.author = author.cloned();
            msg.branch_of = author.and_then(|a| self.open_branches.get(a)).cloned();
            self.push(msg);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use time::OffsetDateTime;

    fn thread() -> Thread {
        Thread {
            id: ThreadId::new(),
            project_id: Some(ProjectId::new()),
            title: "t".into(),
            kind: ThreadKind::Chat { engine: EngineId::Claude },
            created_at: OffsetDateTime::now_utc(),
            updated_at: OffsetDateTime::now_utc(),
            cwd: ".".into(),
            archived: false,
        }
    }

    #[test]
    fn deltas_build_a_message_and_bump_revision() {
        let mut m = ThreadModel::new(thread(), vec![], vec![]);
        let mid = MessageId::new();
        let pid = PartId::new();
        m.apply(None, EngineEvent::TextDelta { message_id: mid.clone(), part_id: pid.clone(), delta: "Hel".into() });
        let r1 = m.message(&mid).unwrap().revision;
        m.apply(None, EngineEvent::TextDelta { message_id: mid.clone(), part_id: pid, delta: "lo".into() });
        let msg = m.message(&mid).unwrap();
        assert_eq!(msg.text(), "Hello");
        assert!(msg.revision > r1);
        assert_eq!(msg.status, MessageStatus::Streaming);
        m.apply(None, EngineEvent::MessageCompleted { message_id: mid.clone(), usage: None, model: Some("x".into()) });
        assert_eq!(m.message(&mid).unwrap().status, MessageStatus::Complete);
    }

    #[test]
    fn tool_call_lifecycle() {
        let mut m = ThreadModel::new(thread(), vec![], vec![]);
        let mid = MessageId::new();
        let pid = PartId::new();
        m.apply(None, EngineEvent::ToolCallStarted { message_id: mid.clone(), part_id: pid.clone(), call_id: "c1".into(), name: "Read".into(), input: serde_json::json!({"path":"a"}), title: Some("a".into()) });
        m.apply(None, EngineEvent::ToolCallRunning { message_id: mid.clone(), part_id: pid.clone() });
        m.apply(None, EngineEvent::ToolCallFinished { message_id: mid.clone(), part_id: pid.clone(), output: Some("ok".into()), error: None });
        match &m.message(&mid).unwrap().parts[0] {
            Part::ToolCall(tc) => {
                assert_eq!(tc.state, ToolState::Done);
                assert_eq!(tc.output.as_deref(), Some("ok"));
            }
            _ => panic!(),
        }
    }

    #[test]
    fn pending_requests_come_and_go() {
        let mut m = ThreadModel::new(thread(), vec![], vec![]);
        let req = RequestId::new();
        m.apply(None, EngineEvent::PermissionRequested { request: req.clone(), tool: "Bash".into(), input: serde_json::json!({}), title: None, message_id: None });
        assert_eq!(m.pending.len(), 1);
        m.resolve_request(&req);
        assert!(m.pending.is_empty());
    }
}
