//! `TeamSetup`: what a room tab shows before its shape is chosen.
//!
//! One screen, not the three the Electron app used. The shape and the team
//! answer the same question — how this job runs — and splitting them made
//! the user answer half of it, click, and answer the other half.
//!
//! Every row arrives filled in. Setup burden is what stops people using a
//! tool, so the screen opens on a chosen shape with a team already suggested
//! from the engines that are connected; the user changes a row or presses
//! Start.

use super::{SHAPES, shape_detail, shape_label};
use boss_core::rooms::{RoomRole, RoomTeam, is_assistant, reach_of, roles_for_shape};
use boss_core::{EngineId, ModelInfo, ParticipantId, PermissionMode, RoomShape};
use gpui::prelude::*;
use gpui::{AnyElement, Context, EventEmitter, Render, SharedString, Window, div, px};
use gpui_component::button::{Button, ButtonVariants as _};
use gpui_component::menu::{DropdownMenu as _, PopupMenu, PopupMenuItem};
use crate::theme::ActivePalette as _;
use gpui_component::{ActiveTheme as _, Disableable as _, Icon, IconName, Sizable as _, StyledExt as _, h_flex, v_flex};

/// First entry of a model picker: leave the engine to choose. The same
/// wording the settings page uses.
pub const ENGINE_DEFAULT: &str = "Engine default";

/// What the setup screen asks the shell to do.
#[derive(Clone, Debug, PartialEq)]
pub enum TeamSetupEvent {
    /// Start the job: this shape, with this team.
    Start {
        /// How the job runs.
        shape: RoomShape,
        /// The team as the user left it. Every role, not only the ones this
        /// shape uses, so a later shape change finds them already set.
        team: RoomTeam,
    },
    /// The user backed out without starting.
    Cancel,
}

/// The team and shape picker for one room.
pub struct TeamSetup {
    team: RoomTeam,
    shape: RoomShape,
    engines: Vec<EngineId>,
    models: Vec<(EngineId, Vec<ModelInfo>)>,
}

impl EventEmitter<TeamSetupEvent> for TeamSetup {}

impl TeamSetup {
    /// Build the screen over a team, the engines the user has connected, and
    /// the models each of those engines offers.
    ///
    /// `models` is a list per engine, not one flat list: a `ModelInfo`'s
    /// `provider` names the model's vendor rather than the engine, so a flat
    /// list cannot be split back apart. An engine missing from it offers the
    /// default only.
    ///
    /// The shape starts at the team's default, which is what the user chose
    /// in settings; `ask_shape` decides whether they are asked again, and
    /// this screen is where the asking happens.
    pub fn new(team: RoomTeam, engines: Vec<EngineId>, models: Vec<(EngineId, Vec<ModelInfo>)>) -> Self {
        let shape = team.default_shape;
        Self { team, shape, engines, models }
    }

    /// The team as edited so far.
    pub fn team(&self) -> &RoomTeam {
        &self.team
    }

    /// The shape currently chosen.
    pub fn shape(&self) -> RoomShape {
        self.shape
    }

    /// Choose a shape. Which roles the screen lists follows from it.
    pub fn set_shape(&mut self, shape: RoomShape, cx: &mut Context<Self>) {
        self.shape = shape;
        cx.notify();
    }

    /// The roles this shape uses, BOSS first: it is who the user talks to,
    /// it joins every room, and no shape lists it.
    pub fn roles(&self) -> Vec<&RoomRole> {
        let mut roles: Vec<&RoomRole> = self
            .team
            .roles
            .iter()
            .filter(|role| is_assistant(&role.id))
            .collect();
        roles.extend(
            roles_for_shape(self.shape, &self.team)
                .iter()
                .filter_map(|id| self.team.role(id)),
        );
        roles
    }

    /// Models offered for `engine`, in menu order.
    ///
    /// `models` is keyed by engine because a `ModelInfo`'s `provider` names
    /// the model's vendor ("anthropic", "openai"), not the engine that runs
    /// it — Claude Code and OpenCode both serve Anthropic models. An engine
    /// with nothing listed still offers the default, so the picker is never
    /// an empty menu.
    pub fn models_for(&self, engine: EngineId) -> &[ModelInfo] {
        self.models
            .iter()
            .find(|(id, _)| *id == engine)
            .map(|(_, models)| models.as_slice())
            .unwrap_or(&[])
    }

    fn set_engine(&mut self, id: &ParticipantId, engine: EngineId, cx: &mut Context<Self>) {
        if let Some(role) = self.team.roles.iter_mut().find(|role| &role.id == id) {
            if role.engine == engine {
                return;
            }
            role.engine = engine;
            // A model belongs to the engine that runs it. Keeping the old
            // one would name a model the new engine has never heard of.
            role.model = None;
            cx.notify();
        }
    }

