//! The native wry webview and the GPUI element that positions it.

use std::cell::Cell;
use std::rc::Rc;

use anyhow::Result;
use gpui::{
    App, Bounds, ContentMask, Element, ElementId, GlobalElementId, Hitbox, HitboxBehavior,
    InspectorElementId, IntoElement, LayoutId, MouseDownEvent, Pixels, Size, Style, Window,
};

/// What the native page reports back. Pushed from wry's handlers, drained on
/// the foreground executor so entity updates never re-enter GPUI.
#[derive(Clone, Debug)]
pub(crate) enum WebEvent {
    /// A load started.
    LoadStarted(String),
    /// A load finished; carries the final URL.
    LoadFinished(String),
    /// The document title changed.
    TitleChanged(String),
    /// The page asked to open something BOSS will not host (popup, non-http scheme).
    External(String),
}

fn is_http(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    lower.starts_with("http:") || lower.starts_with("https:")
}

/// Builds a hardened child webview inside the GPUI window.
///
/// Hardening mirrors `browse.ts`: only http(s) navigations, popups denied and
/// reported as [`WebEvent::External`], all permission prompts refused.
#[cfg(any(target_os = "macos", target_os = "windows"))]
pub(crate) fn build_webview(
    window: &mut Window,
    events: async_channel::Sender<WebEvent>,
) -> Result<wry::WebView> {
    use raw_window_handle::HasWindowHandle;
    use wry::{NewWindowResponse, PageLoadEvent, PermissionResponse};

    let handle = HasWindowHandle::window_handle(&*window)?;
    let nav_events = events.clone();
    let title_events = events.clone();
    let load_events = events.clone();
    let builder = wry::WebViewBuilder::new()
        .with_devtools(cfg!(debug_assertions))
        .with_visible(false)
        .with_bounds(wry::Rect::default())
        .with_url("about:blank")
        .with_navigation_handler(move |url| {
            if is_http(&url) || url == "about:blank" {
                return true;
            }
            let _ = nav_events.try_send(WebEvent::External(url));
            false
        })
        .with_new_window_req_handler(move |url, _features| {
            let _ = events.try_send(WebEvent::External(url));
            NewWindowResponse::Deny
        })
        .with_permission_handler(|_kind| PermissionResponse::Deny)
        .with_document_title_changed_handler(move |title| {
            let _ = title_events.try_send(WebEvent::TitleChanged(title));
        })
        .with_on_page_load_handler(move |event, url| {
            let event = match event {
                PageLoadEvent::Started => WebEvent::LoadStarted(url),
                PageLoadEvent::Finished => WebEvent::LoadFinished(url),
            };
            let _ = load_events.try_send(event);
        });
    Ok(builder.build_as_child(&handle)?)
}

/// Linux needs a GTK `Fixed` container that GPUI does not expose; not implemented.
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub(crate) fn build_webview(
    _window: &mut Window,
    _events: async_channel::Sender<WebEvent>,
) -> Result<wry::WebView> {
    let _ = is_http;
    anyhow::bail!("not implemented on this platform")
}

/// Element state that keeps the native view shown while the element paints.
///
/// GPUI drops element state that was not touched during a frame, so when the
/// owning tab stops rendering (tab switched) this guard is dropped at the end
/// of that frame and hides the native view. Nothing polls.
struct ShownGuard {
    webview: Rc<wry::WebView>,
    shown: Rc<Cell<bool>>,
}

impl Drop for ShownGuard {
    fn drop(&mut self) {
        let _ = self.webview.focus_parent();
        let _ = self.webview.set_visible(false);
        self.shown.set(false);
    }
}

/// Positions a wry webview under the element's bounds.
pub(crate) struct WebViewElement {
    id: ElementId,
    webview: Rc<wry::WebView>,
    /// Set by the owning view to keep the page hidden even while laid out.
    suppressed: bool,
    /// Shared with the owning view so it can report visibility.
    shown: Rc<Cell<bool>>,
}

impl WebViewElement {
    pub(crate) fn new(
        id: impl Into<ElementId>,
        webview: Rc<wry::WebView>,
        suppressed: bool,
        shown: Rc<Cell<bool>>,
    ) -> Self {
        Self { id: id.into(), webview, suppressed, shown }
    }
}

impl IntoElement for WebViewElement {
    type Element = Self;
    fn into_element(self) -> Self {
        self
    }
}

impl Element for WebViewElement {
    type RequestLayoutState = ();
    type PrepaintState = Option<Hitbox>;

    fn id(&self) -> Option<ElementId> {
        Some(self.id.clone())
    }

    fn source_location(&self) -> Option<&'static std::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, ()) {
        let style = Style { size: Size::full(), flex_shrink: 1., ..Default::default() };
        (window.request_layout(style, [], cx), ())
    }

    fn prepaint(
        &mut self,
        id: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut (),
        window: &mut Window,
        _: &mut App,
    ) -> Option<Hitbox> {
        if self.suppressed {
            return None;
        }
        let webview = self.webview.clone();
        let shown = self.shown.clone();
        if let Some(id) = id {
            window.with_element_state(id, |guard: Option<ShownGuard>, _| {
                let guard = guard.unwrap_or_else(|| {
                    let _ = webview.set_visible(true);
                    shown.set(true);
                    ShownGuard { webview: webview.clone(), shown: shown.clone() }
                });
                ((), guard)
            });
        }
        let _ = self.webview.set_bounds(wry::Rect {
            position: wry::dpi::Position::Logical(wry::dpi::LogicalPosition::new(
                f64::from(bounds.origin.x),
                f64::from(bounds.origin.y),
            )),
            size: wry::dpi::Size::Logical(wry::dpi::LogicalSize::new(
                f64::from(bounds.size.width),
                f64::from(bounds.size.height),
            )),
        });
        Some(window.insert_hitbox(bounds, HitboxBehavior::Normal))
    }

    fn paint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut (),
        hitbox: &mut Option<Hitbox>,
        window: &mut Window,
        _: &mut App,
    ) {
        let bounds = hitbox.as_ref().map(|h| h.bounds).unwrap_or(bounds);
        window.with_content_mask(Some(ContentMask { bounds }), |window| {
            let webview = self.webview.clone();
            window.on_mouse_event(move |event: &MouseDownEvent, _, _, _| {
                // A click on the GPUI side of the window moves focus off the page.
                if !bounds.contains(&event.position) {
                    let _ = webview.focus_parent();
                }
            });
        });
    }
}
