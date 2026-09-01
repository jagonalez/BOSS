//! The browser tab: URL bar, navigation buttons, and the native page.

use std::cell::Cell;
use std::rc::Rc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{Result, anyhow};
use async_trait::async_trait;
use futures::channel::oneshot;
use gpui::{
    App, AppContext as _, Context, EventEmitter, FocusHandle, Focusable, InteractiveElement as _,
    IntoElement, ParentElement as _, Render, SharedString, Styled as _, Window, div, px,
};
use gpui_component::button::{Button, ButtonVariants as _};
use gpui_component::input::{Input, InputEvent, InputState};
use gpui_component::{ActiveTheme as _, Disableable as _, IconName, Sizable as _, h_flex, v_flex};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::automation::{NavigationState, PageAutomation, http_url};
use crate::screenshot;
use crate::webview::{WebEvent, WebViewElement, build_webview};

/// How long `navigate` waits for the page to finish loading.
const NAVIGATE_TIMEOUT: Duration = Duration::from_secs(30);

/// Identifies one browser tab across the registry, the UI, and the bus tools.
#[derive(Clone, Debug, Hash, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct BrowserTabId(pub String);

impl BrowserTabId {
    /// A fresh process-unique id.
    pub fn new() -> Self {
        use std::sync::atomic::{AtomicU64, Ordering};
        static NEXT: AtomicU64 = AtomicU64::new(1);
        Self(format!("browser-{}", NEXT.fetch_add(1, Ordering::Relaxed)))
    }
}

impl Default for BrowserTabId {
    fn default() -> Self {
        Self::new()
    }
}

impl std::fmt::Display for BrowserTabId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl From<&str> for BrowserTabId {
    fn from(value: &str) -> Self {
        Self(value.to_string())
    }
}

/// Events a [`BrowserView`] emits.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BrowserEvent {
    /// URL, history, or loading state changed.
    Navigated(NavigationState),
    /// The document title changed.
    TitleChanged(String),
    /// The page asked for something BOSS will not host; open it externally.
    OpenExternal(String),
    /// An agent drove this tab. Lets the UI highlight a tab that is off screen.
    AgentActivity,
}

/// What the url bar does with what you typed. Ported from `browse-guests.ts`.
///
/// A bare word is a search, not a hostname. Something with a dot and no
/// spaces is treated as a host, which is the guess every browser makes.
pub fn as_url(typed: &str) -> String {
    let text = typed.trim();
    let has_scheme = text
        .split_once("://")
        .map(|(scheme, _)| {
            let mut chars = scheme.chars();
            matches!(chars.next(), Some(c) if c.is_ascii_alphabetic())
                && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-'))
        })
        .unwrap_or(false);
    if has_scheme {
        return text.to_string();
    }
    if text.starts_with("localhost") || looks_like_ipv4(text) {
        return format!("http://{text}");
    }
    let no_space = !text.chars().any(char::is_whitespace);
    let host_part = text.split(['/', '?', '#']).next().unwrap_or("");
    let looks_like_host = no_space
        && host_part
            .split_once('.')
            .map(|(head, tail)| !head.is_empty() && tail.len() >= 2)
            .unwrap_or(false);
    if looks_like_host {
        return format!("https://{text}");
    }
    let query: String = url::form_urlencoded::byte_serialize(text.as_bytes()).collect();
    format!("https://www.google.com/search?q={query}")
}

fn looks_like_ipv4(text: &str) -> bool {
    let head = text.split([':', '/']).next().unwrap_or("");
    let parts: Vec<&str> = head.split('.').collect();
    parts.len() == 4 && parts.iter().all(|p| !p.is_empty() && p.len() <= 3 && p.chars().all(|c| c.is_ascii_digit()))
}

/// A command posted from any thread to the tab's main-thread pump.
pub(crate) enum PageCommand {
    Navigate { url: String, reply: oneshot::Sender<Result<()>> },
    Eval { js: String, reply: oneshot::Sender<Result<Value>> },
    Screenshot { reply: oneshot::Sender<Result<Vec<u8>>> },
}

/// A `Send + Sync` handle that drives one [`BrowserView`] from any thread.
///
/// Every call is forwarded over a channel to the GPUI foreground executor and
/// awaited; the page itself never leaves the main thread.
#[derive(Clone)]
pub struct PageHandle {
    id: BrowserTabId,
    commands: async_channel::Sender<PageCommand>,
    state: Arc<Mutex<NavigationState>>,
}

impl PageHandle {
    pub(crate) fn new(
        id: BrowserTabId,
        commands: async_channel::Sender<PageCommand>,
        state: Arc<Mutex<NavigationState>>,
    ) -> Self {
        Self { id, commands, state }
    }

