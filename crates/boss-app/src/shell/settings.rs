//! The settings page, shown as a tab. Bound to `boss_core::store::Settings`
//! through `AppState::settings`; every change goes to `ShellActions::save_settings`.
//!
//! Engine status and model lists are live. The app probes engines off the
//! UI thread and pushes results into the shared [`ProbeState`] entity that
//! [`SettingsPage`] observes; see [`ProbeState`] for the exact call.

use super::actions::ShellActions;
use super::state::AppState;
use super::{apply_font_size, apply_theme};
use boss_core::store::settings::{READING_SIZE, slugify};
use boss_core::store::{McpConnection, McpTransport, Settings, Theme as ThemePref};
use boss_core::*;
use gpui::{
    AnyElement, App, Context, Entity, EventEmitter, FocusHandle, Focusable, IntoElement, ParentElement, Render,
    SharedString, Styled, Subscription, Window, div, prelude::*, px,
};
use gpui_component::{
    ActiveTheme, IndexPath, Sizable, h_flex,
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
use time::OffsetDateTime;

/// First entry of every model picker: leave the engine to choose.
const ENGINE_DEFAULT: &str = "Engine default";

/// Models offered per engine before `Engine::list_models` has answered, and
/// whenever it fails (an engine that is not installed cannot list models,
/// but the user still needs to pick what a future install will run).
pub fn model_options(engine: EngineId) -> Vec<SharedString> {
    let models: &[&str] = match engine {
        EngineId::Claude => &["claude-opus-4", "claude-sonnet-4", "claude-haiku-4"],
        EngineId::Codex => &["gpt-5", "gpt-5-codex", "o4-mini"],
        EngineId::Opencode => &["anthropic/claude-sonnet-4", "openai/gpt-5", "google/gemini-2.5-pro"],
        EngineId::Pi => &["claude-sonnet-4", "gpt-5"],
    };
    std::iter::once(ENGINE_DEFAULT).chain(models.iter().copied()).map(SharedString::from).collect()
}

/// The options a picker shows: the engine's live list when there is one,
/// otherwise the hardcoded fallback. The engine default is always first,
/// and a model the user has already chosen is kept even when the live list
/// does not mention it, so opening settings never silently drops a setting.
pub fn model_options_for(engine: EngineId, live: Option<&[ModelInfo]>, current: Option<&str>) -> Vec<SharedString> {
    let mut options: Vec<SharedString> = match live {
        Some(models) if !models.is_empty() => std::iter::once(SharedString::from(ENGINE_DEFAULT))
            .chain(models.iter().map(|m| SharedString::from(m.id.clone())))
            .collect(),
        _ => model_options(engine),
    };
    if let Some(current) = current
        && !current.is_empty()
        && !options.iter().any(|o| o.as_ref() == current)
    {
        options.push(SharedString::from(current.to_owned()));
    }
    options
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

/// What the Status column shows for one engine.
pub fn probe_label(probe: Option<&EngineProbe>, probing: bool) -> SharedString {
    match probe {
        None if probing => "Checking…".into(),
        None => "Not probed".into(),
        Some(p) if !p.installed => "Not installed".into(),
        Some(p) => match (&p.auth_error, &p.version) {
            (Some(err), _) => format!("Auth: {err}").into(),
            (None, Some(v)) => format!("Ready · {v}").into(),
            (None, None) => "Ready".into(),
        },
    }
}

/// Live engine facts the app fills in from the tokio runtime.
///
/// The app owns one of these and hands the same entity to
/// [`SettingsPage::new`]. From `app.rs`, after spawning `Engine::probe` on
/// the runtime, deliver the result on the UI thread:
///
/// ```ignore
/// let probes = self.probes.clone();          // Entity<ProbeState>
/// let engine = engine.clone();               // Arc<dyn Engine>
/// cx.spawn(async move |cx: &mut AsyncApp| {
///     let id = engine.id();
///     let probe = engine.probe().await;
///     let models = engine.list_models().await;
///     let _ = probes.update(cx, |state, cx| {
///         match probe {
///             Ok(p) => state.set_probe(id, p, cx),
///             Err(e) => state.set_probe_error(id, e.to_string(), cx),
///         }
///         if let Ok(models) = models {
///             state.set_models(id, models, cx);
///         }
///     });
/// })
/// .detach();
/// ```
///
/// `probe()` and `list_models()` are async and must not run on the UI
/// thread; `cx.spawn` awaits them on GPUI's executor and the `update`
/// closure runs back on the UI thread, which is what makes this safe.
#[derive(Clone, Debug, Default)]
pub struct ProbeState {
    probes: HashMap<EngineId, EngineProbe>,
    models: HashMap<EngineId, Vec<ModelInfo>>,
    /// Engines with a probe in flight, so the page can say "Checking…".
    in_flight: HashMap<EngineId, bool>,
}

impl ProbeState {
    /// Nothing probed yet.
    pub fn new() -> Self {
        Self::default()
    }

    /// Mark every engine as being probed right now.
    pub fn begin_probe(&mut self, cx: &mut Context<Self>) {
        for engine in EngineId::ALL {
            self.in_flight.insert(engine, true);
        }
        cx.notify();
    }

    /// Record a probe result.
    pub fn set_probe(&mut self, engine: EngineId, probe: EngineProbe, cx: &mut Context<Self>) {
        self.in_flight.insert(engine, false);
        self.probes.insert(engine, probe);
        cx.notify();
    }

    /// Record a probe that could not run at all, shown the same way an
    /// auth failure is: an engine BOSS cannot use, with the reason.
    pub fn set_probe_error(&mut self, engine: EngineId, error: String, cx: &mut Context<Self>) {
        self.set_probe(engine, EngineProbe { installed: false, version: None, auth_error: Some(error) }, cx);
    }

    /// Record the models an engine reports.
    pub fn set_models(&mut self, engine: EngineId, models: Vec<ModelInfo>, cx: &mut Context<Self>) {
        self.models.insert(engine, models);
        cx.notify();
    }

    /// The last probe for an engine.
    pub fn probe(&self, engine: EngineId) -> Option<&EngineProbe> {
        self.probes.get(&engine)
    }

    /// The engine's live model list, if it has answered.
    pub fn models(&self, engine: EngineId) -> Option<&[ModelInfo]> {
        self.models.get(&engine).map(Vec::as_slice)
    }

    /// Is a probe for this engine in flight?
    pub fn is_probing(&self, engine: EngineId) -> bool {
        self.in_flight.get(&engine).copied().unwrap_or(false)
    }
}

/// What the settings page asks the window to do. The lead wires these to
/// the relay and Tailscale once those land in the Rust app.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SettingsEvent {
    /// The remote-access switch was flipped.
    EnableRemote(bool),
    /// The user asked to pair a phone; show the pairing code and QR.
    ShowPairing,
}

type ModelSelect = Entity<SelectState<Vec<SharedString>>>;

/// A model picker plus the options it was built with, so the page can tell
/// when a live list has replaced the fallback and rebuild it.
struct ModelPicker {
    engine: EngineId,
    select: ModelSelect,
    options: Vec<SharedString>,
}

/// Which transport an in-progress new connection uses.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DraftTransport {
    Stdio,
    Http,
}