    fn set_model(&mut self, id: &ParticipantId, model: Option<String>, cx: &mut Context<Self>) {
        if let Some(role) = self.team.roles.iter_mut().find(|role| &role.id == id) {
            role.model = model;
            cx.notify();
        }
    }

    fn set_reach(&mut self, id: &ParticipantId, mode: PermissionMode, cx: &mut Context<Self>) {
        if let Some(role) = self.team.roles.iter_mut().find(|role| &role.id == id) {
            role.mode = Some(mode);
            cx.notify();
        }
    }

    fn start(&mut self, cx: &mut Context<Self>) {
        let mut team = self.team.clone();
        team.default_shape = self.shape;
        cx.emit(TeamSetupEvent::Start { shape: self.shape, team });
    }

    fn render_shape(&self, shape: RoomShape, cx: &mut Context<Self>) -> AnyElement {
        let chosen = self.shape == shape;
        let theme = cx.theme();
        let palette = *cx.palette();
        let uses = roles_for_shape(shape, &self.team).len();
        v_flex()
            .id(SharedString::from(format!("shape-{}", shape_label(shape))))
            .flex_1()
            .min_w_0()
            .gap_1()
            .p_3()
            .rounded(theme.radius)
            .border_1()
            .cursor_pointer()
            .when(chosen, |this| this.border_color(palette.accent).bg(palette.accent_soft))
            .when(!chosen, |this| {
                this.border_color(palette.border).bg(palette.surface).hover(|s| s.bg(palette.hover))
            })
            .on_click(cx.listener(move |this, _, _, cx| this.set_shape(shape, cx)))
            .child(
                h_flex()
                    .gap_2()
                    .items_center()
                    .map(|this| {
                        if chosen {
                            this.child(Icon::new(IconName::CircleCheck).small().text_color(palette.accent))
                        } else {
                            this.child(
                                div()
                                    .size(px(14.))
                                    .rounded_full()
                                    .border_1()
                                    .border_color(palette.border_strong)
                                    .flex_shrink_0(),
                            )
                        }
                    })
                    .child(div().text_sm().font_semibold().child(shape_label(shape))),
            )
            .child(
                div()
                    .text_xs()
                    .text_color(theme.muted_foreground)
                    .child(shape_detail(shape)),
            )
            .child(
                div()
                    .text_xs()
                    .text_color(theme.muted_foreground)
                    .child(if uses == 1 { "1 agent".to_owned() } else { format!("{uses} agents") }),
            )
            .into_any_element()
    }

    fn render_role(&self, role: &RoomRole, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme();
        let id = role.id.clone();
        let boss = is_assistant(&role.id);
        let model_label: SharedString = role
            .model
            .clone()
            .map(SharedString::from)
            .unwrap_or_else(|| ENGINE_DEFAULT.into());

        let engines = self.engines.clone();
        let engine_of = id.clone();
        let engine_menu = cx.weak_entity();
        let models: Vec<(SharedString, Option<String>)> = std::iter::once((SharedString::from(ENGINE_DEFAULT), None))
            .chain(
                self.models_for(role.engine)
                    .iter()
                    .map(|model| (SharedString::from(model.label.clone()), Some(model.id.clone()))),
            )
            .collect();
        let model_of = id.clone();
        let model_menu = cx.weak_entity();
        let reach_of_role = id.clone();
        let reach_menu = cx.weak_entity();

        h_flex()
            .w_full()
            .gap_2()
            .items_center()
            .py_1()
            .child(div().w(px(110.)).text_sm().font_semibold().truncate().child(role.label.clone()))
            .child(
                Button::new(SharedString::from(format!("engine-{id}")))
                    .small()
                    .outline()
                    .label(role.engine.label())
                    .dropdown_menu(move |mut menu: PopupMenu, _, _| {
                        for engine in engines.clone() {
                            let weak = engine_menu.clone();
                            let role = engine_of.clone();
                            menu = menu.item(PopupMenuItem::new(engine.label()).on_click(move |_, _, cx| {
                                let _ = weak.update(cx, |this, cx| this.set_engine(&role, engine, cx));
                            }));
                        }
                        menu
                    }),
            )
            .child(
                Button::new(SharedString::from(format!("model-{id}")))
                    .small()
                    .outline()
                    .label(model_label)
                    .dropdown_menu(move |mut menu: PopupMenu, _, _| {
                        for (label, model) in models.clone() {
                            let weak = model_menu.clone();
                            let role = model_of.clone();
                            menu = menu.item(PopupMenuItem::new(label).on_click(move |_, _, cx| {
                                let model = model.clone();
                                let _ = weak.update(cx, |this, cx| this.set_model(&role, model, cx));
                            }));
                        }
                        menu
                    }),
            )
            .child(
                div().flex_1().min_w_0().map(|this| {
                    // BOSS has no reach to set. It never changes code: it
                    // starts a room, and the agents in it work under their
                    // own settings. Offering the control asked the user to
                    // decide something that changes nothing.
                    if boss {
                        this.text_xs().text_color(theme.muted_foreground).child("coordinates, never writes code")
                    } else {
                        this.child(
                            Button::new(SharedString::from(format!("reach-{id}")))
                                .small()
                                .ghost()
                                .label(reach_of(role))
                                .dropdown_menu(move |mut menu: PopupMenu, _, _| {
                                    for (mode, words) in boss_core::rooms::REACH_CHOICES {
                                        let weak = reach_menu.clone();
                                        let role = reach_of_role.clone();
                                        menu = menu.item(PopupMenuItem::new(words).on_click(move |_, _, cx| {
                                            let _ = weak.update(cx, |this, cx| this.set_reach(&role, mode, cx));
                                        }));
                                    }
                                    menu
                                }),
                        )
                    }
                }),
            )
            .into_any_element()
    }
}

