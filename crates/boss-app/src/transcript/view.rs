//! The message list. Renders `ThreadModel.messages` as turns inside a
//! bottom-aligned gpui `list()`, follows the tail while streaming until the
//! user scrolls up, and draws every message from the render cache.

use crate::model::ThreadModel;
use crate::transcript::cache::{Block, CachedMessage, RenderCache, ToolBlock};
use crate::transcript::mono_block;
use crate::transcript::recipient::participant_name;
use crate::transcript::turns::{Turn, group_turns};
use boss_core::{Message, MessageId, MessageStatus, Role, ThreadKind, ToolState};
use gpui::{prelude::*, *};
use gpui_component::button::{Button, ButtonVariants as _};
use gpui_component::tag::Tag;
use gpui_component::text::TextView;
use gpui_component::{ActiveTheme as _, Icon, IconName, Sizable as _, StyledExt as _, h_flex, v_flex};
use std::collections::HashSet;
use std::path::PathBuf;
use std::time::Instant;

/// Events the transcript raises for the shell.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TranscriptEvent {
    /// The user clicked the "N replies" affordance under a turn. `message` is
    /// the turn's key; the replies are the messages whose `branch_of` points
    /// into that turn.
    OpenReplies { message: MessageId },
}

/// Counters for the example and for profiling; reset with `take_stats`.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct RenderStats {
    /// List items (turns) rendered since the last reset.
    pub items_rendered: u64,
    /// Time spent building item elements since the last reset.
    pub item_render_micros: u64,
    /// Render-cache hits since the last reset.
    pub cache_hits: u64,
    /// Render-cache rebuilds since the last reset.
    pub cache_misses: u64,
}

/// The transcript list for one thread.
pub struct TranscriptView {
    model: Entity<ThreadModel>,
    list_state: ListState,
    turns: Vec<Turn>,
    cache: RenderCache,
    seen_revision: u64,
    /// Element ids of reasoning parts and tool cards the user opened.
    expanded: HashSet<SharedString>,
    /// Tool cards whose whole output is shown.
    full_output: HashSet<SharedString>,
    following: bool,
    stats: RenderStats,
    stats_base: (u64, u64),
    _subscriptions: Vec<Subscription>,
}

impl EventEmitter<TranscriptEvent> for TranscriptView {}

impl TranscriptView {
    /// Build a transcript over `model`, scrolled to and following the tail.
    pub fn new(model: Entity<ThreadModel>, cx: &mut Context<Self>) -> Self {
        let (turns, seen_revision) = {
            let m = model.read(cx);
            (group_turns(&m.messages), m.revision)
        };
        let list_state = ListState::new(turns.len(), ListAlignment::Bottom, px(1000.));
        list_state.set_follow_mode(FollowMode::Tail);

        let weak = cx.weak_entity();
        list_state.set_scroll_handler(move |event, _window, cx| {
            // The handler runs while the ListState is borrowed; touch the view later.
            let following = event.is_following_tail;
            let weak = weak.clone();
            cx.defer(move |cx| {
                let _ = weak.update(cx, |this, cx| this.set_following(following, cx));
            });
        });

        let subscription = cx.observe(&model, |this, model, cx| this.model_changed(&model, cx));
        Self {
            model,
            list_state,
            turns,
            cache: RenderCache::new(),
            seen_revision,
            expanded: HashSet::new(),
            full_output: HashSet::new(),
            following: true,
            stats: RenderStats::default(),
            stats_base: (0, 0),
            _subscriptions: vec![subscription],
        }
    }

    /// Number of visual turns currently in the list.
    pub fn turn_count(&self) -> usize {
        self.turns.len()
    }

    /// True while the list snaps to the newest content.
    pub fn is_following(&self) -> bool {
        self.following
    }

    /// Scroll to the end and resume following the tail.
    pub fn jump_to_latest(&mut self, cx: &mut Context<Self>) {
        self.list_state.set_follow_mode(FollowMode::Tail);
        self.set_following(true, cx);
    }

    /// Reveal the turn that holds `message`, stopping tail-follow.
    pub fn scroll_to_message(&mut self, message: &MessageId, cx: &mut Context<Self>) {
        let model = self.model.read(cx);
        let Some(ix) = model.messages.iter().position(|m| &m.id == message) else { return };
        let Some(turn_ix) = self.turns.iter().position(|t| t.members().any(|m| m == ix)) else { return };
        self.list_state.scroll_to_reveal_item(turn_ix);
        let following = self.list_state.is_following_tail();
        self.set_following(following, cx);
    }

