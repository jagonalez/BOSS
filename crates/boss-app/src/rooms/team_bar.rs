//! `TeamBar`: the strip above a room's transcript.
//!
//! This is where the engine, the model and the reach live — the team's
//! answers, chosen once, shown where the team is shown. The composer below
//! asks one thing only: who the message is for. See `docs/rooms-ui.md`.
//!
//! Participants join when the work reaches them, so the bar grows during a
//! job. A role that is not here yet is not a chip; it is an entry in the
//! "add" menu.

use super::{effective_state, engine_badge, state_color, state_word};
use boss_core::rooms::{
    ParticipantState, RoomParticipant, RoomRole, is_assistant, missing_roles,
};
use boss_core::{EngineId, ParticipantId};
use gpui::prelude::*;
use gpui::{AnyElement, ClickEvent, Context, EventEmitter, Render, SharedString, Window, div, px};
use gpui_component::button::{Button, ButtonVariants as _};
use gpui_component::menu::{DropdownMenu as _, PopupMenu, PopupMenuItem};
use gpui_component::tooltip::Tooltip;
use gpui_component::{ActiveTheme as _, IconName, Sizable as _, StyledExt as _, h_flex};
use time::OffsetDateTime;

/// What the team bar asks the shell to do.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TeamBarEvent {
    /// Bring a role into this room, on this engine.
    AddRole {
        /// Which default role. Its id doubles as the participant id.
        role: ParticipantId,
        /// The engine it runs on.
        engine: EngineId,
    },
    /// Take a participant out of the room.
    RemoveRole {
        /// The seat to remove.
        participant: ParticipantId,
    },
    /// Point the composer at a participant. Clicking a chip is the shortest
    /// way to address someone, and it is what the user reaches for first.
    Retarget {
        /// The seat to address.
        participant: ParticipantId,
    },
}

/// The participants of one room, as a compact strip.
pub struct TeamBar {
    participants: Vec<RoomParticipant>,
    engines: Vec<EngineId>,
    now: OffsetDateTime,
}

impl EventEmitter<TeamBarEvent> for TeamBar {}

impl TeamBar {
    /// Build a bar over the room's seats and the engines the user has
    /// connected. `engines` decides what the "add" menu may offer: a role on
    /// an engine that is not installed cannot run.
    pub fn new(participants: Vec<RoomParticipant>, engines: Vec<EngineId>) -> Self {
        Self { participants, engines, now: OffsetDateTime::now_utc() }
    }

    /// Replace the seats, e.g. when a participant joins mid-job.
    pub fn set_participants(&mut self, participants: Vec<RoomParticipant>, cx: &mut Context<Self>) {
        self.participants = participants;
        self.now = OffsetDateTime::now_utc();
        cx.notify();
    }

    /// The seats the bar is drawing.
    pub fn participants(&self) -> &[RoomParticipant] {
        &self.participants
    }

    /// Pin the clock, so a test can say what "stale" means.
    #[cfg(test)]
    pub(crate) fn set_now(&mut self, now: OffsetDateTime) {
        self.now = now;
    }

    /// Default roles not in the room yet, each on an engine that is
    /// connected. Empty when the room already has everyone.
    pub fn addable(&self) -> Vec<RoomRole> {
        let present: Vec<RoomRole> = self
            .participants
            .iter()
            .map(|seat| {
                RoomRole::new(seat.id().as_str(), seat.label(), seat.engine(), None)
            })
            .collect();
        missing_roles(&present, &self.engines)
    }

