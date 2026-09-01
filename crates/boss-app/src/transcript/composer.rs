//! The composer: multi-line input, recipient chip, attachments, and the
//! permission/question bar. Emits `ComposerEvent`s; never touches the model.

use crate::model::{PendingRequest, ThreadModel};
use crate::transcript::cache::head_lines;
use crate::transcript::mono_block;
use crate::transcript::recipient::{default_recipient, participant_name, retarget};
use boss_core::{Participant, ParticipantId, PermissionDecision, RequestId};
use gpui::{prelude::*, *};
use gpui_component::button::{Button, ButtonVariants as _};
use gpui_component::input::{InputEvent, Textarea, TextareaState};
use gpui_component::tag::Tag;
use gpui_component::{ActiveTheme as _, Icon, IconName, Sizable as _, StyledExt as _, h_flex, v_flex};
use std::path::PathBuf;

/// Tools whose permission prompt offers "Allow always" (file edits).
const EDIT_TOOLS: &[&str] = &["edit", "write", "multiedit", "notebookedit", "apply_patch", "str_replace_editor", "create_file"];

/// What the composer asks the shell to do.
#[derive(Clone, Debug, PartialEq)]
pub enum ComposerEvent {
    /// Send a message. `recipient` is `None` in a plain chat.
    Send { text: String, recipient: Option<ParticipantId>, attachments: Vec<PathBuf> },
    /// Answer a permission request. `always` asks the shell to also switch
    /// the session to `PermissionMode::AcceptEdits`.
    Permission { request: RequestId, decision: PermissionDecision, always: bool },
    /// Answer a question with one of its options.
    Answer { request: RequestId, option: String },
    /// Stop the running turn.
    Interrupt,
}

/// The message composer for one thread.
pub struct Composer {
    model: Entity<ThreadModel>,
    input: Entity<TextareaState>,
    recipient: Option<ParticipantId>,
    attachments: Vec<PathBuf>,
    _subscriptions: Vec<Subscription>,
}

impl EventEmitter<ComposerEvent> for Composer {}

impl Composer {
    /// Build a composer over `model`. Enter sends; Shift+Enter inserts a newline.
    pub fn new(model: Entity<ThreadModel>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let input = cx.new(|cx| {
            TextareaState::new(window, cx)
                .auto_grow(1, 8)
                .submit_on_enter(true)
                .placeholder("Message — Enter to send, Shift+Enter for a new line")
        });
        let recipient = default_recipient(&model.read(cx).participants);
        let subscriptions = vec![
            cx.subscribe_in(&input, window, |this: &mut Self, _input, event: &InputEvent, window, cx| match event {
                InputEvent::PressEnter { shift: false, .. } => this.send(window, cx),
                InputEvent::Change => this.retarget_while_typing(window, cx),
                _ => {}
            }),
            cx.observe(&model, |_, _, cx| cx.notify()),
        ];
        Self { model, input, recipient, attachments: Vec::new(), _subscriptions: subscriptions }
    }

    /// The text input, for focus and key handling by the shell.
    pub fn input(&self) -> &Entity<TextareaState> {
        &self.input
    }

    /// Current recipient chip.
    pub fn recipient(&self) -> Option<&ParticipantId> {
        self.recipient.as_ref()
    }

    /// Point the chip at `recipient`; it stays there across sends.
    pub fn set_recipient(&mut self, recipient: Option<ParticipantId>, cx: &mut Context<Self>) {
        self.recipient = recipient;
        cx.notify();
    }

    /// Attachments queued for the next send.
    pub fn attachments(&self) -> &[PathBuf] {
        &self.attachments
    }

    /// Queue a file for the next send.
    pub fn add_attachment(&mut self, path: PathBuf, cx: &mut Context<Self>) {
        if !self.attachments.contains(&path) {
            self.attachments.push(path);
            cx.notify();
        }
    }