    /// Counters since the last call, then reset.
    pub fn take_stats(&mut self) -> RenderStats {
        let hits = self.cache.hits();
        let misses = self.cache.misses();
        let stats = RenderStats {
            cache_hits: hits - self.stats_base.0,
            cache_misses: misses - self.stats_base.1,
            ..self.stats
        };
        self.stats_base = (hits, misses);
        self.stats = RenderStats::default();
        stats
    }

    fn set_following(&mut self, following: bool, cx: &mut Context<Self>) {
        if self.following != following {
            self.following = following;
            cx.notify();
        }
    }

    fn model_changed(&mut self, model: &Entity<ThreadModel>, cx: &mut Context<Self>) {
        let m = model.read(cx);
        if m.revision == self.seen_revision {
            return;
        }
        self.seen_revision = m.revision;
        let new_turns = group_turns(&m.messages);
        let prefix_matches = self.turns.iter().zip(&new_turns).all(|(a, b)| a.key == b.key);
        if prefix_matches {
            for (ix, (old, new)) in self.turns.iter().zip(&new_turns).enumerate() {
                if old.revision != new.revision || old.replies != new.replies {
                    self.list_state.remeasure_items(ix..ix + 1);
                }
            }
            let (old_len, new_len) = (self.turns.len(), new_turns.len());
            if new_len > old_len {
                self.list_state.splice(old_len..old_len, new_len - old_len);
            } else if new_len < old_len {
                self.list_state.splice(new_len..old_len, 0);
            }
        } else {
            // Reordered or removed history: rebuild measurements and drop dead cache entries.
            self.list_state.reset(new_turns.len());
            self.cache.retain(|id| m.message(id).is_some());
        }
        self.turns = new_turns;
        cx.notify();
    }

    fn toggle_expanded(&mut self, id: SharedString, turn_ix: usize, cx: &mut Context<Self>) {
        if !self.expanded.remove(&id) {
            self.expanded.insert(id);
            // Opening a card grows the item; do not let the tail snap the view away.
            if self.list_state.is_following_tail() {
                self.list_state.pause_following_tail();
            }
        }
        self.list_state.remeasure_items(turn_ix..turn_ix + 1);
        let following = self.list_state.is_following_tail();
        self.following = following;
        cx.notify();
    }

    fn show_full_output(&mut self, id: SharedString, turn_ix: usize, cx: &mut Context<Self>) {
        self.full_output.insert(id);
        if self.list_state.is_following_tail() {
            self.list_state.pause_following_tail();
        }
        self.list_state.remeasure_items(turn_ix..turn_ix + 1);
        self.following = self.list_state.is_following_tail();
        cx.notify();
    }

    fn render_turn(&mut self, turn_ix: usize, _window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let started = Instant::now();
        let Some(turn) = self.turns.get(turn_ix).cloned() else {
            return div().into_any_element();
        };
        let model = self.model.clone();
        let model = model.read(cx);

        let mut column = v_flex().w_full().px_5().py_3().gap_3();
        let mut shown_author = false;
        for message_ix in turn.members() {
            let Some(msg) = model.messages.get(message_ix) else { continue };
            let entry = self.cache.get(msg);
            let with_header = msg.role != Role::Assistant || !shown_author;
            if msg.role == Role::Assistant {
                shown_author = true;
            }
            column = column.child(render_message(msg, entry, with_header, model, turn_ix, &self.expanded, &self.full_output, cx));
        }
        if turn.replies > 0 {
            let key = turn.key.clone();
            column = column.child(
                Button::new(ElementId::Name(format!("{}/replies", turn.key).into()))
                    .ghost()
                    .xsmall()
                    .icon(IconName::ChevronRight)
                    .label(if turn.replies == 1 { "1 reply".to_owned() } else { format!("{} replies", turn.replies) })
                    .on_click(cx.listener(move |_, _, _, cx| cx.emit(TranscriptEvent::OpenReplies { message: key.clone() }))),
            );
        }

        self.stats.items_rendered += 1;
        self.stats.item_render_micros += started.elapsed().as_micros() as u64;
        column.into_any_element()
    }
}

