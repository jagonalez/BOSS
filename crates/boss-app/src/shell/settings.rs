//! The settings page, shown as a tab. Bound to `boss_core::store::Settings`
//! through `AppState::settings`; every change goes to `ShellActions::save_settings`.

use super::actions::ShellActions;
use super::state::AppState;
use super::{apply_font_size, apply_theme};
use boss_core::store::settings::READING_SIZE;
use boss_core::store::{McpTransport, Settings, Theme as ThemePref};
use boss_core::*;
use gpui::{
    AnyElement, App, Context, Entity, FocusHandle, Focusable, IntoElement, ParentElement, Render, SharedString, Styled, Subscription,
    Window, div, prelude::*, px,
};
use gpui_component::{
    ActiveTheme, Disableable, IndexPath, Sizable, h_flex,
    button::{Button, ButtonVariants},
    group_box::GroupBox,
    input::{Input, InputEvent, InputState},
    select::{Select, SelectEvent, SelectState},
    switch::Switch,
    v_flex,
};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

/// First entry of every model picker: leave the engine to choose.
const ENGINE_DEFAULT: &str = "Engine default";

/// Models offered per engine until `Engine::list_models` is wired.
// TODO(lead): replace with the live list from boss_engines.
pub fn model_options(engine: EngineId) -> Vec<SharedString> {
    let models: &[&str] = match engine {
        EngineId::Claude => &["claude-opus-4", "claude-sonnet-4", "claude-haiku-4"],
        EngineId::Codex => &["gpt-5", "gpt-5-codex", "o4-mini"],
        EngineId::Opencode => &["anthropic/claude-sonnet-4", "openai/gpt-5", "google/gemini-2.5-pro"],
        EngineId::Pi => &["claude-sonnet-4", "gpt-5"],
    };
    std::iter::once(ENGINE_DEFAULT).chain(models.iter().copied()).map(SharedString::from).collect()
}

/// Every permission mode, in display order.
pub const PERMISSION_MODES: [PermissionMode; 4] =
    [PermissionMode::Default, PermissionMode::AcceptEdits, PermissionMode::Plan, PermissionMode::Bypass];

/// Label for a permission mode.
pub fn permission_label(mode: PermissionMode) -> &'static str {
    match mode {
        PermissionMode::Default => "Ask",
        PermissionMode::AcceptEdits => "Accept edits",
        PermissionMode::Plan => "Plan only",
        PermissionMode::Bypass => "Bypass",
    }
}

/// Label for a theme preference.
pub fn theme_label(theme: ThemePref) -> &'static str {
    match theme {
        ThemePref::System => "System",
        ThemePref::Light => "Light",
        ThemePref::Dark => "Dark",
    }
}

type ModelSelect = Entity<SelectState<Vec<SharedString>>>;

/// The settings view.
pub struct SettingsPage {
    state: Entity<AppState>,
    actions: Arc<dyn ShellActions>,
    exec_inputs: Vec<(EngineId, Entity<InputState>)>,
    model_selects: Vec<(EngineId, ModelSelect)>,
    /// Last probe result per engine. Empty until `probe_engines` reports back.
    // TODO(lead): fill from Engine::probe results.
    probes: HashMap<EngineId, EngineProbe>,
    focus_handle: FocusHandle,
    _subscriptions: Vec<Subscription>,
}

impl SettingsPage {
    /// Build the page over shared state.
    pub fn new(state: Entity<AppState>, actions: Arc<dyn ShellActions>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let settings = state.read(cx).settings.clone();
        let mut subscriptions = vec![cx.observe(&state, |_, _, cx| cx.notify())];
        let mut exec_inputs = Vec::new();
        let mut model_selects = Vec::new();
        for engine in EngineId::ALL {
            let current = settings.engine_executable(engine).map(|p| p.display().to_string()).unwrap_or_default();
            let input = cx.new(|cx| {
                InputState::new(window, cx).placeholder(format!("{} on PATH", engine.as_str())).default_value(current)
            });
            subscriptions.push(cx.subscribe_in(&input, window, move |this, input, event: &InputEvent, _, cx| {
                if let InputEvent::Change = event {
                    let value = input.read(cx).value().to_string();
                    this.set_executable(engine, value, cx);
                }
            }));
            exec_inputs.push((engine, input));

            let options = model_options(engine);
            let selected = settings
                .default_model(engine)
                .and_then(|m| options.iter().position(|o| o.as_ref() == m))
                .unwrap_or(0);
            let select = cx.new(|cx| SelectState::new(options, Some(IndexPath::default().row(selected)), window, cx));
            subscriptions.push(cx.subscribe_in(&select, window, move |this, _, event: &SelectEvent<Vec<SharedString>>, _, cx| {
                let SelectEvent::Confirm(value) = event;
                this.set_default_model(engine, value.clone(), cx);
            }));
            model_selects.push((engine, select));
        }
        Self {
            state,
            actions,
            exec_inputs,
            model_selects,
            probes: HashMap::new(),
            focus_handle: cx.focus_handle(),
            _subscriptions: subscriptions,
        }
    }

