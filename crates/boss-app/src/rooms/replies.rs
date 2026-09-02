//! `RepliesPanel`: the branch under one turn.
//!
//! A reply thread is for taking review points one at a time — same room,
//! same participants, same rules (`docs/rooms.md`). Replies are not placed
//! inline: the transcript counts them and offers a way in, and this panel is
//! what opens beside it.
//!
//! The panel reads the same `ThreadModel` the transcript does. Nothing is
//! copied, so a reply that streams in appears here without a second path.

use crate::model::ThreadModel;
use crate::transcript::cache::{Block, RenderCache};
use crate::transcript::recipient::participant_name;
use boss_core::{Message, MessageId, MessageStatus, Role};
use gpui::prelude::*;
use gpui::{App, Context, ElementId, Entity, EventEmitter, Render, SharedString, Subscription, Window, div};
use gpui_component::button::{Button, ButtonVariants as _};
use gpui_component::tag::Tag;
use gpui_component::text::TextView;
use gpui_component::{ActiveTheme as _, IconName, Sizable as _, StyledExt as _, h_flex, v_flex};

/// What the replies panel asks the shell to do.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RepliesEvent {
    /// The user closed the panel.
    Close,
    /// Send a reply into this branch. The shell owns sending; the panel only
    /// says which turn the reply belongs under.
    Reply {
        /// The turn the reply hangs off.
        parent: MessageId,
    },
}

/// The replies under one message.
pub struct RepliesPanel {
    model: Entity<ThreadModel>,
    parent: MessageId,
    cache: RenderCache,
    seen_revision: u64,
    _subscription: Subscription,
}

impl EventEmitter<RepliesEvent> for RepliesPanel {}

impl RepliesPanel {
    /// Build a panel over the branch whose parent is `parent`.
    pub fn new(model: Entity<ThreadModel>, parent: MessageId, cx: &mut Context<Self>) -> Self {
        let seen_revision = model.read(cx).revision;
        let subscription = cx.observe(&model, |this: &mut Self, model, cx| {
            let revision = model.read(cx).revision;
            if revision == this.seen_revision {
                return;
            }
            this.seen_revision = revision;
            // Replies can be deleted with their turn; drop what is gone
            // rather than growing the cache for the life of the tab.
            let m = model.read(cx);
            this.cache.retain(|id| m.message(id).is_some());
            cx.notify();
        });
        Self { model, parent, cache: RenderCache::new(), seen_revision, _subscription: subscription }
    }

    /// The turn these replies hang off.
    pub fn parent(&self) -> &MessageId {
        &self.parent
    }

    /// Show a different branch without rebuilding the view.
    pub fn set_parent(&mut self, parent: MessageId, cx: &mut Context<Self>) {
        self.parent = parent;
        cx.notify();
    }

    /// How many replies this branch holds.
    pub fn count(&self, cx: &App) -> usize {
        replies_of(self.model.read(cx), &self.parent).count()
    }

    /// What the header says: the first words of the message being replied
    /// to, so the panel names the point rather than an id.
    pub fn title(&self, cx: &App) -> String {
        let model = self.model.read(cx);
        let Some(parent) = model.message(&self.parent) else {
            return "Replies".to_owned();
        };
        match first_words(parent, 48) {
            Some(words) => format!("Replies to “{words}”"),
            None => "Replies".to_owned(),
        }
    }
}

/// Messages whose `branch_of` points at `parent`, in stored order.
fn replies_of<'a>(model: &'a ThreadModel, parent: &'a MessageId) -> impl Iterator<Item = &'a Message> {
    model
        .messages
        .iter()
        .filter(move |msg| msg.branch_of.as_ref() == Some(parent))
}

/// The opening of a message, cut to `limit` characters on a character
/// boundary. `None` when the message is all tool calls and attachments:
/// quoting an empty string would name nothing.
fn first_words(msg: &Message, limit: usize) -> Option<String> {
    let text = msg.parts.iter().find_map(|part| match part {
        boss_core::Part::Text(t) => Some(t.text.trim()),
        _ => None,
    })?;
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.is_empty() {
        return None;
    }
    if flat.chars().count() <= limit {
        return Some(flat);
    }
    let cut: String = flat.chars().take(limit).collect();
    Some(format!("{}…", cut.trim_end()))
}

impl Render for RepliesPanel {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        let title = self.title(cx);
        let model = self.model.clone();
        let model = model.read(cx);
        let replies: Vec<Message> = replies_of(model, &self.parent).cloned().collect();