impl Render for TranscriptView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let following = self.following;
        div()
            .relative()
            .size_full()
            .overflow_hidden()
            .child(list(self.list_state.clone(), cx.processor(|this, ix: usize, window, cx| this.render_turn(ix, window, cx))).size_full())
            .when(!following, |this| {
                this.child(
                    div().absolute().bottom_4().right_6().child(
                        Button::new("jump-to-latest")
                            .small()
                            .icon(IconName::ArrowDown)
                            .label("Jump to latest")
                            .on_click(cx.listener(|this, _, _, cx| this.jump_to_latest(cx))),
                    ),
                )
            })
    }
}

/// Who a message is from, as shown in the header.
fn author_label(msg: &Message, model: &ThreadModel) -> SharedString {
    match msg.role {
        Role::User => "You".into(),
        Role::System => "System".into(),
        Role::Assistant => msg
            .author
            .as_ref()
            .and_then(|a| participant_name(&model.participants, a))
            .map(|n| SharedString::from(n.to_owned()))
            .unwrap_or_else(|| match &model.thread.kind {
                ThreadKind::Chat { engine } => engine.label().into(),
                ThreadKind::Room { .. } | ThreadKind::Assistant => "Assistant".into(),
            }),
    }
}

#[allow(clippy::too_many_arguments)]
fn render_message(
    msg: &Message,
    entry: &CachedMessage,
    with_header: bool,
    model: &ThreadModel,
    turn_ix: usize,
    expanded: &HashSet<SharedString>,
    full_output: &HashSet<SharedString>,
    cx: &Context<TranscriptView>,
) -> AnyElement {
    let theme = cx.theme();
    let muted = msg.role == Role::System;
    let is_error = msg.status == MessageStatus::Error;
    let is_user = msg.role == Role::User;

    let mut body = v_flex().w_full().gap_2();
    if with_header {
        let mut header = h_flex().gap_2().items_center().text_xs().text_color(theme.muted_foreground);
        header = header.child(
            div()
                .text_sm()
                .font_semibold()
                .text_color(if is_user { theme.primary } else if muted { theme.muted_foreground } else { theme.foreground })
                .child(author_label(msg, model)),
        );
        if let Some(recipient) = &msg.recipient {
            let name = participant_name(&model.participants, recipient).unwrap_or(recipient.as_str()).to_owned();
            header = header.child(Tag::secondary().small().child(format!("→ {name}")));
        }
        header = header.child(entry.time.clone());
        if msg.status == MessageStatus::Streaming {
            header = header.child(Tag::info().outline().small().child("streaming"));
        } else if msg.status == MessageStatus::Interrupted {
            header = header.child(Tag::warning().outline().small().child("interrupted"));
        }
        body = body.child(header);
    }

    let mut blocks = v_flex().w_full().gap_2();
    if is_error {
        blocks = blocks.text_color(theme.danger);
    } else if muted {
        blocks = blocks.text_color(theme.muted_foreground).italic();
    }
    for block in &entry.blocks {
        blocks = blocks.child(render_block(block, turn_ix, muted, expanded, full_output, cx));
    }
    if is_user {
        blocks = blocks.rounded_lg().bg(theme.secondary).px_3().py_2();
    }
    body.child(blocks).into_any_element()
}

