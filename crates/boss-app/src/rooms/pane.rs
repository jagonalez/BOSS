//! The room tab: team bar over the transcript, team setup before a shape
//! is chosen, and a replies panel on the right when a branch is open.

use super::replies::{RepliesEvent, RepliesPanel};
use super::team_bar::{TeamBar, TeamBarEvent};
use super::team_setup::{TeamSetup, TeamSetupEvent};
use crate::model::ThreadModel;
use crate::transcript::{ComposerEvent, ThreadPane, TranscriptEvent};
use boss_core::rooms::{RoomParticipant, RoomTeam};
use boss_core::*;
use gpui::{
    AppContext as _, Context, Entity, EventEmitter, IntoElement, ParentElement, Render, Styled, Subscription, Window, div,
};
use gpui_component::{h_flex, v_flex};

/// What the room pane asks the app to do.
#[derive(Clone, Debug)]
pub enum RoomPaneEvent {
    /// The user chose a shape and a team on the setup screen.
    Start { shape: RoomShape, team: RoomTeam },
    /// The user cancelled setup.
    Cancel,
    AddRole { role: ParticipantId, engine: EngineId },
    RemoveRole { participant: ParticipantId },
}

pub struct RoomPane {
    pane: Entity<ThreadPane>,
    team_bar: Entity<TeamBar>,
    setup: Option<Entity<TeamSetup>>,
    replies: Option<Entity<RepliesPanel>>,
    model: Entity<ThreadModel>,
    _subs: Vec<Subscription>,
}

impl EventEmitter<RoomPaneEvent> for RoomPane {}
impl EventEmitter<ComposerEvent> for RoomPane {}

impl RoomPane {
    pub fn new(
        model: Entity<ThreadModel>,
        participants: Vec<RoomParticipant>,
        setup: Option<(RoomTeam, Vec<(EngineId, Vec<ModelInfo>)>)>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let pane = cx.new(|cx| ThreadPane::new(model.clone(), window, cx));
        let team_bar = cx.new(|_| TeamBar::new(participants, EngineId::ALL.to_vec()));
        let setup = setup.map(|(team, models)| cx.new(|_| TeamSetup::new(team, EngineId::ALL.to_vec(), models)));
        let mut subs = vec![
            cx.subscribe(&pane, |_, _, event: &ComposerEvent, cx| cx.emit(event.clone())),
            cx.subscribe(&pane, |this: &mut Self, _, event: &TranscriptEvent, cx| {
                let TranscriptEvent::OpenReplies { message } = event;
                this.open_replies(message.clone(), cx);
            }),
            cx.subscribe(&team_bar, |this: &mut Self, _, event: &TeamBarEvent, cx| match event {
                TeamBarEvent::Retarget { participant } => {
                    let composer = this.pane.read(cx).composer().clone();
                    composer.update(cx, |c, cx| c.set_recipient(Some(participant.clone()), cx));
                }
                TeamBarEvent::AddRole { role, engine } => {
                    cx.emit(RoomPaneEvent::AddRole { role: role.clone(), engine: *engine })
                }
                TeamBarEvent::RemoveRole { participant } => {
                    cx.emit(RoomPaneEvent::RemoveRole { participant: participant.clone() })
                }
            }),
        ];
        if let Some(setup) = &setup {
            subs.push(cx.subscribe(setup, |this: &mut Self, _, event: &TeamSetupEvent, cx| match event {
                TeamSetupEvent::Start { shape, team } => {
                    this.setup = None;
                    cx.emit(RoomPaneEvent::Start { shape: *shape, team: team.clone() });
                    cx.notify();
                }
                TeamSetupEvent::Cancel => cx.emit(RoomPaneEvent::Cancel),
            }));
        }
        Self { pane, team_bar, setup, replies: None, model, _subs: subs }
    }

    pub fn pane(&self) -> &Entity<ThreadPane> {
        &self.pane
    }

    /// Refresh the seats shown in the team bar.
    pub fn set_participants(&mut self, participants: Vec<RoomParticipant>, cx: &mut Context<Self>) {
        self.team_bar.update(cx, |bar, cx| bar.set_participants(participants, cx));
    }

    fn open_replies(&mut self, parent: MessageId, cx: &mut Context<Self>) {
        match &self.replies {
            Some(panel) => panel.update(cx, |p, cx| p.set_parent(parent, cx)),
            None => {
                let model = self.model.clone();
                let panel = cx.new(|cx| RepliesPanel::new(model, parent, cx));
                self._subs.push(cx.subscribe(&panel, |this: &mut Self, _, event: &RepliesEvent, cx| match event {
                    RepliesEvent::Close => {
                        this.replies = None;
                        cx.notify();
                    }
                    RepliesEvent::Reply { .. } => {
                        // Branch replies go out through the composer as a normal
                        // send for now; the branch id is not threaded yet.
                        let _ = this;
                    }
                }));
                self.replies = Some(panel);
            }
        }
        cx.notify();
    }
}

impl Render for RoomPane {
    fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        if let Some(setup) = &self.setup {
            return div().size_full().child(setup.clone());
        }
        let mut row = h_flex().size_full().min_h_0().child(div().flex_1().min_w_0().size_full().child(self.pane.clone()));
        if let Some(replies) = &self.replies {
            row = row.child(div().w_96().h_full().child(replies.clone()));
        }
        div().size_full().child(v_flex().size_full().child(self.team_bar.clone()).child(row.flex_1().min_h_0()))
    }
}
