//! Open browser tabs and the bus tools that reach them.

use std::collections::BTreeMap;
use std::sync::{Arc, RwLock};

use base64::Engine as _;
use boss_core::{BusContent, BusTool, BusToolResult};
use gpui::{App, Entity};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::automation::PageAutomation;
use crate::screenshot::png_dimensions;
use crate::tools::{BrowserToolCall, browser_tool_definitions, is_browser_tool};
use crate::view::{BrowserTabId, BrowserView, PageHandle};

/// One row of `boss_browser_tabs`. Field names match the Electron output.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTabInfo {
    /// The tab id other tools take as `tabId`.
    pub id: String,
    /// Current URL.
    pub url: String,
    /// Document title.
    pub title: String,
    /// Whether a load is in flight.
    pub loading: bool,
}

/// The thread-safe half of the registry: tab handles keyed by id, plus the
/// six `boss_browser_*` tools mapped onto them. Clone it into the app's
/// `BusHandler`; it stays valid as tabs open and close.
#[derive(Clone, Default)]
pub struct BrowserBusTools {
    tabs: Arc<RwLock<BTreeMap<BrowserTabId, PageHandle>>>,
}

impl BrowserBusTools {
    /// MCP definitions for the six tools.
    pub fn definitions(&self) -> Vec<BusTool> {
        browser_tool_definitions()
    }

    /// Whether this helper answers `name`.
    pub fn handles(&self, name: &str) -> bool {
        is_browser_tool(name)
    }

    /// Registers a tab handle. Replaces any handle already under that id.
    pub fn insert(&self, handle: PageHandle) {
        if let Ok(mut tabs) = self.tabs.write() {
            tabs.insert(handle.id().clone(), handle);
        }
    }

    /// Forgets a tab.
    pub fn remove(&self, id: &BrowserTabId) -> Option<PageHandle> {
        self.tabs.write().ok().and_then(|mut tabs| tabs.remove(id))
    }

    /// The handle for `id`.
    pub fn get(&self, id: &BrowserTabId) -> Option<PageHandle> {
        self.tabs.read().ok().and_then(|tabs| tabs.get(id).cloned())
    }

    /// Open tabs with their current state, in id order.
    pub fn tabs(&self) -> Vec<BrowserTabInfo> {
        let Ok(tabs) = self.tabs.read() else { return Vec::new() };
        tabs.values()
            .map(|handle| {
                let state = handle.current_state();
                BrowserTabInfo { id: handle.id().0.clone(), url: state.url, title: state.title, loading: state.loading }
            })
            .collect()
    }

    /// Runs one `boss_browser_*` call. Unknown tools and bad arguments come
    /// back as error results rather than panics.
    pub async fn call(&self, name: &str, args: &Value) -> BusToolResult {
        let call = match BrowserToolCall::parse(name, args) {
            Ok(Some(call)) => call,
            Ok(None) => return BusToolResult::error(format!("{name} is not a browser tool.")),
            Err(message) => return BusToolResult::error(message),
        };
        match self.run(call).await {
            Ok(result) => result,
            Err(error) => BusToolResult::error(error.to_string()),
        }
    }

    async fn run(&self, call: BrowserToolCall) -> anyhow::Result<BusToolResult> {
        let tab = |id: &str| -> anyhow::Result<PageHandle> {
            self.get(&BrowserTabId::from(id)).ok_or_else(|| {
                anyhow::anyhow!("Browser tab {} was not found. Use boss_browser_tabs first.", if id.is_empty() { "(missing)" } else { id })
            })
        };
        Ok(match call {
            BrowserToolCall::Tabs => BusToolResult::text(serde_json::to_string_pretty(&self.tabs())?),
            BrowserToolCall::Navigate { tab_id, url } => {
                let page = tab(&tab_id)?;
                let parsed = crate::automation::http_url(&url)?;
                page.navigate(parsed.as_str()).await?;
                BusToolResult::text(format!("Opened {parsed} in browser tab {tab_id}."))
            }
            BrowserToolCall::Snapshot { tab_id } => BusToolResult::text(tab(&tab_id)?.snapshot().await?),
            BrowserToolCall::Screenshot { tab_id } => {
                let png = tab(&tab_id)?.screenshot().await?;
                let (width, height) = png_dimensions(&png).unwrap_or((0, 0));
                BusToolResult {
                    content: vec![
                        BusContent::Text { text: format!("Screenshot of browser tab {tab_id} ({width}\u{d7}{height}).") },
                        BusContent::Image {
                            data: base64::engine::general_purpose::STANDARD.encode(&png),
                            mime_type: "image/png".into(),
                        },
                    ],
                    is_error: false,
                }
            }
            BrowserToolCall::Click { tab_id, ref_ } => {
                tab(&tab_id)?.click(&ref_).await?;
                BusToolResult::text(format!("Clicked {ref_} in browser tab {tab_id}. Take a fresh snapshot to verify the result."))
            }
            BrowserToolCall::Type { tab_id, ref_, text, submit } => {
                tab(&tab_id)?.type_text(&ref_, &text, submit).await?;
                let suffix = if submit { " and submitted" } else { "" };
                BusToolResult::text(format!("Typed into {ref_} in browser tab {tab_id}{suffix}. Take a fresh snapshot to verify the result."))
            }
        })
    }
}