    /// The tab this handle drives.
    pub fn id(&self) -> &BrowserTabId {
        &self.id
    }

    /// Current navigation state without a round trip to the main thread.
    pub fn current_state(&self) -> NavigationState {
        self.state.lock().map(|s| s.clone()).unwrap_or_default()
    }

    async fn send<T>(&self, make: impl FnOnce(oneshot::Sender<Result<T>>) -> PageCommand) -> Result<T> {
        let (tx, rx) = oneshot::channel();
        self.commands
            .send(make(tx))
            .await
            .map_err(|_| anyhow!("Browser tab {} was closed.", self.id))?;
        rx.await.map_err(|_| anyhow!("Browser tab {} went away before replying.", self.id))?
    }
}

#[async_trait]
impl PageAutomation for PageHandle {
    async fn navigate(&self, url: &str) -> Result<()> {
        let url = http_url(url)?.to_string();
        self.send(|reply| PageCommand::Navigate { url, reply }).await
    }

    async fn eval(&self, js: &str) -> Result<Value> {
        let js = js.to_string();
        self.send(|reply| PageCommand::Eval { js, reply }).await
    }

    async fn screenshot(&self) -> Result<Vec<u8>> {
        self.send(|reply| PageCommand::Screenshot { reply }).await
    }

    async fn state(&self) -> Result<NavigationState> {
        Ok(self.current_state())
    }
}

/// One embedded browser tab.
pub struct BrowserView {
    id: BrowserTabId,
    focus_handle: FocusHandle,
    webview: Option<Rc<wry::WebView>>,
    /// Why there is no webview, when `webview` is `None`.
    unavailable: Option<String>,
    state: NavigationState,
    shared_state: Arc<Mutex<NavigationState>>,
    url_input: gpui::Entity<InputState>,
    /// Url bar text needs re-syncing from `state.url` on the next render.
    sync_url_bar: bool,
    /// Set by the app to keep the page hidden even while laid out.
    hidden: bool,
    shown: Rc<Cell<bool>>,
    load_waiters: Vec<(u64, oneshot::Sender<Result<()>>)>,
    next_waiter: u64,
    commands: async_channel::Sender<PageCommand>,
    _subscriptions: Vec<gpui::Subscription>,
}

impl BrowserView {
    /// Creates a tab. Pass an initial http(s) URL to start loading at once.
    pub fn new(
        id: BrowserTabId,
        initial_url: Option<&str>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let (events_tx, events_rx) = async_channel::unbounded::<WebEvent>();
        let (webview, unavailable) = match build_webview(window, events_tx) {
            Ok(webview) => (Some(Rc::new(webview)), None),
            Err(error) => {
                tracing::warn!(?error, "browser webview unavailable");
                (None, Some(error.to_string()))
            }
        };

        let url_input = cx.new(|cx| InputState::new(window, cx).placeholder("Search the web or enter a URL"));
        let url_subscription = cx.subscribe_in(&url_input, window, |this, input, event: &InputEvent, window, cx| {
            if let InputEvent::PressEnter { .. } = event {
                let typed = input.read(cx).value().to_string();
                if !typed.trim().is_empty() {
                    this.navigate(&as_url(&typed), cx);
                    this.focus_handle.focus(window, cx);
                }
            }
        });

        let (commands_tx, commands_rx) = async_channel::unbounded::<PageCommand>();
        // Native events and cross-thread commands both land here, on the
        // foreground executor, so entity updates never re-enter GPUI.
        cx.spawn(async move |this, cx| {
            while let Ok(event) = events_rx.recv().await {
                if this.update(cx, |view, cx| view.apply(event, cx)).is_err() {
                    break;
                }
            }
        })
        .detach();
        cx.spawn(async move |this, cx| {
            while let Ok(command) = commands_rx.recv().await {
                if this.update(cx, |view, cx| view.handle_command(command, cx)).is_err() {
                    break;
                }
            }
        })
        .detach();

        let mut view = Self {
            id,
            focus_handle: cx.focus_handle(),
            webview,
            unavailable,
            state: NavigationState::default(),
            shared_state: Arc::new(Mutex::new(NavigationState::default())),
            url_input,
            sync_url_bar: false,
            hidden: false,
            shown: Rc::new(Cell::new(false)),
            load_waiters: Vec::new(),
            next_waiter: 0,
            commands: commands_tx,
            _subscriptions: vec![url_subscription],
        };
        if let Some(url) = initial_url {
            view.navigate(url, cx);
        }
        view
    }

    /// The tab id.
    pub fn id(&self) -> &BrowserTabId {
        &self.id
    }

    /// A thread-safe handle implementing [`PageAutomation`].
    pub fn handle(&self) -> PageHandle {
        PageHandle::new(self.id.clone(), self.commands.clone(), self.shared_state.clone())
    }