/// The half-filled "Add connection" form.
struct McpDraft {
    transport: DraftTransport,
    name: Entity<InputState>,
    /// The command line for stdio, or the URL for HTTP.
    target: Entity<InputState>,
}

/// The settings view.
pub struct SettingsPage {
    /// Pairing code and QR shown after the user asks to pair a phone.
    pairing_code: Option<String>,
    pairing_png: Option<Arc<gpui::Image>>,
    state: Entity<AppState>,
    probe_state: Entity<ProbeState>,
    actions: Arc<dyn ShellActions>,
    exec_inputs: Vec<(EngineId, Entity<InputState>)>,
    model_pickers: Vec<ModelPicker>,
    mcp_draft: Option<McpDraft>,
    tailscale_host: Entity<InputState>,
    remote_enabled: bool,
    focus_handle: FocusHandle,
    subscriptions: Vec<Subscription>,
}

impl EventEmitter<SettingsEvent> for SettingsPage {}

impl SettingsPage {
    /// Build the page over shared state and the app's live probe results.
    pub fn new(
        state: Entity<AppState>,
        probe_state: Entity<ProbeState>,
        actions: Arc<dyn ShellActions>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let settings = state.read(cx).settings.clone();
        let mut subscriptions =
            vec![cx.observe(&state, |_, _, cx| cx.notify()), cx.observe(&probe_state, |_, _, cx| cx.notify())];
        let mut exec_inputs = Vec::new();
        let mut model_pickers = Vec::new();
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

            let options = model_options_for(engine, None, settings.default_model(engine));
            let picker = Self::build_picker(engine, options, settings.default_model(engine), window, cx);
            subscriptions.push(Self::subscribe_picker(engine, &picker.select, window, cx));
            model_pickers.push(picker);
        }