    /// Record a probe result so the engines list can show it.
    pub fn set_probe(&mut self, engine: EngineId, probe: EngineProbe, cx: &mut Context<Self>) {
        self.probes.insert(engine, probe);
        cx.notify();
    }

    fn settings(&self, cx: &App) -> Settings {
        self.state.read(cx).settings.clone()
    }

    /// Change the settings snapshot and ask the app to persist it.
    fn update_settings(&mut self, cx: &mut Context<Self>, f: impl FnOnce(&mut Settings)) {
        self.state.update(cx, |s, cx| {
            f(&mut s.settings);
            cx.notify();
        });
        let settings = self.settings(cx);
        self.actions.save_settings(&settings, cx);
    }

    fn set_executable(&mut self, engine: EngineId, value: String, cx: &mut Context<Self>) {
        let value = value.trim().to_owned();
        let path = if value.is_empty() { None } else { Some(PathBuf::from(value)) };
        self.update_settings(cx, |s| s.set_engine_executable(engine, path));
    }

    fn set_default_model(&mut self, engine: EngineId, model: Option<SharedString>, cx: &mut Context<Self>) {
        let model = model.filter(|m| m.as_ref() != ENGINE_DEFAULT).map(|m| m.to_string());
        self.update_settings(cx, |s| s.set_default_model(engine, model));
    }

    fn set_theme(&mut self, theme: ThemePref, window: &mut Window, cx: &mut Context<Self>) {
        self.update_settings(cx, |s| s.theme = theme);
        apply_theme(theme, Some(window), cx);
        self.actions.set_theme(theme, cx);
        window.refresh();
    }

    fn bump_font_size(&mut self, delta: f32, window: &mut Window, cx: &mut Context<Self>) {
        let size = READING_SIZE.clamp(self.settings(cx).typography.reading_size + delta);
        self.update_settings(cx, |s| s.typography.reading_size = size);
        apply_font_size(size, Some(window), cx);
    }

    fn set_permission_mode(&mut self, mode: PermissionMode, cx: &mut Context<Self>) {
        self.update_settings(cx, |s| s.permission_mode = mode);
    }

    fn set_default_engine(&mut self, engine: EngineId, cx: &mut Context<Self>) {
        self.update_settings(cx, |s| s.default_engine = engine);
    }

    fn set_mcp_enabled(&mut self, id: String, enabled: bool, cx: &mut Context<Self>) {
        self.update_settings(cx, |s| {
            if let Some(c) = s.mcp_connections.iter_mut().find(|c| c.id == id) {
                c.enabled = enabled;
            }
        });
    }

    fn choice<T: Copy + PartialEq + 'static>(
        &self,
        id: &'static str,
        options: impl IntoIterator<Item = (T, &'static str)>,
        current: T,
        on_pick: impl Fn(&mut Self, T, &mut Window, &mut Context<Self>) + Clone + 'static,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        h_flex()
            .gap_1()
            .children(options.into_iter().enumerate().map(|(ix, (value, label))| {
                let on_pick = on_pick.clone();
                let button = Button::new((id, ix)).label(label).small().on_click(cx.listener(move |this, _, window, cx| {
                    on_pick(this, value, window, cx);
                }));
                if value == current { button.primary() } else { button.secondary() }
            }))
            .into_any_element()
    }