impl Render for TeamSetup {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let roles: Vec<RoomRole> = self.roles().into_iter().cloned().collect();
        let cards: Vec<AnyElement> = SHAPES.iter().map(|shape| self.render_shape(*shape, cx)).collect();
        let rows: Vec<AnyElement> = roles.iter().map(|role| self.render_role(role, cx)).collect();
        let can_start = !roles.is_empty() && !self.engines.is_empty();
        let theme = cx.theme();

        v_flex()
            .id("team-setup")
            .size_full()
            .overflow_y_scroll()
            .bg(cx.theme().background)
            .p_6()
            .gap_5()
            .child(
                v_flex()
                    .gap_1()
                    .child(div().text_lg().font_semibold().child("How should this job run?"))
                    .child(
                        div()
                            .text_sm()
                            .text_color(theme.muted_foreground)
                            .child("You choose the shape. BOSS never picks it for you."),
                    ),
            )
            .child(h_flex().w_full().gap_3().items_stretch().children(cards))
            .child(
                v_flex()
                    .w_full()
                    .gap_1()
                    .child(div().text_sm().font_semibold().child("Who works on it"))
                    .child(
                        div()
                            .text_xs()
                            .text_color(theme.muted_foreground)
                            .child("Filled in from what you have connected. Keep it, or change a row."),
                    )
                    .child(
                        v_flex()
                            .w_full()
                            .mt_2()
                            .rounded(theme.radius)
                            .border_1()
                            .border_color(theme.border)
                            .px_3()
                            .py_1()
                            .children(rows),
                    )
                    .when(!can_start, |this| {
                        this.child(
                            div()
                                .mt_2()
                                .text_xs()
                                .text_color(theme.muted_foreground)
                                .child("Connect at least one agent before starting work."),
                        )
                    }),
            )
            .child(
                h_flex()
                    .w_full()
                    .gap_2()
                    .child(
                        Button::new("team-setup-cancel")
                            .small()
                            .ghost()
                            .label("Cancel")
                            .on_click(cx.listener(|_, _, _, cx| cx.emit(TeamSetupEvent::Cancel))),
                    )
                    .child(div().flex_1())
                    .child(
                        Button::new("team-setup-start")
                            .primary()
                            .small()
                            .label("Start")
                            .disabled(!can_start)
                            .on_click(cx.listener(|this, _, _, cx| this.start(cx))),
                    ),
            )
    }
}

#[cfg(test)]
mod tests {
    use super::super::demo::team;
    use super::*;
    use gpui::{Entity, TestAppContext};

    fn models() -> Vec<(EngineId, Vec<ModelInfo>)> {
        vec![
            (
                EngineId::Claude,
                vec![ModelInfo { id: "claude-sonnet-4".into(), label: "Claude Sonnet 4".into(), provider: Some("anthropic".into()) }],
            ),
            (
                EngineId::Codex,
                vec![ModelInfo { id: "gpt-5-codex".into(), label: "GPT-5 Codex".into(), provider: Some("openai".into()) }],
            ),
        ]
    }

    fn setup(cx: &mut TestAppContext) -> (Entity<TeamSetup>, &mut gpui::VisualTestContext) {
        cx.update(gpui_component::init);
        let (view, cx) = cx.add_window_view(|_, _| {
            TeamSetup::new(team(), vec![EngineId::Claude, EngineId::Codex], models())
        });
        cx.update(|window, cx| window.draw(cx).clear(cx));
        (view, cx)
    }

    #[gpui::test]
    fn it_opens_on_the_teams_default_shape_and_lists_that_shapes_roles(cx: &mut TestAppContext) {
        let (view, cx) = setup(cx);
        view.read_with(cx, |this, _| {
            assert_eq!(this.shape(), RoomShape::Reviewed);
            let labels: Vec<&str> = this.roles().iter().map(|role| role.label.as_str()).collect();
            assert_eq!(labels, vec!["BOSS", "Builder", "Reviewer"], "BOSS is first, and no shape lists it");
        });
    }