    fn render_chip(&self, seat: &RoomParticipant, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme();
        let id = seat.id().clone();
        let state = effective_state(seat, self.now);
        let boss = is_assistant(seat.id());
        let target = id.clone();
        let remove = id.clone();
        // Nothing removes BOSS. It is who the user talks to, and a room
        // without it would have nobody to ask.
        let removable = !boss;

        h_flex()
            .id(SharedString::from(format!("chip-{id}")))
            .gap_1p5()
            .items_center()
            .px_2()
            .py_0p5()
            .rounded_full()
            .border_1()
            .border_color(if boss { theme.primary.opacity(0.5) } else { theme.border })
            .bg(if boss { theme.accent } else { theme.secondary })
            .cursor_pointer()
            .hover(|s| s.bg(theme.accent))
            .text_xs()
            .when(state == ParticipantState::Done, |this| this.opacity(0.6))
            .tooltip({
                let text = SharedString::from(format!(
                    "{} · {} · {}",
                    seat.label(),
                    engine_badge(seat.engine()),
                    state_word(state)
                ));
                move |window, cx| Tooltip::new(text.clone()).build(window, cx)
            })
            .on_click(cx.listener(move |_, _: &ClickEvent, _, cx| {
                cx.emit(TeamBarEvent::Retarget { participant: target.clone() })
            }))
            .child(div().size(px(6.)).rounded_full().flex_shrink_0().bg(state_color(state, cx)))
            .child(div().font_semibold().child(seat.label().to_owned()))
            .child(
                div()
                    .text_color(theme.muted_foreground)
                    .child(engine_badge(seat.engine())),
            )
            .when(removable, |this| {
                this.child(
                    Button::new(SharedString::from(format!("remove-{id}")))
                        .ghost()
                        .xsmall()
                        .icon(IconName::Close)
                        .tooltip("Remove from this room")
                        .on_click(cx.listener(move |_, _, _, cx| {
                            cx.emit(TeamBarEvent::RemoveRole { participant: remove.clone() });
                            cx.stop_propagation();
                        })),
                )
            })
            .into_any_element()
    }
}

impl Render for TeamBar {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let seats: Vec<RoomParticipant> = self.participants.clone();
        let chips: Vec<AnyElement> = seats.iter().map(|seat| self.render_chip(seat, cx)).collect();
        let addable = self.addable();
        let weak = cx.weak_entity();
        let theme = cx.theme();

        h_flex()
            .w_full()
            .flex_wrap()
            .items_center()
            .gap_1p5()
            .px_4()
            .py_1p5()
            .border_b_1()
            .border_color(theme.border)
            .bg(theme.background)
            .children(chips)
            .when(seats.is_empty(), |this| {
                this.child(
                    div()
                        .text_xs()
                        .text_color(theme.muted_foreground)
                        .child("Nobody here yet. Say what the job is and BOSS brings people in."),
                )
            })
            .when(!addable.is_empty(), |this| {
                this.child(
                    Button::new("add-role")
                        .ghost()
                        .xsmall()
                        .icon(IconName::Plus)
                        .label("Add")
                        .tooltip("Bring another role into this room")
                        .dropdown_menu(move |mut menu: PopupMenu, _, _| {
                            for role in addable.clone() {
                                let weak = weak.clone();
                                menu = menu.item(
                                    PopupMenuItem::new(format!(
                                        "{} · {}",
                                        role.label,
                                        engine_badge(role.engine)
                                    ))
                                    .on_click(move |_, _, cx| {
                                        let role = role.clone();
                                        let _ = weak.update(cx, |_, cx| {
                                            cx.emit(TeamBarEvent::AddRole {
                                                role: role.id.clone(),
                                                engine: role.engine,
                                            })
                                        });
                                    }),
                                );
                            }
                            menu
                        }),
                )
            })
    }
}

#[cfg(test)]
mod tests {
    use super::super::demo::{at, seat};
    use super::*;
    use boss_core::rooms::{PARTICIPANT_STALE_AFTER, addable_roles};
    use gpui::{Entity, TestAppContext};

    fn room() -> Vec<RoomParticipant> {
        vec![
            seat("boss", "BOSS", EngineId::Claude, ParticipantState::Active),
            seat("builder", "Builder", EngineId::Codex, ParticipantState::Working),
            seat("reviewer", "Reviewer", EngineId::Claude, ParticipantState::Done),
        ]
    }