        let tailscale_host = cx.new(|cx| InputState::new(window, cx).placeholder("boss-mac.tailnet.ts.net"));

        Self {
            pairing_code: None,
            pairing_png: None,
            state,
            probe_state,
            actions,
            exec_inputs,
            model_pickers,
            mcp_draft: None,
            tailscale_host,
            remote_enabled: false,
            focus_handle: cx.focus_handle(),
            subscriptions,
        }
    }

    /// The live-probe entity the app writes into.
    pub fn probe_state(&self) -> &Entity<ProbeState> {
        &self.probe_state
    }

    /// Record a probe result directly. Equivalent to updating
    /// [`ProbeState`], and kept because the app already calls it.
    pub fn set_probe(&mut self, engine: EngineId, probe: EngineProbe, cx: &mut Context<Self>) {
        self.probe_state.update(cx, |state, cx| state.set_probe(engine, probe, cx));
    }

    /// Show (or clear) the phone pairing code and its QR image.
    pub fn set_pairing(&mut self, code: Option<String>, png: Option<Vec<u8>>, cx: &mut Context<Self>) {
        self.pairing_code = code;
        self.pairing_png = png.map(|bytes| Arc::new(gpui::Image::from_bytes(gpui::ImageFormat::Png, bytes)));
        cx.notify();
    }

    fn build_picker(
        engine: EngineId,
        options: Vec<SharedString>,
        current: Option<&str>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> ModelPicker {
        let selected = current.and_then(|m| options.iter().position(|o| o.as_ref() == m)).unwrap_or(0);
        let for_state = options.clone();
        let select = cx.new(|cx| SelectState::new(for_state, Some(IndexPath::default().row(selected)), window, cx));
        ModelPicker { engine, select, options }
    }

    fn subscribe_picker(
        engine: EngineId,
        select: &ModelSelect,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Subscription {
        cx.subscribe_in(select, window, move |this, _, event: &SelectEvent<Vec<SharedString>>, _, cx| {
            let SelectEvent::Confirm(value) = event;
            this.set_default_model(engine, value.clone(), cx);
        })
    }

    /// Rebuild any picker whose option list has gone stale because the
    /// engine answered `list_models`. Called from `render`, which is the
    /// only place with a `Window` after construction.
    fn refresh_model_pickers(&mut self, settings: &Settings, window: &mut Window, cx: &mut Context<Self>) {
        for ix in 0..self.model_pickers.len() {
            let engine = self.model_pickers[ix].engine;
            let current = settings.default_model(engine).map(str::to_owned);
            let wanted = {
                let probes = self.probe_state.read(cx);
                model_options_for(engine, probes.models(engine), current.as_deref())
            };
            if wanted == self.model_pickers[ix].options {
                continue;
            }
            let picker = Self::build_picker(engine, wanted, current.as_deref(), window, cx);
            self.subscriptions.push(Self::subscribe_picker(engine, &picker.select, window, cx));
            self.model_pickers[ix] = picker;
        }
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

    pub fn set_theme(&mut self, theme: ThemePref, window: &mut Window, cx: &mut Context<Self>) {
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

    fn probe_engines(&mut self, cx: &mut Context<Self>) {
        self.probe_state.update(cx, |state, cx| state.begin_probe(cx));
        self.actions.probe_engines(cx);
    }

    // ---- MCP connections ---------------------------------------------

    fn set_mcp_enabled(&mut self, id: String, enabled: bool, cx: &mut Context<Self>) {
        self.update_settings(cx, |s| {
            if let Some(c) = s.mcp_connections.iter_mut().find(|c| c.id == id) {
                c.enabled = enabled;
            }
        });
    }

    fn remove_mcp(&mut self, id: String, cx: &mut Context<Self>) {
        self.update_settings(cx, |s| s.mcp_connections.retain(|c| c.id != id));
    }

    fn begin_add_mcp(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let name = cx.new(|cx| InputState::new(window, cx).placeholder("GitHub"));
        let target = cx.new(|cx| InputState::new(window, cx).placeholder("npx -y @modelcontextprotocol/server-github"));
        name.read(cx).focus_handle(cx).focus(window, cx);
        self.mcp_draft = Some(McpDraft { transport: DraftTransport::Stdio, name, target });
        cx.notify();
    }

    fn cancel_add_mcp(&mut self, cx: &mut Context<Self>) {
        self.mcp_draft = None;
        cx.notify();
    }

    fn set_draft_transport(&mut self, transport: DraftTransport, window: &mut Window, cx: &mut Context<Self>) {
        let Some(draft) = self.mcp_draft.as_mut() else { return };
        if draft.transport == transport {
            return;
        }
        draft.transport = transport;
        let placeholder = match transport {
            DraftTransport::Stdio => "npx -y @modelcontextprotocol/server-github",
            DraftTransport::Http => "https://api.githubcopilot.com/mcp/",
        };
        draft.target.update(cx, |input, cx| input.set_placeholder(placeholder, window, cx));
        cx.notify();
    }

    /// Add the drafted connection. A blank name or target is ignored, and
    /// the slug is made unique so tool namespaces cannot collide.
    fn commit_add_mcp(&mut self, cx: &mut Context<Self>) {
        let Some(draft) = self.mcp_draft.as_ref() else { return };
        let name = draft.name.read(cx).value().trim().to_owned();
        let target = draft.target.read(cx).value().trim().to_owned();
        if name.is_empty() || target.is_empty() {
            return;
        }
        let existing: Vec<String> = self.settings(cx).mcp_connections.iter().map(|c| c.slug.clone()).collect();
        let connection = new_connection(&name, &target, draft.transport == DraftTransport::Http, &existing);
        self.update_settings(cx, |s| s.mcp_connections.push(connection));
        self.mcp_draft = None;
        cx.notify();
    }

    // ---- remote access ------------------------------------------------

    fn set_remote_enabled(&mut self, enabled: bool, cx: &mut Context<Self>) {
        self.remote_enabled = enabled;
        cx.emit(SettingsEvent::EnableRemote(enabled));
        cx.notify();
    }

    // ---- shared rendering helpers -------------------------------------

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
                .child(div().w(px(140.)).child("Status"))
                .child(div().w(px(200.)).child("Default model")),
        );
        for (ix, (engine, input)) in self.exec_inputs.iter().enumerate() {
            let engine = *engine;
            let select = &self.model_pickers[ix].select;
            let (status, live_models) = {
                let probes = self.probe_state.read(cx);
                (probe_label(probes.probe(engine), probes.is_probing(engine)), probes.models(engine).map(<[_]>::len))
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
                    .child(div().w(px(140.)).text_xs().truncate().text_color(cx.theme().muted_foreground).child(status))
                    .child(
                        v_flex()
                            .w(px(200.))
                            .gap_1()
                            .child(Select::new(select).small().placeholder(ENGINE_DEFAULT))
                            .when_some(live_models, |this, n| {
                                this.child(
                                    div()
                                        .text_xs()
                                        .text_color(cx.theme().muted_foreground)
                                        .child(format!("{n} models from {}", engine.as_str())),
                                )
                            }),
                    ),
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
                        .on_click(cx.listener(|this, _, _, cx| this.probe_engines(cx))),
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
            let remove_id = c.id.clone();
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
                            .child(
                                div()
                                    .text_xs()
                                    .truncate()
                                    .text_color(cx.theme().muted_foreground)
                                    .child(connection_target(c)),
                            ),
                    )
                    .child(
                        Switch::new(("mcp-enabled", ix))
                            .small()
                            .checked(c.enabled)
                            .on_click(cx.listener(move |this, checked: &bool, _, cx| this.set_mcp_enabled(id.clone(), *checked, cx))),
                    )
                    .child(
                        Button::new(("mcp-remove", ix))
                            .label("Remove")
                            .small()
                            .danger()
                            .on_click(cx.listener(move |this, _, _, cx| this.remove_mcp(remove_id.clone(), cx))),
                    ),
            );
        }
        match self.mcp_draft.as_ref() {
            Some(draft) => group.child(self.render_mcp_draft(draft, cx)),
            None => group.child(
                h_flex().justify_end().child(
                    Button::new("mcp-add")
                        .label("Add connection")
                        .small()
                        .on_click(cx.listener(|this, _, window, cx| this.begin_add_mcp(window, cx))),
                ),
            ),
        }
    }

    fn render_mcp_draft(&self, draft: &McpDraft, cx: &mut Context<Self>) -> impl IntoElement {
        let stdio = draft.transport == DraftTransport::Stdio;
        v_flex()
            .gap_2()
            .p_2()
            .rounded(cx.theme().radius)
            .bg(cx.theme().muted)
            .child(Self::row(
                "Transport",
                self.choice(
                    "mcp-transport",
                    [(DraftTransport::Stdio, "Command (stdio)"), (DraftTransport::Http, "HTTP")],
                    draft.transport,
                    |this, transport, window, cx| this.set_draft_transport(transport, window, cx),
                    cx,
                ),
                cx,
            ))
            .child(Self::row("Name", Input::new(&draft.name).small(), cx))
            .child(Self::row(if stdio { "Command" } else { "URL" }, Input::new(&draft.target).small(), cx))
            .child(
                h_flex()
                    .justify_end()
                    .gap_2()
                    .child(
                        Button::new("mcp-cancel")
                            .label("Cancel")
                            .small()
                            .secondary()
                            .on_click(cx.listener(|this, _, _, cx| this.cancel_add_mcp(cx))),
                    )
                    .child(
                        Button::new("mcp-save")
                            .label("Add")
                            .small()
                            .primary()
                            .on_click(cx.listener(|this, _, _, cx| this.commit_add_mcp(cx))),
                    ),
            )
    }

    fn render_remote(&self, cx: &mut Context<Self>) -> impl IntoElement {
        GroupBox::new()
            .title(div().font_weight(gpui::FontWeight::SEMIBOLD).child("Remote access"))
            .child(
                div()
                    .text_xs()
                    .text_color(cx.theme().muted_foreground)
                    .child("Reach this Mac from your phone over your tailnet, or pair through the relay."),
            )
            .child(Self::row(
                "Tailscale host",
                h_flex()
                    .gap_2()
                    .items_center()
                    .child(div().flex_1().min_w_0().child(Input::new(&self.tailscale_host).small()))
                    .child(
                        Switch::new("remote-enabled")
                            .small()
                            .checked(self.remote_enabled)
                            .on_click(cx.listener(|this, checked: &bool, _, cx| this.set_remote_enabled(*checked, cx))),
                    ),
                cx,
            ))
            .child(Self::row(
                "Pair a phone",
                h_flex()
                    .gap_3()
                    .items_center()
                    .child(
                        Button::new("remote-pair")
                            .label("Show pairing code")
                            .small()
                            .on_click(cx.listener(|this, _, _, cx| {
                                cx.emit(SettingsEvent::ShowPairing);
                                cx.notify();
                                let _ = this;
                            })),
                    )
                    .child(match self.pairing_png.clone() {
                        Some(image) => div().size(px(160.)).child(gpui::img(image).size_full()).into_any_element(),
                        None => div()
                            .size(px(96.))
                            .rounded(cx.theme().radius)
                            .border_1()
                            .border_color(cx.theme().border)
                            .flex()
                            .items_center()
                            .justify_center()
                            .text_xs()
                            .text_color(cx.theme().muted_foreground)
                            .child("QR")
                            .into_any_element(),
                    })
                    .child(
                        div()
                            .text_xs()
                            .text_color(cx.theme().muted_foreground)
                            .max_w(px(320.))
                            .child(self.pairing_code.clone().unwrap_or_default()),
                    ),
                cx,
            ))
    }
}