    /// Current navigation state.
    pub fn state(&self) -> &NavigationState {
        &self.state
    }

    /// The raw wry webview, when the platform could create one.
    pub fn webview(&self) -> Option<&wry::WebView> {
        self.webview.as_deref()
    }

    /// Whether the native view is currently shown on screen.
    pub fn is_shown(&self) -> bool {
        self.shown.get()
    }

    /// Keeps the native page hidden while `hidden` is true, even when laid
    /// out (for example under a modal). Tabs that stop rendering hide on
    /// their own; this is for the cases layout cannot express.
    pub fn set_hidden(&mut self, hidden: bool, cx: &mut Context<Self>) {
        if self.hidden != hidden {
            self.hidden = hidden;
            cx.notify();
        }
    }

    /// Loads `url` if it is http(s); anything else is ignored, as in `browse.ts`.
    pub fn navigate(&mut self, url: &str, cx: &mut Context<Self>) {
        let Ok(parsed) = http_url(url) else { return };
        if let Some(webview) = &self.webview
            && let Err(error) = webview.load_url(parsed.as_str())
        {
            tracing::warn!(?error, "load_url failed");
        }
        self.set_state(|s| s.loading = true, cx);
    }

    /// History back.
    pub fn go_back(&mut self, cx: &mut Context<Self>) {
        if let Some(webview) = &self.webview {
            let _ = webview.go_back();
            self.refresh_history(cx);
        }
    }

    /// History forward.
    pub fn go_forward(&mut self, cx: &mut Context<Self>) {
        if let Some(webview) = &self.webview {
            let _ = webview.go_forward();
            self.refresh_history(cx);
        }
    }

    /// Reloads the page.
    pub fn reload(&mut self, cx: &mut Context<Self>) {
        if let Some(webview) = &self.webview {
            let _ = webview.reload();
            self.set_state(|s| s.loading = true, cx);
        }
    }

    fn set_state(&mut self, change: impl FnOnce(&mut NavigationState), cx: &mut Context<Self>) {
        let before = self.state.clone();
        change(&mut self.state);
        if let Some(webview) = &self.webview {
            self.state.can_go_back = webview.can_go_back().unwrap_or(false);
            self.state.can_go_forward = webview.can_go_forward().unwrap_or(false);
        }
        if self.state != before {
            if let Ok(mut shared) = self.shared_state.lock() {
                *shared = self.state.clone();
            }
            if self.state.title != before.title {
                cx.emit(BrowserEvent::TitleChanged(self.state.title.clone()));
            }
            cx.emit(BrowserEvent::Navigated(self.state.clone()));
            cx.notify();
        }
    }

    fn refresh_history(&mut self, cx: &mut Context<Self>) {
        self.set_state(|_| {}, cx);
    }

    fn apply(&mut self, event: WebEvent, cx: &mut Context<Self>) {
        // about:blank is where a guest starts so it exists at all; it is not
        // somewhere the user went.
        let real = |url: String| if url == "about:blank" { String::new() } else { url };
        match event {
            WebEvent::LoadStarted(url) => self.set_state(
                |s| {
                    s.loading = true;
                    let url = real(url);
                    if !url.is_empty() {
                        s.url = url;
                    }
                },
                cx,
            ),
            WebEvent::LoadFinished(url) => {
                let url = real(url);
                self.set_state(
                    |s| {
                        s.loading = false;
                        if !url.is_empty() {
                            s.url = url;
                        }
                    },
                    cx,
                );
                self.sync_url_bar = true;
                for (_, waiter) in self.load_waiters.drain(..) {
                    let _ = waiter.send(Ok(()));
                }
                cx.notify();
            }
            WebEvent::TitleChanged(title) => self.set_state(|s| s.title = title, cx),
            WebEvent::External(url) => cx.emit(BrowserEvent::OpenExternal(url)),
        }
    }