        let mut list = v_flex().id("replies-list").flex_1().min_h_0().overflow_y_scroll().px_4().py_3().gap_3();
        for msg in &replies {
            let entry = self.cache.get(msg);
            let is_user = msg.role == Role::User;
            let author: SharedString = match msg.role {
                Role::User => "You".into(),
                Role::System => "System".into(),
                Role::Assistant => msg
                    .author
                    .as_ref()
                    .and_then(|a| participant_name(&model.participants, a))
                    .map(|name| SharedString::from(name.to_owned()))
                    .unwrap_or_else(|| "Assistant".into()),
            };
            let mut body = v_flex().w_full().gap_1().child(
                h_flex()
                    .gap_2()
                    .items_center()
                    .text_xs()
                    .text_color(theme.muted_foreground)
                    .child(
                        div()
                            .text_sm()
                            .font_semibold()
                            .text_color(if is_user { theme.primary } else { theme.foreground })
                            .child(author),
                    )
                    .child(entry.time.clone())
                    .when(msg.status == MessageStatus::Streaming, |this| {
                        this.child(Tag::info().outline().small().child("streaming"))
                    }),
            );
            let mut blocks = v_flex().w_full().gap_2();
            for block in &entry.blocks {
                // A branch is for one point. Tool calls and attachments stay
                // in the main stream, where their turn already shows them.
                if let Block::Text { id, markdown } = block {
                    blocks = blocks
                        .child(TextView::markdown(ElementId::Name(id.clone()), markdown.clone()).selectable(true));
                }
            }
            if is_user {
                blocks = blocks.rounded_lg().bg(theme.secondary).px_3().py_2();
            }
            body = body.child(blocks);
            list = list.child(body);
        }
        if replies.is_empty() {
            list = list.child(
                div()
                    .text_xs()
                    .text_color(theme.muted_foreground)
                    .child("No replies yet."),
            );
        }

        let parent = self.parent.clone();
        v_flex()
            .id("replies-panel")
            .size_full()
            .bg(theme.background)
            .border_l_1()
            .border_color(theme.border)
            .child(
                h_flex()
                    .w_full()
                    .gap_2()
                    .items_center()
                    .px_4()
                    .py_2()
                    .border_b_1()
                    .border_color(theme.border)
                    .child(div().flex_1().min_w_0().text_sm().font_semibold().truncate().child(title))
                    .child(
                        Button::new("replies-close")
                            .ghost()
                            .xsmall()
                            .icon(IconName::Close)
                            .tooltip("Close replies")
                            .on_click(cx.listener(|_, _, _, cx| cx.emit(RepliesEvent::Close))),
                    ),
            )
            .child(list)
            .child(
                h_flex()
                    .w_full()
                    .px_4()
                    .py_2()
                    .border_t_1()
                    .border_color(theme.border)
                    .child(
                        Button::new("replies-reply")
                            .small()
                            .outline()
                            .icon(IconName::ArrowUp)
                            .label("Reply here")
                            .on_click(cx.listener(move |_, _, _, cx| {
                                cx.emit(RepliesEvent::Reply { parent: parent.clone() })
                            })),
                    ),
            )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use boss_core::*;
    use time::OffsetDateTime;
    use gpui::TestAppContext;

    fn text(msg: &mut Message, body: &str) {
        msg.parts.push(Part::Text(TextPart { id: PartId::new(), text: body.to_owned() }));
    }

    fn model() -> (ThreadModel, MessageId) {
        let thread = Thread {
            id: ThreadId::from_raw("thr_1"),
            project_id: ProjectId::from_raw("prj_1"),
            title: "Port the sidebar".into(),
            kind: ThreadKind::Room { room_id: RoomId::from_raw("room_1") },
            created_at: OffsetDateTime::now_utc(),
            updated_at: OffsetDateTime::now_utc(),
            cwd: std::path::PathBuf::from("/tmp"),
            archived: false,
        };
        let participants = vec![Participant {
            id: ParticipantId::from_raw("reviewer"),
            name: "Reviewer".into(),
            engine: EngineId::Claude,
            model: None,
            is_boss: false,
            native_session_id: None,
        }];

        let mut parent = Message::new(thread.id.clone(), Role::Assistant);
        parent.author = Some(ParticipantId::from_raw("reviewer"));
        parent.status = MessageStatus::Complete;
        text(&mut parent, "The header capped the list at fifty rows, which the plan did not say.");
        let parent_id = parent.id.clone();

        let mut question = Message::new(thread.id.clone(), Role::User);
        question.status = MessageStatus::Complete;
        question.branch_of = Some(parent_id.clone());
        text(&mut question, "Why fifty?");

        let mut answer = Message::new(thread.id.clone(), Role::Assistant);
        answer.author = Some(ParticipantId::from_raw("reviewer"));
        answer.status = MessageStatus::Complete;
        answer.branch_of = Some(parent_id.clone());
        text(&mut answer, "It is what the old renderer used.");

        // Not a reply: it belongs to the main stream.
        let mut other = Message::new(thread.id.clone(), Role::User);
        other.status = MessageStatus::Complete;
        text(&mut other, "Fix it then.");

        (
            ThreadModel::new(thread, participants, vec![parent, question, answer, other]),
            parent_id,
        )
    }