    fn row(label: &'static str, control: impl IntoElement, cx: &App) -> impl IntoElement {
        h_flex()
            .gap_3()
            .items_center()
            .child(div().w(px(120.)).flex_shrink_0().text_sm().text_color(cx.theme().muted_foreground).child(label))
            .child(div().flex_1().min_w_0().child(control))
    }

    fn render_engines(&self, settings: &Settings, cx: &mut Context<Self>) -> impl IntoElement {
        let mut group = GroupBox::new().title(div().font_weight(gpui::FontWeight::SEMIBOLD).child("Engines"));
        group = group.child(
            h_flex()
                .gap_3()
                .text_xs()
                .text_color(cx.theme().muted_foreground)
                .child(div().w(px(120.)).child("Engine"))
                .child(div().flex_1().child("Executable override"))
                .child(div().w(px(110.)).child("Status"))
                .child(div().w(px(200.)).child("Default model")),
        );
        for (ix, (engine, input)) in self.exec_inputs.iter().enumerate() {
            let engine = *engine;
            let select = &self.model_selects[ix].1;
            let status: SharedString = match self.probes.get(&engine) {
                None => "Not probed".into(),
                Some(p) if !p.installed => "Not installed".into(),
                Some(p) => match (&p.auth_error, &p.version) {
                    (Some(err), _) => format!("Auth: {err}").into(),
                    (None, Some(v)) => format!("Ready · {v}").into(),
                    (None, None) => "Ready".into(),
                },
            };
            group = group.child(
                h_flex()
                    .gap_3()
                    .items_center()
                    .child(
                        h_flex()
                            .w(px(120.))
                            .gap_1()
                            .items_center()
                            .child(div().text_sm().child(engine.label()))
                            .when(settings.default_engine == engine, |this| {
                                this.child(
                                    div()
                                        .px_1()
                                        .rounded(cx.theme().radius)
                                        .bg(cx.theme().muted)
                                        .text_xs()
                                        .text_color(cx.theme().muted_foreground)
                                        .child("default"),
                                )
                            }),
                    )
                    .child(div().flex_1().min_w_0().child(Input::new(input).small()))
                    .child(div().w(px(110.)).text_xs().text_color(cx.theme().muted_foreground).child(status))
                    .child(div().w(px(200.)).child(Select::new(select).small().placeholder(ENGINE_DEFAULT))),
            );
        }
        group
            .child(Self::row(
                "New chats use",
                self.choice(
                    "default-engine",
                    EngineId::ALL.into_iter().map(|e| (e, e.label())),
                    settings.default_engine,
                    |this, engine, _, cx| this.set_default_engine(engine, cx),
                    cx,
                ),
                cx,
            ))
            .child(
                h_flex().justify_end().child(
                    Button::new("probe-engines")
                        .label("Probe engines")
                        .small()
                        .on_click(cx.listener(|this, _, _, cx| this.actions.probe_engines(cx))),
                ),
            )
    }

    fn render_appearance(&self, settings: &Settings, cx: &mut Context<Self>) -> impl IntoElement {
        let size = settings.typography.reading_size;
        GroupBox::new()
            .title(div().font_weight(gpui::FontWeight::SEMIBOLD).child("Appearance"))
            .child(Self::row(
                "Theme",
                self.choice(
                    "theme",
                    [ThemePref::System, ThemePref::Light, ThemePref::Dark].into_iter().map(|t| (t, theme_label(t))),
                    settings.theme,
                    |this, theme, window, cx| this.set_theme(theme, window, cx),
                    cx,
                ),
                cx,
            ))
            .child(Self::row(
                "Font size",
                h_flex()
                    .gap_2()
                    .items_center()
                    .child(
                        Button::new("font-smaller")
                            .label("−")
                            .small()
                            .secondary()
                            .on_click(cx.listener(|this, _, window, cx| this.bump_font_size(-0.5, window, cx))),
                    )
                    .child(div().w(px(56.)).text_sm().text_center().child(format!("{size:.1} pt")))
                    .child(
                        Button::new("font-larger")
                            .label("+")
                            .small()
                            .secondary()
                            .on_click(cx.listener(|this, _, window, cx| this.bump_font_size(0.5, window, cx))),
                    )
                    .child(
                        div()
                            .text_xs()
                            .text_color(cx.theme().muted_foreground)
                            .child(format!("{}–{} pt", READING_SIZE.min, READING_SIZE.max)),
                    ),
                cx,
            ))
    }