    #[gpui::test]
    fn choosing_a_shape_changes_who_is_listed(cx: &mut TestAppContext) {
        let (view, cx) = setup(cx);
        view.update(cx, |this, cx| this.set_shape(RoomShape::Direct, cx));
        cx.update(|window, cx| window.draw(cx).clear(cx));
        view.read_with(cx, |this, _| {
            let labels: Vec<&str> = this.roles().iter().map(|role| role.label.as_str()).collect();
            assert_eq!(labels, vec!["BOSS", "Builder"]);
        });
        view.update(cx, |this, cx| this.set_shape(RoomShape::Full, cx));
        cx.update(|window, cx| window.draw(cx).clear(cx));
        view.read_with(cx, |this, _| {
            let labels: Vec<&str> = this.roles().iter().map(|role| role.label.as_str()).collect();
            assert_eq!(labels, vec!["BOSS", "Researcher", "Planner", "Builder", "Reviewer"]);
        });
    }

    #[gpui::test]
    fn changing_an_engine_drops_a_model_the_new_engine_never_heard_of(cx: &mut TestAppContext) {
        let (view, cx) = setup(cx);
        let builder = ParticipantId::from("builder");
        view.update(cx, |this, cx| {
            this.set_model(&builder, Some("gpt-5-codex".into()), cx);
            assert_eq!(this.team().role(&builder).unwrap().model.as_deref(), Some("gpt-5-codex"));
            this.set_engine(&builder, EngineId::Claude, cx);
        });
        view.read_with(cx, |this, _| {
            let role = this.team().role(&builder).expect("builder");
            assert_eq!(role.engine, EngineId::Claude);
            assert_eq!(role.model, None, "a model belongs to the engine that runs it");
        });
    }

    #[gpui::test]
    fn a_model_picker_offers_the_models_of_the_engine_that_will_run_the_role(cx: &mut TestAppContext) {
        let (view, cx) = setup(cx);
        view.read_with(cx, |this, _| {
            let claude: Vec<&str> = this.models_for(EngineId::Claude).iter().map(|m| m.id.as_str()).collect();
            assert_eq!(claude, vec!["claude-sonnet-4"]);
            let codex: Vec<&str> = this.models_for(EngineId::Codex).iter().map(|m| m.id.as_str()).collect();
            assert_eq!(codex, vec!["gpt-5-codex"]);
            assert!(
                this.models_for(EngineId::Pi).is_empty(),
                "an engine that listed nothing offers the default only"
            );
        });
    }

    #[gpui::test]
    fn reach_is_set_in_plain_words_and_boss_is_never_asked(cx: &mut TestAppContext) {
        let (view, cx) = setup(cx);
        let builder = ParticipantId::from("builder");
        view.update(cx, |this, cx| {
            assert_eq!(reach_of(this.team().role(&builder).unwrap()), "its own copy of the code");
            this.set_reach(&builder, PermissionMode::Plan, cx);
        });
        view.read_with(cx, |this, _| {
            assert_eq!(reach_of(this.team().role(&builder).unwrap()), "reads only");
        });
    }

    #[gpui::test]
    fn starting_carries_the_whole_team_and_the_shape_it_was_started_with(cx: &mut TestAppContext) {
        let (view, cx) = setup(cx);
        let seen = std::rc::Rc::new(std::cell::RefCell::new(Vec::new()));
        let sink = seen.clone();
        cx.update(|_, cx| {
            cx.subscribe(&view, move |_, event: &TeamSetupEvent, _| sink.borrow_mut().push(event.clone())).detach();
        });
        view.update(cx, |this, cx| {
            this.set_shape(RoomShape::Full, cx);
            this.start(cx);
        });
        cx.update(|window, cx| window.draw(cx).clear(cx));
        let events = seen.borrow();
        let TeamSetupEvent::Start { shape, team } = &events[0] else { panic!("expected Start, got {:?}", events[0]) };
        assert_eq!(*shape, RoomShape::Full);
        assert_eq!(team.roles.len(), 5, "every role, not only the ones this shape uses");
        assert_eq!(team.default_shape, RoomShape::Full);
    }

    #[gpui::test]
    fn with_no_engines_connected_there_is_nothing_to_start(cx: &mut TestAppContext) {
        cx.update(gpui_component::init);
        let (view, cx) = cx.add_window_view(|_, _| TeamSetup::new(team(), Vec::new(), Vec::new()));
        cx.update(|window, cx| window.draw(cx).clear(cx));
        view.read_with(cx, |this, _| assert!(this.engines.is_empty()));
    }
}