    /// Drop a queued attachment by index.
    pub fn remove_attachment(&mut self, ix: usize, cx: &mut Context<Self>) {
        if ix < self.attachments.len() {
            self.attachments.remove(ix);
            cx.notify();
        }
    }

    /// Focus the text input.
    pub fn focus(&self, window: &mut Window, cx: &mut Context<Self>) {
        self.input.update(cx, |state, cx| state.focus(window, cx));
    }

    /// Emit `Send` for the current text and attachments, then clear them.
    pub fn send(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let mut text = self.input.read(cx).value().trim().to_owned();
        if let Some(mention) = retarget(&text, &self.model.read(cx).participants, false) {
            self.recipient = Some(mention.recipient);
            text = mention.rest;
        }
        if text.is_empty() && self.attachments.is_empty() {
            return;
        }
        let attachments = std::mem::take(&mut self.attachments);
        self.input.update(cx, |state, cx| state.set_value("", window, cx));
        cx.emit(ComposerEvent::Send { text, recipient: self.recipient.clone(), attachments });
        cx.notify();
    }

    fn retarget_while_typing(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let value = self.input.read(cx).value();
        let Some(mention) = retarget(&value, &self.model.read(cx).participants, true) else { return };
        self.recipient = Some(mention.recipient);
        self.input.update(cx, |state, cx| state.set_value(mention.rest, window, cx));
        cx.notify();
    }

    fn cycle_recipient(&mut self, cx: &mut Context<Self>) {
        let participants = &self.model.read(cx).participants;
        if participants.is_empty() {
            return;
        }
        let current = self.recipient.as_ref().and_then(|r| participants.iter().position(|p| &p.id == r));
        let next = current.map_or(0, |ix| (ix + 1) % participants.len());
        self.recipient = Some(participants[next].id.clone());
        cx.notify();
    }
}

impl Render for Composer {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        let model = self.model.read(cx);
        let in_room = !model.participants.is_empty();
        let busy = model.busy;
        let recipient_label = self
            .recipient
            .as_ref()
            .map(|r| participant_name(&model.participants, r).map(str::to_owned).unwrap_or_else(|| r.to_string()))
            .unwrap_or_else(|| "nobody".to_owned());
        let requests: Vec<AnyElement> = model.pending.iter().map(|req| render_request(req, &model.participants, cx)).collect();

        v_flex()
            .w_full()
            .border_t_1()
            .border_color(theme.border)
            .bg(theme.background)
            .p_3()
            .gap_2()
            .children(requests)
            .when(!self.attachments.is_empty(), |this| {
                this.child(h_flex().gap_1().flex_wrap().children(self.attachments.iter().enumerate().map(|(ix, path)| {
                    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| path.display().to_string());
                    Tag::secondary().small().child(
                        h_flex()
                            .gap_1()
                            .items_center()
                            .child(Icon::new(IconName::FileText).xsmall())
                            .child(name)
                            .child(
                                Button::new(ElementId::Name(format!("attachment-{ix}").into()))
                                    .ghost()
                                    .xsmall()
                                    .icon(IconName::Close)
                                    .on_click(cx.listener(move |this, _, _, cx| this.remove_attachment(ix, cx))),
                            ),
                    )
                })))
            })
            .child(
                h_flex()
                    .w_full()
                    .items_end()
                    .gap_2()
                    .when(in_room, |this| {
                        this.child(
                            Button::new("recipient")
                                .small()
                                .outline()
                                .label(format!("@{recipient_label}"))
                                .tooltip("Who this message goes to. Click to change, or type @name.")
                                .on_click(cx.listener(|this, _, _, cx| this.cycle_recipient(cx))),
                        )
                    })
                    .child(Textarea::new(&self.input).flex_1())
                    .child(if busy {
                        Button::new("stop")
                            .danger()
                            .small()
                            .icon(IconName::Pause)
                            .label("Stop")
                            .on_click(cx.listener(|_, _, _, cx| cx.emit(ComposerEvent::Interrupt)))
                    } else {
                        Button::new("send")
                            .primary()
                            .small()
                            .icon(IconName::ArrowUp)
                            .label("Send")
                            .on_click(cx.listener(|this, _, window, cx| this.send(window, cx)))
                    }),
            )
    }
}