/// Main-thread owner of the open browser tabs.
///
/// Holds the [`BrowserView`] entities; [`BrowserRegistry::bus_tools`] gives
/// the `Send + Sync` view of the same tabs for the bus.
#[derive(Default)]
pub struct BrowserRegistry {
    views: BTreeMap<BrowserTabId, Entity<BrowserView>>,
    tools: BrowserBusTools,
}

impl BrowserRegistry {
    /// An empty registry.
    pub fn new() -> Self {
        Self::default()
    }

    /// Registers an open tab and returns its id.
    pub fn open(&mut self, view: Entity<BrowserView>, cx: &App) -> BrowserTabId {
        let (id, handle) = {
            let view = view.read(cx);
            (view.id().clone(), view.handle())
        };
        self.tools.insert(handle);
        self.views.insert(id.clone(), view);
        id
    }

    /// Removes a tab, returning its view so the caller can drop or park it.
    pub fn close(&mut self, id: &BrowserTabId) -> Option<Entity<BrowserView>> {
        self.tools.remove(id);
        self.views.remove(id)
    }

    /// The view for `id`.
    pub fn get(&self, id: &BrowserTabId) -> Option<&Entity<BrowserView>> {
        self.views.get(id)
    }

    /// Ids of open tabs, in order.
    pub fn ids(&self) -> impl Iterator<Item = &BrowserTabId> {
        self.views.keys()
    }

    /// Number of open tabs.
    pub fn len(&self) -> usize {
        self.views.len()
    }

    /// Whether no tabs are open.
    pub fn is_empty(&self) -> bool {
        self.views.is_empty()
    }

    /// Open tabs with their current state.
    pub fn tabs(&self) -> Vec<BrowserTabInfo> {
        self.tools.tabs()
    }