    fn bar(cx: &mut TestAppContext, seats: Vec<RoomParticipant>) -> (Entity<TeamBar>, &mut gpui::VisualTestContext) {
        cx.update(gpui_component::init);
        let (view, cx) = cx.add_window_view(move |_, _| {
            let mut bar = TeamBar::new(seats, vec![EngineId::Claude, EngineId::Codex]);
            bar.set_now(at(60));
            bar
        });
        cx.update(|window, cx| window.draw(cx).clear(cx));
        (view, cx)
    }

    #[gpui::test]
    fn it_draws_a_chip_for_every_seat(cx: &mut TestAppContext) {
        let (view, cx) = bar(cx, room());
        view.read_with(cx, |this, _| assert_eq!(this.participants().len(), 3));
    }

    #[gpui::test]
    fn only_roles_the_room_lacks_are_offered_and_only_on_connected_engines(cx: &mut TestAppContext) {
        let (view, cx) = bar(cx, room());
        view.read_with(cx, |this, _| {
            let offered: Vec<String> = this.addable().iter().map(|role| role.id.to_string()).collect();
            assert_eq!(offered, vec!["researcher", "planner", "releaser"]);
            assert!(
                this.addable().iter().all(|role| this.engines.contains(&role.engine)),
                "a role on an engine that is not installed cannot run"
            );
        });
    }

    #[gpui::test]
    fn an_empty_room_offers_every_default_role(cx: &mut TestAppContext) {
        let (view, cx) = bar(cx, Vec::new());
        view.read_with(cx, |this, _| assert_eq!(this.addable().len(), addable_roles().len()));
    }

    #[gpui::test]
    fn a_seat_that_aged_out_reads_idle_even_though_it_was_stored_active(cx: &mut TestAppContext) {
        let (view, cx) = bar(cx, room());
        view.update(cx, |this, cx| {
            this.set_now(at(PARTICIPANT_STALE_AFTER.whole_seconds() + 1));
            cx.notify();
        });
        cx.update(|window, cx| window.draw(cx).clear(cx));
        view.read_with(cx, |this, _| {
            let boss = &this.participants()[0];
            assert_eq!(boss.state, ParticipantState::Active);
            assert_eq!(effective_state(boss, this.now), ParticipantState::Stale);
            let working = &this.participants()[1];
            assert_eq!(
                effective_state(working, this.now),
                ParticipantState::Working,
                "a running agent is never drawn as idle"
            );
        });
    }

    #[gpui::test]
    fn clicking_a_chip_asks_the_shell_to_address_it(cx: &mut TestAppContext) {
        let (view, cx) = bar(cx, room());
        let seen = std::rc::Rc::new(std::cell::RefCell::new(Vec::new()));
        let sink = seen.clone();
        cx.update(|_, cx| {
            cx.subscribe(&view, move |_, event: &TeamBarEvent, _| sink.borrow_mut().push(event.clone())).detach();
        });
        view.update(cx, |_, cx| {
            cx.emit(TeamBarEvent::Retarget { participant: ParticipantId::from("builder") });
            cx.emit(TeamBarEvent::RemoveRole { participant: ParticipantId::from("reviewer") });
            cx.emit(TeamBarEvent::AddRole { role: ParticipantId::from("planner"), engine: EngineId::Claude });
        });
        cx.update(|window, cx| window.draw(cx).clear(cx));
        assert_eq!(seen.borrow().len(), 3);
    }

    #[gpui::test]
    fn seats_can_be_replaced_when_someone_joins_mid_job(cx: &mut TestAppContext) {
        let (view, cx) = bar(cx, vec![seat("boss", "BOSS", EngineId::Claude, ParticipantState::Active)]);
        view.update(cx, |this, cx| this.set_participants(room(), cx));
        cx.update(|window, cx| window.draw(cx).clear(cx));
        view.read_with(cx, |this, _| assert_eq!(this.participants().len(), 3));
    }
}