/// What a connection points at, for the one-line summary under its name.
pub fn connection_target(c: &McpConnection) -> String {
    match c.transport {
        McpTransport::Http => c.url.clone().unwrap_or_default(),
        McpTransport::Stdio => {
            let mut parts = vec![c.command.clone().unwrap_or_default()];
            parts.extend(c.args.iter().cloned());
            parts.join(" ")
        }
    }
}

/// Build a connection from what the user typed. `target` is a command line
/// for stdio or a URL for HTTP; `taken` are slugs already in use, which the
/// new slug is made not to collide with.
pub fn new_connection(name: &str, target: &str, http: bool, taken: &[String]) -> McpConnection {
    let base = {
        let s = slugify(name);
        if s.is_empty() { "server".to_owned() } else { s }
    };
    let mut slug = base.clone();
    let mut n = 2;
    while taken.iter().any(|t| t == &slug) {
        slug = format!("{base}_{n}");
        n += 1;
    }
    let id = format!("mcp_{}_{}", slug, OffsetDateTime::now_utc().unix_timestamp());
    let mut connection = McpConnection {
        id,
        name: name.trim().to_owned(),
        slug,
        enabled: true,
        created_at: OffsetDateTime::now_utc(),
        ..McpConnection::default()
    };
    if http {
        connection.transport = McpTransport::Http;
        connection.url = Some(target.trim().to_owned());
    } else {
        connection.transport = McpTransport::Stdio;
        let mut parts = target.split_whitespace().map(str::to_owned);
        connection.command = parts.next();
        connection.args = parts.collect();
    }
    connection
}