fn is_edit_tool(tool: &str) -> bool {
    let lower = tool.to_lowercase();
    EDIT_TOOLS.iter().any(|t| lower == *t || lower.ends_with(&format!("_{t}")))
}

fn render_request(request: &PendingRequest, participants: &[Participant], cx: &Context<Composer>) -> AnyElement {
    let theme = cx.theme();
    let frame = v_flex().w_full().rounded_md().border_1().border_color(theme.border).bg(theme.secondary).p_3().gap_2();
    match request {
        PendingRequest::Permission { request, participant, tool, input, title, .. } => {
            let who = participant.as_ref().and_then(|p| participant_name(participants, p)).unwrap_or("The agent");
            let input_text = match input {
                serde_json::Value::Null => String::new(),
                other => serde_json::to_string_pretty(other).unwrap_or_default(),
            };
            let (input_head, hidden) = head_lines(&input_text, 8);
            let input_head = if hidden > 0 { format!("{input_head}\n… {hidden} more lines") } else { input_head };
            let id = |suffix: &str| ElementId::Name(format!("{request}/{suffix}").into());
            let decide = |decision: PermissionDecision, always: bool| {
                let request = request.clone();
                cx.listener(move |_, _, _, cx| cx.emit(ComposerEvent::Permission { request: request.clone(), decision: decision.clone(), always }))
            };
            frame
                .child(
                    h_flex()
                        .gap_2()
                        .items_center()
                        .child(Icon::new(IconName::TriangleAlert).small())
                        .child(div().text_sm().font_semibold().child(format!("{who} wants to run {tool}")))
                        .when_some(title.clone(), |this, title| this.child(div().flex_1().min_w_0().text_sm().text_color(theme.muted_foreground).truncate().child(title))),
                )
                .when(!input_head.is_empty(), |this| this.child(mono_block(input_head.into(), cx)))
                .child(
                    h_flex()
                        .gap_2()
                        .child(Button::new(id("allow")).primary().small().label("Allow").on_click(decide(PermissionDecision::Allow { updated_input: None }, false)))
                        .when(is_edit_tool(tool), |this| {
                            this.child(Button::new(id("always")).small().label("Allow always").on_click(decide(PermissionDecision::Allow { updated_input: None }, true)))
                        })
                        .child(Button::new(id("deny")).danger().outline().small().label("Deny").on_click(decide(PermissionDecision::Deny { reason: String::new() }, false))),
                )
                .into_any_element()
        }
        PendingRequest::Question { request, participant, prompt, options } => {
            let who = participant.as_ref().and_then(|p| participant_name(participants, p)).unwrap_or("The agent");
            frame
                .child(
                    h_flex()
                        .gap_2()
                        .items_center()
                        .child(Icon::new(IconName::Info).small())
                        .child(div().text_sm().font_semibold().child(format!("{who} asks")))
                        .child(div().flex_1().min_w_0().text_sm().child(prompt.clone())),
                )
                .child(h_flex().gap_2().flex_wrap().children(options.iter().enumerate().map(|(ix, option)| {
                    let request = request.clone();
                    let answer = option.clone();
                    Button::new(ElementId::Name(format!("{request}/option-{ix}").into()))
                        .small()
                        .outline()
                        .label(option.clone())
                        .on_click(cx.listener(move |_, _, _, cx| cx.emit(ComposerEvent::Answer { request: request.clone(), option: answer.clone() })))
                })))
                .into_any_element()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::is_edit_tool;

    #[test]
    fn edit_tools_get_allow_always() {
        assert!(is_edit_tool("Edit"));
        assert!(is_edit_tool("Write"));
        assert!(is_edit_tool("mcp__fs_write"));
        assert!(!is_edit_tool("Bash"));
        assert!(!is_edit_tool("Read"));
    }
}