    fn render_permissions(&self, settings: &Settings, cx: &mut Context<Self>) -> impl IntoElement {
        GroupBox::new()
            .title(div().font_weight(gpui::FontWeight::SEMIBOLD).child("Permissions"))
            .child(Self::row(
                "New threads start",
                self.choice(
                    "permission-mode",
                    PERMISSION_MODES.into_iter().map(|m| (m, permission_label(m))),
                    settings.permission_mode,
                    |this, mode, _, cx| this.set_permission_mode(mode, cx),
                    cx,
                ),
                cx,
            ))
            .child(div().text_xs().text_color(cx.theme().muted_foreground).child(
                "Ask: every tool the engine would ask about. Accept edits: file changes go through. Plan only: read-only. Bypass: approve everything.",
            ))
    }

    fn render_mcp(&self, settings: &Settings, cx: &mut Context<Self>) -> impl IntoElement {
        let mut group = GroupBox::new().title(div().font_weight(gpui::FontWeight::SEMIBOLD).child("MCP connections"));
        if settings.mcp_connections.is_empty() {
            group = group.child(div().text_sm().text_color(cx.theme().muted_foreground).child("No connections yet."));
        }
        for (ix, c) in settings.mcp_connections.iter().enumerate() {
            let id = c.id.clone();
            let target = match c.transport {
                McpTransport::Http => c.url.clone().unwrap_or_default(),
                McpTransport::Stdio => {
                    let mut parts = vec![c.command.clone().unwrap_or_default()];
                    parts.extend(c.args.iter().cloned());
                    parts.join(" ")
                }
            };
            group = group.child(
                h_flex()
                    .gap_3()
                    .items_center()
                    .child(
                        v_flex()
                            .flex_1()
                            .min_w_0()
                            .child(h_flex().gap_2().items_center().child(div().text_sm().child(c.name.clone())).child(
                                div().text_xs().text_color(cx.theme().muted_foreground).child(format!("mcp_{}_*", c.slug)),
                            ))
                            .child(div().text_xs().truncate().text_color(cx.theme().muted_foreground).child(target)),
                    )
                    .child(
                        Switch::new(("mcp-enabled", ix))
                            .small()
                            .checked(c.enabled)
                            .on_click(cx.listener(move |this, checked: &bool, _, cx| this.set_mcp_enabled(id.clone(), *checked, cx))),
                    ),
            );
        }
        // TODO(lead): add/edit/remove connections once the MCP hub client lands in boss-bus.
        group.child(
            h_flex()
                .justify_between()
                .items_center()
                .child(div().text_xs().text_color(cx.theme().muted_foreground).child("Adding and editing connections arrives with the MCP hub."))
                .child(Button::new("mcp-add").label("Add connection").small().disabled(true)),
        )
    }
}

impl Focusable for SettingsPage {
    fn focus_handle(&self, _cx: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

impl Render for SettingsPage {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let settings = self.settings(cx);
        v_flex()
            .id("settings-page")
            .track_focus(&self.focus_handle)
            .size_full()
            .overflow_y_scroll()
            .child(
                v_flex()
                    .p_6()
                    .gap_5()
                    .max_w(px(820.))
                    .child(div().text_xl().font_weight(gpui::FontWeight::SEMIBOLD).child("Settings"))
                    .child(self.render_engines(&settings, cx))
                    .child(self.render_appearance(&settings, cx))
                    .child(self.render_permissions(&settings, cx))
                    .child(self.render_mcp(&settings, cx)),
            )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_options_start_with_the_engine_default() {
        for engine in EngineId::ALL {
            let options = model_options(engine);
            assert_eq!(options[0].as_ref(), ENGINE_DEFAULT);
            assert!(options.len() >= 2);
        }
    }

    #[test]
    fn labels_cover_every_variant() {
        for mode in PERMISSION_MODES {
            assert!(!permission_label(mode).is_empty());
        }
        for theme in [ThemePref::System, ThemePref::Light, ThemePref::Dark] {
            assert!(!theme_label(theme).is_empty());
        }
    }
}