    /// The thread-safe tool mapper for the app's `BusHandler`.
    pub fn bus_tools(&self) -> BrowserBusTools {
        self.tools.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::automation::NavigationState;
    use crate::view::PageCommand;
    use futures::executor::block_on;
    use serde_json::json;
    use std::sync::Mutex;

    /// A fake tab: answers every eval with `reply`, screenshots with a tiny PNG.
    fn fake_tab(id: &str, state: NavigationState, reply: Value) -> (PageHandle, std::thread::JoinHandle<Vec<String>>) {
        let (tx, rx) = async_channel::unbounded::<PageCommand>();
        let shared = Arc::new(Mutex::new(state));
        let handle = PageHandle::new(BrowserTabId::from(id), tx, shared);
        let worker = std::thread::spawn(move || {
            let mut scripts = Vec::new();
            while let Ok(command) = block_on(rx.recv()) {
                match command {
                    PageCommand::Navigate { url, reply } => {
                        scripts.push(format!("navigate:{url}"));
                        let _ = reply.send(Ok(()));
                    }
                    PageCommand::Eval { js, reply: tx } => {
                        scripts.push(js);
                        let _ = tx.send(Ok(reply.clone()));
                    }
                    PageCommand::Screenshot { reply } => {
                        let mut png = b"\x89PNG\r\n\x1a\n".to_vec();
                        png.extend_from_slice(&13u32.to_be_bytes());
                        png.extend_from_slice(b"IHDR");
                        png.extend_from_slice(&64u32.to_be_bytes());
                        png.extend_from_slice(&32u32.to_be_bytes());
                        let _ = reply.send(Ok(png));
                    }
                }
            }
            scripts
        });
        (handle, worker)
    }

    fn text(result: &BusToolResult) -> String {
        result
            .content
            .iter()
            .filter_map(|c| match c {
                BusContent::Text { text } => Some(text.clone()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn bookkeeping_tracks_tabs_by_id() {
        let tools = BrowserBusTools::default();
        assert!(tools.tabs().is_empty());
        let state = NavigationState { url: "https://a.test".into(), title: "A".into(), loading: false, ..Default::default() };
        let (a, _) = fake_tab("t-a", state, Value::Null);
        let (b, _) = fake_tab("t-b", NavigationState::default(), Value::Null);
        tools.insert(a);
        tools.insert(b);
        let tabs = tools.tabs();
        assert_eq!(tabs.len(), 2);
        assert_eq!(tabs[0], BrowserTabInfo { id: "t-a".into(), url: "https://a.test".into(), title: "A".into(), loading: false });
        assert!(tools.get(&BrowserTabId::from("t-b")).is_some());
        assert!(tools.remove(&BrowserTabId::from("t-a")).is_some());
        assert!(tools.remove(&BrowserTabId::from("t-a")).is_none());
        assert_eq!(tools.tabs().len(), 1);
        assert_eq!(tools.definitions().len(), 6);
        assert!(tools.handles("boss_browser_tabs"));
    }

    #[test]
    fn tabs_tool_lists_open_tabs_as_json() {
        let tools = BrowserBusTools::default();
        let (a, _) = fake_tab("t-a", NavigationState { url: "https://a.test".into(), ..Default::default() }, Value::Null);
        tools.insert(a);
        let result = block_on(tools.call("boss_browser_tabs", &json!({})));
        assert!(!result.is_error);
        let listed: Vec<BrowserTabInfo> = serde_json::from_str(&text(&result)).unwrap();
        assert_eq!(listed[0].id, "t-a");
    }

    #[test]
    fn calls_reach_the_tab_and_report_like_electron() {
        let tools = BrowserBusTools::default();
        let (a, worker) = fake_tab("t-a", NavigationState::default(), json!({"ok": true, "ref": "e1"}));
        tools.insert(a);

        let nav = block_on(tools.call("boss_browser_navigate", &json!({"tabId": "t-a", "url": "https://example.com"})));
        assert_eq!(text(&nav), "Opened https://example.com/ in browser tab t-a.");
        let bad = block_on(tools.call("boss_browser_navigate", &json!({"tabId": "t-a", "url": "file:///x"})));
        assert!(bad.is_error);

        let snap = block_on(tools.call("boss_browser_snapshot", &json!({"tabId": "t-a"})));
        assert!(!snap.is_error);
        assert!(text(&snap).contains("\"ok\": true"));

        let click = block_on(tools.call("boss_browser_click", &json!({"tabId": "t-a", "ref": "e1"})));
        assert_eq!(text(&click), "Clicked e1 in browser tab t-a. Take a fresh snapshot to verify the result.");

        let typed = block_on(tools.call("boss_browser_type", &json!({"tabId": "t-a", "ref": "e1", "text": "hi", "submit": true})));
        assert_eq!(text(&typed), "Typed into e1 in browser tab t-a and submitted. Take a fresh snapshot to verify the result.");

        let shot = block_on(tools.call("boss_browser_screenshot", &json!({"tabId": "t-a"})));
        assert_eq!(text(&shot), "Screenshot of browser tab t-a (64\u{d7}32).");
        assert!(matches!(&shot.content[1], BusContent::Image { mime_type, .. } if mime_type == "image/png"));

        let missing = block_on(tools.call("boss_browser_snapshot", &json!({"tabId": "nope"})));
        assert!(missing.is_error);
        assert!(text(&missing).contains("Use boss_browser_tabs first"));
        let unknown = block_on(tools.call("boss_computer", &json!({})));
        assert!(unknown.is_error);

        tools.remove(&BrowserTabId::from("t-a"));
        let scripts = worker.join().unwrap();
        assert_eq!(scripts[0], "navigate:https://example.com/");
        assert_eq!(scripts[1], crate::scripts::SNAPSHOT_JS);
        assert!(scripts[2].contains("element.click()"));
        assert!(scripts[3].contains("const submit = true"));
    }

    #[test]
    fn a_failed_script_result_is_an_error() {
        let tools = BrowserBusTools::default();
        let (a, _) = fake_tab("t-a", NavigationState::default(), json!({"ok": false, "error": "Element is disabled."}));
        tools.insert(a);
        let click = block_on(tools.call("boss_browser_click", &json!({"tabId": "t-a", "ref": "e1"})));
        assert!(click.is_error);
        assert_eq!(text(&click), "Element is disabled.");
    }
}