impl Focusable for SettingsPage {
    fn focus_handle(&self, _cx: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

impl Render for SettingsPage {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let settings = self.settings(cx);
        self.refresh_model_pickers(&settings, window, cx);
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
                    .child(self.render_mcp(&settings, cx))
                    .child(self.render_remote(cx)),
            )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn info(id: &str) -> ModelInfo {
        ModelInfo { id: id.into(), label: id.into(), provider: None }
    }

    #[test]
    fn model_options_start_with_the_engine_default() {
        for engine in EngineId::ALL {
            let options = model_options(engine);
            assert_eq!(options[0].as_ref(), ENGINE_DEFAULT);
            assert!(options.len() >= 2);
        }
    }

    #[test]
    fn a_live_model_list_replaces_the_fallback() {
        let live = [info("claude-opus-5"), info("claude-sonnet-5")];
        let options = model_options_for(EngineId::Claude, Some(&live), None);
        assert_eq!(
            options.iter().map(|o| o.to_string()).collect::<Vec<_>>(),
            vec![ENGINE_DEFAULT, "claude-opus-5", "claude-sonnet-5"]
        );
    }

    #[test]
    fn the_fallback_is_used_when_the_engine_has_not_answered_or_lists_nothing() {
        assert_eq!(model_options_for(EngineId::Codex, None, None), model_options(EngineId::Codex));
        assert_eq!(model_options_for(EngineId::Codex, Some(&[]), None), model_options(EngineId::Codex));
    }

    #[test]
    fn a_chosen_model_survives_a_live_list_that_omits_it() {
        let live = [info("gpt-6")];
        let options = model_options_for(EngineId::Codex, Some(&live), Some("gpt-5-codex"));
        assert!(options.iter().any(|o| o.as_ref() == "gpt-5-codex"), "{options:?}");
        // Already present: not duplicated.
        let options = model_options_for(EngineId::Codex, Some(&live), Some("gpt-6"));
        assert_eq!(options.iter().filter(|o| o.as_ref() == "gpt-6").count(), 1);
        // A blank setting adds nothing.
        assert_eq!(model_options_for(EngineId::Codex, Some(&live), Some("")).len(), 2);
    }

    #[test]
    fn probe_labels_cover_every_state() {
        assert_eq!(probe_label(None, false), "Not probed");
        assert_eq!(probe_label(None, true), "Checking…");
        assert_eq!(probe_label(Some(&EngineProbe::default()), false), "Not installed");
        let ready = EngineProbe { installed: true, version: Some("2.1.0".into()), auth_error: None };
        assert_eq!(probe_label(Some(&ready), false), "Ready · 2.1.0");
        let versionless = EngineProbe { installed: true, version: None, auth_error: None };
        assert_eq!(probe_label(Some(&versionless), false), "Ready");
        let unauthed = EngineProbe { installed: true, version: Some("2.1.0".into()), auth_error: Some("login".into()) };
        assert_eq!(probe_label(Some(&unauthed), false), "Auth: login");
        // A finished probe wins over a stale in-flight flag.
        assert_eq!(probe_label(Some(&ready), true), "Ready · 2.1.0");
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

    #[test]
    fn a_stdio_connection_splits_its_command_line() {
        let c = new_connection("GitHub", "npx -y @modelcontextprotocol/server-github", false, &[]);
        assert_eq!(c.transport, McpTransport::Stdio);
        assert_eq!(c.command.as_deref(), Some("npx"));
        assert_eq!(c.args, vec!["-y", "@modelcontextprotocol/server-github"]);
        assert_eq!(c.slug, "github");
        assert!(c.enabled);
        assert_eq!(c.url, None);
        assert_eq!(connection_target(&c), "npx -y @modelcontextprotocol/server-github");
    }

    #[test]
    fn an_http_connection_keeps_its_url() {
        let c = new_connection("  Copilot  ", " https://api.githubcopilot.com/mcp/ ", true, &[]);
        assert_eq!(c.transport, McpTransport::Http);
        assert_eq!(c.url.as_deref(), Some("https://api.githubcopilot.com/mcp/"));
        assert_eq!(c.name, "Copilot");
        assert!(c.command.is_none() && c.args.is_empty());
        assert_eq!(connection_target(&c), "https://api.githubcopilot.com/mcp/");
    }

    #[test]
    fn slugs_are_made_unique_so_tool_namespaces_cannot_collide() {
        let taken = vec!["github".to_owned(), "github_2".to_owned()];
        let c = new_connection("GitHub", "npx x", false, &taken);
        assert_eq!(c.slug, "github_3");
        assert!(c.id.starts_with("mcp_github_3_"));
        // A name with nothing sluggable still gets a usable namespace.
        assert_eq!(new_connection("!!!", "npx x", false, &[]).slug, "server");
    }
}