fn render_block(
    block: &Block,
    turn_ix: usize,
    muted: bool,
    expanded: &HashSet<SharedString>,
    full_output: &HashSet<SharedString>,
    cx: &Context<TranscriptView>,
) -> AnyElement {
    let theme = cx.theme();
    match block {
        Block::Text { id, markdown } => {
            let view = TextView::markdown(ElementId::Name(id.clone()), markdown.clone()).selectable(true);
            if muted { view.text_color(theme.muted_foreground) } else { view }.into_any_element()
        }
        Block::Reasoning { id, markdown } => {
            let open = expanded.contains(id);
            let toggle_id = id.clone();
            v_flex()
                .gap_1()
                .child(
                    Button::new(ElementId::Name(format!("{id}/toggle").into()))
                        .ghost()
                        .xsmall()
                        .icon(if open { IconName::ChevronDown } else { IconName::ChevronRight })
                        .label("Reasoning")
                        .on_click(cx.listener(move |this, _, _, cx| this.toggle_expanded(toggle_id.clone(), turn_ix, cx))),
                )
                .when(open, |this| {
                    this.child(
                        div().pl_3().border_l_2().border_color(theme.border).child(
                            TextView::markdown(ElementId::Name(id.clone()), markdown.clone())
                                .selectable(true)
                                .text_sm()
                                .text_color(theme.muted_foreground),
                        ),
                    )
                })
                .into_any_element()
        }
        Block::Tool(tool) => render_tool_card(tool, turn_ix, expanded, full_output, cx),
        Block::Attachment { id: _, name, mime, source, is_image } => {
            if *is_image {
                img(PathBuf::from(source.as_ref()))
                    .max_w(px(480.))
                    .max_h(px(320.))
                    .rounded_md()
                    .into_any_element()
            } else {
                Tag::secondary()
                    .small()
                    .child(
                        h_flex()
                            .gap_1()
                            .items_center()
                            .child(Icon::new(IconName::FileText).xsmall())
                            .child(name.clone())
                            .child(div().text_color(theme.muted_foreground).child(mime.clone())),
                    )
                    .into_any_element()
            }
        }
    }
}

fn render_tool_card(
    tool: &ToolBlock,
    turn_ix: usize,
    expanded: &HashSet<SharedString>,
    full_output: &HashSet<SharedString>,
    cx: &Context<TranscriptView>,
) -> AnyElement {
    let theme = cx.theme();
    let open = expanded.contains(&tool.id);
    let show_full = full_output.contains(&tool.id);
    let toggle_id = tool.id.clone();

    let header = h_flex()
        .id(ElementId::Name(format!("{}/header", tool.id).into()))
        .w_full()
        .px_2()
        .py_1()
        .gap_2()
        .items_center()
        .cursor_pointer()
        .hover(|style| style.bg(theme.list_hover))
        .on_click(cx.listener(move |this, _, _, cx| this.toggle_expanded(toggle_id.clone(), turn_ix, cx)))
        .child(Icon::new(if open { IconName::ChevronDown } else { IconName::ChevronRight }).xsmall())
        .child(div().text_sm().font_semibold().child(tool.name.clone()))
        .when_some(tool.title.clone(), |this, title| {
            this.child(div().flex_1().min_w_0().text_sm().text_color(theme.muted_foreground).truncate().child(title))
        })
        .child(div().flex_1())
        .child(state_tag(&tool.state));

    let card = v_flex().w_full().rounded_md().border_1().border_color(theme.border).bg(theme.secondary).overflow_hidden().child(header);
    if !open {
        return card.into_any_element();
    }

    let output_text = if show_full { tool.output_full.clone() } else { tool.output_head.clone() };
    let more_id = tool.id.clone();
    let content = v_flex()
        .px_2()
        .pb_2()
        .gap_2()
        .when(!tool.input.is_empty(), |this| this.child(section("Input", mono_block(tool.input.clone(), cx), cx)))
        .when(!tool.output_full.is_empty(), |this| {
            this.child(section(
                "Output",
                v_flex().gap_1().child(mono_block(output_text, cx)).when(tool.hidden_lines > 0 && !show_full, |this| {
                    this.child(
                        Button::new(ElementId::Name(format!("{}/more", tool.id).into()))
                            .ghost()
                            .xsmall()
                            .label(format!("Show {} more lines", tool.hidden_lines))
                            .on_click(cx.listener(move |this, _, _, cx| this.show_full_output(more_id.clone(), turn_ix, cx))),
                    )
                }),
                cx,
            ))
        })
        .when_some(tool.error.clone(), |this, error| this.child(div().text_sm().text_color(theme.danger).child(error)));
    card.child(content).into_any_element()
}

fn section(label: &'static str, content: impl IntoElement, cx: &App) -> Div {
    v_flex().gap_1().child(div().text_xs().text_color(cx.theme().muted_foreground).child(label)).child(content)
}

fn state_tag(state: &ToolState) -> Tag {
    match state {
        ToolState::Pending => Tag::secondary().small().child("pending"),
        ToolState::Running => Tag::info().small().child("running"),
        ToolState::Done => Tag::success().small().child("done"),
        ToolState::Error => Tag::danger().small().child("error"),
    }
}