    fn handle_command(&mut self, command: PageCommand, cx: &mut Context<Self>) {
        let Some(webview) = self.webview.clone() else {
            let error = || anyhow!("{}", self.unavailable.clone().unwrap_or_else(|| "browser unavailable".into()));
            match command {
                PageCommand::Navigate { reply, .. } => drop(reply.send(Err(error()))),
                PageCommand::Eval { reply, .. } => drop(reply.send(Err(error()))),
                PageCommand::Screenshot { reply } => drop(reply.send(Err(error()))),
            }
            return;
        };
        match command {
            PageCommand::Navigate { url, reply } => {
                cx.emit(BrowserEvent::AgentActivity);
                if let Err(error) = webview.load_url(&url) {
                    let _ = reply.send(Err(anyhow!("load_url failed: {error}")));
                    return;
                }
                self.set_state(|s| s.loading = true, cx);
                let token = self.next_waiter;
                self.next_waiter += 1;
                self.load_waiters.push((token, reply));
                let timer = cx.background_executor().timer(NAVIGATE_TIMEOUT);
                cx.spawn(async move |this, cx| {
                    timer.await;
                    let _ = this.update(cx, |view, _| {
                        if let Some(index) = view.load_waiters.iter().position(|(t, _)| *t == token) {
                            let (_, waiter) = view.load_waiters.remove(index);
                            let _ = waiter.send(Err(anyhow!("Page did not finish loading within {}s.", NAVIGATE_TIMEOUT.as_secs())));
                        }
                    });
                })
                .detach();
            }
            PageCommand::Eval { js, reply } => {
                cx.emit(BrowserEvent::AgentActivity);
                let reply = Mutex::new(Some(reply));
                let result = webview.evaluate_script_with_callback(&js, move |result| {
                    if let Some(tx) = reply.lock().ok().and_then(|mut slot| slot.take()) {
                        let value = if result.is_empty() {
                            Ok(Value::Null)
                        } else {
                            serde_json::from_str(&result).map_err(|e| anyhow!("script result was not JSON: {e}"))
                        };
                        let _ = tx.send(value);
                    }
                });
                if let Err(error) = result {
                    tracing::warn!(?error, "evaluate_script failed");
                }
            }
            PageCommand::Screenshot { reply } => screenshot::capture_png(&webview, reply),
        }
    }
}

impl Focusable for BrowserView {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

impl EventEmitter<BrowserEvent> for BrowserView {}

impl Render for BrowserView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if self.sync_url_bar {
            self.sync_url_bar = false;
            let focused = self.url_input.focus_handle(cx).is_focused(window);
            if !focused {
                let url = self.state.url.clone();
                self.url_input.update(cx, |input, cx| input.set_value(url, window, cx));
            }
        }
        let theme = cx.theme();
        let (border, muted_fg) = (theme.border, theme.muted_foreground);
        let state = self.state.clone();
        let title: SharedString = if state.title.is_empty() { state.url.clone().into() } else { state.title.clone().into() };

        let bar = h_flex()
            .gap_1()
            .px_2()
            .py_1()
            .items_center()
            .border_b_1()
            .border_color(border)
            .child(
                Button::new("back")
                    .icon(IconName::ArrowLeft)
                    .ghost()
                    .xsmall()
                    .disabled(!state.can_go_back)
                    .on_click(cx.listener(|this, _, _, cx| this.go_back(cx))),
            )
            .child(
                Button::new("forward")
                    .icon(IconName::ArrowRight)
                    .ghost()
                    .xsmall()
                    .disabled(!state.can_go_forward)
                    .on_click(cx.listener(|this, _, _, cx| this.go_forward(cx))),
            )
            .child(
                Button::new("reload")
                    .icon(IconName::RotateCw)
                    .ghost()
                    .xsmall()
                    .loading(state.loading)
                    .on_click(cx.listener(|this, _, _, cx| this.reload(cx))),
            )
            .child(div().flex_1().child(Input::new(&self.url_input).xsmall()))
            .child(
                div()
                    .max_w(px(240.))
                    .overflow_hidden()
                    .text_xs()
                    .text_color(muted_fg)
                    .whitespace_nowrap()
                    .text_ellipsis()
                    .child(title),
            );

        let page = match &self.webview {
            Some(webview) => div().flex_1().size_full().child(WebViewElement::new(
                gpui::ElementId::Name(format!("boss-browser-page-{}", self.id.0).into()),
                webview.clone(),
                self.hidden,
                self.shown.clone(),
            )),
            None => div()
                .flex_1()
                .size_full()
                .flex()
                .items_center()
                .justify_center()
                .text_color(muted_fg)
                .child(format!("Browser unavailable: {}", self.unavailable.clone().unwrap_or_default())),
        };

        v_flex().track_focus(&self.focus_handle).size_full().child(bar).child(page)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn as_url_matches_browse_guests() {
        assert_eq!(as_url("https://a.b/c"), "https://a.b/c");
        assert_eq!(as_url("localhost:3000/x"), "http://localhost:3000/x");
        assert_eq!(as_url("127.0.0.1:8080"), "http://127.0.0.1:8080");
        assert_eq!(as_url("example.com/path?q=1"), "https://example.com/path?q=1");
        assert_eq!(as_url("electron"), "https://www.google.com/search?q=electron");
        assert_eq!(as_url("what is example.com"), "https://www.google.com/search?q=what+is+example.com");
    }

    #[test]
    fn tab_ids_are_unique() {
        assert_ne!(BrowserTabId::new(), BrowserTabId::new());
        assert_eq!(BrowserTabId::from("x").to_string(), "x");
    }
}