    type Panel<'a> = (Entity<RepliesPanel>, Entity<ThreadModel>, MessageId, &'a mut gpui::VisualTestContext);

    fn panel(cx: &mut TestAppContext) -> Panel<'_> {
        cx.update(gpui_component::init);
        let (thread, parent) = model();
        let model = cx.new(|_| thread);
        let (view, cx) = {
            let model = model.clone();
            let parent = parent.clone();
            cx.add_window_view(move |_, cx| RepliesPanel::new(model, parent, cx))
        };
        cx.update(|window, cx| window.draw(cx).clear(cx));
        (view, model, parent, cx)
    }

    #[gpui::test]
    fn it_shows_only_the_messages_that_branch_off_this_turn(cx: &mut TestAppContext) {
        let (view, _model, _parent, cx) = panel(cx);
        view.read_with(cx, |this, cx| assert_eq!(this.count(cx), 2));
    }

    #[gpui::test]
    fn the_header_quotes_the_point_being_replied_to(cx: &mut TestAppContext) {
        let (view, _model, _parent, cx) = panel(cx);
        view.read_with(cx, |this, cx| {
            let title = this.title(cx);
            assert!(title.starts_with("Replies to "), "{title}");
            assert!(title.contains("The header capped"), "{title}");
            assert!(title.ends_with('”'));
        });
    }

    #[gpui::test]
    fn a_reply_that_arrives_later_shows_without_a_second_path(cx: &mut TestAppContext) {
        let (view, model, parent, cx) = panel(cx);
        model.update(cx, |m, cx| {
            m.push_user_message("Understood.".into(), None, Vec::new());
            // `push_user_message` cannot set `branch_of`; place it directly.
            let ix = m.messages.len() - 1;
            m.messages[ix].branch_of = Some(parent.clone());
            cx.notify();
        });
        cx.update(|window, cx| window.draw(cx).clear(cx));
        view.read_with(cx, |this, cx| assert_eq!(this.count(cx), 3));
    }

    #[gpui::test]
    fn an_unknown_parent_still_draws_a_header_and_an_empty_branch(cx: &mut TestAppContext) {
        let (view, _model, _parent, cx) = panel(cx);
        view.update(cx, |this, cx| this.set_parent(MessageId::from_raw("msg_ghost"), cx));
        cx.update(|window, cx| window.draw(cx).clear(cx));
        view.read_with(cx, |this, cx| {
            assert_eq!(this.count(cx), 0);
            assert_eq!(this.title(cx), "Replies");
        });
    }

    #[gpui::test]
    fn closing_and_replying_are_the_only_two_things_it_asks_for(cx: &mut TestAppContext) {
        let (view, _model, parent, cx) = panel(cx);
        let seen = std::rc::Rc::new(std::cell::RefCell::new(Vec::new()));
        let sink = seen.clone();
        cx.update(|_, cx| {
            cx.subscribe(&view, move |_, event: &RepliesEvent, _| sink.borrow_mut().push(event.clone())).detach();
        });
        view.update(cx, |_, cx| {
            cx.emit(RepliesEvent::Reply { parent: parent.clone() });
            cx.emit(RepliesEvent::Close);
        });
        cx.update(|window, cx| window.draw(cx).clear(cx));
        assert_eq!(
            *seen.borrow(),
            vec![RepliesEvent::Reply { parent }, RepliesEvent::Close]
        );
    }

    #[test]
    fn a_quoted_opening_is_cut_on_a_character_boundary_and_a_toolless_turn_quotes_nothing() {
        let mut msg = Message::new(ThreadId::from_raw("t"), Role::Assistant);
        assert_eq!(first_words(&msg, 10), None, "nothing to quote");
        text(&mut msg, "  a  b\n c  ");
        assert_eq!(first_words(&msg, 10).as_deref(), Some("a b c"));
        let mut long = Message::new(ThreadId::from_raw("t"), Role::Assistant);
        text(&mut long, "ünicode ünicode ünicode ünicode");
        let cut = first_words(&long, 10).expect("cut");
        assert_eq!(cut, "ünicode ün…", "cut by characters, not by bytes");
    }
}
